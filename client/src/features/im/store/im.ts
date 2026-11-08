/**
 * IM feature store（模块 UI 态，D01 §12.2-5）：
 * - 会话列表/消息流的端内投影（服务端态主缓存仍在 Query，成功后写入此处）
 * - 发送乐观更新：先上屏 sending（临时负序置底），ack 后置 sent，失败置 failed（D01 §7.7 / D03 S1）
 * - 草稿 / 选中会话 / 我的 uid（app 层注入，避免 feature 横向依赖 auth）
 */

import { create } from 'zustand';
import { emit } from '../../../shared/bus';
import { wsClient } from '../../../shared/api/ws';
import { sendTextMessage, updateConvState as apiUpdateConvState } from '../api/im';
import { systemMessageText } from '../pages/systemMessageRegistry';
// 本地持久化（写穿/outbox）——与 ../api/local 互引为运行时环（函数体引用，模块初始化无环序依赖）
import { outboxBumpRetry, outboxEnqueue, outboxSettle, persistMessage, persistReadSeq, persistUpdatedLocal } from '../api/local';
import type { Conversation, ConvUpdatedPushPayload, Mention, Message, MessageBody, MsgExt, SystemBody } from '../model/types';
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
  /** 上翻加载更早：prepend（INT-IM-13；去重按 seq） */
  prependMessages: (convId: string, items: Message[]) => void;

  /** 对方已读游标：convId → peer read_seq（msg.receipt 推送维护，✓✓ 渲染依据） */
  peerReadSeq: Record<string, number>;
  /** msg.receipt 推送入 store（只进不退） */
  applyReceipt: (convId: string, userId: string, readSeq: number) => void;
  /** 已读上报（INT-IM-12：进会话/当前会话新消息两时机，1s 节流 trailing；服务端只进不退，失败静默） */
  markRead: (convId: string, upToSeq: number) => void;
  /** 清零本地未读徽标（进会话/已读上报后；服务端真值由 convs 刷新对齐） */
  clearUnread: (convId: string) => void;

  /** 草稿（切换会话即存，INT-IM-10；500ms 防抖 PATCH state 多端同步） */
  drafts: Record<string, string>;
  setDraft: (convId: string, text: string) => void;

  /** msg.new 推送入流 */
  appendIncoming: (msg: Message) => void;

  /** msg.recall 推送：原地转撤回占位（seq 不断裂，INT-IM-03） */
  applyRecall: (convId: string, msgId: string, operatorId: string) => void;
  /** msg.updated 推送：编辑原地更新（INT-IM-02；body 泛化——call_card 终态回写同通道，D04） */
  applyUpdated: (convId: string, msgId: string, body: MessageBody, editedAt: number, editVersion: number) => void;
  /** msg.reaction.new 推送：全量快照幂等合并（INT-IM-23） */
  applyReactions: (convId: string, msgId: string, reactions: Record<string, string[]>) => void;

  /** 正在输入：convId → uid（TTL 5s 由 applyTyping 的时间戳判定，INT-IM-11） */
  typing: Record<string, { uid: string; at: number } | undefined>;
  applyTyping: (convId: string, uid: string) => void;

  /** 在线状态：uid → status（presence.changed 维护，D03 §5.3；offline 含 invisible 投影） */
  presence: Record<string, string | undefined>;
  applyPresence: (uid: string, status: string) => void;

  /** conv.updated 推送入 store（D03 §5.3：kind=meta/member/setting/status/announcement 分发） */
  applyConvUpdated: (payload: ConvUpdatedPushPayload) => void;

  /** 审批卡终态：applyId → 'approved' | 'rejected'（PIM-06 卡内按钮结果回显） */
  handledApplies: Record<string, 'approved' | 'rejected'>;
  markApplyHandled: (applyId: string, result: 'approved' | 'rejected') => void;

  /** 会话详情合并（PIM-05 打开侧栏时拉取；含 group_setting/myRole/myMuteUntil） */
  mergeConvDetail: (convId: string, patch: Partial<Conversation>) => void;

  /** 会话态（置顶/免打扰）：乐观更新 + PATCH（INT-IM-07） */
  togglePin: (convId: string) => void;
  toggleMute: (convId: string) => void;

  /** 发送文本（乐观更新；replyToSeq 携带引用；mentions 含 @全体） */
  sendText: (convId: string, text: string, replyToSeq?: number, mentions?: Mention[]) => Promise<void>;
  /** 失败重试：复用原 client_msg_id（幂等回原 seq，INT-IM-01a） */
  retrySend: (convId: string, clientMsgId: string) => Promise<void>;
  /** 本地恢复：outbox 行重建端内 sending 消息（hydrateLocal 用） */
  enqueueOutbox: (clientMsgId: string, convId: string, text: string) => void;
  /** 本地恢复后的重放（重连/启动 resendOutbox 用） */
  replayOutbox: (clientMsgId: string, convId: string, text: string) => Promise<void>;

  /** 收藏标记（msgId → true，PIM-08）：气泡/收藏页操作即时回显；
   * 收藏列表主缓存在 Query（['im','favorites']），此处仅端内标记投影 */
  favoriteIds: Record<string, boolean>;
  applyFavorite: (msgId: string, on: boolean) => void;

  /** 跨页待定位（PIM-07/PIM-08 点击跳转）：ChatPage 消费后滚动锚点 + 闪烁 2s */
  pendingLocate: { convId: string; seq: number } | null;
  setPendingLocate: (target: { convId: string; seq: number } | null) => void;

  /** 多选模式（INT-IM-14/PIM-10）：isActive + 选中 msgId 集。
   * 选择集独立于消息流渲染窗口（滚动/上翻加载不丢选择）；切换会话由 ChatPage 主动退出 */
  multiSelect: { isActive: boolean; selectedIds: Set<string> };
  /** 进入多选（右键/悬浮菜单「多选」）；initialMsgId=触发消息直接预选（飞书同款） */
  enterMultiSelect: (initialMsgId?: string) => void;
  /** 退出多选并清空选择（Esc/点空白/取消按钮） */
  exitMultiSelect: () => void;
  /** 勾选/取消单条（幂等切换） */
  toggleMultiSelectItem: (msgId: string) => void;
}

