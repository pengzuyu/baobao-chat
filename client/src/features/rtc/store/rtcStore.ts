/**
 * rtcStore（05 篇 §4.2 状态机端内投影 + D17 统一媒体面）：
 * - 活动通话 call（1v1/群合一，group 区分）+ 来电 incoming（1v1 接听弹窗/群"点击加入"）
 * - 媒体引擎=LiveKitEngine（SFU 进房；凭证经 GET /calls/{id}/token，D17 §3.3）：
 *   取 token 失败/连接失败 → mediaFailed 降级（信令照走，UI 横幅提示）
 * - rtc.ringing / rtc.state 推送驱动；rtc.signal 已退役（D17 §7）
 * - ended 后 3s 保窗 → 自动 reset；单设备单活动通话（群响铃不打扰——静默忽略不回 busy）
 */

import { create } from 'zustand';
import { emit } from '../../../shared/bus';
import { LiveKitEngine, type EngineParticipant } from '../engine/LiveKitEngine';
import { fetchCallToken, rtcAccept, rtcBye, rtcCancel, rtcInvite, rtcJoin, rtcReject } from '../api/rtcApi';
import type { RtcCallState, RtcCallType, RtcRingingPayload, RtcStatePayload } from '../model/types';
import '../events'; // bus 事件类型声明装载

/** 活动通话快照（UI 投影） */
export interface ActiveCall {
  callId: string;
  convId: string;
  callType: RtcCallType;
  /** 群通话（join 模式：成员随时加入/退出） */
  group: boolean;
  role: 'caller' | 'callee' | 'member';
  peer: { uid: string; name: string };
  state: RtcCallState;
  reason?: string;
  /** connected 起算（本地计时；服务端 duration 为结算权威） */
  startedAt?: number;
  serverDuration?: number;
  mediaFailed: boolean;
}

/** 会议窗口交接动作载荷（shared/meeting/launcher 与 Rust MeetingHandoff 的 action 子集） */
export interface MeetingHandoffAction {
  action: 'outgoing1v1' | 'outgoingGroup' | 'accept1v1' | 'joinGroup';
  callId: string;
  convId: string;
  video: boolean;
  peer: { uid: string; name: string };
}

/** call_id 生成（幂等键：重试不换，14 篇 §5.3） */
let callSeq = 0;
function newCallId(): string {
  callSeq += 1;
  return `call-${Date.now()}-${callSeq}`;
}

/** ended 保窗时长（展示终态后自动收窗） */
const ENDED_HOLD_MS = 3000;

// ---- 模块级运行态（非 React 投影）----
let engine: LiveKitEngine | null = null;
/** ensureEngine 重入防护（同 call 只建一次） */
let engineCallId: string | null = null;
let endedTimer: ReturnType<typeof setTimeout> | null = null;

interface RtcState {
  /** 当前用户 uid（app 组合层注入，同 im 口径） */
  myUid: string;
  setMyUid: (uid: string) => void;
  /** 本端 did（与 WS 连接 did 同源；LiveKit identity=uid:did；会议窗口注入 'meeting'） */
  myDid: string;
  setMyDid: (did: string) => void;

  call: ActiveCall | null;
  incoming: RtcRingingPayload | null;
  /** 通话中来电等待条（INT-RTC-16：仅 toast 不弹窗不响铃；[拒接][挂断并接听]） */
  callWaiting: RtcRingingPayload | null;
  /** 会议网格投影（engine 驱动；本端恒在首位） */
  participants: EngineParticipant[];
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  /** 轻提示（3s 自清） */
  toast: { text: string; at: number } | null;

