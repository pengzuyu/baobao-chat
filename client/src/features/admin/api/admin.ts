/**
 * 管理域 REST 封装（D10 阶段一务实版 10 项）：
 * - 仪表盘 GET /admin/dashboard（60s 轮询，PAD-02）
 * - 用户 GET /admin/users · PATCH /admin/users/{id} · POST .../disable|enable
 * - 策略 GET /admin/policies/agent · 敏感词 GET/POST /admin/policies/sensitive-words · DELETE .../{id}
 * - 用量 GET /admin/usage/summary?days=
 * - 审计 GET /admin/audit?cursor=
 * mock 桩集中本文件（默认真实 REST，显式 VITE_USE_MOCK=1 才启用——D18 翻转）。
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
  AIProvider,
  AIProviderInput,
  AIRouteRule,
} from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

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
        { id: '10001', employee_no: 'alice', display_name: 'Alice', email: 'alice@bbc.io', status: 1, scopes: ['admin', 'im:message:send'], roles: [{ role_id: '1', role_name: '管理员' }] },
        { id: '10002', employee_no: 'bob', display_name: 'Bob', email: 'bob@bbc.io', status: 1, scopes: ['im:message:send'], roles: [] },
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

/** 工具策略行（agent_tool_policy；编辑器数据源） */
export interface AgentToolPolicyRow {
  subject: string;
  allowed: boolean;
  risk_override: string;
  config: string;
  updated_by: string;
  updated_at: string;
}

/** 行级 upsert（allowed 显式传 false 合法）；返回合成快照 */
export async function updateAgentToolPolicy(req: { subject: string; allowed: boolean; risk_override?: string; config?: string }): Promise<AgentPolicySnapshot> {
  if (USE_MOCK) {
    await delay(200);
    return { version: 1, updated_at: new Date().toISOString(), source: 'table', policy: {}, rows: [{ subject: req.subject, allowed: req.allowed, risk_override: req.risk_override ?? '{}', config: req.config ?? '{}', updated_by: 'u-1', updated_at: new Date().toISOString() }] };
  }
  return http.put<AgentPolicySnapshot>('/admin/policies/agent/tools', req);
}

/** 删行回落默认 */
export async function deleteAgentToolPolicy(subject: string): Promise<AgentPolicySnapshot> {
  if (USE_MOCK) {
    await delay(150);
    return { version: 1, updated_at: new Date().toISOString(), source: 'default', policy: {}, rows: [] };
  }
  return http.delete<AgentPolicySnapshot>(`/admin/policies/agent/tools/${encodeURIComponent(subject)}`);
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
  scope_type?: number; // D10：1 本人 2 本部门 3 本部门及以下 4 全租户（缺省 4）
  scope_dept_id?: number;
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

export async function grantRole(userId: string, roleId: string, scopeType: number = 4, scopeDeptId: number = 0): Promise<void> {
  if (USE_MOCK) return;
  await http.post(`/admin/users/${encodeURIComponent(userId)}/grants`, { role_id: Number(roleId), scope_type: scopeType, scope_dept_id: scopeDeptId });
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
    id: '2', name: '应用管理员', description: '应用/技能管理（内置）', is_builtin: true,
    permissions: ['admin:app:publish'],
    user_count: 0, created_at: Date.now() - 86400_000 * 30,
  },
  {
    id: '3', name: '开发者', description: '自定义示例', is_builtin: false,
    permissions: ['im:message:send', 'agent:session:use'],
    user_count: 3, created_at: Date.now() - 86400_000 * 7,
  },
];

/** 权限点字典（API-ADM-02；服务端内嵌权威清单 D12 §2.4 经接口下发，前端不硬编码） */
export interface PermPoint {
  code: string;
  domain: string;
  desc: string;
}
export interface PermGroup {
  domain: string;
  label: string;
  points: PermPoint[];
}
export interface PermPointsDoc {
  version: number;
  total: number;
  groups: PermGroup[];
}

export async function fetchPermPoints(): Promise<PermPointsDoc> {
  if (USE_MOCK) return MOCK_PERM_DOC;
  return http.get<PermPointsDoc>('/admin/perm-points');
}

