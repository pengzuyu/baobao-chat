/**
 * RTC API 封装（D04 §5.1 rtc.* WS 事件 + 会话成员 REST）：
 * - WS 请求：rtc.call.invite / rtc.call.cancel / rtc.accept / rtc.reject / rtc.bye / rtc.signal
 * - REST：GET /convs/{id}/members（对端解析；shared http 直连，禁横向 import im，D01 §12.2）
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type { RtcCallType, RtcSignalData } from '../model/types';

/** 发起 1v1（幂等键 call_id 客户端生成）→ ack {call_id}；会话进行中 5009 / 对方忙 5004 */
export function rtcInvite(p: { callId: string; convId: string; calleeId: string; callType: RtcCallType }): Promise<{ call_id: string }> {
  return wsClient.request<{ call_id: string }>('rtc.call.invite', {
    call_id: p.callId,
    conv_id: p.convId,
    callee_id: p.calleeId,
    call_type: p.callType,
  });
}

/** 主叫振铃期取消 */
export function rtcCancel(callId: string): Promise<void> {
  return wsClient.request('rtc.call.cancel', { call_id: callId });
}

/** 被叫接听/拒答（answer=false 视同拒接） */
export function rtcAccept(callId: string, answer: boolean, did: string): Promise<void> {
  return wsClient.request('rtc.accept', { call_id: callId, answer, did });
}

/** 被叫拒接 */
export function rtcReject(callId: string, reason: string): Promise<void> {
  return wsClient.request('rtc.reject', { call_id: callId, reason });
}

/** 任一端挂断 */
export function rtcBye(callId: string): Promise<void> {
  return wsClient.request('rtc.bye', { call_id: callId });
}

/** SDP/ICE 透传（≤64KB；服务端转发给对端） */
export function rtcSignal(callId: string, data: RtcSignalData): Promise<void> {
  return wsClient.request('rtc.signal', { call_id: callId, data });
}

/** 会话成员简表（对端解析；复用 IM 既有 REST 端点） */
export interface RtcConvMember {
  uid: string;
  displayName: string;
  role: number;
  status: number;
}

export async function fetchConvMembers(convId: string): Promise<RtcConvMember[]> {
  const data = await http.get<{ items?: RtcConvMember[] } | RtcConvMember[]>(`/convs/${encodeURIComponent(convId)}/members`);
  return Array.isArray(data) ? data : (data.items ?? []);
}
