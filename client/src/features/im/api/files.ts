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

/** 下载票据响应（GET /files/ticket/{id}；路由修正：原 {id}/ticket 与 convs/uploads 段二义） */
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
  /** 消息锚点（群文件定位消息跳转依据；0/缺省=未关联，OQ-B24） */
  msgSeq?: number;
  /** 锚点消息已撤回：文件保留可下载，锚点置灰不可跳转（OQ-B24） */
  recalled?: boolean;
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
  return http.get<DownloadTicket>(`/files/ticket/${encodeURIComponent(fileId)}`);
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

/* ────────────────────────────────────────────────────────────
 * D06 阶段二：分片上传会话（check 秒传 → init → PATCH 分片 →
 * 位图断点续传 → complete）+ 分享外链 + 会话文件聚合
 * ──────────────────────────────────────────────────────────── */

/** 秒传预检结果（POST /files/check） */
export interface CheckResult {
  file_id?: string;
  dedup: boolean;
}

/** 分片会话初始化结果（POST /files/uploads；秒传命中直接回 file_id） */
export interface UploadInitResult {
  upload_id?: string;
  part_size?: number;
  part_total?: number;
  file_id?: string;
  dedup: boolean;
}

/** 断点续传位图（GET /files/uploads/{id}） */
export interface UploadStatusResult {
  upload_id: string;
  received: number[];
}

/** complete 结果（POST /files/uploads/{id}/complete；幂等回放同结果） */
export interface CompleteResult {
  file_id: string;
  dedup?: boolean;
}

/** 分享创建结果（POST /files/{id}/share；code 一次性返回） */
export interface ShareCreateResult {
  share_id: string;
  code: string;
  url: string;
  expires_at?: number;
}

/** 分享解析响应（GET /files/s/{code}；命中即计数+1 并附一次性下载票据） */
export interface ShareView {
  file: MyFileItem;
  used_times: number;
  max_times?: number;
  need_pwd?: boolean;
  ticket: DownloadTicket;
}

/** 分享创建要素（07 §4.4：有效期/次数/密码三选一组合） */
export interface ShareCreateReq {
  expire_mode: 1 | 2 | 3; // 1 永不 2 时限 3 次数
  expires_at?: number; // ms；mode=2 必填
  max_times?: number; // mode=3 必填
  password?: string; // 可选
}

/** 本地 sha256（hex；单文件 ≤20MB 整块计算——流式实现随大文件支持阶段三，登记） */
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 秒传预检（策略再校验在服务端：黑名单/上限不因预检豁免） */
export async function checkFile(sha256: string, size: number, name: string, convId?: string): Promise<CheckResult> {
  return http.post<CheckResult>('/files/check', {
    sha256, size, name, content_type: '', conv_id: convId ? Number(convId) : 0,
  });
}

/** 建分片会话（7 天有效；part_size 缺省 4MB） */
export async function initChunkedUpload(req: {
  sha256: string; name: string; size: number; content_type?: string; conv_id?: string; part_size?: number;
}): Promise<UploadInitResult> {
  return http.post<UploadInitResult>('/files/uploads', {
    sha256: req.sha256,
    name: req.name,
    size: req.size,
    content_type: req.content_type ?? '',
    conv_id: req.conv_id ? Number(req.conv_id) : 0,
    part_size: req.part_size ?? 0,
  });
}

/** 断点续传位图（已落盘分片号；会话过期 4008） */
export async function fetchUploadStatus(uploadId: string): Promise<UploadStatusResult> {
  return http.get<UploadStatusResult>(`/files/uploads/${encodeURIComponent(uploadId)}`);
}