/** mock 字典（USE_MOCK 走查用；真实环境以服务端下发为准） */
const MOCK_PERM_DOC: PermPointsDoc = {
  version: 1,
  total: 12,
  groups: [
    { domain: 'im', label: '即时通讯', points: [
      { code: 'im:message:send', domain: 'im', desc: '发消息' },
      { code: 'im:group:manage', domain: 'im', desc: '群管理' },
    ] },
    { domain: 'kb', label: '知识库', points: [
      { code: 'kb:query:use', domain: 'kb', desc: '检索使用' },
      { code: 'kb:doc:contribute', domain: 'kb', desc: '投稿文档' },
    ] },
    { domain: 'agent', label: '智能体', points: [
      { code: 'agent:session:use', domain: 'agent', desc: '使用 Agent 会话' },
      { code: 'agent:tool:run_command', domain: 'agent', desc: '执行命令工具' },
    ] },
    { domain: 'admin', label: '租户管理', points: [
      { code: 'admin:user:manage', domain: 'admin', desc: '用户生命周期' },
      { code: 'admin:role:manage', domain: 'admin', desc: '角色 CRUD' },
      { code: 'admin:role:assign', domain: 'admin', desc: '成员授权' },
      { code: 'admin:policy:manage', domain: 'admin', desc: '安全/合规策略' },
      { code: 'admin:audit:read', domain: 'admin', desc: '审计检索' },
      { code: 'admin:notice:publish', domain: 'admin', desc: '租户公告' },
    ] },
  ],
};

/* ── 平台公告（PAD-15） ── */

export interface AdminNotice {
  id: string;
  title: string;
  content: string;
  created_by: string;
  reach: number;
  created_at: number;
}

export async function fetchNotices(params: { cursor?: string; limit?: number } = {}): Promise<{ items: AdminNotice[]; has_more: boolean }> {
  if (USE_MOCK) {
    return {
      items: [
        { id: '1', title: '停机维护公告', content: '今晚 22:00-24:00 停机升级', created_by: '10001', reach: 2, created_at: Date.now() - 3600_000 },
      ],
      has_more: false,
    };
  }
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  return http.get(`/admin/notices${q.size > 0 ? `?${q}` : ''}`);
}

export async function publishNotice(title: string, content: string): Promise<AdminNotice> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持发布公告');
  return http.post<AdminNotice>('/admin/notices', { title, content });
}

/* ── 批量导入（PAD-06） ── */

export interface ImportRowResult {
  row: number;
  empno: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export interface ImportResult {
  created: number;
  failed: number;
  rows: ImportRowResult[];
}

export interface ImportInputRow {
  empno: string;
  name: string;
  email?: string;
}

export async function batchImportUsers(rows: ImportInputRow[]): Promise<ImportResult> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持批量导入');
  return http.post<ImportResult>('/admin/users/import', { rows });
}

/* ── Agent 治理（PAD-14） ── */

export interface AgentUserRow {
  user_id: string;
  name: string;
  requests: number;
  tokens: number;
  sessions: number;
  last_hour: number;
}

export async function fetchAgentUsers(): Promise<AgentUserRow[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: AgentUserRow[] }>('/admin/agent/users');
  return data.items;
}

export async function revokeAgentAccess(userId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.post('/admin/agent/revoke', { user_id: Number(userId) });
}

export async function agentKillswitch(on?: boolean): Promise<boolean> {
  if (USE_MOCK) return false;
  if (on === undefined) {
    const data = await http.get<{ on: boolean }>('/admin/agent/killswitch');
    return data.on;
  }
  const data = await http.put<{ on: boolean }>('/admin/agent/killswitch', { on });
  return data.on;
}

/* ── 组织树（PAD-04） ── */

export interface DeptNode {
  id: string;
  parent_id?: string;
  name: string;
  sort: number;
  path: string;
  children?: DeptNode[];
}

export async function fetchDeptTree(): Promise<DeptNode[]> {
  if (USE_MOCK) return [{ id: '1', name: '总公司', sort: 0, path: '/1/', children: [{ id: '2', parent_id: '1', name: '研发部', sort: 0, path: '/1/2/' }] }];
  const data = await http.get<{ items: DeptNode[] }>('/admin/org/tree');
  return data.items;
}

export async function createDept(parentId: string, name: string, sort = 0): Promise<DeptNode> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持组织管理');
  return http.post<DeptNode>('/admin/org/depts', { parent_id: Number(parentId || 0), name, sort });
}

export async function renameDept(id: string, name: string): Promise<void> {
  if (USE_MOCK) return;
  await http.patch(`/admin/org/depts/${encodeURIComponent(id)}`, { name });
}

