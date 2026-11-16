/**
 * 外部智能体接入面 API（D30 批4）：Tauri 壳命令封装——纯客户端本机面
 * （127.0.0.1 A2A/MCP server 随 App 生命周期），无服务端接口。
 * 非 Tauri（Web 预览）不可用。
 */

import { invoke } from '@tauri-apps/api/core';

/** 壳侧接入面状态（ext_agent_status 回执） */
export interface ExtAgentStatus {
  online: boolean;
  port: number;
  /** 本机 token（明文返回——授权卡展示/复制用；仅本机回环有效） */
  token: string;
}

/** Tauri WebView 注入标记（同 mcp.ts：无则本地链不可用） */
export function isExtAgentUiAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function fetchExtAgentStatus(): Promise<ExtAgentStatus> {
  return invoke<ExtAgentStatus>('ext_agent_status');
}

/** 重新生成 token（=撤销既有授权，旧 token 立即 401） */
export async function regenExtAgentToken(): Promise<string> {
  const r = await invoke<{ token: string }>('ext_agent_token_regen');
  return r.token;
}
