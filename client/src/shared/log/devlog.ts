/**
 * 开发者日志总线（2026-11-23 开发者模式批次1）：
 * - 纯内存环形缓冲（上限 500 条，满丢最旧）——零落流红线不动：不落盘、不自动上报，
 *   导出是用户在 DevPanel 里的主动动作；
 * - 埋点方：http/ws 全链路、渲染错误（ErrorBoundary）、window error /
 *   unhandledrejection（main.tsx）——此前异步异常静默消失、生产包无 devtools 可看
 *   是排查的两大盲区；
 * - 消费方：DevPanel（useSyncExternalStore 订阅，面板关闭时零渲染开销）。
 */

export type DevLogLevel = 'error' | 'warn' | 'info';
export type DevLogSource = 'js' | 'promise' | 'render' | 'http' | 'ws' | 'dev';

export interface DevLogEntry {
  id: number;
  ts: number;
  level: DevLogLevel;
  source: DevLogSource;
  message: string;
  stack?: string;
  data?: Record<string, unknown>;
}

export type DevLogInput = Omit<DevLogEntry, 'id' | 'ts'>;

const MAX_ENTRIES = 500; // 环形上限：覆盖一次排错会话，更早历史让位新现场
const DEV_ENABLED_KEY = 'bbc:dev'; // 开发者模式已启用标记（对齐 bbc:kb:recent 命名）

let seq = 0;
let entries: readonly DevLogEntry[] = [];
const logListeners = new Set<() => void>();

/** 追加一条（满 500 丢最旧；数组引用换新以配合 useSyncExternalStore 快照语义） */
export function pushLog(input: DevLogInput): void {
  const entry: DevLogEntry = { id: ++seq, ts: Date.now(), ...input };
  entries =
    entries.length >= MAX_ENTRIES
      ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry]
      : [...entries, entry];
  logListeners.forEach((fn) => fn());
}

export function subscribeDevLog(fn: () => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export function getDevLogEntries(): readonly DevLogEntry[] {
  return entries;
}

export function clearDevLog(): void {
  entries = [];
  logListeners.forEach((fn) => fn());
}

/** 组装导出包（env 由 DevPanel 组装传入——本模块不反向依赖 api 层取 WS 地址） */
export function buildDevLogExport(env: Record<string, unknown>): string {
  return JSON.stringify({ exported_at: new Date().toISOString(), env, entries }, null, 2);
}

// ---- 脱敏 ----

/** 敏感字段名（请求体进日志前打码；Idempotency-Key 等业务键不在其列） */
const SENSITIVE_KEY = /password|passwd|passphrase|token|secret|authorization|cookie/i;

/** 递归打码敏感字段值（深搜 3 层、数组截 20 项——日志够用即可，不追求完整） */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '***' : sanitizeForLog(v, depth + 1);
  }
  return out;
}

/** URL query 中的凭据参数打码（WS 连接串 ?token=&did=；显式配置的 VITE_WS_BASE 同样防一手） */
export function maskUrl(url: string): string {
  return url.replace(/([?&](?:token|access_token|did)=)[^&]*/gi, '$1***');
}

// ---- 面板开关（外部 store：DevPanel 经 useSyncExternalStore 订阅；快捷键直接调函数） ----

let panelOpen = false;
const panelListeners = new Set<() => void>();

export function subscribeDevPanel(fn: () => void): () => void {
  panelListeners.add(fn);
  return () => panelListeners.delete(fn);
}

export function getDevPanelOpen(): boolean {
  return panelOpen;
}

/** 开面板即置开发者模式标记（设置·关于出现开发者卡片） */
export function setDevPanelOpen(open: boolean): void {
  panelOpen = open;
  if (open) setDevEnabled(true);
  panelListeners.forEach((fn) => fn());
}

export function toggleDevPanel(): void {
  setDevPanelOpen(!panelOpen);
}

/** 开发者模式启用标记（localStorage；隐私模式读写失败静默） */
export function isDevEnabled(): boolean {
  try {
    return localStorage.getItem(DEV_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 关闭开发者模式：摘标记 + 顺带收起面板（摘牌后面板仍开着语义矛盾） */
export function setDevEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DEV_ENABLED_KEY, '1');
    else localStorage.removeItem(DEV_ENABLED_KEY);
  } catch {
    /* 隐私模式写失败静默 */
  }
  if (!enabled && panelOpen) {
    panelOpen = false;
    panelListeners.forEach((fn) => fn());
  }
}