// ---- msg.read 上报节流（1s trailing，D03 INT-IM-12）----
const READ_THROTTLE_MS = 1000;
const readLastSent = new Map<string, number>(); // convId → 上次发送时刻
const readLatestSeq = new Map<string, number>(); // convId → 待上报的最新 seq
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---- 草稿多端同步防抖（INT-IM-10：500ms 静默后 PATCH state；空串=清除）----
const DRAFT_SYNC_DEBOUNCE_MS = 500;
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 停止 typing 展示的过期阈值（TTL 5s，D03 INT-IM-11） */
export const TYPING_TTL_MS = 5000;

function flushRead(convId: string): void {
  const seq = readLatestSeq.get(convId);
  if (seq === undefined) return;
  readLastSent.set(convId, Date.now());
  readLatestSeq.delete(convId);
  // fire-and-forget：服务端只进不退 + 重连补投，失败无需重试
  void wsClient.request('msg.read', { conv_id: convId, read_seq: seq }).catch(() => undefined);
}

/** sending 消息临时序：-1 起递减，不与服务端 seq 冲突（真实置底由 sortMessages 的未决规则保证） */
let localSeq = 0;
function nextLocalSeq(): number {
  localSeq -= 1;
  return localSeq;
}

/** 会话内消息排序（D03 INT-IM-01"临时负序置底"）：
 * - 已确认消息按 seq 升序（上旧下新；负临时序在纯升序下会排到最顶，须压底）
 * - 本端未决（sending/failed）恒在已确认之后（置底）；未决之间后发的更靠下（临时序越负越新） */
