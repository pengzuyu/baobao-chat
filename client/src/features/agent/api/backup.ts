/**
 * Agent 会话云备份 REST 客户端（08 篇 §6.3 四 API + blob 下载；
 * 服务端零知识——本层只搬运密文与 envelope）。
 */

import { http } from '../../../shared/api/http';
import type { BackupKeyEnvelope } from '../../../shared/utils/backupCrypto';

/** 备份行（服务端索引；envelope 随行供跨设备恢复） */
export interface BackupItem {
  id: string;
  localSessionId: string;
  title: string;
  encAlg: string;
  keyEnvelope: string; // JSON 字符串（BackupKeyEnvelope）
  size: number;
  createdAt: number; // ms
}

/** 创建备份（data=密文字节；Idempotency-Key 防重） */
export async function createBackup(req: {
  local_session_id: string;
  title: string;
  enc_alg: string;
  key_envelope: string;
  data: Uint8Array;
  idempotencyKey?: string;
}): Promise<BackupItem> {
  // []byte 契约：JSON base64（与 Go 端 agentBackupCreateReq.Data 对齐）
  let b64 = '';
  for (const b of req.data) b64 += String.fromCharCode(b);
  return http.post<BackupItem>(
    '/agent/sessions/backups',
    {
      local_session_id: req.local_session_id,
      title: req.title,
      enc_alg: req.enc_alg,
      key_envelope: req.key_envelope,
      data: btoa(b64),
    },
    req.idempotencyKey,
  );
}

/** 我的备份列表 */
export async function listBackups(): Promise<BackupItem[]> {
  const data = await http.get<{ items: BackupItem[] }>('/agent/sessions/backups');
  return data.items ?? [];
}

/** 恢复下载凭证（120s 一次性） */
export async function issueRestoreTicket(id: string): Promise<{ ticket: string; url: string; expires_in: number }> {
  return http.post(`/agent/sessions/backups/${encodeURIComponent(id)}/restore-ticket`, {});
}

/** 消费票据下载密文（envelope 经响应头 X-Backup-Key-Envelope 带回） */
export async function downloadBackupBlob(url: string): Promise<{ data: Uint8Array; envelope: BackupKeyEnvelope | null }> {
  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) throw new Error(`下载失败（${resp.status}）`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let envelope: BackupKeyEnvelope | null = null;
  const raw = resp.headers.get('X-Backup-Key-Envelope');
  if (raw) {
    try {
      envelope = JSON.parse(raw) as BackupKeyEnvelope;
    } catch {
      envelope = null;
    }
  }
  return { data: buf, envelope };
}

/** 删除备份 */
export async function deleteBackup(id: string): Promise<void> {
  await http.delete(`/agent/sessions/backups/${encodeURIComponent(id)}`);
}
