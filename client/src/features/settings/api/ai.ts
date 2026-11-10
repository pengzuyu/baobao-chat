/**
 * 设置 · AI 个人配置 REST（0023）：
 * - 我的供应商 BYOK CRUD + 探活（/me/ai/providers；密钥服务端加密，仅本人可见）
 * - 公司级供应商只读（/ai/providers/shared；默认模型下拉数据源）
 * - 个人设置（/me/settings；ai_default 默认模型选择，PATCH 顶层浅合并）
 */

import { http } from '../../../shared/api/http';
import type { AIProvider, AIProviderInput } from '../../admin/model/types';

/** 我的供应商列表（≤5 个/人） */
export async function fetchMyProviders(): Promise<AIProvider[]> {
  const data = await http.get<{ items: Array<AIProvider & { id: number | string }> }>('/me/ai/providers');
  // ProviderDTO.id wire 为数字（TS 口径 string）：fetch 层归一化（同 admin 侧修复）
  return data.items.map((it) => ({ ...it, id: String(it.id) }));
}

/** 创建个人供应商（BYOK；仅本人可引用） */
export async function createMyProvider(input: AIProviderInput): Promise<AIProvider> {
  return http.post<AIProvider & { id: number | string }>('/me/ai/providers', input).then((p) => ({ ...p, id: String(p.id) }));
}

/** 更新（apiKey 留空=保留） */
export async function updateMyProvider(id: string, input: AIProviderInput): Promise<AIProvider> {
  return http.patch<AIProvider>(`/me/ai/providers/${encodeURIComponent(id)}`, input);
}

/** 删除 */
export async function deleteMyProvider(id: string): Promise<void> {
  await http.delete(`/me/ai/providers/${encodeURIComponent(id)}`);
}

/** 探活已建（行内密钥） */
export async function probeMyProvider(id: string): Promise<string[]> {
  const data = await http.post<{ models: string[] }>(`/me/ai/providers/${encodeURIComponent(id)}/probe`);
  return data.models;
}

/** 探活未落库 base+key（添加表单） */
export async function probeMyProviderRaw(baseUrl: string, apiKey: string): Promise<string[]> {
  const data = await http.post<{ models: string[] }>('/me/ai/providers/probe', { baseUrl, apiKey });
  return data.models;
}

/** 公司级启用中供应商（默认模型下拉：公司+我的合并展示） */
export async function fetchSharedProviders(): Promise<AIProvider[]> {
  const data = await http.get<{ items: Array<AIProvider & { id: number | string }> }>('/ai/providers/shared');
  return data.items.map((it) => ({ ...it, id: String(it.id) }));
}

/** ai_default 默认模型选择（users.settings；mode=org 跟随公司默认） */
export interface AIDefaultSetting {
  mode: 'org' | 'provider';
  providerId?: string;
  model?: string;
}

/** 读个人设置（任意 JSON；ai_default 为本页消费键） */
export async function fetchMeSettings(): Promise<Record<string, unknown>> {
  return http.get<Record<string, unknown>>('/me/settings');
}

/** 保存默认模型选择 */
export async function patchAIDefault(aiDefault: AIDefaultSetting): Promise<void> {
  await http.patch('/me/settings', { ai_default: aiDefault });
}
