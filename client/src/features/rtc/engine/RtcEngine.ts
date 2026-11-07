/**
 * RtcEngine（D04 §5 engine/RtcEngine.ts 阶段一务实版）：
 * - 媒体：getUserMedia{audio[,video]}；3s 未决/失败降级"无媒体通话模式"（信令照走——
 *   E2E IAB 无 fake media 设备且 getUserMedia 可能挂起的既定口径，登记）；统计不上报
 * - 连接：RTCPeerConnection P2P 直连（STUN google 默认 + rtc.ice_servers 占位，D04 API-RTC-01 未启用）
 * - 时序健壮性：PeerConnection 构造即建；媒体未决期间到达的信令缓冲、主叫 offer 挂起，
 *   媒体 settle（成功或降级）后统一放行——避免 getUserMedia 挂起阻断信令协商
 * - 候选缓冲：setRemote(offer) 前到达的 candidate 暂存队列按序补加
 */

import type { RtcCallType, RtcSignalData } from '../model/types';
import { isCandidateSignal, isSdpSignal } from '../model/types';
import { rtcSignal } from '../api/rtcApi';

/** ICE servers 占位（D04 API-RTC-01：阶段二换 GET /api/v1/rtc/config 下发 TURN 短期凭证） */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.l.google.com:19302'] }];

/** getUserMedia 决断窗口：超时按无媒体降级（自动化环境挂起场景） */
const MEDIA_TIMEOUT_MS = 3000;

/** 引擎向 store 的状态回流（媒体层连接态；信令态由 rtc.state 推送驱动） */
export interface EngineCallbacks {
  onLocalStream: (stream: MediaStream | null) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  /** 媒体层 connected/failed（与信令层 connected 近似互补：UI 以先到者点亮） */
  onConnectionChange: (state: RTCPeerConnectionState) => void;
}

export class RtcEngine {
  private pc: RTCPeerConnection;
  private callId: string;
  private cbs: EngineCallbacks;
  /** offer 到达前的候选缓冲（被叫侧） */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  /** 媒体未决期间缓冲的入站信令（offer/candidate 先于媒体 settle 到达） */
  private pendingSignals: RtcSignalData[] = [];
  private remoteDescSet = false;
  private closed = false;
  /** 媒体决断完成（true=采集成功或已按无媒体降级） */
  private mediaReady = false;
  /** connecting 已到但媒体未决：offer 挂起待放行（主叫侧） */
  private offerDue = false;

  /** 本端媒体（getUserMedia 失败/超时=null：无媒体通话模式，登记） */
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;
  /** 采集失败/超时标记（UI 提示"无媒体通话模式"） */
  mediaFailed = false;
  micOn = true;
  camOn = true;

  constructor(callId: string, cbs: EngineCallbacks) {
    this.callId = callId;
    this.cbs = cbs;
    // PeerConnection 构造即建：信令时序不依赖媒体采集结果
    this.pc = this.buildPeer();
  }

  private buildPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void this.sendSignal({
          kind: 'candidate',
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        });
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.remoteStream = stream;
      this.cbs.onRemoteStream(stream);
    };
    pc.onconnectionstatechange = () => {
      this.cbs.onConnectionChange(pc.connectionState);
    };
    return pc;
  }

  /** 采集本端媒体：audio 恒开；video 按通话类型。失败/3s 未决 → mediaFailed 降级（信令照走） */
  async initMedia(callType: RtcCallType): Promise<void> {
    try {
      this.localStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), MEDIA_TIMEOUT_MS)),
      ]);
    } catch {
      this.localStream = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
      this.micOn = true;
      this.camOn = callType === 'video';
    } else {
      // 无媒体通话模式（设备不可用/自动化环境无 fake 设备/权限未决挂起）
      this.mediaFailed = true;
      this.micOn = false;
      this.camOn = false;
    }
    this.mediaReady = true;
    this.cbs.onLocalStream(this.localStream);
    // 放行缓冲：入站信令 + 挂起的 offer（主叫）
    const buffered = this.pendingSignals.splice(0);
    for (const d of buffered) {
      void this.handleSignal(d);
    }
    if (this.offerDue) {
      this.offerDue = false;
      void this.sendOffer();
    }
  }

  /** 主叫：生成并发送 offer（被叫接听 connecting 态后调用；媒体未决则挂起待放行） */
  async sendOffer(): Promise<void> {
    if (this.closed) return;
    if (!this.mediaReady) {
      this.offerDue = true;
      return;
    }
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.sendSignal({ kind: 'sdp', type: 'offer', sdp: offer.sdp ?? '' });
  }

  /** 信令入站分发：offer（被叫）→ answer 回传；answer（主叫）→ setRemote；candidate → 缓冲/补加 */
  async handleSignal(data: RtcSignalData): Promise<void> {
    if (this.closed) return;
    if (!this.mediaReady) {
      // 媒体未决（被叫接听瞬间 offer 已到）：缓冲至 initMedia settle
      this.pendingSignals.push(data);
      return;
    }
    try {
      if (isSdpSignal(data)) {
        if (data.type === 'offer') {
          await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          this.remoteDescSet = true;
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          await this.sendSignal({ kind: 'sdp', type: 'answer', sdp: answer.sdp ?? '' });
        } else {
          await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          this.remoteDescSet = true;
        }
        // 补加缓冲候选（远端描述就绪前到达的）
        for (const c of this.pendingCandidates.splice(0)) {
          await this.pc.addIceCandidate(c).catch(() => undefined);
        }
        return;
      }
      if (isCandidateSignal(data)) {
        const init: RTCIceCandidateInit = {
          candidate: data.candidate,
          sdpMid: data.sdpMid ?? undefined,
          sdpMLineIndex: data.sdpMLineIndex ?? undefined,
        };
        if (this.remoteDescSet) {
          await this.pc.addIceCandidate(init).catch(() => undefined);
        } else {
          this.pendingCandidates.push(init);
        }
      }
    } catch {
      // 信令异常不抛出：降级为等待重试/最终由 connecting 超时兜底（阶段一登记）
    }
  }

  /** 静音切换（track.enabled 即时生效，不发信令——D04 INT-RTC-11） */
  toggleMic(): boolean {
    this.micOn = !this.micOn;
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = this.micOn;
    return this.micOn;
  }

  /** 摄像头切换（同上） */
  toggleCam(): boolean {
    this.camOn = !this.camOn;
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = this.camOn;
    return this.camOn;
  }

  /** 释放：停轨 + 关 PeerConnection（幂等） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    this.localStream = null;
    this.remoteStream = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* 已关闭 */
    }
    this.cbs.onLocalStream(null);
    this.cbs.onRemoteStream(null);
  }

  private async sendSignal(data: RtcSignalData): Promise<void> {
    try {
      await rtcSignal(this.callId, data);
    } catch {
      // 发送失败（WS 抖动）静默：ICE 有超时兜底；阶段一无重试队列，登记
    }
  }
}
