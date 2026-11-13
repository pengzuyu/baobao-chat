/**
 * 统一 REST 客户端（14 篇 §5）：
 * - 响应包解包 {code, data, trace_id}，code!==0 抛 ApiError
 * - token 注入：由 features/auth 经 setTokenProvider 注册（shared 不得 import features，D01 §12.2）
 * - 错误码→中文文案映射表（14 篇 §7 主流码；文案只依赖 code 不依赖服务端 message，D01 §11）
 * - 写操作幂等：调用方传 Idempotency-Key（14 篇 §5.3）
 */

/** REST 统一响应包（14 篇 §5.2） */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  message?: string;
  details?: Record<string, unknown>;
  trace_id?: string;
}

/** 业务错误：携带错误码 / trace_id / 附加细节（如 1007 锁定剩余秒数） */
export class ApiError extends Error {
  readonly code: number;
  readonly traceId?: string;
  readonly details?: Record<string, unknown>;
  /** 429 / 1007 场景的重试等待秒数 */
  readonly retryAfterSec?: number;
  /**
   * 认领旗标（2026-11-12 全局兜底机制）：调用方自己展示了错误（errText/内联错误条）
   * 或有意静默（后台预取）时置真——未认领的错由全局 notifier 兜底 toast，
   * 从此「catch 静默吞掉」不再等于「用户看不见」。
   */
  claimed = false;

  constructor(code: number, message: string, options?: { traceId?: string; details?: Record<string, unknown>; retryAfterSec?: number }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = options?.traceId;
    this.details = options?.details;
    this.retryAfterSec = options?.retryAfterSec;
  }

  /** 认领（自展示/有意静默）——认领后不再触发全局兜底提示 */
  claim(): ApiError {
    this.claimed = true;
    return this;
  }
}

/** 全局兜底 notifier（main.tsx 装配=antd message；测试/特殊宿主可置空） */
let apiErrorNotifier: ((e: ApiError) => void) | null = null;
export function setApiErrorNotifier(fn: ((e: ApiError) => void) | null): void {
  apiErrorNotifier = fn;
}

/** 抛出即调度兜底：一个宏任务内未被认领 → 全局 toast（同步 catch 有机会先认领） */
function scheduleFallback(err: ApiError): ApiError {
  if (apiErrorNotifier) {
    setTimeout(() => {
      if (!err.claimed) apiErrorNotifier?.(err);
    }, 0);
  }
  return err;
}

/** 取错误文案并认领（自展示场景统一入口：认领+服务端 message 优先+码表回退） */
export function errText(e: unknown, fallback = '操作失败，请稍后重试'): string {
  if (e instanceof ApiError) {
    e.claim();
    return e.message || getErrorText(e.code);
  }
  return fallback;
}

/** 错误码→中文文案（14 篇 §7 主流码；未登记者回退通用文案） */
const ERROR_TEXT: Record<number, string> = {
  // 1xxx 认证/令牌
  1001: '账号或口令错误',
  1002: '需要进行多因素认证',
  1003: '登录已过期，请重新登录',
  1004: '登录态已被吊销，请重新登录',
  1005: '设备已被锁定，请联系管理员',
  1007: '失败次数过多，账号已临时锁定',
  1008: '验证码错误',
  1014: '系统已初始化，引导已关闭',
  // 2xxx 组织/权限/租户
  2001: '你没有相应的操作权限',
  2002: '数据访问范围不足',
  2003: '无权访问该资源',
  2004: '该企业空间已被禁用',
  2005: '该账号已被禁用',
  // 3xxx IM
  3001: '你已不在该会话中',
  3002: '该群聊已解散',
  3003: '已超过可撤回时间',
  3004: '消息内容超过长度限制',
  3005: '消息包含违禁词，无法发送',
  3006: '你已被禁言',
  3007: '发送过于频繁，请稍后再试',
  3008: '已超过可编辑时间',
  3010: '群成员数已达上限',
  3011: '目标用户不可加入',
  3012: '对方已在会话中',
  3013: '该会话仅发布者可发言',
  3014: '当前群策略不允许 @全体',
  3015: '无权执行该群管理操作',
  3016: '群主不可退群，请先转让或解散',
  3017: '消息不存在或已被删除',
  3019: '会话不存在',
  3022: '收藏数量已达上限（1000 条）',
  // 4xxx 文件
  4001: '存储空间配额不足',
  4002: '该文件类型不允许上传',
  4003: '分片校验失败，请重新上传',
  4004: '文件未通过安全检测，已被拦截',
  4005: '文件不存在或已被删除',
  4006: '文件校验不一致，请重新上传',
  4007: '分片未上传完整，请补传后重试',
  4008: '上传会话已过期，请重新上传',
  4009: '文件超过单文件大小上限',
  // 4010-4012 分享外链（已移除）/ 5xxx RTC/会议（已移除）：编号段废弃不复用
  // 6xxx 文档
  // 7xxx 知识库
  7001: '知识库空间不存在',
  7002: '你没有检索权限',
  7003: '知识摄入失败，请稍后重试',
  // 8xxx Agent/应用
  8001: 'Agent 会话不存在',
  8002: '工具未授权',
  8005: '模型用量配额超限',
  // 9xxx 通用
  9001: '请求参数错误',
  9002: '资源不存在',
  9003: '操作过于频繁，请稍后再试',
  9004: '服务开小差了，请稍后重试',
  9005: '服务暂时不可用，已切换降级模式',
};

