/**
 * 文件域 API 封装（D06 阶段一务实版）：
 * - upload：multipart 单请求直传 ≤20MB（XHR 携带进度回调；分片/断点续传/秒传阶段二）
 * - getTicket：短期一次性下载票据（120s；4014 失效/复用）
 * - downloadUrl：票据相对路径 → 绝对地址（img src / window.open 直用）
 * - 我的文件列表 / owner 软删
 */

import { ApiError, apiOrigin, authToken, getErrorText, http } from '../../../shared/api/http';
import { sha256HexStream } from './sha256';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

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

/** 取下载票据（owner 或会话成员；120s。variant=240/720 缩略变体——服务端惰性生成、
 * 无变体自动回退原图，客户端无需判定；缺省=原图） */
export async function getDownloadTicket(fileId: string, variant?: 'origin' | '240' | '720'): Promise<DownloadTicket> {
  if (USE_MOCK) return { url: `/api/v1/files/dl?t=mock-${fileId}`, expiresIn: 120 };
  const q = variant && variant !== 'origin' ? `?variant=${variant}` : '';
  return http.get<DownloadTicket>(`/files/ticket/${encodeURIComponent(fileId)}${q}`);
}

/** 票据 URL → 可用地址：S3 模式为预签名绝对地址直用（D25）；Local 模式相对路径拼 API origin */
export function downloadUrl(ticketUrl: string): string {
  if (/^https?:\/\//i.test(ticketUrl)) return ticketUrl;
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
 * 位图断点续传 → complete）+ 会话文件聚合（分享外链随 2026-11 瘦身移除）
 * ──────────────────────────────────────────────────────────── */

/** 秒传预检结果（POST /files/check） */
export interface CheckResult {
  file_id?: string;
  dedup: boolean;
}

/** 分片预签名 URL（D25 presign 模式；PUT 原始字节、免 Authorization、1h 时效、批 ≤32） */
export interface UploadPartURL {
  no: number;
  url: string;
  method: string;
  expires_at: number; // ms
}

/** 分片会话初始化结果（POST /files/uploads；秒传命中直接回 file_id） */
export interface UploadInitResult {
  upload_id?: string;
  part_size?: number;
  part_total?: number;
  mode?: string; // presign=客户端 PUT 直传（D25）；缺省/relay=PATCH 中转
  parts?: UploadPartURL[]; // presign 首批
  file_id?: string;
  dedup: boolean;
}

/** 断点续传位图（GET /files/uploads/{id}?from_part=N；from_part>0 附预签名续批） */
export interface UploadStatusResult {
  upload_id: string;
  received: number[];
  parts?: UploadPartURL[];
}

/** complete 结果（POST /files/uploads/{id}/complete；幂等回放同结果） */
export interface CompleteResult {
  file_id: string;
  dedup?: boolean;
}

/** 本地 sha256（hex；流式切片增量——大文件不再整块入内存，D25。见 sha256.ts） */
export async function sha256Hex(file: File): Promise<string> {
  return sha256HexStream(file);
}

/** 秒传预检（策略再校验在服务端：黑名单/上限不因预检豁免） */
export async function checkFile(sha256: string, size: number, name: string, convId?: string): Promise<CheckResult> {
  return http.post<CheckResult>('/files/check', {
    sha256, size, name, content_type: '', conv_id: convId ? Number(convId) : 0,
  });
}

/** 建分片会话（7 天有效；part_size 由服务端定：presign=8MB/relay=4MB——D25 拍板⑤） */
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

/** 断点续传位图（已落盘分片号；会话过期 4008。fromPart>0 附预签名续批） */
export async function fetchUploadStatus(uploadId: string, fromPart = 0): Promise<UploadStatusResult> {
  const q = fromPart > 0 ? `?from_part=${fromPart}` : '';
  return http.get<UploadStatusResult>(`/files/uploads/${encodeURIComponent(uploadId)}${q}`);
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

/** 分片阈值：超过走分片会话链路（阈值下 multipart 中转直传保留 XHR 进度；D25 拍板④） */
const CHUNKED_THRESHOLD = 8 << 20;

/** URL 到期保护边（07 §4.1：到期前 10min 视为失效主动续签） */
const PRESIGN_EXPIRE_MARGIN = 10 * 60_000;

/**
 * 预签名直传引擎（D25 presign 模式）：并行 3 PUT 直传 MinIO（大流量不经服务端）；
 * 断点位图跳过已传分片；URL 临期/403 自动续签重批（不计失败次数）；单片重试 ≤3
 * 指数退避；连续失败降并行 1（弱网）。进度按字节比例。
 */
async function uploadPresigned(
  file: File,
  init: UploadInitResult,
  onProgress?: (percent: number, phase?: 'dedup' | 'direct' | 'chunked' | 'resuming') => void,
): Promise<CompleteResult> {
  const uploadId = init.upload_id!;
  const partSize = init.part_size!;
  const total = init.part_total!;
  const sizeOf = (no: number): number =>
    no === total ? file.size - (no - 1) * partSize : partSize;

  // URL 缓存（init 首批 + status 续批回填）
  const urls = new Map<number, UploadPartURL>();
  (init.parts ?? []).forEach((p) => urls.set(p.no, p));

  // 断点续传：位图跳过（进度从已有字节起算；resuming 相=07 篇 OQ-C29 枚举）
  let received = new Set<number>();
  try {
    const st = await fetchUploadStatus(uploadId);
    (st.parts ?? []).forEach((p) => urls.set(p.no, p));
    received = new Set(st.received);
  } catch {
    /* 位图拉取失败按全量重传（分片覆盖写幂等） */
  }
  let done = 0;
  received.forEach((no) => (done += sizeOf(no)));
  const resuming = received.size > 0;
  const report = () =>
    onProgress?.(Math.min(99, Math.round((done / file.size) * 100)), resuming ? 'resuming' : 'chunked');
  report();

  // 取分片 URL：缓存未到期直用；临期/缺失 → status?from_part={no} 续批
  const ensureUrl = async (no: number): Promise<string> => {
    const p = urls.get(no);
    if (p && p.expires_at - PRESIGN_EXPIRE_MARGIN > Date.now()) return p.url;
    const st = await fetchUploadStatus(uploadId, no);
    (st.parts ?? []).forEach((q) => urls.set(q.no, q));
    const np = urls.get(no);
    if (!np) throw new ApiError(9004, getErrorText(9004));
    return np.url;
  };

  // 单片 PUT（403/400=签名过期 → 重签一次重试，不计失败）
  const putPart = async (no: number, allowResign: boolean): Promise<void> => {
    const url = await ensureUrl(no);
    const blob = file.slice((no - 1) * partSize, Math.min(no * partSize, file.size));
    const resp = await fetch(url, { method: 'PUT', body: blob }); // 预签名即凭证，免 Authorization
    if ((resp.status === 403 || resp.status === 400) && allowResign) {
      urls.delete(no);
      return putPart(no, false);
    }
    if (!resp.ok) throw new ApiError(9004, `分片上传失败（${resp.status}）`);
    done += sizeOf(no);
    report();
  };

  // 工作池：queue + N 协程；activeGate 落实降并行（连败 2 → 并行 1，多出协程等待）
  const queue: number[] = [];
  for (let no = 1; no <= total; no++) if (!received.has(no)) queue.push(no);
  let qi = 0;
  let parallel = 3;
  let active = 0;
  let consecutiveFails = 0;
  let firstErr: unknown = null;
  const worker = async (): Promise<void> => {
    while (qi < queue.length && !firstErr) {
      while (active >= parallel && !firstErr) await new Promise((r) => setTimeout(r, 150));
      if (firstErr) return;
      const no = queue[qi++];
      active++;
      try {
        await putPart(no, true);
        consecutiveFails = 0;
      } catch (e) {
        // 单片三次指数退避；仍败即全局止（首错透传）
        let last = e;
        for (let attempt = 1; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          try {
            await putPart(no, true);
            last = null;
            break;
          } catch (e2) {
            last = e2;
          }
        }
        if (last) {
          firstErr = firstErr ?? last;
          break;
        }
        if (++consecutiveFails >= 2) parallel = 1; // 弱网：降并行
      } finally {
        active--;
      }
    }
  };
  const workers = Array.from({ length: Math.min(3, queue.length || 1) }, () => worker());
  await Promise.all(workers);
  if (firstErr) throw firstErr instanceof ApiError ? firstErr : new ApiError(9004, getErrorText(9004));
  return completeChunkedUpload(uploadId);
}

/**
 * 智能上传（D06+D25 统一入口）：
 * ① sha256（流式增量）→ init 秒传（命中零上传直接回 file_id）
 * ② 未命中且 ≤8MB → multipart 中转直传（既有 XHR 进度路径；拍板④小文件保留中转）
 * ③ 未命中且 >8MB → 分片会话：mode=presign → 直传引擎（并行 3/续签/降级）；
 *    mode=relay（Local 回落）→ 顺序 PATCH（part_size 用服务端下发值）
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
    content_type: file.type, conv_id: convId, part_size: 0, // 服务端定片宽（presign=8MB/relay=4MB）
  });
  if (init.dedup && init.file_id) {
    onProgress?.(100, 'dedup');
    return { ...localMeta(), id: init.file_id, dedup: true };
  }
  if (!init.upload_id || !init.part_total) throw new ApiError(9004, getErrorText(9004));
  const uploadId = init.upload_id;
  const total = init.part_total;

  // presign 模式（D25）：并行 PUT 直传
  if (init.mode === 'presign') {
    const done2 = await uploadPresigned(file, init, onProgress);
    onProgress?.(100, 'chunked');
    return { ...localMeta(), id: done2.file_id, dedup: done2.dedup };
  }

  // relay 模式（Local 回落）：顺序 PATCH（part_size 用服务端下发值，不再本地硬编码）
  const partSize = init.part_size ?? 4 << 20;
  let received = new Set<number>();
  try {
    const st = await fetchUploadStatus(uploadId);
    received = new Set(st.received);
  } catch {
    /* 位图拉取失败按全量重传（服务端覆盖写幂等） */
  }
  const resuming = received.size > 0;
  let done = 0;
  received.forEach((no) => {
    done += no === total ? file.size - (no - 1) * partSize : partSize;
  });
  const report = () => onProgress?.(Math.min(99, Math.round((done / file.size) * 100)), resuming ? 'resuming' : 'chunked');
  report();
  for (let no = 1; no <= total; no++) {
    if (received.has(no)) continue;
    const start = (no - 1) * partSize;
    const blob = file.slice(start, Math.min(start + partSize, file.size));
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
