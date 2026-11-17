/**
 * 本地持久层（IndexedDB，零依赖手写；D03 §6.2 的 web 形态落地）：
 * - bbc-local v1：messages（按 conv 分键）/ convState（游标+态）/ outbox（待发队列）/ meta
 * - 正式 Tauri 版换 Rust SQLite（D01 §12 im_* 命令），本层接口对齐 local_message/
 *   local_conv_state/outbox 三表语义，端内只经本模块读写，迁移面收敛
 * - 非阻塞兜底：IDB 不可用（隐私模式等）时全部 no-op，功能退化为现内存态
 */

const DB_NAME = 'bbc-local';
const DB_VERSION = 1;
const S = { messages: 'messages', convState: 'convState', outbox: 'outbox', meta: 'meta' } as const;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 环境探测（SSR/隐私模式兜底） */
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S.messages)) {
        const st = db.createObjectStore(S.messages, { keyPath: ['convId', 'seq'] });
        st.createIndex('byConv', 'convId');
      }
      if (!db.objectStoreNames.contains(S.convState)) {
        db.createObjectStore(S.convState, { keyPath: 'convId' });
      }
      if (!db.objectStoreNames.contains(S.outbox)) {
        db.createObjectStore(S.outbox, { keyPath: 'clientMsgId' });
      }
      if (!db.objectStoreNames.contains(S.meta)) {
        db.createObjectStore(S.meta, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // 不可用即降级，不阻塞主链路
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (st: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(store, mode);
          const st = t.objectStore(store);
          const req = run(st);
          t.oncomplete = () => resolve(req && 'result' in req ? (req.result as T) : null);
          t.onerror = () => resolve(null);
          t.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// ---- 消息缓存（local_message 语义：服务端态消息；sending 本地态在 outbox）----

export interface StoredMessage {
  convId: string;
  seq: number;
  payload: unknown; // 端内 Message 形态整体存（含 ext/status/ts）
}

export function localPutMessages(items: StoredMessage[]): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return openDb().then((db) => {
    if (!db) return;
    return new Promise<void>((resolve) => {
      const t = db.transaction(S.messages, 'readwrite');
      const st = t.objectStore(S.messages);
      for (const m of items) st.put(m);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  });
}

export function localGetMessages(convId: string, limit = 200): Promise<StoredMessage[]> {
  return openDb().then((db) => {
    if (!db) return [];
    return new Promise<StoredMessage[]>((resolve) => {
      const t = db.transaction(S.messages, 'readonly');
      const idx = t.objectStore(S.messages).index('byConv');
      const out: StoredMessage[] = [];
      const req = idx.openCursor(IDBKeyRange.only(convId), 'prev'); // seq 降序取最新 N
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && out.length < limit) {
          out.push(cur.value as StoredMessage);
          cur.continue();
        }
      };
      t.oncomplete = () => resolve(out.reverse()); // 升序返回
      t.onerror = () => resolve([]);
    });
  });
}

/** 撤回/编辑/回应的原地覆盖：同 key put 即替换 */
export function localPutMessage(item: StoredMessage): Promise<void> {
  return localPutMessages([item]);
}

// ---- 会话游标与态（local_conv_state 语义）----

export interface LocalConvState {
  convId: string;
  readSeq: number;
  /** 本地已持久化的最大服务端 seq（sync 游标） */
  syncedSeq: number;
  draft: string;
  pinned: boolean;
  mute: boolean;
  updatedAt: number;
}

export function localGetConvState(convId: string): Promise<LocalConvState | null> {
  return tx<LocalConvState>(S.convState, 'readonly', (st) => st.get(convId) as IDBRequest<LocalConvState>);
}

export function localGetAllConvStates(): Promise<LocalConvState[]> {
  return tx<LocalConvState[]>(S.convState, 'readonly', (st) => st.getAll() as IDBRequest<LocalConvState[]>).then(
    (r) => r ?? [],
  );
}

export function localPutConvState(s: LocalConvState): Promise<void> {
  return tx(S.convState, 'readwrite', (st) => {
    st.put(s);
  }).then(() => undefined);
}

// ---- outbox（弱网重发源；跨刷新存活）----

export interface OutboxRow {
  clientMsgId: string;
  convId: string;
  text: string;
  /** sending | failed（sent 即出队） */
  state: 'sending' | 'failed';
  retryCount: number;
  createdAt: number;
}

export function localOutboxAdd(row: OutboxRow): Promise<void> {
  return tx(S.outbox, 'readwrite', (st) => {
    st.put(row);
  }).then(() => undefined);
}

export function localOutboxUpdate(clientMsgId: string, patch: Partial<OutboxRow>): Promise<OutboxRow | null> {
  return tx<OutboxRow>(S.outbox, 'readwrite', (st) => st.get(clientMsgId) as IDBRequest<OutboxRow>).then(async (row) => {
    if (!row) return null;
    const next = { ...row, ...patch };
    await tx(S.outbox, 'readwrite', (st) => {
      st.put(next);
    });
    return next;
  });
}

export function localOutboxRemove(clientMsgId: string): Promise<void> {
  return tx(S.outbox, 'readwrite', (st) => {
    st.delete(clientMsgId);
  }).then(() => undefined);
}

export function localOutboxAll(): Promise<OutboxRow[]> {
  return tx<OutboxRow[]>(S.outbox, 'readonly', (st) => st.getAll() as IDBRequest<OutboxRow[]>).then((r) => r ?? []);
}

// ---- meta / 生命周期 ----

export function localMetaSet(k: string, v: unknown): Promise<void> {
  return tx(S.meta, 'readwrite', (st) => {
    st.put({ k, v });
  }).then(() => undefined);
}

export function localMetaGet<T>(k: string): Promise<T | null> {
  return tx<{ k: string; v: T }>(S.meta, 'readonly', (st) => st.get(k) as IDBRequest<{ k: string; v: T }>).then(
    (r) => (r ? r.v : null),
  );
}

/** 登出清库（auth 层调用；不清 outbox 之外的会话隐私面） */
export function localClearAll(): Promise<void> {
  return openDb().then((db) => {
    if (!db) return;
    return new Promise<void>((resolve) => {
      const t = db.transaction([S.messages, S.convState, S.outbox, S.meta], 'readwrite');
      for (const name of [S.messages, S.convState, S.outbox, S.meta]) t.objectStore(name).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  });
}
