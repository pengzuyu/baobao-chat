/**
 * IM feature store（模块 UI 态，D01 §12.2-5）：
 * - 会话列表/消息流的端内投影（服务端态主缓存仍在 Query，成功后写入此处）
 * - 发送乐观更新：先上屏 sending（临时负序置底），ack 后置 sent，失败置 failed（D01 §7.7 / D03 S1）
 * - 草稿 / 选中会话 / 我的 uid（app 层注入，避免 feature 横向依赖 auth）
 */

import { create } from 'zustand';
import { emit } from '../../../shared/bus';
import { wsClient } from '../../../shared/api/ws';
import { sendTextMessage } from '../api/im';
import type { Conversation, Message } from '../model/types';
import '../events'; // 装载 bus 事件类型声明（im:unread-changed 等）

interface ImState {
  /** 当前用户 uid（app 层由 auth store 注入） */
  myUid: string;
  setMyUid: (uid: string) => void;

  convs: Conversation[];
  setConvs: (convs: Conversation[]) => void;

  activeConvId: string | null;
  setActiveConv: (convId: string | null) => void;

  /** 消息流端内投影：convId → 升序消息（含本端 sending/failed） */
  messagesByConv: Record<string, Message[] | undefined>;
  /** Query 拉取成功后整体写入（替换式，保留本端未决消息） */
  replaceMessages: (convId: string, items: Message[]) => void;

  /** 对方已读游标：convId → peer read_seq（msg.receipt 推送维护，✓✓ 渲染依据） */
  peerReadSeq: Record<string, number>;
  /** msg.receipt 推送入 store（只进不退） */
  applyReceipt: (convId: string, userId: string, readSeq: number) => void;
  /** 已读上报（INT-IM-12：进会话/当前会话新消息两时机，1s 节流 trailing；服务端只进不退，失败静默） */
  markRead: (convId: string, upToSeq: number) => void;

  /** 草稿（切换会话即存，INT-IM-10；正式版落 Rust SQLite 经 PATCH state 多端同步） */
  drafts: Record<string, string>;
  setDraft: (convId: string, text: string) => void;

  /** msg.new 推送入流 */
  appendIncoming: (msg: Message) => void;

  /** 发送文本（乐观更新） */
  sendText: (convId: string, text: string) => Promise<void>;
  /** 失败重试：复用原 client_msg_id（幂等回原 seq，INT-IM-01a） */
  retrySend: (convId: string, clientMsgId: string) => Promise<void>;
}

// ---- msg.read 上报节流（1s trailing，D03 INT-IM-12）----
const READ_THROTTLE_MS = 1000;
const readLastSent = new Map<string, number>(); // convId → 上次发送时刻
const readLatestSeq = new Map<string, number>(); // convId → 待上报的最新 seq
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushRead(convId: string): void {
  const seq = readLatestSeq.get(convId);
  if (seq === undefined) return;
  readLastSent.set(convId, Date.now());
  readLatestSeq.delete(convId);
  // fire-and-forget：服务端只进不退 + 重连补投，失败无需重试
  void wsClient.request('msg.read', { conv_id: convId, read_seq: seq }).catch(() => undefined);
}

/** sending 消息临时序：-1 起递减，保证置底且不与服务端 seq 冲突 */
let localSeq = 0;
function nextLocalSeq(): number {
  localSeq -= 1;
  return localSeq;
}

/** 会话内消息排序：seq 升序（负序的本端消息天然置底） */
function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => a.seq - b.seq);
}

/** 更新会话的 lastMsg 摘要（列表即时反馈） */
function touchConv(convs: Conversation[], convId: string, digest: string, ts: number): Conversation[] {
  return convs.map((c) => (c.id === convId ? { ...c, lastMsgDigest: digest, lastMsgTs: ts } : c));
}

/** 按未读总数广播给 app 壳（导航徽标 + 托盘角标同源，D03 §8） */
function broadcastUnread(convs: Conversation[]): void {
  const total = convs.reduce((sum, c) => sum + (c.my?.unreadBadge ?? 0), 0);
  const mention = convs.reduce((sum, c) => sum + (c.my?.mentionUnread ? 1 : 0), 0);
  emit('im:unread-changed', { total, mention });
}

