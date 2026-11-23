/**
 * 管理后台 · 客户端发布（D39）：安装包上传（预签名直传对象存储）→ 发布/撤回/回滚。
 *
 * 流程（上传）：
 *   1) presign 取直传票据 {storage_key, upload_url}
 *   2) PUT 文件到 upload_url（浏览器直传 RustFS，不经 Go 服务）
 *   3) 本地算 sha256 + 读 .sig 文本 → register 登记草稿
 * 发布：整版本四平台齐后 publish；回滚=把历史版本 published_at 提到最新（清单指针）。
 */

import { http } from '../../../shared/api/http';

export interface ClientRelease {
  id: number;
  version: string;
  channel: string;
  platform: string;
  filename: string;
  size: number;
  sha256: string;
  storage_key: string;
  has_signature: boolean;
  notes: string;
  status: 'draft' | 'published' | 'revoked';
  published_at?: string;
  created_at: string;
}

export interface ReleaseList {
  items: ClientRelease[];
  live_version: string;
}

export interface PresignResp {
  storage_key: string;
  upload_url: string;
  expires_in: number;
}

export async function apiReleaseList(channel: string): Promise<ReleaseList> {
  return http.get<ReleaseList>(`/admin/client-releases?channel=${encodeURIComponent(channel)}`);
}

export async function apiReleasePresign(body: {
  version: string;
  channel: string;
  platform: string;
  filename: string;
}): Promise<PresignResp> {
  return http.post<PresignResp>('/admin/client-releases/presign', body);
}

export async function apiReleaseRegister(body: {
  version: string;
  channel: string;
  platform: string;
  filename: string;
  size: number;
  sha256: string;
  storage_key: string;
  signature: string;
  notes: string;
}): Promise<ClientRelease> {
  return http.post<ClientRelease>('/admin/client-releases', body);
}

export async function apiReleasePublish(version: string, channel: string): Promise<{ published: number }> {
  return http.post<{ published: number }>('/admin/client-releases/publish', { version, channel });
}

export async function apiReleaseRevoke(version: string, channel: string): Promise<{ revoked: number }> {
  return http.post<{ revoked: number }>('/admin/client-releases/revoke', { version, channel });
}

export async function apiReleaseRollback(version: string, channel: string): Promise<{ rolled_back_to: string }> {
  return http.post<{ rolled_back_to: string }>('/admin/client-releases/rollback', { version, channel });
}

export async function apiReleaseDelete(id: number): Promise<{ ok: boolean }> {
  return http.delete<{ ok: boolean }>(`/admin/client-releases/${id}`);
}

/** 浏览器直传文件到预签名 URL（不经应用服务） */
export async function putFileDirect(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', body: file });
  if (!res.ok) throw new Error(`直传失败：HTTP ${res.status}`);
}

/** 本地计算 SHA-256（hex；70MB 内一次性读入内存可接受） */
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}