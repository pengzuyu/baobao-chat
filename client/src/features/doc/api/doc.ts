/**
 * 文档中心域 API 封装（D05 阶段一务实版，REST 11 项）：
 * - 文档：列表（?q= 模糊 + cursor 键集翻页）/ 新建（v1 空白）/ 详情（含正文）/
 *   重命名（6015）/ 软删进回收站（purge_at=+30d）
 * - 保存：PUT content {content_md, base_version}——乐观锁，6004 冲突红条+强制覆盖
 * - 版本：时间线（倒序）/ 恢复（restore 快照新版本）
 * - 回收站：列表 / 恢复（同名加" (恢复)"后缀）
 * - 分享：占位 share_id + 7d（假 URL，外链页阶段二）
 * mock 桩集中本文件（VITE_USE_MOCK=0 关闭后走真实 REST）。
 */

import { http } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import type { DocFile, DocListResp, RestoreResp, SaveContentResp, ShareResp, VersionListResp } from '../model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 列表+名称模糊（cursor 键集翻页；D05 API-DOC-03） */
export async function fetchDocFiles(q: string = '', cursor: string = '', limit = 50): Promise<DocListResp> {
  if (USE_MOCK) {
    await delay(250);
    const kw = q.trim().toLowerCase();
    const items = mockDocs().filter((d) => !kw || d.title.toLowerCase().includes(kw));
    return { items, next_cursor: '', has_more: false };
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return http.get<DocListResp>(`/doc/files${qs ? `?${qs}` : ''}`);
}

/** 新建 markdown 文档（建 v1 空白；同名 6015） */
export async function createDocFile(title: string): Promise<DocFile> {
  if (USE_MOCK) {
    await delay(200);
    return {
      id: `mock-doc-${Date.now()}`, owner_id: 'u-1001', title, folder_id: '0', scope: 'personal',
      status: 1, current_version: 1, content_md: '', created_at: Date.now(), updated_at: Date.now(),
    };
  }
  return http.post<DocFile>('/doc/files', { title });
}

/** 文档详情（元数据+当前正文；6005 不存在/回收站） */
export async function fetchDocFile(docId: string): Promise<DocFile> {
  if (USE_MOCK) return { ...mockDocs()[0], id: docId, content_md: '# mock 文档\n\n正文内容。' };
  return http.get<DocFile>(`/doc/files/${encodeURIComponent(docId)}`);
}

/** 重命名（6015 同名） */
export async function renameDocFile(docId: string, title: string): Promise<DocFile> {
  if (USE_MOCK) return { ...mockDocs()[0], id: docId, title };
  return http.patch<DocFile>(`/doc/files/${encodeURIComponent(docId)}`, { title });
}

/** 移入回收站（30 天保留期；返回回收站态行） */
export async function trashDocFile(docId: string): Promise<DocFile> {
  if (USE_MOCK) {
    await delay(150);
    return { ...mockDocs()[0], id: docId, status: 2, purge_at: Date.now() + 30 * 86400_000 };
  }
  return http.delete<DocFile>(`/doc/files/${encodeURIComponent(docId)}`);
}

/**
 * 乐观锁保存正文（PUT content；base_version 必填）。
 * 冲突 → 抛 ApiError(code=6004)：调用方展示红条 + 强制覆盖选项
 * （强制覆盖语义 = 重取详情拿最新 current_version 再存，服务端不设 force 旁路，06 §7.1 口径）。
 */
export async function saveDocContent(docId: string, baseVersion: number, contentMd: string): Promise<SaveContentResp> {
  if (USE_MOCK) {
    await delay(300);
    return {
      file: { ...mockDocs()[0], id: docId, current_version: baseVersion + 1, content_md: contentMd, updated_at: Date.now() },
      version: {
        id: `mock-v-${baseVersion + 1}`, doc_id: docId, version: baseVersion + 1,
        editor_id: 'u-1001', snapshot_type: 'manual', created_at: Date.now(),
      },
      next_version: baseVersion + 1,
    };
  }
  return http.put<SaveContentResp>(`/doc/files/${encodeURIComponent(docId)}/content`, {
    content_md: contentMd,
    base_version: baseVersion,
  });
}

/** 版本时间线（version 倒序；cursor 翻页） */
export async function fetchDocVersions(docId: string, cursor: string = '', limit = 50): Promise<VersionListResp> {
  if (USE_MOCK) {
    await delay(200);
    const items = [
      { id: 'v3', doc_id: docId, version: 3, editor_id: 'u-1001', snapshot_type: 'manual', created_at: Date.now() - 3600_000 },
      { id: 'v2', doc_id: docId, version: 2, editor_id: 'u-1001', snapshot_type: 'manual', created_at: Date.now() - 7200_000 },
      { id: 'v1', doc_id: docId, version: 1, editor_id: 'u-1001', snapshot_type: 'create', created_at: Date.now() - 86400_000 },
    ];
    return { items, next_cursor: '', has_more: false };
  }
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return http.get<VersionListResp>(`/doc/files/${encodeURIComponent(docId)}/versions${qs ? `?${qs}` : ''}`);
}

/** 恢复目标版本（restore 快照新版本+正文回写；6013） */
export async function restoreDocVersion(docId: string, version: number): Promise<RestoreResp> {
  if (USE_MOCK) {
    await delay(250);
    return {
      file: { ...mockDocs()[0], id: docId, current_version: 4 },
      new_version_no: 4,
      renamed: false,
    };
  }
  return http.post<RestoreResp>(`/doc/files/${encodeURIComponent(docId)}/versions/${version}/restore`);
}

/** 回收站列表（purge_at 升序；过期行服务端已过滤） */
export async function fetchDocTrash(cursor: string = '', limit = 50): Promise<DocListResp> {
  if (USE_MOCK) {
    await delay(200);
    return {
      items: [
        {
          id: 'mock-doc-9', owner_id: 'u-1001', title: '旧方案（已删）', folder_id: '0', scope: 'personal',
          status: 2, purge_at: Date.now() + 29 * 86400_000, current_version: 2,
          created_at: Date.now() - 10 * 86400_000, updated_at: Date.now() - 86400_000,
        },
      ],
      next_cursor: '',
      has_more: false,
    };
  }
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return http.get<DocListResp>(`/doc/trash${qs ? `?${qs}` : ''}`);
}

/** 回收站恢复（同名冲突服务端自动加" (恢复)"后缀；6011 过期/不存在） */
export async function restoreDocFromTrash(docId: string): Promise<RestoreResp> {
  if (USE_MOCK) {
    await delay(200);
    return { file: { ...mockDocs()[0], id: docId }, new_version_no: 1, renamed: false };
  }
  return http.post<RestoreResp>(`/doc/trash/${encodeURIComponent(docId)}/restore`);
}

/** 分享占位（share_id + 7d；假 URL——外链页阶段二，登记） */
export async function shareDoc(docId: string): Promise<ShareResp> {
  if (USE_MOCK) {
    await delay(200);
    const sid = `mockshare${Date.now().toString(36)}`;
    return { share_id: sid, url: `bbw://doc/s/${sid}`, expires_at: Date.now() + 7 * 86400_000, note: 'mock 占位链接' };
  }
  return http.post<ShareResp>(`/doc/files/${encodeURIComponent(docId)}/share`);
}

// ── doc_card 卡片消息发送（WS msg.send type=doc_card；06 §4.8 IM 联动简版）──

/** 会话下拉项（GET /convs 最小投影——不引 im feature 类型，D01 §12.2） */
export interface DocConvOption {
  id: string;
  name: string;
}

/** 可发送卡片的目标会话列表（REST /convs） */
export async function fetchConvsForCard(): Promise<DocConvOption[]> {
  if (USE_MOCK) return [{ id: 'mock-conv-1', name: 'alice-bob（mock）' }];
  const data = await http.get<{ items: Array<{ id: string; name: string }> }>('/convs');
  return data.items.map((c) => ({ id: c.id, name: c.name }));
}

/** 发送 doc_card 消息到会话（WS msg.send；服务端透传 body 原样落流） */
export async function sendDocCard(convId: string, docId: string, title: string, version: number): Promise<void> {
  if (USE_MOCK) {
    await delay(200);
    return;
  }
  await wsClient.request('msg.send', {
    conv_id: convId,
    client_msg_id: crypto.randomUUID(),
    type: 'doc_card',
    body: { doc_id: docId, title, version },
  });
}

// ── 工具与 mock 桩（六态走查用；不散落组件）──

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockDocs(): DocFile[] {
  return [
    {
      id: 'mock-doc-1', owner_id: 'u-1001', title: '季度汇报（mock）', folder_id: '0', scope: 'personal',
      status: 1, current_version: 3, created_at: Date.now() - 86400_000, updated_at: Date.now() - 3600_000,
    },
    {
      id: 'mock-doc-2', owner_id: 'u-1001', title: '接口说明（mock）', folder_id: '0', scope: 'personal',
      status: 1, current_version: 1, created_at: Date.now() - 43200_000, updated_at: Date.now() - 7200_000,
    },
  ];
}