export const useImStore = create<ImState>((set, get) => ({
  myUid: '',
  setMyUid: (uid) => set({ myUid: uid }),

  convs: [],
  setConvs: (convs) => {
    set({ convs });
    broadcastUnread(convs);
  },

  activeConvId: null,
  setActiveConv: (convId) => set({ activeConvId: convId }),

  messagesByConv: {},
  replaceMessages: (convId, items) =>
    set((s) => {
      // 保留本端未决消息（sending/failed）与服务端数据合并
      const localPending = (s.messagesByConv[convId] ?? []).filter((m) => m.localState && m.localState !== 'sent');
      return { messagesByConv: { ...s.messagesByConv, [convId]: sortMessages([...items, ...localPending]) } };
    }),

  drafts: {},
  setDraft: (convId, text) => set((s) => ({ drafts: { ...s.drafts, [convId]: text } })),

  peerReadSeq: {},
  applyReceipt: (convId, _userId, readSeq) =>
    set((s) => {
      const cur = s.peerReadSeq[convId] ?? 0;
      // 只进不退：回执游标与已读上报同一不变量（04 篇 §4.2）
      if (readSeq <= cur) return s;
      return { peerReadSeq: { ...s.peerReadSeq, [convId]: readSeq } };
    }),

  markRead: (convId, upToSeq) => {
    // 仅激活会话上报（可见性判定；窗口聚焦时机由 app 层后续接入）
    if (get().activeConvId !== convId) return;
    readLatestSeq.set(convId, Math.max(readLatestSeq.get(convId) ?? 0, upToSeq));
    const last = readLastSent.get(convId) ?? 0;
    const since = Date.now() - last;
    if (since >= READ_THROTTLE_MS) {
      flushRead(convId);
      return;
    }
    // trailing：窗口末补发窗口内最新游标
    if (!readTimers.has(convId)) {
      readTimers.set(
        convId,
        setTimeout(() => {
          readTimers.delete(convId);
          flushRead(convId);
        }, READ_THROTTLE_MS - since),
      );
    }
  },

  appendIncoming: (msg) =>
    set((s) => {
      const list = s.messagesByConv[msg.convId] ?? [];
      // 幂等：重连补投与实时推送可能重复（client_msg_id 去重）。
      // 注意竞态：msg.new 可能先于 ack 到达（同毫秒推送），本地副本仍 sending——
      // 仍须去重，且用推送的真值就地"提前 ack"（回填 seq/msgId/ts），settle 的 ack 再写一次幂等。
      const hitIdx = list.findIndex((m) => m.clientMsgId === msg.clientMsgId);
      if (hitIdx >= 0) {
        const next = [...list];
        next[hitIdx] = { ...next[hitIdx], localState: 'sent', seq: msg.seq, msgId: msg.msgId, ts: msg.ts };
        return { messagesByConv: { ...s.messagesByConv, [msg.convId]: next } };
      }
      const convs = s.convs.map((c) => {
        if (c.id !== msg.convId) return c;
        // 非当前会话新消息 → 未读 +1（当前会话应触发 msg.read 上报，TODO INT-IM-12）
        const inActive = c.id === s.activeConvId;
        return {
          ...c,
          latestSeq: Math.max(c.latestSeq, msg.seq),
          lastMsgDigest: msg.senderId === s.myUid ? `我: ${digestOf(msg)}` : digestOf(msg),
          lastMsgTs: msg.ts,
          my: c.my ? { ...c.my, unreadBadge: inActive ? c.my.unreadBadge : c.my.unreadBadge + 1 } : c.my,
        };
      });
      broadcastUnread(convs);
      return { convs, messagesByConv: { ...s.messagesByConv, [msg.convId]: sortMessages([...list, msg]) } };
    }),

  sendText: async (convId, text) => {
    const { myUid } = get();
    const clientMsgId = crypto.randomUUID(); // 发送幂等键（14 篇 §4.1）
    // 乐观更新：先上屏 sending（灰钟），临时负序置底
    const optimistic: Message = {
      msgId: '',
      convId,
      seq: nextLocalSeq(),
      clientMsgId,
      senderId: myUid,
      senderName: '我',
      type: 'text',
      body: { text },
      status: 1,
      ts: Date.now(),
      localState: 'sending',
    };
    set((s) => ({
      messagesByConv: { ...s.messagesByConv, [convId]: sortMessages([...(s.messagesByConv[convId] ?? []), optimistic]) },
      convs: touchConv(s.convs, convId, `我: ${text}`, optimistic.ts),
    }));
    await settle(set, get, convId, clientMsgId);
  },

  retrySend: async (convId, clientMsgId) => {
    // failed → sending，复用原 client_msg_id 重发（服务端幂等返回原 seq）
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId]: (s.messagesByConv[convId] ?? []).map((m) =>
          m.clientMsgId === clientMsgId && m.localState === 'failed' ? { ...m, localState: 'sending' as const } : m,
        ),
      },
    }));
    await settle(set, get, convId, clientMsgId);
  },
}));

/** 统一收尾：ack → sent（回填 seq/msgId/ts）；异常 → failed（红叹号+重试入口） */
async function settle(
  set: (partial: Partial<ImState> | ((s: ImState) => Partial<ImState>)) => void,
  get: () => ImState,
  convId: string,
  clientMsgId: string,
): Promise<void> {
  const pending = (get().messagesByConv[convId] ?? []).find((m) => m.clientMsgId === clientMsgId);
  const text = pending && 'text' in pending.body ? pending.body.text : '';
  try {
    const ack = await sendTextMessage(convId, clientMsgId, text);
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId]: (s.messagesByConv[convId] ?? []).map((m) =>
          m.clientMsgId === clientMsgId ? { ...m, localState: 'sent' as const, seq: ack.seq, msgId: ack.msgId, ts: ack.ts } : m,
        ),
      },
    }));
  } catch {
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId]: (s.messagesByConv[convId] ?? []).map((m) =>
          m.clientMsgId === clientMsgId ? { ...m, localState: 'failed' as const } : m,
        ),
      },
    }));
  }
}

/** 类型化摘要（D03 §3.1：[图片][文件][语音]…；system 取文案） */
export function digestOf(msg: Message): string {
  switch (msg.type) {
    case 'text':
      return 'text' in msg.body ? msg.body.text : '';
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio_clip':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'doc_card':
      return '[文档]';
    case 'agent_card':
      return '[卡片]';
    case 'merge_forward':
      return '[合并转发]';
    case 'call_card':
      return '[通话]';
    case 'system':
      return '系统消息';
  }
}
