/**
 * 管理域模型（D10 阶段一务实版；字段与服务端 internal/admin/api 契约同源）。
 * ID 一律字符串透出（14 篇 §5 契约）。
 */

/** 仪表盘（API-ADM-01 务实版：六指标 + 今日 AI tokens 趋势简表） */
export interface AdminDashboard {
  as_of: string;
  users_total: number;
  online_now: number;
  sessions_today: number;
  msgs_today: number;
  ai_today: { requests: number; total_tokens: number };
  kb_docs: number;
  file_storage_bytes: number;
  ai_tokens_trend: Array<{ date: string; total_tokens: number }>;
}

/** 用户状态（org 域口径：1 启用 2 禁用） */
export type AdminUserStatus = 1 | 2;

/** 管理端用户行 */
export interface AdminUser {
  id: string;
  employee_no: string;
  display_name: string;
  email?: string;
  status: AdminUserStatus;
  scopes: string[];
}

/** 分页壳（cursor 翻页；next_cursor 空=到底） */
export interface CursorPage<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string;
}

/** Agent 工具策略只读快照（v0.1 恒默认策略） */
/** 工具策略行（agent_tool_policy 行级覆盖；D7 编辑器数据源） */
export interface AgentToolPolicyRow {
  subject: string;
  allowed: boolean;
  risk_override: string;
  config: string;
  updated_by: string;
  updated_at: string;
}

export interface AgentPolicySnapshot {
  version: number;
  updated_at: string;
  source: 'default' | 'table';
  policy: Record<string, unknown>;
  rows?: AgentToolPolicyRow[];
}

/** 敏感词行（0006 表；mode v0.1 恒 1=拦截） */
export interface SensitiveWord {
  id: string;
  word: string;
  mode: number;
  category?: string;
  enabled: boolean;
  created_at: string;
}

/** 词库分页（total=全量计数，策略页副标题） */
export interface WordPage extends CursorPage<SensitiveWord> {
  total: number;
}

/** 按日用量行 */
export interface UsageDaily {
  date: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 按 tier/scene 汇总行 */
export interface UsageByDim {
  key: string;
  requests: number;
  total_tokens: number;
}

/** 用量汇总（API-ADM-21 务实版） */
export interface UsageSummary {
  as_of: string;
  days: number;
  mode: 'pg' | 'memory';
  daily: UsageDaily[];
  by_tier: UsageByDim[];
  by_scene: UsageByDim[];
  total: UsageDaily;
}

/** 审计行（v0.1 落 admin_audit_action 窄表） */
export interface AuditItem {
  id: string;
  operator_id: string;
  operator_name: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  created_at: string;
}

/** 审计动作 → 中文标签（时间线渲染；未登记者原样展示 action） */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'user.disable': '禁用用户',
  'user.enable': '启用用户',
  'policy.sensitive_word.add': '新增敏感词',
  'policy.sensitive_word.delete': '删除敏感词',
};

/** AI 供应商模型清单项（ai_provider.models；id=上游真实模型名） */
export interface AIProviderModel {
  id: string;
  label?: string;
}

/** AI 供应商行（0023；公司级管理视角；keyMask=****last4） */
export interface AIProvider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  keyMask: string;
  ownerId?: string;
  models: AIProviderModel[];
  status: 1 | 2;
}

/** 路由候选（fast/strong 主备；priority 小者先） */
export interface AIRouteCandidate {
  providerId: string;
  model: string;
  priority: number;
}

/** 一条 active 路由 */
export interface AIRouteRule {
  tier: 'fast' | 'strong';
  candidates: AIRouteCandidate[];
}

/** 供应商创建/更新入参（更新时 apiKey 留空=保留） */
export interface AIProviderInput {
  name: string;
  kind?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: AIProviderModel[];
  status?: number;
}

/** 厂商预设（v0.1 国内三家：智谱/DeepSeek/自定义 OpenAI 兼容；后续按此扩展） */
export interface ProviderPreset {
  key: string;
  label: string;
  baseUrl: string;
  name: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: 'zhipu', label: '智谱开放平台', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', name: '智谱开放平台' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', name: 'DeepSeek' },
  { key: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', name: '' },
];

/** 按 baseUrl 反推预设 key（编辑态回显用；不匹配=custom） */
export function presetKeyOfBaseUrl(baseUrl: string): string {
  const hit = PROVIDER_PRESETS.find((p) => p.baseUrl && baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, ''));
  return hit?.key ?? 'custom';
}