function sortMessages(list: Message[]): Message[] {
  return [...list].sort((a, b) => {
    const aPending = a.localState && a.localState !== 'sent' ? 1 : 0;
    const bPending = b.localState && b.localState !== 'sent' ? 1 : 0;
    if (aPending !== bPending) return aPending - bPending;
    if (aPending === 1) return b.seq - a.seq;
    return a.seq - b.seq;
  });
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
    const s = get();
    // 列表接口不含群设置（API-IM-02 无该字段）——保留端内已合并的
    // groupSetting/myRole/myMuteUntil（详情/conv.updated 推送写入），防刷新丢失
    const merged = convs.map((c) => {
      const prev = s.convs.find((p) => p.id === c.id);
      if (!prev) return c;
      return {
        ...c,
        groupSetting: c.groupSetting ?? prev.groupSetting,
        myRole: c.myRole ?? prev.myRole,
        myMuteUntil: c.myMuteUntil ?? prev.myMuteUntil,
      };
    });
    set({ convs: merged });
    broadcastUnread(merged);
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

  prependMessages: (convId, items) =>
    set((s) => {
      const cur = s.messagesByConv[convId] ?? [];
      const known = new Set(cur.map((m) => m.seq));
      const fresh = items.filter((m) => !known.has(m.seq));
      if (fresh.length === 0) return s;
      return { messagesByConv: { ...s.messagesByConv, [convId]: sortMessages([...cur, ...fresh]) } };
    }),

  drafts: {},
  setDraft: (convId, text) => {
    set((s) => ({ drafts: { ...s.drafts, [convId]: text } }));
    clearTimeout(draftTimers.get(convId));
    draftTimers.set(
      convId,
      setTimeout(() => {
        draftTimers.delete(convId);
        void apiUpdateConvState(convId, { draft: useImStore.getState().drafts[convId] ?? '' }).catch(() => undefined);
      }, DRAFT_SYNC_DEBOUNCE_MS),
    );
  },

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
      void persistReadSeq(convId, readLatestSeq.get(convId) ?? upToSeq);
      get().clearUnread(convId);
      return;
    }
    // trailing：窗口末补发窗口内最新游标
    if (!readTimers.has(convId)) {
      readTimers.set(
        convId,
        setTimeout(() => {
          readTimers.delete(convId);
          flushRead(convId);
          void persistReadSeq(convId, readLatestSeq.get(convId) ?? 0);
          useImStore.getState().clearUnread(convId);
        }, READ_THROTTLE_MS - since),
      );
    }
  },

  clearUnread: (convId) =>
    set((s) => {
      const conv = s.convs.find((c) => c.id === convId);
      if (!conv?.my || (conv.my.unreadBadge === 0 && !conv.my.mentionUnread)) return s;
      const convs = s.convs.map((c) =>
        c.id === convId && c.my ? { ...c, my: { ...c.my, unreadBadge: 0, mentionUnread: false, readSeq: c.latestSeq } } : c,
      );
      broadcastUnread(convs);
      return { convs };
    }),

  appendIncoming: (msg) => {
    // 写穿本地库（服务端态消息；幂等 put）
    void persistMessage(msg);
    set((s) => {
      const list = s.messagesByConv[msg.convId] ?? [];
      // 幂等：重连补投与实时推送可能重复（client_msg_id 去重）。
      // 注意竞态：msg.new 可能先于 ack 到达（同毫秒推送），本地副本仍 sending——
      // 仍须去重，且用推送的真值就地"提前 ack"（回填 seq/msgId/ts），settle 的 ack 再写一次幂等。
      const hitIdx = list.findIndex((m) => m.clientMsgId === msg.clientMsgId);
      if (hitIdx >= 0) {
        const next = [...list];
        // 本端发送副本命中推送：ext 以服务端真值覆盖（引用快照/回应权威源；本地预填兜底）
        next[hitIdx] = {
          ...next[hitIdx],
          localState: 'sent',
          seq: msg.seq,
          msgId: msg.msgId,
          ts: msg.ts,
          ext: msg.ext ?? next[hitIdx].ext,
        };
        // 服务端真值到达即自愈：清 outbox 行 + 落本地库（settle 的 ack 写幂等兜底）；
        // 回填真 seq 后重排归位（乐观副本可能仍在顶部/中部，负序占位槽位可能偏移）
        void outboxSettle(msg.clientMsgId, true, next[hitIdx]);
        return { messagesByConv: { ...s.messagesByConv, [msg.convId]: sortMessages(next) } };
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
    });
  },

  applyRecall: (convId, msgId, operatorId) => {

    set((s) => {
      const list = s.messagesByConv[convId];
      if (!list) return s;
      let hit = false;
      const next = list.map((m) => {
        if (m.msgId !== msgId || m.status === 2) return m;
        hit = true;
        // 占位转 system 形态渲染（seq 保留不断裂）；文案区分本人/他人（INT-IM-03）
        return {
          ...m,
          status: 2 as const,
          type: 'system' as const,
          body: { text: operatorId === s.myUid ? '你撤回了一条消息' : '对方撤回了一条消息' },
          ext: undefined,
        };
      });
      if (!hit) return s;
      return { messagesByConv: { ...s.messagesByConv, [convId]: next } };
    });
      void persistUpdatedLocal(convId, msgId);
    },


  applyUpdated: (convId, msgId, body, editedAt, editVersion) => {

    set((s) => {
      const list = s.messagesByConv[convId];
      if (!list) return s;
      const next = list.map((m) =>
        m.msgId === msgId ? { ...m, body, status: 3 as const, editedAt, editVersion } : m,
      );
      return { messagesByConv: { ...s.messagesByConv, [convId]: next } };
    });
      void persistUpdatedLocal(convId, msgId);
    },


  applyReactions: (convId, msgId, reactions) => {

    set((s) => {
      const list = s.messagesByConv[convId];
      if (!list) return s;
      const next = list.map((m) => {
        if (m.msgId !== msgId) return m;
        const ext: MsgExt = { ...m.ext, reactions };
        return { ...m, ext };
      });
      return { messagesByConv: { ...s.messagesByConv, [convId]: next } };
    });
      void persistUpdatedLocal(convId, msgId);
    },


  typing: {},
  applyTyping: (convId, uid) => set((s) => ({ typing: { ...s.typing, [convId]: { uid, at: Date.now() } } })),

  presence: {},
  applyPresence: (uid, status) =>
    set((s) => {
      // 离线清理 typing 态（对方断线即失效，防悬挂动画）
      const typing = Object.fromEntries(
        Object.entries(s.typing).filter(([, v]) => v?.uid !== uid),
      );
      return { presence: { ...s.presence, [uid]: status }, typing };
    }),

  applyConvUpdated: (payload) =>
    set((s) => {
      const snap = payload.conv;
      let touched = false;
      const convs = s.convs.map((c) => {
        if (c.id !== payload.conv_id) return c;
        touched = true;
        let next: Conversation = { ...c };
        // 快照字段合并（各 kind 均携带变更后 conv 快照）
        if (snap) {
          next = {
            ...next,
            name: snap.name,
            type: snap.type,
            ownerId: snap.ownerId,
            memberCount: snap.memberCount,
            status: snap.status,
            latestSeq: Math.max(next.latestSeq, snap.latestSeq),
            groupSetting: snap.groupSetting ?? next.groupSetting,
          };
        }
        // kind=member：members_delta 合并——我的角色/禁言随 delta 更新；离群成员数已由快照纠正
        if (payload.members_delta && s.myUid) {
          for (const d of payload.members_delta) {
            if (d.uid === s.myUid) {
              next = { ...next, myRole: d.role, myMuteUntil: d.mute_until > 0 ? d.mute_until : undefined };
            }
          }
        }
        // kind=setting：全员禁言即时反馈（输入框禁用条依据）
        if (payload.kind === 'setting' && snap?.groupSetting) {
          next = { ...next, groupSetting: snap.groupSetting };
        }
        // kind=status：解散置灰只读（D03 INT-IM-19）
        if (payload.kind === 'status' && snap) {
          next = { ...next, status: snap.status };
        }
        return next;
      });
      if (!touched) return s;
      return { convs };
    }),

  handledApplies: {},
  markApplyHandled: (applyId, result) =>
    set((s) => ({ handledApplies: { ...s.handledApplies, [applyId]: result } })),

  mergeConvDetail: (convId, patch) =>
    set((s) => ({
      convs: s.convs.map((c) => (c.id === convId ? { ...c, ...patch } : c)),
    })),

  togglePin: (convId) => {
    const cur = get().convs.find((c) => c.id === convId);
    const next = !cur?.my?.pinned;
    set((s) => ({
      convs: s.convs.map((c) => (c.id === convId ? { ...c, my: { ...c.my!, pinned: next } } : c)),
    }));
    void apiUpdateConvState(convId, { pinned: next }).catch(() => undefined);
  },

  toggleMute: (convId) => {
    const cur = get().convs.find((c) => c.id === convId);
    const next = !cur?.my?.mute;
    set((s) => ({
      convs: s.convs.map((c) => (c.id === convId ? { ...c, my: { ...c.my!, mute: next } } : c)),
    }));
    void apiUpdateConvState(convId, { mute: next }).catch(() => undefined);
  },

  sendText: async (convId, text, replyToSeq, mentions) => {
    const { myUid } = get();
    const clientMsgId = crypto.randomUUID(); // 发送幂等键（14 篇 §4.1）
    // 引用快照预填（INT-IM-04）：本端乐观消息即带 reply_digest，引用条即时渲染；
    // 服务端 msg.new/历史真值随后覆盖（appendIncoming 去重分支合并 ext）
    const replyTarget = replyToSeq
      ? (get().messagesByConv[convId] ?? []).find((m) => m.seq === replyToSeq)
      : undefined;
    const ext = replyTarget
      ? {
          reply_digest: {
            sender_id: replyTarget.senderId,
            sender_name: replyTarget.senderName,
            type: replyTarget.type,
            digest: digestOf(replyTarget).slice(0, 60), // 摘要 60 字截断（D03 §3.2）
            seq: replyTarget.seq,
          },
        }
      : undefined;
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
      replyToSeq,
      mentions,
      ext,
      status: 1,
      ts: Date.now(),
      localState: 'sending',
    };
    set((s) => ({
      messagesByConv: { ...s.messagesByConv, [convId]: sortMessages([...(s.messagesByConv[convId] ?? []), optimistic]) },
      convs: touchConv(s.convs, convId, `我: ${text}`, optimistic.ts),
    }));
    // outbox 入队（弱网重发源，跨刷新存活，D03 §1.2）
    void outboxEnqueue(clientMsgId, convId, text);
    await settle(set, get, convId, clientMsgId, replyToSeq, mentions);
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

  /** 本地恢复：把 outbox 行重建为端内 sending 消息（hydrateLocal 用；已存在则跳过） */
  enqueueOutbox: (clientMsgId, convId, text) => {
    const { myUid, messagesByConv } = get();
    if ((messagesByConv[convId] ?? []).some((m) => m.clientMsgId === clientMsgId)) return;
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
    }));
  },

  /** 本地恢复后的重放（重连/启动 resendOutbox 用）：复用幂等键走 settle */
  replayOutbox: async (clientMsgId, convId, text) => {
    const { myUid, messagesByConv } = get();
    if (!(messagesByConv[convId] ?? []).some((m) => m.clientMsgId === clientMsgId)) {
      get().enqueueOutbox(clientMsgId, convId, text);
    }
    void myUid;
    await settle(set, get, convId, clientMsgId);
  },

  favoriteIds: {},
  applyFavorite: (msgId, on) =>
    set((s) => ({ favoriteIds: { ...s.favoriteIds, [msgId]: on } })),

  pendingLocate: null,
  setPendingLocate: (target) => set({ pendingLocate: target }),

  multiSelect: { isActive: false, selectedIds: new Set<string>() },
  enterMultiSelect: (initialMsgId) =>
    set({
      multiSelect: {
        isActive: true,
        selectedIds: initialMsgId ? new Set([initialMsgId]) : new Set<string>(),
      },
    }),
  exitMultiSelect: () => set({ multiSelect: { isActive: false, selectedIds: new Set<string>() } }),
  toggleMultiSelectItem: (msgId) =>
    set((s) => {
      if (!s.multiSelect.isActive) return s;
      const next = new Set(s.multiSelect.selectedIds);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return { multiSelect: { isActive: true, selectedIds: next } };
    }),
}));