  /** 发起 1v1（对端已解析；ChatHeader/bus 入口 → RtcOverlay 解析后调这里；
   *  callId 外部传入=独立会议窗口已用其作窗口幂等键） */
  startOutgoing: (convId: string, peer: { uid: string; name: string }, callType: RtcCallType, callId?: string) => Promise<void>;
  /** 发起群呼（callee 空=全员 ringing+join 模式；主叫即参与者） */
  startGroupCall: (convId: string, callType: RtcCallType, callId?: string) => Promise<void>;
  /** 加入群通话（群响铃[加入]/进行中卡片[加入]；callId/convId 已知） */
  joinCall: (callId: string, convId: string, callType: RtcCallType, caller: { uid: string; name: string }) => Promise<void>;
  /** 接听来电（1v1） */
  acceptIncoming: () => Promise<void>;
  /** 通话中来电：挂断当前并接听新呼（INT-RTC-16/OQ-C06：accept 带 bye_call_id 原子帧） */
  answerWaiting: () => Promise<void>;
  /** 通话中来电：拒接（回 busy）并收起等待条 */
  dismissWaiting: () => void;
  /** 拒接来电（1v1） */
  rejectIncoming: () => void;
  /** 挂断/取消（按当前态路由 cancel/bye） */
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  /** 屏幕共享开/关（D17 P1；失败 toast：权限拒绝 5007 / 平台不支持） */
  toggleScreen: () => void;

  /** 独立会议窗口 bootstrap（D17 §4）：交接载荷分发到既有动作（accept1v1 内部走 accept） */
  bootstrapHandoff: (h: MeetingHandoffAction) => Promise<void>;
  /** rtc.ringing 推送（来电/群呼邀请；通话中 1v1 自动 busy、群呼静默忽略） */
  applyRinging: (p: RtcRingingPayload) => void;
  /** rtc.state 推送（状态机驱动） */
  applyState: (p: RtcStatePayload) => void;
  /** toast 自清 */
  clearToast: () => void;
  /** 终态清理（ended 保窗后） */
  reset: () => void;
}

