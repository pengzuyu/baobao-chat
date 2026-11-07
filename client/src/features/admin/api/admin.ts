/**
 * 管理域 REST 封装（D10 阶段一务实版 10 项）：
 * - 仪表盘 GET /admin/dashboard（60s 轮询，PAD-02）
 * - 用户 GET /admin/users · PATCH /admin/users/{id} · POST .../disable|enable
 * - 策略 GET /admin/policies/agent · 敏感词 GET/POST /admin/policies/sensitive-words · DELETE .../{id}
 * - 用量 GET /admin/usage/summary?days=
 * - 审计 GET /admin/audit?cursor=
 * mock 桩集中本文件（VITE_USE_MOCK=0 关闭后走真实 REST；mock 登录用户无 admin 权限，
 * 正常入口不可达——直敲 /admin URL 时供六态走查）。
 */

import { ApiError, http } from '../../../shared/api/http';
import type {
  AdminDashboard,
  AdminUser,
  AdminUserStatus,
  AgentPolicySnapshot,
  AuditItem,
  CursorPage,
  UsageSummary,
  WordPage,
} from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 仪表盘聚合 */
export async function fetchDashboard(): Promise<AdminDashboard> {
  if (USE_MOCK) {
    await delay(400);
    return {
      as_of: new Date().toISOString(),
      users_total: 128,
      online_now: 12,
      sessions_today: 34,
      msgs_today: 1024,
      ai_today: { requests: 86, total_tokens: 1_234_567 },
      kb_docs: 57,
      file_storage_bytes: 3_221_225_472,
      ai_tokens_trend: Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10),
        total_tokens: 400_000 + Math.round(Math.sin(i) * 200_000) + 100_000,
      })),
    };
  }
  return http.get<AdminDashboard>('/admin/dashboard');
}

/** 用户列表（?keyword&status&cursor&limit） */
export async function fetchUsers(params: { keyword?: string; status?: number; cursor?: string; limit?: number }): Promise<CursorPage<AdminUser>> {
  if (USE_MOCK) {
    await delay(300);
    const items: AdminUser[] = (
      [
        { id: '10001', employee_no: 'alice', display_name: 'Alice', email: 'alice@bbw.io', status: 1, scopes: ['admin', 'im:message:send'] },
        { id: '10002', employee_no: 'bob', display_name: 'Bob', email: 'bob@bbw.io', status: 1, scopes: ['im:message:send'] },
      ] as AdminUser[]
    ).filter((u) => (!params.status || u.status === params.status) && (!params.keyword || u.employee_no.includes(params.keyword) || u.display_name.toLowerCase().includes(params.keyword.toLowerCase())));
    return { items, has_more: false, next_cursor: '' };
  }
  const q = new URLSearchParams();
  if (params.keyword) q.set('keyword', params.keyword);
  if (params.status) q.set('status', String(params.status));
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  return http.get<CursorPage<AdminUser>>(`/admin/users${q.size > 0 ? `?${q}` : ''}`);
}

/** 用户状态变更（PATCH {status}；禁用=踢线+吊销+审计，服务端语义） */
export async function patchUserStatus(userId: string, status: AdminUserStatus): Promise<AdminUser> {
  if (USE_MOCK) {
    await delay(300);
    return { id: userId, employee_no: 'bob', display_name: 'Bob', status, scopes: [] };
  }
  return http.patch<AdminUser>(`/admin/users/${encodeURIComponent(userId)}`, { status });
}

/** 禁用/启用语义端点（POST disable|enable） */
export async function postUserStatus(userId: string, action: 'disable' | 'enable'): Promise<AdminUser> {
  if (USE_MOCK) {
    await delay(300);
    return { id: userId, employee_no: 'bob', display_name: 'Bob', status: action === 'disable' ? 2 : 1, scopes: [] };
  }
  return http.post<AdminUser>(`/admin/users/${encodeURIComponent(userId)}/${action}`);
}

/** Agent 工具策略只读快照 */
export async function fetchAgentPolicy(): Promise<AgentPolicySnapshot> {
  if (USE_MOCK) {
    await delay(200);
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      source: 'default',
      policy: { tool_mode: 'allowlist', builtin_tools: { fs_read: true, fs_write: true, shell_exec: false }, audit_report_level: 'metadata' },
    };
  }
  return http.get<AgentPolicySnapshot>('/admin/policies/agent');
}

/** 敏感词分页列表 */
export async function fetchWords(params: { cursor?: string; limit?: number } = {}): Promise<WordPage> {
  if (USE_MOCK) {
    await delay(250);
    return {
      items: [
        { id: '1', word: '内部机密', mode: 1, enabled: true, created_at: new Date().toISOString() },
        { id: '2', word: '源代码泄露', mode: 1, category: '安全', enabled: true, created_at: new Date().toISOString() },
      ],
      total: 2,
      has_more: false,
      next_cursor: '',
    };
  }
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  return http.get<WordPage>(`/admin/policies/sensitive-words${q.size > 0 ? `?${q}` : ''}`);
}

/** 新增敏感词（mode=1 拦截；写后消息域即时生效 3005） */
export async function addWord(word: string, category?: string): Promise<{ id: string; word: string }> {
  if (USE_MOCK) {
    await delay(250);
    return { id: `mock-${Date.now()}`, word };
  }
  return http.post<{ id: string; word: string }>('/admin/policies/sensitive-words', { word, category });
}

/** 删除敏感词 */
export async function deleteWord(id: string): Promise<void> {
  if (USE_MOCK) {
    await delay(200);
    return;
  }
  await http.delete<null>(`/admin/policies/sensitive-words/${encodeURIComponent(id)}`);
}

