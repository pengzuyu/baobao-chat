/**
 * RTC 类型（D04 §6.3 子集，阶段一务实版）：
 * 服务端契约见 server/internal/rtc/api/api.go——事件 payload 字段与之对齐（snake_case）。
 */

/** 通话类型（入口二选一） */
export type RtcCallType = 'audio' | 'video';

/**
 * 通话状态机（客户端投影，05 §4.2/4.3 裁剪）：
 * caller:  idle → dialing → ringing → connecting → connected → ended
 * callee:  idle → ringing(incoming) → connecting → connected → ended
 */
export type RtcCallState =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ended';

/** 终态原因（服务端 rtc.state.reason；canceled/declined/timeout/bye/failed/busy） */
export type RtcEndReason = 'canceled' | 'declined' | 'busy' | 'timeout' | 'bye' | 'failed';

/** 主叫信息（rtc.ringing.caller） */
export interface RtcCallerInfo {
  id: string;
  name: string;
  avatar?: string;
}

/** rtc.ringing 推送（被叫端） */
export interface RtcRingingPayload {
  call_id: string;
  caller: RtcCallerInfo;
  call_type: RtcCallType;
  conv_id: string;
}

/** rtc.state 推送（判别联合：kind 区分） */
export interface RtcStatePayload {
  call_id: string;
  kind: 'dialing' | 'ringing' | 'connecting' | 'connected' | 'ended' | 'answered_elsewhere';
  reason?: RtcEndReason | string;
  /** kind=ended：接通秒数（服务端结算权威） */
  duration?: number;
  /** kind=answered_elsewhere：接听端 did（本端过滤） */
  did?: string;
  ts: number;
}

/** rtc.signal 推送（对端 SDP/ICE 透传） */
export interface RtcSignalPayload {
  call_id: string;
  from: string;
  data: RtcSignalData;
}

/** rtc.signal data 判别联合（kind 区分；服务端不解释） */
export interface RtcSignalSdp {
  kind: 'sdp';
  type: 'offer' | 'answer';
  sdp: string;
}

export interface RtcSignalCandidate {
  kind: 'candidate';
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export type RtcSignalData = RtcSignalSdp | RtcSignalCandidate | Record<string, unknown>;

/** 判定 SDP 信令 */
export function isSdpSignal(d: RtcSignalData): d is RtcSignalSdp {
  return !!d && typeof d === 'object' && (d as RtcSignalSdp).kind === 'sdp';
}

/** 判定 ICE candidate 信令 */
export function isCandidateSignal(d: RtcSignalData): d is RtcSignalCandidate {
  return !!d && typeof d === 'object' && (d as RtcSignalCandidate).kind === 'candidate';
}