/** 按错误码取中文文案（未登记者回退；9004/9005 需上报 trace_id 供排查） */
export function getErrorText(code: number): string {
  return ERROR_TEXT[code] ?? `操作失败（错误码 ${code}），请稍后重试`;
}

/** token 提供者：auth store 在应用装配期注入（内存持有，避免依赖倒置） */
let tokenProvider: () => string | null = () => null;
export function setTokenProvider(provider: () => string | null): void {
  tokenProvider = provider;
}

/** 当前 access token 读取（fetch 封装外的请求——如 XHR 文件上传——注入 Authorization 用，D06） */
export function authToken(): string | null {
  return tokenProvider();
}

/** API origin（票据等相对 URL 拼绝对地址用；API_BASE 形如 http://host/api/v1） */
export function apiOrigin(): string {
  return new URL(API_BASE, window.location.href).origin;
}

/** 401/1003 统一处理钩子：auth 层注册（触发登出或静默刷新） */
let unauthorizedHandler: ((err: ApiError) => void) | null = null;
export function setUnauthorizedHandler(handler: (err: ApiError) => void): void {
  unauthorizedHandler = handler;
}

const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080/api/v1';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 写操作幂等键（14 篇 §5.3，服务端 24h 去重） */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotencyKey, signal } = options;
  const headers = new Headers();
  const token = tokenProvider();
  if (token) headers.set('Authorization', `Bearer ${token}`); // token 注入
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // 主动取消（组件卸载/query 失效）透传不提示；断网/CORS 等网络层失败统一 9004 兜底
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw scheduleFallback(new ApiError(9004, getErrorText(9004)));
  }

  // 429 限流：读取 Retry-After（14 篇 §5.1）
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '0') || undefined;
    throw scheduleFallback(new ApiError(9003, getErrorText(9003), { retryAfterSec: retryAfter }));
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw scheduleFallback(new ApiError(9004, getErrorText(9004)));
  }

  if (envelope.code !== 0) {
    // 服务端 message 优先（具体校验原因如「baseUrl 须以 http(s):// 开头」；
    // 无 message 回退错误码映射文案），trace_id 随错误带出便于排查
    const err = new ApiError(envelope.code, envelope.message?.trim() || getErrorText(envelope.code), {
      traceId: envelope.trace_id,
      details: envelope.details,
    });
    // token 过期/吊销：交给 auth 层（静默刷新失败则登出）——该两类已被登出流接管，认领防双显
    if (envelope.code === 1003 || envelope.code === 1004) {
      err.claim();
      unauthorizedHandler?.(err);
    }
    throw scheduleFallback(err);
  }
  return envelope.data;
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'POST', body, idempotencyKey }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * 二进制下载（D22 插件包）：同 token 注入与网络层错误口径，但不走 JSON 信封——
 * 失败时服务端可能返回 JSON 错误包或原始 zip，统一非 2xx 抛 ApiError（认领交给调用方）。
 */
export async function downloadBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  const token = tokenProvider();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw scheduleFallback(new ApiError(9004, getErrorText(9004)));
  }
  if (!res.ok) {
    // 尝试解 JSON 错误包（如 401/404 的信封），失败则按状态码兜底
    let code = res.status;
    let msg = `下载失败（HTTP ${res.status}）`;
    try {
      const envelope = (await res.json()) as ApiEnvelope<unknown>;
      if (envelope.code !== 0) {
        code = envelope.code;
        msg = envelope.message?.trim() || getErrorText(code);
      }
    } catch {
      /* 非 JSON 体：保持状态码口径 */
    }
    throw scheduleFallback(new ApiError(code, msg));
  }
  return res.blob();
}

/**
 * multipart 上传（D22 方案 A 个人插件）：同 token/错误口径；formData 原样
 * 透传（浏览器自动设 Content-Type boundary），服务端信封解包同 request。
 */
export async function postMultipart<T>(path: string, formData: FormData): Promise<T> {
  const headers = new Headers();
  const token = tokenProvider();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw scheduleFallback(new ApiError(9004, getErrorText(9004)));
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw scheduleFallback(new ApiError(9004, getErrorText(9004)));
  }
  if (envelope.code !== 0) {
    const err = new ApiError(envelope.code, envelope.message?.trim() || getErrorText(envelope.code), {
      traceId: envelope.trace_id,
    });
    if (envelope.code === 1003 || envelope.code === 1004) {
      err.claim();
      unauthorizedHandler?.(err);
    }
    throw scheduleFallback(err);
  }
  return envelope.data;
}
