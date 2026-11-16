/**
 * OIDC desktop 确认链 API（D28 批2/Q2b）：
 * 深链 bbw://auth → 确认卡数据（GET confirm/info）→ 点头像确认（POST confirm）。
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
