/**
 * rtcStore（D04 §4.2 状态机的端内单一投影，阶段一务实版）：
 * - 活动通话 call（主/被叫合一）+ 来电 incoming（接听前不建引擎）
 * - rtc.ringing / rtc.state / rtc.signal 三推送经 RtcOverlay 接线驱动
 * - ended 后 3s 保窗（展示时长/原因）→ 自动 reset（D04 §4.2 ended 态 3s 关窗）
 * - 单设备单活动通话：通话中来电自动回 busy（INT-RTC-08 简化，登记）
 */

import { create } from 'zustand';
import { emit } from '../../../shared/bus';
import { RtcEngine } from '../engine/RtcEngine';
import { rtcAccept, rtcBye, rtcCancel, rtcInvite, rtcReject } from '../api/rtcApi';
import type { RtcCallState, RtcCallType, RtcRingingPayload, RtcSignalData, RtcSignalPayload, RtcStatePayload } from '../model/types';
import '../events'; // bus 事件类型声明装载

/** 活动通话快照（UI 投影） */
export interface ActiveCall {
  callId: string;
  convId: string;
  callType: RtcCallType;
  role: 'caller' | 'callee';
  peer: { uid: string; name: string };
  state: RtcCallState;
  reason?: string;
  /** connected 起算（本地计时；服务端 duration 为结算权威） */
  startedAt?: number;
  serverDuration?: number;
  mediaFailed: boolean;
}

/** call_id 生成（幂等键：重试不换，14 篇 §5.3） */
let callSeq = 0;
function newCallId(): string {
  callSeq += 1;
  return `call-${Date.now()}-${callSeq}`;
}

/** ended 保窗时长（展示终态后自动收窗） */
const ENDED_HOLD_MS = 3000;

// ---- 模块级运行态（非 React 投影）：引擎 + 信令缓冲 ----
let engine: RtcEngine | null = null;
/** 引擎就绪前到达的 signal（offer 可能先于 accept ack 到达被叫） */
const signalBuffer = new Map<string, RtcSignalData[]>();
let endedTimer: ReturnType<typeof setTimeout> | null = null;

interface RtcState {
  /** 当前用户 uid（app 组合层注入，同 im 口径） */
  myUid: string;
  setMyUid: (uid: string) => void;
  /** 本端 did（answered_elsewhere 过滤；与 WS 连接 did 同源） */
  myDid: string;

  call: ActiveCall | null;
  incoming: RtcRingingPayload | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  /** 轻提示（已在其他设备接听/对方已拒绝等，3s 自清） */
  toast: { text: string; at: number } | null;

  /** 发起 1v1（对端已解析；ChatHeader/bus 入口 → RtcOverlay 解析后调这里） */
  startOutgoing: (convId: string, peer: { uid: string; name: string }, callType: RtcCallType) => Promise<void>;
  /** 接听来电 */
  acceptIncoming: () => Promise<void>;
  /** 拒接来电 */
  rejectIncoming: () => void;
  /** 挂断/取消（按当前态路由 cancel/bye/reject） */
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => void;

  /** rtc.ringing 推送（来电；通话中自动 busy） */
  applyRinging: (p: RtcRingingPayload) => void;
  /** rtc.state 推送（状态机驱动） */
  applyState: (p: RtcStatePayload) => void;
  /** rtc.signal 推送（SDP/ICE 入站 → 引擎/缓冲） */
  applySignal: (p: RtcSignalPayload) => void;
  /** toast 自清 */
  clearToast: () => void;
  /** 终态清理（ended 保窗后） */
  reset: () => void;
}