/** 统一收尾：ack → sent（回填 seq/msgId/ts）；异常 → 自动重试≤3 后 failed（红叹号+重试入口） */
async function settle(
  set: (partial: Partial<ImState> | ((s: ImState) => Partial<ImState>)) => void,
  get: () => ImState,
  convId: string,
  clientMsgId: string,
  replyToSeq?: number,
  mentions?: Mention[],
  attempt = 0,
): Promise<void> {
  const pending = (get().messagesByConv[convId] ?? []).find((m) => m.clientMsgId === clientMsgId);
  const text = pending && 'text' in pending.body ? pending.body.text : '';
  try {
    const ack = await sendTextMessage(convId, clientMsgId, text, replyToSeq, mentions);
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        // 回填真 seq 后重排归位（乐观期按未决置底，此处转入 seq 序；D03 INT-IM-01 置底不变量）
        [convId]: sortMessages(
          (s.messagesByConv[convId] ?? []).map((m) =>
            m.clientMsgId === clientMsgId ? { ...m, localState: 'sent' as const, seq: ack.seq, msgId: ack.msgId, ts: ack.ts } : m,
          ),
        ),
      },
    }));
    // outbox 出队 + 服务端态消息落库（pending 必在：乐观上屏先行）
    if (pending) {
      const sent: Message = { ...pending, localState: 'sent', seq: ack.seq, msgId: ack.msgId, ts: ack.ts };
      void outboxSettle(clientMsgId, true, sent);
    } else {
      void outboxSettle(clientMsgId, true);
    }
  } catch {
    // 自动重试 3 次指数退避（14 §2.2）；重试期间保持 sending 灰钟
    const retries = await outboxBumpRetry(clientMsgId).catch(() => attempt + 1);
    if (retries <= 3) {
      const backoff = Math.min(1000 * 2 ** (retries - 1), 8000);
      setTimeout(() => void settle(set, get, convId, clientMsgId, replyToSeq, mentions, retries), backoff);
      return;
    }
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId]: sortMessages(
          (s.messagesByConv[convId] ?? []).map((m) =>
            m.clientMsgId === clientMsgId ? { ...m, localState: 'failed' as const } : m,
          ),
        ),
      },
    }));
    void outboxSettle(clientMsgId, false);
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
      // PIM-12：系统消息摘要直接取模板文案（如"张三 邀请 李四 加入群聊"）
      return 'kind' in msg.body && msg.body.kind ? systemMessageText(msg.body as SystemBody) : '群通知';
  }
}