/** AI 用量汇总（?days=，默认 7 上限 30） */
export async function fetchUsage(days = 7): Promise<UsageSummary> {
  if (USE_MOCK) {
    await delay(350);
    return {
      as_of: new Date().toISOString(),
      days,
      mode: 'memory',
      daily: Array.from({ length: days }, (_, i) => ({
        date: new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
        requests: 20 + i * 3,
        prompt_tokens: 1000 * (i + 1),
        completion_tokens: 500 * (i + 1),
        total_tokens: 1500 * (i + 1),
      })),
      by_tier: [
        { key: 'fast', requests: 120, total_tokens: 800_000 },
        { key: 'embed', requests: 60, total_tokens: 300_000 },
      ],
      by_scene: [
        { key: 'chat', requests: 100, total_tokens: 700_000 },
        { key: 'embed', requests: 60, total_tokens: 300_000 },
        { key: 'kb', requests: 20, total_tokens: 100_000 },
      ],
      total: { date: '', requests: 180, prompt_tokens: 900_000, completion_tokens: 400_000, total_tokens: 1_100_000 },
    };
  }
  return http.get<UsageSummary>(`/admin/usage/summary?days=${days}`);
}

/** 审计时间线（?cursor&limit） */
export async function fetchAudit(params: { cursor?: string; limit?: number } = {}): Promise<CursorPage<AuditItem>> {
  if (USE_MOCK) {
    await delay(300);
    return {
      items: [
        { id: '3', operator_id: '10001', operator_name: 'Alice', action: 'policy.sensitive_word.add', target: 'sensitive_word:3', detail: { word: '测试词' }, created_at: new Date().toISOString() },
        { id: '2', operator_id: '10001', operator_name: 'Alice', action: 'user.disable', target: 'user:10002', detail: { kicked_conns: 1 }, created_at: new Date(Date.now() - 600_000).toISOString() },
        { id: '1', operator_id: '10001', operator_name: 'Alice', action: 'user.enable', target: 'user:10002', created_at: new Date(Date.now() - 1200_000).toISOString() },
      ],
      has_more: false,
      next_cursor: '',
    };
  }
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  return http.get<CursorPage<AuditItem>>(`/admin/audit${q.size > 0 ? `?${q}` : ''}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── 角色与授权（PAD-08 角色编辑器；D06 后追加） ── */

/** 角色行（GET /admin/roles） */
export interface AdminRole {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  is_builtin: boolean;
  user_count: number;
  created_at: number;
}

/** 授权行（GET /admin/users/{id}/grants） */
export interface AdminGrant {
  id: string;
  user_id: string;
  role_id: string;
  role_name: string;
  created_at: number;
}

export async function fetchRoles(): Promise<AdminRole[]> {
  if (USE_MOCK) return MOCK_ROLES;
  const data = await http.get<{ items: AdminRole[] }>('/admin/roles');
  return data.items;
}

export async function createRole(req: { name: string; description?: string; permissions: string[] }): Promise<AdminRole> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持角色管理');
  return http.post<AdminRole>('/admin/roles', req);
}

export async function updateRole(
  roleId: string,
  req: { name: string; description?: string; permissions: string[] },
): Promise<void> {
  if (USE_MOCK) return;
  await http.patch(`/admin/roles/${encodeURIComponent(roleId)}`, req);
}

export async function deleteRole(roleId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/admin/roles/${encodeURIComponent(roleId)}`);
}

export async function fetchUserGrants(userId: string): Promise<AdminGrant[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: AdminGrant[] }>(`/admin/users/${encodeURIComponent(userId)}/grants`);
  return data.items;
}

export async function grantRole(userId: string, roleId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/admin/users/${encodeURIComponent(userId)}/grants`, { role_id: Number(roleId) });
}

export async function revokeRole(grantId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/admin/grants/${encodeURIComponent(grantId)}`);
}

/** mock 数据（阶段一形态：展示骨架） */
const MOCK_ROLES: AdminRole[] = [
  {
    id: '1', name: '管理员', description: '全部管理权限（内置）', is_builtin: true,
    permissions: ['admin', 'admin:user:manage', 'admin:policy:manage', 'admin:audit:read'],
    user_count: 1, created_at: Date.now() - 86400_000 * 30,
  },
  {
    id: '2', name: '应用管理员', description: '应用/技能/bot 管理（内置）', is_builtin: true,
    permissions: ['admin:app:publish', 'bot:manage'],
    user_count: 0, created_at: Date.now() - 86400_000 * 30,
  },
  {
    id: '3', name: '开发者', description: '自定义示例', is_builtin: false,
    permissions: ['im:message:send', 'agent:session:use'],
    user_count: 3, created_at: Date.now() - 86400_000 * 7,
  },
];

/** 常用权限点分组（v0.1 前端静态字典；正式 53 项字典随 D12 权限点字典接口下发，登记） */
export const PERMISSION_GROUPS: Array<{ group: string; items: string[] }> = [
  { group: 'IM', items: ['im:message:send', 'im:message:recall', 'im:conv:manage'] },
  { group: 'Agent', items: ['agent:session:use', 'agent:delegate:use', 'agent:tool:run_command'] },
  { group: '知识库/文档', items: ['kb:query:use', 'doc:file:view', 'doc:file:edit'] },
  { group: '文件/通话', items: ['file:upload', 'rtc:call:start'] },
  { group: '机器人', items: ['bot:manage', 'bot:install'] },
  { group: '管理', items: ['admin', 'admin:user:manage', 'admin:role:manage', 'admin:policy:manage', 'admin:kb:govern', 'admin:audit:read', 'admin:usage:read', 'admin:app:publish'] },
];
