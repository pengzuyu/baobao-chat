/**
 * IM API 封装（D03 §5）：
 * - REST：会话列表 /convs（API-IM-02）、消息流 /convs/{id}/messages（API-IM-04）
 * - WS：msg.send（乐观更新链路的 ack 来源，幂等键 client_msg_id）
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type {
  ConvType,
  ConvDetail,
  Conversation,
  ConversationMember,
  Mention,
  Message,
  MsgNewPayload,
  NotificationItem,
  NotificationKind,
  SendAck,
} from '../model/types';
import { MOCK_CONVS, MOCK_MESSAGES, mockLatestSeq } from './mock';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

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

/** 在线状态快照（04 篇 §6.1：登录/重连后首拉种子，此后靠 presence.changed 推送增量） */
export async function fetchPresences(): Promise<Record<string, string>> {
  const data = await http.get<{ items: { uid: string; status: string }[] }>('/presences');
  return Object.fromEntries(data.items.map((it) => [it.uid, it.status]));
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
 * reply_to_seq：引用回复（快照由服务端按源消息冗余入 ext）。
 * mentions：@提及（含 @全体 all=true，服务端按 mention_all_policy 校验 3014）。
 */
export async function sendTextMessage(
  convId: string,
  clientMsgId: string,
  text: string,
  replyToSeq?: number,
  mentions?: Mention[],
): Promise<SendAck> {
  if (USE_MOCK) {
    await delay(600);
    return mockSendAck(convId, clientMsgId);
  }
  return wsClient.request<SendAck>('msg.send', {
    conv_id: convId,
    client_msg_id: clientMsgId,
    type: 'text',
    body: { text },
    ...(replyToSeq && replyToSeq > 0 ? { reply_to_seq: replyToSeq } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
  });
}

/**
 * 发送文件/图片/语音/视频消息（WS msg.send，D06 阶段一：先 POST /files/upload 得 file_id 再发消息）。
 * 服务端校验 body.file_id（存在/owner 或 source=message/未删；audio_clip 另校验
 * duration_ms ≤60s；video 校验 duration ≤10min；image 可带 caption ≤500 字），回执与 msg.new 不变。
 */
export async function sendFileMessage(
  convId: string,
  clientMsgId: string,
  type: 'image' | 'file' | 'audio_clip' | 'video',
  body: {
    file_id: string;
    name?: string;
    size?: number;
    ext?: string;
    width?: number;
    height?: number;
    contentType?: string;
    caption?: string;
    duration_ms?: number;
    poster_file_id?: string;
  },
  replyToSeq?: number,
): Promise<SendAck> {
  if (USE_MOCK) {
    await delay(300);
    return mockSendAck(convId, clientMsgId);
  }
  return wsClient.request<SendAck>('msg.send', {
    conv_id: convId,
    client_msg_id: clientMsgId,
    type,
    body,
    ...(replyToSeq && replyToSeq > 0 ? { reply_to_seq: replyToSeq } : {}),
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
    senderName: payload.sender_name || senderName || payload.sender_id,
    type: payload.type,
    body: payload.body,
    mentions: payload.mentions,
    replyToSeq: payload.reply_to_seq,
    ext: payload.ext,
    status: payload.status,
    ts: payload.ts,
  };
}

// ---- 会话交互（D03 §5）----

/** 撤回（API-IM-07；本人 ≤24h，幂等） */
export async function recallMessage(msgId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/messages/${encodeURIComponent(msgId)}/recall`, {});
}

/** 编辑（API-IM-08：body.text；仅本人 text ≤5min） */
export async function editMessage(msgId: string, text: string): Promise<{ editedAt: number; editVersion: number }> {
  if (USE_MOCK) return { editedAt: Date.now(), editVersion: 2 };
  const data = await http.patch<{ editedAt: number; editVersion: number }>(`/messages/${encodeURIComponent(msgId)}`, {
    body: { text },
  });
  return { editedAt: data.editedAt, editVersion: data.editVersion };
}

/** 表情回应（WS msg.reaction.set；ack 空，结果经 msg.reaction.new 全量快照回收） */
export async function setReaction(msgId: string, emoji: string, action: 'add' | 'remove'): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('msg.reaction.set', { msg_id: msgId, emoji, action });
}

/** 已读面板成员行（API-IM-06） */
export interface ReceiptPanelRow {
  uid: string;
  displayName: string;
}

/** 已读回执面板响应（truncated=大群仅计数口径，OQ-B04：参与成员 >200 名单置空） */
export interface ReceiptPanel {
  seq: number;
  truncated: boolean;
  readCount: number;
  unreadCount: number;
  read: ReceiptPanelRow[];
  unread: ReceiptPanelRow[];
}

/** 已读回执面板（API-IM-06：seq 的已读/未读分组；群聊尾标点击拉取） */
export async function fetchReceiptPanel(convId: string, seq: number): Promise<ReceiptPanel> {
  if (USE_MOCK) {
    await delay(200);
    return { seq, truncated: false, readCount: 0, unreadCount: 0, read: [], unread: [] };
  }
  return http.get<ReceiptPanel>(`/convs/${encodeURIComponent(convId)}/receipts?seq=${seq}`);
}

/** 正在输入（WS msg.typing，瞬时：不重试不落库，TTL 5s；ack 为空） */
export function sendTyping(convId: string): void {
  if (USE_MOCK) return;
  void wsClient.request('msg.typing', { conv_id: convId }).catch(() => undefined);
}

/** 会话态（API-IM-13：置顶/免打扰/草稿，按字段覆盖） */
export async function updateConvState(
  convId: string,
  patch: { pinned?: boolean; mute?: boolean; draft?: string },
): Promise<void> {
  if (USE_MOCK) return;
  await http.patch(`/convs/${encodeURIComponent(convId)}/state`, patch);
}

/** 转发（API-IM-09：逐条/合并）——失败明细逐条回报（msgId→错误码），端内 toast 汇总 */
export interface ForwardResult {
  sentCount: number;
  failed: Array<{ msgId: string; code: number }>;
}

export async function forwardMessages(
  targetConvId: string,
  msgIds: string[],
  mode: 'merge' | 'one_by_one',
  note?: string,
): Promise<ForwardResult> {
  if (USE_MOCK) return { sentCount: msgIds.length, failed: [] };
  const data = await http.post<{ sentCount: number; failed?: Array<{ msg_id: string; code?: number }> }>(
    '/messages/forward',
    {
      target_conv_id: targetConvId,
      msg_ids: msgIds,
      mode,
      note,
    },
  );
  return {
    sentCount: data.sentCount,
    failed: (data.failed ?? []).map((f) => ({ msgId: f.msg_id, code: f.code ?? 0 })),
  };
}

/** 历史上翻（API-IM-04 before 区间；分页加载更早消息） */
export async function fetchMessagesBefore(convId: string, before: number, limit = 20): Promise<Message[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: Message[] }>(
    `/convs/${encodeURIComponent(convId)}/messages?before=${before}&limit=${limit}`,
  );
  return [...data.items].sort((a, b) => a.seq - b.seq);
}

/**
 * 合并转发子条目原文快照（PIM-11，D03 §3.11）：按 origin_conv+origin_seq 拉该条全文及上下文。
 * 服务端 ListMessages 语义为 `seq > after AND seq < before` 升序取前 N（memory/PG 一致），
 * 故取「目标条 + 前 2 条」窗口须用 after={seq-3}&limit=3&order=seq——
 * 若按 before={seq} 会把目标条本身排除且取到会话最旧 N 条，与设计意图（around 快照）不符。
 * 无权限/已退群/会话不存在 → ApiError(3001/3019/3002)，由抽屉按条置灰"原消息不可见"。
 */
export async function fetchOriginSnapshot(convId: string, seq: number, limit = 3): Promise<Message[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: Message[] }>(
    `/convs/${encodeURIComponent(convId)}/messages?after=${seq - limit}&limit=${limit}&order=seq`,
  );
  return [...data.items].sort((a, b) => a.seq - b.seq);
}

// ---- 群管理（D03 §5.2 conv.* 全集 + API-IM-03/05；WS 事件 snake 入参）----

/** 建会话（conv.create：单聊去重复用/建群；ack {conv}） */
export async function convCreate(p: {
  type: 1 | 2 | 3;
  name?: string;
  memberIds: string[];
}): Promise<ConvDetail> {
  if (USE_MOCK) {
    await delay(400);
    return {
      id: `mock-conv-${Date.now()}`,
      type: p.type,
      name: p.name || '新会话',
      latestSeq: 0,
      memberCount: p.memberIds.length + 1,
      status: 1,
      members: [],
    };
  }
  return wsClient.request<ConvDetail>('conv.create', {
    type: p.type,
    ...(p.name ? { name: p.name } : {}),
    member_ids: p.memberIds,
  });
}

/** 退群（conv.quit；owner 服务端拒 3016） */
export async function convQuit(convId: string): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.quit', { conv_id: convId });
}

/** 邀请入群（conv.member.add；invite_policy 校验/3012/3010） */
export async function memberAdd(convId: string, uids: string[]): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.member.add', { conv_id: convId, uids });
}

/** 移出成员（conv.member.remove；矩阵校验） */
export async function memberRemove(convId: string, uid: string): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.member.remove', { conv_id: convId, uid });
}

/** 角色变更（conv.member.role：1 转让 / 2 设管 / 3 取消，仅 owner） */
export async function memberRole(convId: string, uid: string, role: 1 | 2 | 3): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.member.role', { conv_id: convId, uid, role });
}

/** 群设置 patch（conv.setting；按字段覆盖，未传字段不动） */
export async function convSetting(
  convId: string,
  patch: {
    name?: string;
    announcement?: string;
    mute_all_until?: number;
    mute_member?: { uid: string; until: number };
    join_mode?: 1 | 2 | 3;
    invite_policy?: 1 | 2;
    mention_all_policy?: 1 | 2 | 3;
    history_visible?: boolean;
  },
): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.setting', { conv_id: convId, ...patch });
}

/** 解散（conv.dissolve；仅 owner，危险确认后调用） */
export async function convDissolve(convId: string): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.dissolve', { conv_id: convId });
}

/** 入群申请（conv.apply；ack {apply_id}；7 天过期服务端懒判） */
export async function applyJoin(convId: string, reason: string): Promise<{ apply_id: string }> {
  if (USE_MOCK) return { apply_id: `mock-apply-${Date.now()}` };
  return wsClient.request<{ apply_id: string }>('conv.apply', { conv_id: convId, reason });
}

/** 审批（conv.apply.handle：approve/reject；仅 owner/admin） */
export async function handleApply(applyId: string, action: 'approve' | 'reject'): Promise<void> {
  if (USE_MOCK) return;
  await wsClient.request('conv.apply.handle', { apply_id: applyId, action });
}

/** 会话详情（API-IM-03：conversation 全字段 + group_setting + my + 成员概要） */
export async function fetchConvDetail(convId: string): Promise<ConvDetail> {
  if (USE_MOCK) {
    await delay(200);
    return {
      id: convId,
      type: 2,
      name: 'Mock 群',
      latestSeq: 0,
      memberCount: 2,
      status: 1,
      groupSetting: { joinMode: 1, invitePolicy: 1, mentionAllPolicy: 2, historyVisible: true },
      members: [],
    };
  }
  return http.get<ConvDetail>(`/convs/${encodeURIComponent(convId)}`);
}

/** 成员列表（API-IM-05 简版：在群成员含 role/mute_until） */
export async function fetchConvMembers(convId: string): Promise<ConversationMember[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: ConversationMember[] }>(`/convs/${encodeURIComponent(convId)}/members`);
  return data.items;
}

// ---- 收藏与搜索（D03 §3.7 PIM-07 服务端态 / §3.8 PIM-08；API-IM-10/11/12）----

/** 收藏列表项（API-IM-11：msg 实时快照——已撤回时 status=2 端内渲染占位） */
export interface FavoriteItem {
  id: string;
  msg: Message;
  conv: { id: string; name: string; type: ConvType };
  createdAt: number;
}

/** 搜索结果项（API-IM-12：msg + conv/sender 名 + 服务端高亮区间；端内另做 substring 高亮兜底） */
export interface SearchHit {
  msg: Message;
  convName: string;
  senderName: string;
  highlight?: Array<{ start: number; end: number }>;
}

/** 搜索过滤器（AND 组合；零值/缺省=不限，D03 §3.7 过滤器矩阵） */
export interface SearchFilters {
  keyword: string;
  fromUid?: string;
  convId?: string;
  type?: string;
  fromTs?: number;
  toTs?: number;
  cursor?: string;
  limit?: number;
}

/** 收藏（API-IM-10 POST：幂等 UK；上限 1000→3022；撤回消息可收藏） */
export async function favoriteMessage(msgId: string): Promise<{ favoriteId: string; createdAt: number; duplicate?: boolean }> {
  if (USE_MOCK) {
    await delay(200);
    return { favoriteId: `mock-fav-${Date.now()}`, createdAt: Date.now() };
  }
  return http.post<{ favoriteId: string; createdAt: number; duplicate?: boolean }>(
    `/messages/${encodeURIComponent(msgId)}/favorite`,
    {},
  );
}

/** 取消收藏（API-IM-10 DELETE：幂等 no-op） */
export async function unfavoriteMessage(msgId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/messages/${encodeURIComponent(msgId)}/favorite`);
}

/** 收藏列表（API-IM-11：created_at 倒序 + type 过滤 + cursor 翻页） */
export async function fetchFavorites(params: { type?: string; cursor?: string; limit?: number } = {}): Promise<Paged<FavoriteItem>> {
  if (USE_MOCK) {
    await delay(300);
    return { items: [], hasMore: false };
  }
  const qs = new URLSearchParams();
  if (params.type) qs.set('type', params.type);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const data = await http.get<{ items: FavoriteItem[]; nextCursor?: string; hasMore: boolean }>(`/favorites${suffix}`);
  return { items: data.items, nextCursor: data.nextCursor, hasMore: data.hasMore };
}

/** 服务端态搜索（API-IM-12：keyword 必填非空白 ≤64 字；仅本人可见会话）。
 * 本地 FTS5 态（Tauri/Rust 侧）不在本封装——两态编排见 D03 §3.7/INT-IM-21 */
export async function searchMessages(f: SearchFilters): Promise<Paged<SearchHit>> {
  if (USE_MOCK) {
    await delay(300);
    return { items: [], hasMore: false };
  }
  const qs = new URLSearchParams({ keyword: f.keyword });
  if (f.fromUid) qs.set('from_uid', f.fromUid);
  if (f.convId) qs.set('conv_id', f.convId);
  if (f.type) qs.set('type', f.type);
  if (f.fromTs) qs.set('from_ts', String(f.fromTs));
  if (f.toTs) qs.set('to_ts', String(f.toTs));
  if (f.cursor) qs.set('cursor', f.cursor);
  if (f.limit) qs.set('limit', String(f.limit));
  const data = await http.get<{ items: SearchHit[]; nextCursor?: string; hasMore: boolean }>(
    `/messages/search?${qs.toString()}`,
  );
  return { items: data.items, nextCursor: data.nextCursor, hasMore: data.hasMore };
}

// ---- 通知中心（D03 §3.9 PIM-09；API-IM-14 列表/已读/未读数；WS notification.new 触发失效）----

/** 通知列表参数（kind=分组 tab；unreadOnly=仅未读；cursor 翻页） */
export interface NotificationListParams {
  kind?: NotificationKind | 'all';
  unreadOnly?: boolean;
  cursor?: string;
  limit?: number;
}

/** 通知列表（GET /notifications：id 倒序 + cursor 翻页） */
export async function fetchNotifications(params: NotificationListParams = {}): Promise<Paged<NotificationItem>> {
  if (USE_MOCK) {
    await delay(300);
    return { items: [], hasMore: false };
  }
  const qs = new URLSearchParams();
  if (params.kind && params.kind !== 'all') qs.set('kind', params.kind);
  if (params.unreadOnly) qs.set('unread_only', '1');
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const data = await http.get<{ items: NotificationItem[]; nextCursor?: string; hasMore: boolean }>(
    `/notifications${suffix}`,
  );
  return { items: data.items, nextCursor: data.nextCursor, hasMore: data.hasMore };
}

/** 已读（POST /notifications/read：ids 单条/多条，或 all 全部；幂等） */
export async function markNotificationsRead(p: { ids?: string[]; all?: boolean }): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/notifications/read`, p);
}

/** 未读数（GET /notifications/unread_count：铃铛红点数据源，端内 99+ 封顶） */
export async function fetchUnreadNotificationCount(): Promise<number> {
  if (USE_MOCK) return 0;
  const data = await http.get<{ count: number }>(`/notifications/unread_count`);
  return data.count;
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
