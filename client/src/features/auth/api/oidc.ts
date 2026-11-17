/**
 * OIDC desktop 确认链 API（D28 批2/Q2b）：
 * 深链 bbc://auth → 确认卡数据（GET confirm/info）→ 点头像确认（POST confirm）。
 * 端点在 /oauth2/*（非 /api/v1 前缀）——path 传绝对 URL，http.ts resolveUrl 直通。
 */

import { apiOrigin, http } from '../../../shared/api/http';

export interface OidcConfirmInfo {
  app_name: string;
  client_id: string;
  scopes: string[];
  /** 6 位确认码（与浏览器等待页大字核对一致再确认——防伪造深链钓鱼，D28 §5.1） */
  code: string;
  /** 既有授权已覆盖 → 轻量形态：点头像即走，免码核对 */
  covered_by_grant: boolean;
  expires_in_sec: number;
}

export async function apiOidcConfirmInfo(reqId: string): Promise<OidcConfirmInfo> {
  return http.get<OidcConfirmInfo>(`${apiOrigin()}/oauth2/confirm/info?id=${encodeURIComponent(reqId)}`);
}

/** 确认提交；covered 场景 code 传空。1012=码不匹配（details.attempts_left）·1010=过期 */
export async function apiOidcConfirm(reqId: string, code: string): Promise<void> {
  await http.post(`${apiOrigin()}/oauth2/confirm`, { id: reqId, code });
}

/** ── 用户面授权管理（D28 批3/Q3：设置·登录与授权） ── */

export interface OidcGrant {
  client_id: string;
  app_name: string;
  scopes: string[];
  granted_at: string;
  last_used_at: string;
  revoked: boolean;
}

export interface OidcSession {
  id: number;
  did: string;
  user_agent: string;
  ip: string;
  last_used_at: string;
  created_at: string;
  expires_at: string;
}

export async function apiMeOidcGrants(): Promise<OidcGrant[]> {
  const d = await http.get<{ items: OidcGrant[] }>('/me/oidc/grants');
  return d.items ?? [];
}

/** 撤销=该应用 refresh/access 全灭（已签 access ≤15min 自然过期） */
export async function apiMeOidcRevokeGrant(clientId: string): Promise<void> {
  await http.post('/me/oidc/grants/revoke', { client_id: clientId });
}

export async function apiMeOidcSessions(): Promise<OidcSession[]> {
  const d = await http.get<{ items: OidcSession[] }>('/me/oidc/sessions');
  return d.items ?? [];
}

/** 浏览器会话远端下线（该浏览器的 SSO 免密立即失效） */
export async function apiMeOidcRevokeSession(id: number): Promise<void> {
  await http.delete(`/me/oidc/sessions/${id}`);
}

/** ── admin 面 OIDC 客户端管理（Q3：与 eco 应用发布联动的凭证面） ── */

export interface AdminOidcClient {
  id: number;
  client_id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  status: string;
  created_at: string;
}

export async function apiAdminOidcClients(): Promise<AdminOidcClient[]> {
  const d = await http.get<{ items: AdminOidcClient[] }>('/admin/oidc/clients');
  return d.items ?? [];
}

export async function apiAdminOidcClientCreate(body: { name: string; redirect_uris: string[]; scopes?: string[] }): Promise<AdminOidcClient> {
  return http.post<AdminOidcClient>('/admin/oidc/clients', body);
}

export async function apiAdminOidcClientStatus(id: number, status: 'active' | 'disabled'): Promise<void> {
  await http.patch('/admin/oidc/clients/status', { id, status });
}
