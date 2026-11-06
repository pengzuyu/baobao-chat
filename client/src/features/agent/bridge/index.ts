/**
 * Agent Bridge 出口：运行时探测选择实现。
 * - Tauri WebView（window.__TAURI_INTERNALS__ 存在）→ TauriAgentBridge（真实 IPC）
 * - 其余（浏览器 dev / vite preview / 宿主命令未接齐构造失败）→ MockAgentBridge 回落
 */

import type { AgentBridge } from './types';
import { MockAgentBridge } from './mock';
import { TauriAgentBridge } from './tauri';

let cached: AgentBridge | null = null;

export function getAgentBridge(): AgentBridge {
  if (cached) return cached;
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      cached = new TauriAgentBridge();
      return cached;
    } catch {
      // 构造失败（宿主命令未接线等）→ 回落 mock，保证 UI 可用
    }
  }
  cached = new MockAgentBridge();
  return cached;
}

export type { AgentBridge } from './types';
