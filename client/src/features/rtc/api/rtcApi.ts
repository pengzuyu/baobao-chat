/**
 * RTC API 封装（05 篇 §5.1 + D17 统一媒体面）：
 * - WS 信令：rtc.call.invite / rtc.call.cancel / rtc.accept / rtc.reject / rtc.bye / rtc.join
 *   （rtc.signal SDP/ICE 中转已退役——媒体面经 LiveKit，D17 §7）
 * - REST：GET /rtc/config（媒体面地址下发）· GET /calls/{id}/token（进房凭证）·
 *   GET /convs/{id}/members（对端解析；shared http 直连，禁横向 import im，D01 §12.2）
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type { RtcCallType } from '../model/types';

/** 发起通话（幂等键 call_id 客户端生成；calleeId 空=群呼全员 ringing+join 模式）→ ack {call_id}；
 *  会话进行中 5009 / 对方忙 5004 */
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
export function rtcAccept(callId: string, answer: boolean, did: string, byeCallId?: string): Promise<void> {
  // bye_call_id=挂断并接听（OQ-C06 服务端原子化：单帧先 bye 旧通话再 accept，无竞态）
  return wsClient.request('rtc.accept', { call_id: callId, answer, did, bye_call_id: byeCallId });
}

/** 被叫拒接 */
export function rtcReject(callId: string, reason: string): Promise<void> {
  return wsClient.request('rtc.reject', { call_id: callId, reason });
}

/** 任一端挂断（群=单成员退出，全员退→服务端 all_left 窗口） */
export function rtcBye(callId: string): Promise<void> {
  return wsClient.request('rtc.bye', { call_id: callId });
}

/** 群通话加入（join 模式；席位 64 上限 5002；all_left 窗口内加入自动复活） */
export function rtcJoin(callId: string, did: string): Promise<void> {
  return wsClient.request('rtc.join', { call_id: callId, did });
}

/** GET /rtc/config：媒体面配置（livekit_url 空=未配置，端侧无媒体降级信令照走，D17 §3.2） */
export interface RtcMediaConfig {
  livekit_url: string;
  ice_servers?: string[];
}

export function fetchRtcConfig(): Promise<RtcMediaConfig> {
  return http.get<RtcMediaConfig>('/rtc/config');
}

/** GET /calls/{id}/token：LiveKit 进房凭证（URL 随凭证同回，免二次拉配置，D17 §3.3） */
export interface RtcJoinToken {
  token: string;
  url: string;
  room: string;
  identity: string;
}

export function fetchCallToken(callId: string, did: string): Promise<RtcJoinToken> {
  return http.get<RtcJoinToken>(`/calls/${encodeURIComponent(callId)}/token?did=${encodeURIComponent(did)}`);
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