export async function deleteDept(id: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/admin/org/depts/${encodeURIComponent(id)}`);
}

/* ── KB 治理（PAD-10） ── */

export interface KBSpaceRow {
  id: string;
  type: 'personal' | 'dept' | 'company';
  name: string;
  status?: 'active' | 'archived';
  owner_id: string;
  owner_name: string;
  doc_count: number;
  quota_bytes: number;
  used_bytes: number;
}

/** 停用/启用空间（D8：停用即刻生效——检索/浏览对全员不可见） */
export async function setKBSpaceStatus(id: string, archived: boolean): Promise<void> {
  if (USE_MOCK) {
    await delay(200);
    return;
  }
  await http.post(`/admin/kb/spaces/${encodeURIComponent(id)}/${archived ? 'archive' : 'activate'}`, {});
}

/** 删除空间（级联；personal 7010） */
export async function deleteKBSpace(id: string): Promise<void> {
  if (USE_MOCK) {
    await delay(200);
    return;
  }
  await http.delete(`/admin/kb/spaces/${encodeURIComponent(id)}`);
}

export async function fetchKBSpaces(): Promise<KBSpaceRow[]> {
  if (USE_MOCK) {
    return [
      { id: '1', type: 'company', name: '公司知识库', owner_id: '10001', owner_name: 'Alice', doc_count: 12, quota_bytes: 10 << 30, used_bytes: 387 << 20 },
      { id: '2', type: 'personal', name: 'Alice 的空间', owner_id: '10001', owner_name: 'Alice', doc_count: 3, quota_bytes: 1 << 30, used_bytes: 21 << 20 },
    ];
  }
  const data = await http.get<{ items: KBSpaceRow[] }>('/admin/kb/spaces');
  return data.items;
}

/* ── KB 嵌入设置与向量重建（D24 §5.3；admin:kb:govern） ── */

/** 嵌入配置与重建进度（治理页轮询） */
export interface KBEmbeddingSettings {
  embed_epoch: number;
  embed_model: string;
  embed_dims: number;
  rebuild_status: 'idle' | 'running';
  rebuild_done: number;
  rebuild_total: number;
}

export async function fetchKBEmbedding(): Promise<KBEmbeddingSettings> {
  if (USE_MOCK) {
    return { embed_epoch: 1, embed_model: 'mock-embed', embed_dims: 1024, rebuild_status: 'idle', rebuild_done: 0, rebuild_total: 0 };
  }
  return http.get<KBEmbeddingSettings>('/admin/kb/embedding');
}

/** 触发重建（跨维度=清空向量+改列——调用方二次确认；7017 running/7018 维度不符） */
export async function rebuildKBEmbedding(req: { model: string; dims: number; force?: boolean }): Promise<KBEmbeddingSettings> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 400));
    return { embed_epoch: 2, embed_model: req.model, embed_dims: req.dims, rebuild_status: 'running', rebuild_done: 0, rebuild_total: 12 };
  }
  return http.post<KBEmbeddingSettings>('/admin/kb/embedding/rebuild', req);
}

/* ── 单建用户 + 工号建议（2026-11-12 通讯录合并页） ── */

/** 单建输入：employee_no 空=服务端按姓名全拼自动生成（重名两位补零递增） */
export interface CreateUserInput {
  employee_no?: string;
  display_name: string;
  email?: string;
  dept_id?: number;
  role_id?: number;
}

/** 单建用户（初始口令=工号+!BBC 首登强制改密——批量导入同口径） */
export async function createUser(input: CreateUserInput): Promise<AdminUser> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持创建用户');
  return http.post<AdminUser>('/admin/users', input);
}

/** 工号建议（姓名→全拼小写；重名 zhangsan02 两位补零递增） */
export async function suggestEmpno(name: string): Promise<string> {
  if (USE_MOCK) return `suggest${Date.now() % 1000}`;
  const data = await http.get<{ empno: string }>(`/admin/users/empno-suggest?name=${encodeURIComponent(name)}`);
  return data.empno;
}

/* ── AI 供应商治理（0023 多供应商；19 篇 §6.5 v0.1 子集） ── */

/** 公司级供应商列表（含停用；scope=shared 为启用中只读） */
export async function fetchAIProviders(scope: 'corp' | 'shared' = 'corp'): Promise<AIProvider[]> {
  if (USE_MOCK) return [];
  const path = scope === 'corp' ? '/admin/ai/providers' : '/ai/providers/shared';
  const data = await http.get<{ items: Array<AIProvider & { id: number | string }> }>(path);
  // ProviderDTO.id wire 为 int64 数字（TS 口径 string）：fetch 层归一化——否则路由面板
  // modelsOf 严格相等比对失败、模型下拉恒空（RoleDTO 字符串化先例同款问题）
  return data.items.map((it) => ({ ...it, id: String(it.id) }));
}

/** 创建公司级供应商（密钥服务端 KMS 加密落库） */
export async function createAIProvider(input: AIProviderInput): Promise<AIProvider> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  return http.post<AIProvider>('/admin/ai/providers', input).then((p) => ({ ...p, id: String(p.id) }));
}

/** 更新供应商（apiKey 留空=保留原密钥） */
export async function updateAIProvider(id: string, input: AIProviderInput): Promise<AIProvider> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  return http.patch<AIProvider>(`/admin/ai/providers/${encodeURIComponent(id)}`, input).then((p) => ({ ...p, id: String(p.id) }));
}

/** 删除供应商（被默认路由引用时服务端拒绝，先改路由） */
export async function deleteAIProvider(id: string): Promise<void> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  await http.delete(`/admin/ai/providers/${encodeURIComponent(id)}`);
}

/** 探活已建供应商（GET 上游 /models，返回可用模型 id 列表） */
export async function probeAIProvider(id: string): Promise<string[]> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  const data = await http.post<{ models: string[] }>(`/admin/ai/providers/${encodeURIComponent(id)}/probe`);
  return data.models;
}

/** 探活未落库的 base+key（创建表单"测试连通/拉取模型"） */
export async function probeAIProviderRaw(baseUrl: string, apiKey: string): Promise<string[]> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  const data = await http.post<{ models: string[] }>('/admin/ai/providers/probe', { baseUrl, apiKey });
  return data.models;
}

/** 当前 fast/strong active 路由 */
export async function fetchAIRoutes(): Promise<AIRouteRule[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: Array<AIRouteRule & { candidates: Array<{ providerId: number | string; model: string; priority: number }> }> }>('/admin/ai/routes');
  // candidates[].providerId wire 为 int64 数字（TS 口径 string）：同供应商 id 归一化
  return data.items.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, providerId: String(c.providerId) })) }));
}

/** 整表替换路由（主备降级：candidates 按 priority 逐个尝试） */
export async function putAIRoutes(items: AIRouteRule[]): Promise<AIRouteRule[]> {
  if (USE_MOCK) throw new ApiError(9001, 'mock 模式不支持');
  // 出参归一化同 fetchAIRoutes；入参 providerId 转 number（服务端 int64，string 反序列化 400）
  const data = await http.put<{ items: Array<AIRouteRule & { candidates: Array<{ providerId: number | string; model: string; priority: number }> }> }>(
    '/admin/ai/routes',
    { items: items.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, providerId: Number(c.providerId) })) })) },
  );
  return data.items.map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c, providerId: String(c.providerId) })) }));
}

// ── 部门成员管理（D10：user_dept 挂/卸/查）──

/** 部门成员行 */
export interface DeptMemberRow {
  user_id: string;
  name: string;
  /** 2026-11-12 通讯录合并页增补（旧服务端无这三字段→undefined 渐进降级） */
  employee_no?: string;
  email?: string;
  status?: number;
  is_primary: boolean;
}

/** 部门成员列表 */
export async function fetchDeptMembers(deptId: string): Promise<DeptMemberRow[]> {
  if (USE_MOCK) {
    await delay(150);
    return [
      { user_id: '10001', name: 'Alice（mock）', is_primary: true },
      { user_id: '10002', name: 'Bob（mock）', is_primary: false },
    ];
  }
  const data = await http.get<{ items: DeptMemberRow[] }>(`/admin/org/depts/${encodeURIComponent(deptId)}/members`);
  return data.items ?? [];
}

/** 挂部门（首挂/显式 is_primary） */
export async function attachDeptMember(deptId: string, userId: string, isPrimary: boolean): Promise<void> {
  if (USE_MOCK) {
    await delay(150);
    return;
  }
  await http.post(`/admin/org/depts/${encodeURIComponent(deptId)}/members`, { user_id: userId, is_primary: isPrimary });
}

/** 卸挂 */
export async function detachDeptMember(deptId: string, userId: string): Promise<void> {
  if (USE_MOCK) {
    await delay(120);
    return;
  }
  await http.delete(`/admin/org/depts/${encodeURIComponent(deptId)}/members/${encodeURIComponent(userId)}`);
}