/** 直传一片（PATCH 原始字节；覆盖写=坏块重传；超 part_size 4009） */
export async function uploadPart(uploadId: string, no: number, blob: Blob): Promise<void> {
  const res = await fetch(`${apiOrigin()}/api/v1/files/uploads/${encodeURIComponent(uploadId)}/${no}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: blob,
  });
  let envelope: { code?: number; message?: string } | null = null;
  try {
    envelope = (await res.json()) as { code?: number; message?: string };
  } catch {
    /* 非 JSON 响应按 9004 处理 */
  }
  if (!res.ok || !envelope || envelope.code !== 0) {
    throw new ApiError(envelope?.code ?? 9004, getErrorText(envelope?.code ?? 9004));
  }
}

/** 合并+整体 sha 校验（不一致 4006 作废）→ 落位建行 */
export async function completeChunkedUpload(uploadId: string): Promise<CompleteResult> {
  return http.post<CompleteResult>(`/files/uploads/${encodeURIComponent(uploadId)}/complete`, {});
}

/** 分片阈值：超过则走分片链路（4MB/片，07 §1.2；阈值下 multipart 直传保留 XHR 进度） */
const CHUNKED_THRESHOLD = 8 << 20;
const PART_SIZE = 4 << 20;

/**
 * 智能上传（D06 阶段二统一入口）：
 * ① sha256 → check 秒传（命中零上传直接回 file_id）
 * ② 未命中且 ≤8MB → multipart 直传（既有 XHR 进度路径）
 * ③ 未命中且 >8MB → 分片会话：init → 位图断点续传（跳过已收分片）→
 *    顺序 PATCH → complete；进度按字节比例（续传从已有分片起算）
 * mock 模式直接走 multipart（服务端不在场，秒传/分片无意义）
 */
export async function uploadFileSmart(
  file: File,
  convId?: string,
  onProgress?: (percent: number, phase?: 'dedup' | 'direct' | 'chunked' | 'resuming') => void,
): Promise<UploadResult> {
  const localMeta = (): UploadResult => ({
    id: '',
    name: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
  });
  if (USE_MOCK || file.size <= CHUNKED_THRESHOLD) {
    // 小文件：先 check 秒传（命中免上传），未命中 multipart 直传
    if (!USE_MOCK) {
      try {
        const sha = await sha256Hex(file);
        const chk = await checkFile(sha, file.size, file.name, convId);
        if (chk.dedup && chk.file_id) {
          onProgress?.(100, 'dedup');
          return { ...localMeta(), id: chk.file_id, dedup: true };
        }
      } catch {
        /* check 失败不阻断——回退直传（预检是优化不是依赖） */
      }
    }
    return uploadFile(file, convId, onProgress);
  }
  // 大文件：分片会话（check 语义并入 init——命中直接建行）
  const sha = await sha256Hex(file);
  const init = await initChunkedUpload({
    sha256: sha, name: file.name, size: file.size,
    content_type: file.type, conv_id: convId, part_size: PART_SIZE,
  });
  if (init.dedup && init.file_id) {
    onProgress?.(100, 'dedup');
    return { ...localMeta(), id: init.file_id, dedup: true };
  }
  if (!init.upload_id || !init.part_total) throw new ApiError(9004, getErrorText(9004));
  const uploadId = init.upload_id;
  const total = init.part_total;
  // 断点续传：已收分片跳过（进度从已有字节起算；resuming 相=07 篇 OQ-C29 枚举）
  let received = new Set<number>();
  try {
    const st = await fetchUploadStatus(uploadId);
    received = new Set(st.received);
  } catch {
    /* 位图拉取失败按全量重传（服务端覆盖写幂等） */
  }
  const resuming = received.size > 0;
  const doneBytes0 = received.size * PART_SIZE;
  let done = doneBytes0;
  const report = () => onProgress?.(Math.min(99, Math.round((done / file.size) * 100)), resuming ? 'resuming' : 'chunked');
  report();
  for (let no = 1; no <= total; no++) {
    if (received.has(no)) continue;
    const start = (no - 1) * PART_SIZE;
    const blob = file.slice(start, Math.min(start + PART_SIZE, file.size));
    await uploadPart(uploadId, no, blob);
    done += blob.size;
    report();
  }
  const done2 = await completeChunkedUpload(uploadId);
  onProgress?.(100, 'chunked');
  return { ...localMeta(), id: done2.file_id, dedup: done2.dedup };
}

/** 会话文件聚合（群文件页签；成员可见） */
export async function fetchConvFiles(convId: string): Promise<MyFileItem[]> {
  if (USE_MOCK) return [];
  const data = await http.get<{ items: MyFileItem[] }>(`/files/convs/${encodeURIComponent(convId)}`);
  return data.items;
}

/** 创建分享（owner；code 一次性返回） */
export async function createFileShare(fileId: string, req: ShareCreateReq): Promise<ShareCreateResult> {
  return http.post<ShareCreateResult>(`/files/${encodeURIComponent(fileId)}/share`, req);
}

/** 解析分享（密码二段式：首访无密码 → 4011 need_pwd；命中计数+直发票据） */
export async function resolveFileShare(code: string, password?: string): Promise<ShareView> {
  const q = password ? `?password=${encodeURIComponent(password)}` : '';
  return http.get<ShareView>(`/files/s/${encodeURIComponent(code)}${q}`);
}

/** 取消分享（creator；链接即刻失效） */
export async function revokeFileShare(code: string): Promise<void> {
  if (USE_MOCK) return;
  await http.delete(`/files/s/${encodeURIComponent(code)}`);
}
