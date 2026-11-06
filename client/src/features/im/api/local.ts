/**
 * IM 本地持久化编排（D03 §6.2 web 形态 + API-IM-01 增量同步）：
 * - 启动：convState + outbox 恢复 → WS 上线后 GET /sync 按游标补投 → gap 全量拉
 * - 写穿：消息事件（new/recall/updated/reaction）与游标变更 fire-and-forget 落 IDB
 * - 离线：outbox 跨刷新存活，重连后按序重发（client_msg_id 幂等）
 */

import { http } from '../../../shared/api/http';
import {
  localGetAllConvStates,
  localGetConvState,
  localGetMessages,
  localMetaSet,
  localOutboxAdd,
  localOutboxAll,
  localOutboxRemove,
  localOutboxUpdate,
  localPutConvState,
  localPutMessage,
  type StoredMessage,
} from '../../../shared/api/localdb';
import type { Message } from '../model/types';
import { fetchMessages } from './im';
import { useImStore } from '../store/im';

/** 同步去重：同一时刻只跑一轮 */
let syncing = false;
/** 启动恢复是否已执行（登录态会话内一次） */
let hydrated = false;

// ---- 写穿（fire-and-forget，IDB 不可用自动 no-op）----

export function persistMessage(msg: Message): void {
  if (msg.seq <= 0) return; // sending 本地负序不入 messages 表（outbox 承担）
  const row: StoredMessage = { convId: msg.convId, seq: msg.seq, payload: msg };
  void localPutMessage(row);
  void bumpSyncedSeq(msg.convId, msg.seq);
}

export async function bumpSyncedSeq(convId: string, seq: number): Promise<void> {
  const cur = (await localGetConvState(convId)) ?? newConvState(convId);
  if (seq > cur.syncedSeq) {
    await localPutConvState({ ...cur, syncedSeq: seq, updatedAt: Date.now() });
  }
}

function newConvState(convId: string) {
  return { convId, readSeq: 0, syncedSeq: 0, draft: '', pinned: false, mute: false, updatedAt: Date.now() };
}

export async function persistReadSeq(convId: string, readSeq: number): Promise<void> {
  const cur = (await localGetConvState(convId)) ?? newConvState(convId);
  if (readSeq > cur.readSeq) {
    await localPutConvState({ ...cur, readSeq, updatedAt: Date.now() });
  }
}

/** 撤回/编辑/回应后的原地覆盖：按 msgId 取端内最新态落库（调用时机=set 之后） */
export function persistUpdatedLocal(convId: string, msgId: string): void {
  const list = useImStore.getState().messagesByConv[convId] ?? [];
  const hit = list.find((m) => m.msgId === msgId && m.seq > 0);
  if (hit) persistMessage(hit);
}

// ---- 启动恢复 ----

/**
 * 登录后调用（ChatPage 首挂）：恢复 outbox 待发与本地缓存消息投影。
 * 幂等：会话生命周期内只跑一次；返回恢复的待重发条数。
 */
export async function hydrateLocal(): Promise<number> {
  if (hydrated) return 0;
  hydrated = true;

  // ① outbox：failed/sending 全部置回 sending 并入端内流（settle 由重发循环处理）
  const rows = await localOutboxAll();
  const store = useImStore.getState();
  for (const row of rows) {
    if (row.state === 'failed') await localOutboxUpdate(row.clientMsgId, { state: 'sending' });
    store.enqueueOutbox(row.clientMsgId, row.convId, row.text);
  }

  // ② 缓存游标登记（sync 用；消息体按会话打开时 hydrateConv 拉取）
  await localMetaSet('hydratedAt', Date.now());
  return rows.length;
}

/** 打开会话时：本地缓存先上屏（零网络），服务端数据到达后 replace 合并 */
export async function hydrateConv(convId: string): Promise<void> {
  const cached = await localGetMessages(convId);
  if (cached.length === 0) return;
  const store = useImStore.getState();
  // 仅当端内尚无该会话数据（首开）时注入缓存，避免覆盖实时流
  if ((store.messagesByConv[convId] ?? []).some((m) => m.seq > 0)) return;
  store.replaceMessages(
    convId,
    cached.map((c) => c.payload as Message),
  );
}

