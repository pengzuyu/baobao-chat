/**
 * 最近打开（localStorage LRU ≤20，D05 §6.2 local_doc_recent 的 v0.1 简版——
 * Tauri SQLite 未接，登记；登出不清除：阶段二随隐私策略接）。
 */

import type { DocRecentEntry } from '../model/types';

const KEY = 'bbw.doc.recent.v1';
const CAP = 20;

function read(): DocRecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DocRecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, CAP) : [];
  } catch {
    return [];
  }
}

function write(entries: DocRecentEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, CAP)));
  } catch {
    // 存储满/隐私模式：静默降级为内存态（本次会话内仍可用）
  }
}

/** 最近打开列表（at 倒序） */
export function listRecent(): DocRecentEntry[] {
  return [...read()].sort((a, b) => b.at - a.at);
}

/** 打开文档后 upsert（LRU 置顶；INT-DOC-26 简版） */
export function pushRecent(id: string, title: string, version: number, at: number = Date.now()): void {
  const rest = read().filter((e) => e.id !== id);
  write([{ id, title, version, at }, ...rest]);
}

/** 文档改名/版本前进后同步刷新条目 */
export function touchRecent(id: string, patch: Partial<Pick<DocRecentEntry, 'title' | 'version'>>): void {
  write(read().map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

/** 删除（移入回收站/彻底删除）后移除条目 */
export function removeRecent(id: string): void {
  write(read().filter((e) => e.id !== id));
}