export const useRtcStore = create<RtcState>((set, get) => {
  /** 引擎回调 → store 投影 */
  const engineCallbacks = {
    onParticipants: (participants: EngineParticipant[]) => set({ participants }),
    onConnectionChange: (state: string) => {
      if (state === 'reconnecting') set({ toast: { text: '媒体重连中…', at: Date.now() } });
      if (state === 'disconnected') {
        // 本端已离房：结束流由服务端（webhook participant_left → rtc.state）权威驱动
        set({ toast: { text: '媒体连接已断开', at: Date.now() } });
      }
    },
  };

  const teardownEngine = () => {
    engine?.leave();
    engine = null;
    engineCallId = null;
    set({ participants: [], micOn: false, camOn: false, screenOn: false });
  };

  /**
   * 建引擎进房（幂等）：取 token → LiveKit connect → 发布轨道。
   * 失败（媒体面未配置 5003 / 连接失败）→ mediaFailed 降级：信令照走，
   * UI 横幅提示（通话卡片仍会正常落流）。
   */
  const ensureEngine = async (call: ActiveCall): Promise<void> => {
    if (engine && engineCallId === call.callId) return;
    if (engine) teardownEngine();
    engineCallId = call.callId;
    try {
      const ack = await fetchCallToken(call.callId, get().myDid);
      const eng = new LiveKitEngine(engineCallbacks);
      engine = eng;
      await eng.join(ack.url, ack.token, call.callType);
      set({ micOn: eng.micOn, camOn: eng.camOn, participants: [] });
      const cur = get().call;
      if (cur && cur.callId === call.callId) set({ call: { ...cur, mediaFailed: false } });
    } catch {
      // 无媒体降级：不建引擎，信令/卡片照走（D17 §3.3 5003 场景与连接失败统一口径）
      engine = null;
      engineCallId = null;
      const cur = get().call;
      if (cur && cur.callId === call.callId) set({ call: { ...cur, mediaFailed: true } });
      set({ toast: { text: '媒体服务未就绪（无媒体模式，通话记录正常）', at: Date.now() } });
    }
  };

  /** 被叫接通后进入通话态（acceptIncoming 与会议窗口 bootstrap 复用） */
  const beginCallee = (callId: string, convId: string, callType: RtcCallType, peer: { uid: string; name: string }) => {
    const call: ActiveCall = {
      callId, convId, callType, group: false, role: 'callee',
      peer, state: 'connecting', mediaFailed: false,
    };
    set({ call });
    void ensureEngine(call);
  };

  /** 终态进入：停引擎 + 3s 保窗后 reset */
  const enterEnded = (call: ActiveCall, reason: string, serverDuration?: number) => {
    teardownEngine();
    set({ call: { ...call, state: 'ended', reason, serverDuration: serverDuration ?? call.serverDuration } });
    emit('rtc:call-ended', { callId: call.callId, reason, durationSec: serverDuration ?? 0 });
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = setTimeout(() => get().reset(), ENDED_HOLD_MS);
  };

  /** 已有活动通话守卫（发起/加入前） */
  const busy = (): boolean => {
    if (get().call || get().incoming) {
      set({ toast: { text: '当前设备已有进行中通话', at: Date.now() } });
      return true;
    }
    return false;
  };

  return {
    myUid: '',
    setMyUid: (uid) => set({ myUid: uid }),
    myDid: 'dev-device', // 与 App.tsx WS 连接 did 同源（正式版 Rust 层生成，D01 §12.3）
    setMyDid: (did) => set({ myDid: did }),

    call: null,
    incoming: null,
    callWaiting: null,
    participants: [],
    micOn: false,
    camOn: false,
    screenOn: false,
    toast: null,

    startOutgoing: async (convId, peer, callType, externalCallId) => {
      if (busy()) return;
      const callId = externalCallId ?? newCallId();
      try {
        await rtcInvite({ callId, convId, calleeId: peer.uid, callType });
      } catch {
        set({ toast: { text: '呼叫发起失败（对方忙线或会话已有通话）', at: Date.now() } });
        return;
      }
      // 1v1 主叫：dialing 等待 accept → connecting 时 ensureEngine（applyState 触发）
      set({
        call: { callId, convId, callType, group: false, role: 'caller', peer, state: 'dialing', mediaFailed: false },
      });
    },

    startGroupCall: async (convId, callType, externalCallId) => {
      if (busy()) return;
      const callId = externalCallId ?? newCallId();
      try {
        await rtcInvite({ callId, convId, calleeId: '', callType });
      } catch {
        set({ toast: { text: '群通话发起失败（会话已有进行中通话）', at: Date.now() } });
        return;
      }
      // 群呼主叫即参与者：服务端直接推 connecting，此处先建引擎（不等推送）
      const call: ActiveCall = {
        callId, convId, callType, group: true, role: 'caller',
        peer: { uid: get().myUid, name: '群通话' }, state: 'connecting', mediaFailed: false,
      };
      set({ call });
      void ensureEngine(call);
    },

    joinCall: async (callId, convId, callType, caller) => {
      if (busy()) return;
      try {
        await rtcJoin(callId, get().myDid);
      } catch {
        set({ toast: { text: '加入失败：通话已结束或人数已满', at: Date.now() } });
        return;
      }
      const call: ActiveCall = {
        callId, convId, callType, group: true, role: 'member',
        peer: { uid: caller.uid, name: caller.name }, state: 'connecting', mediaFailed: false,
      };
      set({ call });
      void ensureEngine(call);
    },

    acceptIncoming: async () => {
      const inc = get().incoming;
      if (!inc || inc.group) return;
      set({ incoming: null });
      try {
        await rtcAccept(inc.call_id, true, get().myDid);
      } catch {
        set({ toast: { text: '接听失败：通话已结束', at: Date.now() } });
        return;
      }
      beginCallee(inc.call_id, inc.conv_id, inc.call_type, { uid: inc.caller.id, name: inc.caller.name });
    },

    answerWaiting: async () => {
      const { callWaiting, call } = get();
      if (!callWaiting) return;
      set({ callWaiting: null });
      // 挂旧接新一帧原子完成（服务端 bye_call_id）；旧通话 media/状态由服务端 rtc.state 推送收尾
      try {
        await rtcAccept(callWaiting.call_id, true, get().myDid, call?.callId);
      } catch {
        set({ toast: { text: '接听失败：通话已结束', at: Date.now() } });
        return;
      }
      beginCallee(callWaiting.call_id, callWaiting.conv_id, callWaiting.call_type, { uid: callWaiting.caller.id, name: callWaiting.caller.name });
    },

    dismissWaiting: () => {
      const { callWaiting } = get();
      if (!callWaiting) return;
      set({ callWaiting: null });
      void rtcReject(callWaiting.call_id, 'busy').catch(() => undefined);
    },

    bootstrapHandoff: async (h) => {
      const callType: RtcCallType = h.video ? 'video' : 'audio';
      switch (h.action) {
        case 'outgoing1v1':
          await get().startOutgoing(h.convId, h.peer, callType, h.callId);
          return;
        case 'outgoingGroup':
          await get().startGroupCall(h.convId, callType, h.callId);
          return;
        case 'accept1v1':
          try {
            await rtcAccept(h.callId, true, get().myDid);
          } catch {
            set({ toast: { text: '接听失败：通话已结束', at: Date.now() } });
            return;
          }
          beginCallee(h.callId, h.convId, callType, h.peer);
          return;
        case 'joinGroup':
          await get().joinCall(h.callId, h.convId, callType, h.peer);
          return;
      }
    },

    rejectIncoming: () => {
      const inc = get().incoming;
      if (!inc) return;
      set({ incoming: null });
      if (!inc.group) void rtcReject(inc.call_id, 'declined').catch(() => undefined);
      // 群呼"忽略"无信令动作（join 模式非被叫应答）
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
      // 1v1=整通结束；群=单成员退出（服务端剩余成员继续/all_left 窗口）
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
    toggleScreen: () => {
      const eng = engine;
      if (!eng) {
        set({ toast: { text: '媒体服务未就绪，无法共享', at: Date.now() } });
        return;
      }
      if (eng.screenOn) {
        void eng.stopScreenShare().then(() => set({ screenOn: false }));
        return;
      }
      void eng
        .startScreenShare()
        .then(() => set({ screenOn: true }))
        .catch((err: unknown) => {
          const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
          set({
            toast: {
              text: denied
                ? '屏幕共享被拒绝（5007）：请在系统设置授权屏幕录制后重试'
                : '当前平台/环境不支持屏幕共享（5007）',
              at: Date.now(),
            },
          });
        });
    },

    applyRinging: (p) => {
      const { call, incoming } = get();
      if (call) {
        // 通话中来电（INT-RTC-16）：1v1 → 等待条（拒接/挂断并接听）；群呼静默忽略
        if (!p.group) set({ callWaiting: p });
        return;
      }
      if (incoming) {
        // 来电弹窗已占用：1v1 新呼自动回 busy；群呼静默忽略
        if (!p.group) void rtcReject(p.call_id, 'busy').catch(() => undefined);
        return;
      }
      set({ incoming: p });
    },

    applyState: (p) => {
      const { call, incoming, callWaiting } = get();
      // 通话中来电等待条终态（INT-RTC-16）：主叫取消/超时/他端接听 → 收起等待条
      if (callWaiting && callWaiting.call_id === p.call_id) {
        if (p.kind === 'ended') {
          set({ callWaiting: null, toast: { text: p.reason === 'canceled' ? '对方已取消' : '未接听', at: Date.now() } });
          return;
        }
        if (p.kind === 'answered_elsewhere' && p.did !== get().myDid) {
          set({ callWaiting: null, toast: { text: '已在其他设备接听', at: Date.now() } });
          return;
        }
      }
      // 来电侧终态：canceled/timeout 收起来电弹窗（未接场景）
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
      // 群成员加入/退出广播：参与网格由 engine 驱动，此处在通话中仅提示性刷新（无动作）
      if (p.kind === 'joined' || p.kind === 'left') return;
      if (!call || call.callId !== p.call_id) return;
      switch (p.kind) {
        case 'dialing':
        case 'ringing':
          if (call.role === 'caller' && call.state !== 'ended') set({ call: { ...call, state: 'ringing' } });
          break;
        case 'connecting':
          if (call.state !== 'ended') set({ call: { ...call, state: 'connecting' } });
          // 1v1 主叫：被叫已接听 → 进房（群呼/被叫在各自入口已建引擎，ensureEngine 幂等）
          if (call.role === 'caller') void ensureEngine(call);
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

    clearToast: () => set({ toast: null }),
    reset: () => {
      if (endedTimer) clearTimeout(endedTimer);
      endedTimer = null;
      teardownEngine();
      set({ callWaiting: null, call: null, incoming: null });
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
export function invokeCall(convId: string, video: boolean, group = false): void {
  emit('im:invoke-call', { convId, video, group });
}