export const useRtcStore = create<RtcState>((set, get) => {
  /** 引擎回调 → store 投影 */
  const engineCallbacks = {
    onLocalStream: (s: MediaStream | null) => set({ localStream: s }),
    onRemoteStream: (s: MediaStream | null) => set({ remoteStream: s }),
    onConnectionChange: (state: RTCPeerConnectionState) => {
      // 媒体层确认：与信令层 connected 近似互补（先到先亮）；failed 提示不强制收窗
      if (state === 'connected') {
        const call = get().call;
        if (call && call.state !== 'connected' && call.state !== 'ended') {
          set({ call: { ...call, state: 'connected', startedAt: call.startedAt ?? Date.now() } });
        }
      }
    },
  };

  /** 建/重建引擎并消费 store 级信令缓冲（引擎构造即建 PeerConnection；
   *  offer 发送时机：主叫在 connecting 态触发——媒体未决时由引擎内部挂起放行） */
  const attachEngine = (callId: string, callType: RtcCallType): RtcEngine => {
    const eng = new RtcEngine(callId, engineCallbacks);
    void eng.initMedia(callType).then(() => {
      set({ micOn: eng.micOn, camOn: eng.camOn });
      const call = get().call;
      if (call) set({ call: { ...call, mediaFailed: eng.mediaFailed } });
      // 消费引擎构造前到达的缓冲信令（引擎内部对媒体未决期再次缓冲，不丢帧）
      const buf = signalBuffer.get(callId) ?? [];
      signalBuffer.delete(callId);
      for (const d of buf) void eng.handleSignal(d);
    });
    return eng;
  };

  const teardownEngine = () => {
    engine?.close();
    engine = null;
    set({ localStream: null, remoteStream: null });
  };

  /** 终态进入：停引擎 + 3s 保窗后 reset */
  const enterEnded = (call: ActiveCall, reason: string, serverDuration?: number) => {
    teardownEngine();
    set({ call: { ...call, state: 'ended', reason, serverDuration: serverDuration ?? call.serverDuration } });
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = setTimeout(() => get().reset(), ENDED_HOLD_MS);
  };

  return {
    myUid: '',
    setMyUid: (uid) => set({ myUid: uid }),
    myDid: 'dev-device', // 与 App.tsx WS 连接 did 同源（正式版 Rust 层生成，D01 §12.3）

    call: null,
    incoming: null,
    localStream: null,
    remoteStream: null,
    micOn: false,
    camOn: false,
    toast: null,

    startOutgoing: async (convId, peer, callType) => {
      if (get().call || get().incoming) {
        set({ toast: { text: '当前设备已有进行中通话', at: Date.now() } });
        return;
      }
      const callId = newCallId();
      // 先建引擎（采集失败→无媒体通话模式，仍走信令——E2E 既定口径）；
      // offer 在服务端推 connecting（被叫已接听）后发送（applyState 触发）
      engine = attachEngine(callId, callType);
      try {
        await rtcInvite({ callId, convId, calleeId: peer.uid, callType });
      } catch {
        teardownEngine();
        set({ toast: { text: '呼叫发起失败（对方忙线或会话已有通话）', at: Date.now() } });
        return;
      }
      set({
        call: {
          callId, convId, callType, role: 'caller', peer,
          state: 'dialing', mediaFailed: engine.mediaFailed,
        },
      });
    },

    acceptIncoming: async () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      try {
        await rtcAccept(inc.call_id, true, get().myDid);
      } catch {
        set({ toast: { text: '接听失败：通话已结束', at: Date.now() } });
        return;
      }
      engine = attachEngine(inc.call_id, inc.call_type);
      set({
        call: {
          callId: inc.call_id, convId: inc.conv_id, callType: inc.call_type, role: 'callee',
          peer: { uid: inc.caller.id, name: inc.caller.name },
          state: 'connecting', mediaFailed: false,
        },
      });
    },

    rejectIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      void rtcReject(inc.call_id, 'declined').catch(() => undefined);
    },

    hangup: () => {
      const { call, incoming } = get();
      if (incoming) {
        get().rejectIncoming();
        return;
      }
      if (!call) return;
      const { callId, role, state } = call;
      if (role === 'caller' && (state === 'dialing' || state === 'ringing')) {
        void rtcCancel(callId).catch(() => undefined);
        enterEnded(call, 'canceled');
        return;
      }
      void rtcBye(callId).catch(() => undefined);
      enterEnded(call, 'bye');
    },

    toggleMic: () => {
      const on = engine?.toggleMic() ?? !get().micOn;
      set({ micOn: on });
    },
    toggleCam: () => {
      const on = engine?.toggleCam() ?? !get().camOn;
      set({ camOn: on });
    },

    applyRinging: (p) => {
      const { call } = get();
      if (call) {
        // 单设备单活动通话：自动回 busy（INT-RTC-08 简化，登记）
        void rtcReject(p.call_id, 'busy').catch(() => undefined);
        return;
      }
      set({ incoming: p });
    },

    applyState: (p) => {
      const { call, incoming } = get();
      // 被叫来电侧终态：canceled/timeout 收起来电弹窗（未接场景）
      if (incoming && incoming.call_id === p.call_id && p.kind === 'ended') {
        set({ incoming: null, toast: { text: p.reason === 'canceled' ? '对方已取消' : '未接听', at: Date.now() } });
        return;
      }
      // 多端：他端接听（本端 did 过滤；接听端自身忽略）
      if (p.kind === 'answered_elsewhere') {
        if (incoming && incoming.call_id === p.call_id && p.did !== get().myDid) {
          set({ incoming: null, toast: { text: '已在其他设备接听', at: Date.now() } });
        }
        return;
      }
      if (!call || call.callId !== p.call_id) return;
      switch (p.kind) {
        case 'dialing':
        case 'ringing':
          if (call.role === 'caller' && call.state !== 'ended') set({ call: { ...call, state: 'ringing' } });
          break;
        case 'connecting':
          if (call.state !== 'ended') set({ call: { ...call, state: 'connecting' } });
          // 主叫：被叫已接听 → 发送 offer（引擎在 invite 前已就绪）
          if (call.role === 'caller' && engine) void engine.sendOffer();
          break;
        case 'connected':
          if (call.state !== 'ended') {
            set({ call: { ...call, state: 'connected', startedAt: call.startedAt ?? Date.now() } });
          }
          break;
        case 'ended':
          enterEnded(call, p.reason ?? 'bye', p.duration);
          break;
        default:
          break;
      }
    },

    applySignal: (p) => {
      if (engine && get().call?.callId === p.call_id) {
        void engine.handleSignal(p.data);
        return;
      }
      // 引擎未就绪（offer 先于 accept ack 到达被叫）：按 call_id 缓冲
      const buf = signalBuffer.get(p.call_id) ?? [];
      buf.push(p.data);
      signalBuffer.set(p.call_id, buf);
    },

    clearToast: () => set({ toast: null }),
    reset: () => {
      if (endedTimer) clearTimeout(endedTimer);
      endedTimer = null;
      teardownEngine();
      signalBuffer.clear();
      set({ call: null, incoming: null });
    },
  };
});

/** 时长格式化 mm:ss（通话窗计时/卡片共用） */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 发起通话 bus 出口（im 侧 invoke；ChatHeader/CallCard 经 bus 解耦，D01 §12.2） */
export function invokeCall(convId: string, video: boolean): void {
  emit('im:invoke-call', { convId, video });
}
