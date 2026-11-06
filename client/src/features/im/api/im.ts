/**
 * IM API 封装（D03 §5）：
 * - REST：会话列表 /convs（API-IM-02）、消息流 /convs/{id}/messages（API-IM-04）
 * - WS：msg.send（乐观更新链路的 ack 来源，幂等键 client_msg_id）
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type { Conversation, Message, MsgNewPayload, SendAck } from '../model/types';
import { MOCK_CONVS, MOCK_MESSAGES, mockLatestSeq } from './mock';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

export interface Paged<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 会话列表（API-IM-02：filter all/unread/group/single/broadcast + cursor 分页） */
export async function fetchConvs(filter: string = 'all'): Promise<Paged<Conversation>> {
  if (USE_MOCK) {
    await delay(300);
    const items = filter === 'unread' ? MOCK_CONVS.filter((c) => (c.my?.unreadBadge ?? 0) > 0) : MOCK_CONVS;
    return { items, hasMore: false };
  }
  const data = await http.get<{ items: Conversation[]; next_cursor?: string; has_more: boolean }>(
    `/convs?filter=${encodeURIComponent(filter)}`,
  );
  return { items: data.items, nextCursor: data.next_cursor, hasMore: data.has_more };
}

/** 会话消息流（API-IM-04：after/before 补洞 + cursor 翻页；骨架阶段拉最新一页） */
export async function fetchMessages(convId: string): Promise<Paged<Message>> {
  if (USE_MOCK) {
    await delay(300);
    const items = MOCK_MESSAGES[convId] ?? [];
    return { items, hasMore: false };
  }
  const data = await http.get<{ items: Message[]; next_cursor?: string; has_more: boolean }>(
    `/convs/${encodeURIComponent(convId)}/messages?order=-seq&limit=50`,
  );
  // 服务端按 -seq 返回，端内统一升序渲染（会话内显示顺序以 seq 为准，14 篇 §4.3）
  return { items: [...data.items].sort((a, b) => a.seq - b.seq), nextCursor: data.next_cursor, hasMore: data.has_more };
}

/**
 * 发送文本消息（WS msg.send，D03 §5.2）。
 * 幂等：重试复用同一 client_msg_id，服务端返回原 seq（14 篇 §5.3）。
 */
export async function sendTextMessage(convId: string, clientMsgId: string, text: string): Promise<SendAck> {
  if (USE_MOCK) {
    await delay(600);
    return mockSendAck(convId, clientMsgId);
  }
  return wsClient.request<SendAck>('msg.send', {
    conv_id: convId,
    client_msg_id: clientMsgId,
    type: 'text',
    body: { text },
  });
}

/** msg.new 推送 → 端内 Message（snake→camel） */
export function mapMsgNew(payload: MsgNewPayload, senderName?: string): Message {
  return {
    msgId: payload.msg_id,
    convId: payload.conv_id,
    seq: payload.seq,
    clientMsgId: payload.client_msg_id,
    senderId: payload.sender_id,
    senderName: senderName ?? payload.sender_id,
    type: payload.type,
    body: payload.body,
    mentions: payload.mentions,
    replyToSeq: payload.reply_to_seq,
    status: payload.status,
    ts: payload.ts,
  };
}

// ---- mock 桩：ack 分配 + 幂等（同 client_msg_id 返回原 seq）----
const mockAckSeqCache = new Map<string, number>();

function mockSendAck(convId: string, clientMsgId: string): SendAck {
  let seq = mockAckSeqCache.get(clientMsgId);
  if (seq === undefined) {
    seq = mockLatestSeq(convId) + 1 + mockAckSeqCache.size;
    mockAckSeqCache.set(clientMsgId, seq);
  }
  return { seq, msgId: `m-mock-${seq}`, ts: Date.now() };
}
