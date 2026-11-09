/**
 * RTC 类型（05 篇 §6.3 + D17 统一媒体面）：
 * 服务端契约见 server/internal/rtc/api/api.go——事件 payload 字段与之对齐（snake_case）。
 * D17 变更：rtc.signal（SDP/ICE 中转）退役；新增 joined/left（群成员加入/退出广播）。
 */

/** 通话类型（入口二选一） */
export type RtcCallType = 'audio' | 'video';

/**
 * 通话状态机（客户端投影，05 §4.2/4.3 裁剪）：
 * caller:  idle → dialing → ringing → connecting → connected → ended
 * callee:  idle → ringing(incoming) → connecting → connected → ended
 * group:   invite/join → connecting → connected → ended（成员 join/left 并行广播）
 */
export type RtcCallState =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ended';

/** 终态原因（服务端 rtc.state.reason；canceled/declined/timeout/bye/failed/busy/all_left） */
export type RtcEndReason = 'canceled' | 'declined' | 'busy' | 'timeout' | 'bye' | 'failed' | 'all_left';

/** 主叫信息（rtc.ringing.caller） */
export interface RtcCallerInfo {
  id: string;
  name: string;
  avatar?: string;
}

/** rtc.ringing 推送（1v1=接听弹窗；group=true=群通话"点击加入"，经 rtc.join 加入） */
export interface RtcRingingPayload {
  call_id: string;
  caller: RtcCallerInfo;
  call_type: RtcCallType;
  conv_id: string;
  group?: boolean;
}

/** rtc.state 推送（判别联合：kind 区分） */
export interface RtcStatePayload {
  call_id: string;
  kind: 'dialing' | 'ringing' | 'connecting' | 'connected' | 'ended' | 'answered_elsewhere' | 'joined' | 'left';
  reason?: RtcEndReason | string;
  /** kind=ended：接通秒数（服务端结算权威） */
  duration?: number;
  /** kind=answered_elsewhere：接听端 did（本端过滤） */
  did?: string;
  ts: number;
}
