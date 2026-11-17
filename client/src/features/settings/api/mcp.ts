/**
 * 个人 MCP server API（D26 §3）：Tauri 壳命令封装——纯客户端本地存储
 * （{dataDir}/eco/mcp/personal.json + 钥匙串），无服务端接口。
 * 非 Tauri（Web 预览）只读空清单、编辑类操作抛错。
 */

import { invoke } from '@tauri-apps/api/core';

/** 壳侧 personal.json 条目镜像（secret 值恒为空串占位——真值只在钥匙串） */
export interface PersonalMcpServer {
  name: string;
  enabled: boolean;
  kind: 'stdio' | 'http';
  /** stdio 形态 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http 形态 */
  url?: string;
  headers?: Record<string, string>;
  /** secret 值键名（文件存空串占位；真值钥匙串 account={name}/{key}） */
  secretKeys?: string[];
  /** 任一值引用 ${BBC_USER_TOKEN}（壳侧保存时探测；UI 警示「将以你的身份调用」） */
  usesIdentity?: boolean;
  note?: string;
  updatedAt?: number;
}

/** mcp.test 回执（D26 §6：RT 一次性连接的真实链路结果） */
export interface McpTestResult {
  name: string;
  ok: boolean;
  /** server 侧原工具名（全名= mcp.{name}.{tool}） */
  tools: string[];
  error?: string;
}

/** Tauri WebView 注入标记（同 plugins.ts：无则本地链不可用） */
export function isMcpUiAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function fetchPersonalMcp(): Promise<PersonalMcpServer[]> {
  if (!isMcpUiAvailable()) return [];
  try {
    const list = await invoke<PersonalMcpServer[] | null>('mcp_personal_list');
    return list ?? [];
  } catch {
    return []; // 降级空清单（文件缺失/损坏壳侧已兜底，此处防御 IPC 异常）
  }
}

/** 新增/编辑（name 为身份键——编辑禁改；secretValues 空=保持旧值不覆盖） */
export async function upsertPersonalMcp(
  server: PersonalMcpServer,
  secretValues: Record<string, string>,
): Promise<void> {
  await invoke('mcp_personal_upsert', { server, secretValues });
}

export async function removePersonalMcp(name: string): Promise<void> {
  await invoke('mcp_personal_remove', { name });
}

export async function setPersonalMcpEnabled(name: string, enabled: boolean): Promise<void> {
  await invoke('mcp_personal_set_enabled', { name, enabled });
}

/** 测试连接（已保存条目；含钥匙串真值；禁用条目也可测） */
export async function testMcpConnection(name: string): Promise<McpTestResult> {
  return invoke<McpTestResult>('mcp_test_connection', { name });
}