// ---- 增量同步（WS 上线/登录后；D03 API-IM-01）----

interface SyncResp {
  convs: Array<{
    convId: string;
    latestSeq: number;
    unread: number;
    gap?: boolean;
    messages?: Message[];
  }>;
  badges: { totalUnread: number };
  serverTs: number;
}

/** 拉增量并入端内流+落库；gap 会话全量拉最新页兜底 */
export async function runSync(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const states = await localGetAllConvStates();
    const cursors: Record<string, number> = {};
    for (const s of states) cursors[s.convId] = s.syncedSeq;
    // 本地无任何游标（首登）→ 不走 sync（首屏由 convs+messages 拉取承担）
    if (Object.keys(cursors).length === 0) return;
    const data = await http.get<SyncResp>(`/sync?cursors=${encodeURIComponent(JSON.stringify(cursors))}`);
    const store = useImStore.getState();
    for (const item of data.convs) {
      if (item.gap) {
        // 缺口：直接全量拉最新页（补洞翻页由端内上滑承担，D03 §9）
        try {
          const page = await fetchMessages(item.convId);
          store.replaceMessages(item.convId, page.items);
          for (const m of page.items) persistMessage(m);
        } catch {
          /* 离线：保留缓存态，下次 sync 再补 */
        }
        continue;
      }
      for (const m of item.messages ?? []) {
        store.appendIncoming(m);
        persistMessage(m);
      }
    }
  } catch {
    /* 离线/失败：静默，重连后再试 */
  } finally {
    syncing = false;
  }
}

/** WS 重连上线即 sync（订阅 connection store——不复用 ws.onStateChange 以免覆盖全局绑定） */
export function hookSyncOnReconnect(): () => void {
  let wasOffline = false;
  return useConnectionStoreSubscribe((status) => {
    if (status === 'offline') wasOffline = true;
    else if (status === 'online' && wasOffline) {
      wasOffline = false;
      void runSync().then(() => resendOutbox());
    }
  });
}

import { useConnectionStore } from '../../../shared/store/connection';
function useConnectionStoreSubscribe(cb: (status: string) => void): () => void {
  return useConnectionStore.subscribe((s) => cb(s.status));
}

// ---- outbox 重发 ----

/** 重发全部待发条目（sending + failed——failed 为自动重试耗尽态，重连后必须回队；幂等：client_msg_id） */
export async function resendOutbox(): Promise<void> {
  const rows = await localOutboxAll();
  const store = useImStore.getState();
  for (const row of rows) {
    await localOutboxUpdate(row.clientMsgId, { state: 'sending' });
    await store.replayOutbox(row.clientMsgId, row.convId, row.text);
  }
}

/** 发送入队（im store sendText 调用）：落 outbox + 端内乐观上屏由 store 完成 */
export async function outboxEnqueue(clientMsgId: string, convId: string, text: string): Promise<void> {
  await localOutboxAdd({ clientMsgId, convId, text, state: 'sending', retryCount: 0, createdAt: Date.now() });
}

/** 发送终态：成功出队 + 落消息；失败置 failed（跨刷新保留重试入口） */
export async function outboxSettle(clientMsgId: string, ok: boolean, sent?: Message): Promise<void> {
  if (ok) {
    await localOutboxRemove(clientMsgId);
    if (sent) persistMessage(sent);
  } else {
    await localOutboxUpdate(clientMsgId, { state: 'failed' });
  }
}

/** 重放计数（自动重试 3 次上限，14 §2.2） */
export async function outboxBumpRetry(clientMsgId: string): Promise<number> {
  const row = (await localOutboxAll()).find((r) => r.clientMsgId === clientMsgId);
  const next = (row?.retryCount ?? 0) + 1;
  await localOutboxUpdate(clientMsgId, { retryCount: next });
  return next;
}

/** 登出清库钩子（auth 层 logout 成功后调用） */
export async function localLogoutCleanup(): Promise<void> {
  hydrated = false;
  const { localClearAll } = await import('../../../shared/api/localdb');
  await localClearAll();
}

/** 读取缓存消息条数（诊断/E2E 探针） */
export async function cachedMessageCount(convId: string): Promise<number> {
  return (await localGetMessages(convId)).length;
}
