/**
 * 文件域 API 封装（D06 阶段一务实版）：
 * - upload：multipart 单请求直传 ≤20MB（XHR 携带进度回调；分片/断点续传/秒传阶段二）
 * - getTicket：短期一次性下载票据（120s；4014 失效/复用）
 * - downloadUrl：票据相对路径 → 绝对地址（img src / window.open 直用）
 * - 我的文件列表 / owner 软删
 */

import { ApiError, apiOrigin, authToken, getErrorText, http } from '../../../shared/api/http';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 上传响应（POST /files/upload；去重命中 dedup=true 且返回原行元数据） */
export interface UploadResult {
  id: string;
  name: string;
  ext?: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  dedup?: boolean;
}

/** 下载票据响应（GET /files/{id}/ticket） */
export interface DownloadTicket {
  url: string; // 相对路径 /api/v1/files/dl?t=...
  expiresIn: number; // 秒（恒 120）
}

/** 我的文件列表项（GET /files/me） */
export interface MyFileItem {
  id: string;
  name: string;
  ext?: string;
  size: number;
  contentType: string;
  width?: number;
  height?: number;
  source: 'upload' | 'message';
  convId?: string;
  createdAt: number;
}

/**
 * 上传文件（multipart：file + 可选 conv_id）。
 * fetch 无上传进度回调 → XMLHttpRequest 实现（D06 PFL-03 进度条数据源）。
 * 失败抛 ApiError（4002 类型禁止 / 4009 超限等文案经 getErrorText）。
 */
export function uploadFile(
  file: File,
  convId?: string,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiOrigin()}/api/v1/files/upload`);
    const token = authToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onerror = () => reject(new ApiError(9004, getErrorText(9004)));
    xhr.onabort = () => reject(new ApiError(9004, '上传已取消'));
    xhr.onload = () => {
      const envelope = xhr.response as { code?: number; data?: UploadResult; message?: string; trace_id?: string } | null;
      if (xhr.status !== 200 || !envelope) {
        reject(new ApiError(envelope?.code ?? 9004, envelope ? getErrorText(envelope.code ?? 9004) : getErrorText(9004)));
        return;
      }
      if (envelope.code !== 0 || !envelope.data) {
        const err = new ApiError(envelope.code ?? 9004, getErrorText(envelope.code ?? 9004), { traceId: envelope.trace_id });
        reject(err);
        return;
      }
      if (onProgress) onProgress(100);
      resolve(envelope.data);
    };

    const fd = new FormData();
    fd.append('file', file, file.name);
    if (convId) fd.append('conv_id', convId);
    xhr.send(fd);
  });
}

/** 取下载票据（owner 或会话成员；一次性 120s） */
export async function getDownloadTicket(fileId: string): Promise<DownloadTicket> {
  if (USE_MOCK) return { url: `/api/v1/files/dl?t=mock-${fileId}`, expiresIn: 120 };
  return http.get<DownloadTicket>(`/files/${encodeURIComponent(fileId)}/ticket`);
}

/** 票据相对路径 → 绝对地址（服务端返回 /api/v1 前缀相对 URL） */
export function downloadUrl(ticketUrl: string): string {
  return `${apiOrigin()}${ticketUrl}`;
}

/** 我的文件列表（软删排除；v0.1 全量不分页） */
export async function fetchMyFiles(): Promise<MyFileItem[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: MyFileItem[]; has_more: boolean }>('/files/me');
  return data.items;
}

/** owner 软删（DELETE /files/{id}；回收站语义） */
export async function deleteMyFile(fileId: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/files/${encodeURIComponent(fileId)}`);
}
