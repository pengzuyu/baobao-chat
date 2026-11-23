/**
 * WS 客户端（14 篇 §2 语义）：
 * - 信封：请求 {v,id,type,ts,payload} / ack 成对回执 / 服务端推送
 * - 心跳：30s ping；60s 无任何下行判定半开断连
 * - 重连：指数退避 1s,2s,4s…上限 60s + 抖动；重连成功触发 resync（§4 增量同步）
 * - ack 配对：请求 10s 未收到 ack 超时重试，共 3 次后抛出（UI 转 failed 态）
 * - 未知 type：忽略并上报埋点（前向兼容，§8）
 *
 * 说明：正式版 WSS 连接由 Rust 核心持有（02 篇 §2：UI 重载不断线），
 * 本文件为 WebView 侧 TS 实现，接口语义与 Rust 侧一致，便于浏览器联调。
 */

import { ApiError, getErrorText } from './http';
import { maskUrl, pushLog } from '../log/devlog';

export const PROTOCOL_VERSION = 1;

/**
 * WS 基址解析（同源推导，2026-11-09 拍板固定域名方案的配套）：
 * 显式 VITE_WS_BASE > 从 VITE_API_BASE 推导 > 本地 dev 默认。
 * 推导规则：去 /api/v1 后缀 → http(s)→ws(s) → 拼 /ws/connect。
 * 前提=统一入口路径分流（网关 /api 与 /ws 同域名，16 篇部署形态）；
 * 未来 WS 独立域名时显式配 VITE_WS_BASE 覆盖（逃生口），或演进为服务端下发端点。
 */
export function resolveWsBase(): string {
  const explicit = import.meta.env.VITE_WS_BASE as string | undefined;
  if (explicit) return explicit;
  const api = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8080/api/v1';
  const origin = api.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
  return origin.replace(/^http/, 'ws') + '/ws/connect';
}

export type WsStatus = 'idle' | 'connecting' | 'online' | 'offline';

/** 客户端→服务端请求信封（需服务端 ack） */
export interface WsRequestEnvelope<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: string;
  ts: number;
  payload: P;
}

/** 服务端 ack 信封（对请求的成对回执，ack 指向请求 id） */
export interface WsAckEnvelope<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ack: string;
  type: string;
  code: number;
  payload: P;
}

/** 服务端推送信封（无对应请求） */
export interface WsPushEnvelope<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: string;
  ts?: number;
  payload: P;
}

export type WsAnyEnvelope<P = unknown> = WsAckEnvelope<P> | WsPushEnvelope<P>;

/** 事件订阅 handler：payload + 原始信封 */
export type WsHandler<P = unknown> = (payload: P, envelope: WsPushEnvelope<P>) => void;

const HEARTBEAT_MS = 30_000; // 心跳周期（14 篇 §2.1）
const DEAD_AFTER_MS = 60_000; // 无下行判定半开
const ACK_TIMEOUT_MS = 10_000; // ack 超时（§2.2 规则）
const MAX_ATTEMPTS = 3; // 超时重试次数：3 次失败转 failed
const BACKOFF_CAP_MS = 60_000; // 退避上限

/** 计算第 attempt 次重连延迟：1s,2s,4s…上限 60s，叠加 ±30% 抖动 */
function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt);
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.round(base * jitter);
}

interface PendingCall {
  resolve: (payload: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private status: WsStatus = 'idle';
  private idSeq = 0;
  private pending = new Map<string, PendingCall>(); // ack 配对表：请求 id → 回调
  private handlers = new Map<string, Set<WsHandler>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastRecvAt = 0;
  private manualClosed = false;
  private connectArgs: { url: string; token: string; deviceId: string } | null = null;

  /** 连接状态变化回调（connection store 绑定 → 全局横幅） */
  onStateChange: ((status: WsStatus, attempt: number) => void) | null = null;
  /** 重连成功回调：立即执行增量同步 GET /sync（14 篇 §4.2） */
  onResync: (() => void) | null = null;
  /** WS 认证失败（close code 4001）：交 auth 层登出 */
  onAuthError: (() => void) | null = null;
  /** 未知事件 type 埋点（前向兼容，14 篇 §8） */
  onUnknownType: ((type: string) => void) | null = null;

  get connected(): boolean {
    return this.status === 'online';
  }

  /** 建立连接：wss://host/ws/connect?token=&did=&v=1 */
  connect(url: string, token: string, deviceId: string): void {
    this.connectArgs = { url, token, deviceId };
    this.manualClosed = false;
    this.open();
  }

  /** 主动断开（登出）：不触发重连 */
  disconnect(): void {
    this.manualClosed = true;
    this.connectArgs = null;
    this.cleanup();
    this.setStatus('idle');
  }

  /** 发送请求并等待 ack；10s 超时重试（幂等由 payload 内业务键保证），3 次后抛出 */
  async request<P = unknown>(type: string, payload: unknown): Promise<P> {
    let lastError: unknown = new ApiError(9005, getErrorText(9005));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return (await this.sendOnce(type, payload)) as P;
      } catch (err) {
        lastError = err;
        // 服务端已明确应答错误码：不重试（重试无意义且可能不幂等）
        if (err instanceof ApiError) throw err;
      }
    }
    throw lastError;
  }

  /** 订阅服务端推送事件（含 ack 型外的所有信封）；返回取消函数 */
  on<P = unknown>(type: string, handler: WsHandler<P>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as WsHandler<unknown>);
    return () => set.delete(handler as WsHandler<unknown>);
  }

  // ---- 内部实现 ----

  private open(): void {
    if (!this.connectArgs) return;
    const { url, token, deviceId } = this.connectArgs;
    this.setStatus('connecting');
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}&did=${encodeURIComponent(deviceId)}&v=${PROTOCOL_VERSION}`);
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastRecvAt = Date.now();
      this.setStatus('online');
      this.startHeartbeat();
      this.onResync?.(); // 连接/重连成功 → 增量同步（14 篇 §4.2）
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(String(ev.data));
    ws.onclose = (ev: CloseEvent) => {
      const failedPending = this.pending.size; // cleanup 清空前取数：并进断开详情条
      this.cleanup();
      // 认证失败 4001：服务端关闭且不重连（14 篇 §2.1）
      if (ev.code === 4001) {
        pushLog({
          level: 'error',
          source: 'ws',
          message: 'WS 认证失败被服务端关闭（code 4001），已触发登出',
          data: { code: ev.code, reason: ev.reason, failed_pending: failedPending },
        });
        this.manualClosed = true;
        this.setStatus('idle');
        this.onAuthError?.();
        return;
      }
      if (!this.manualClosed) {
        pushLog({
          level: 'warn',
          source: 'ws',
          message: `WS 连接断开（code ${ev.code}${ev.reason ? `：${ev.reason}` : ''}，${failedPending} 个未决请求失败），稍后重连`,
          data: { code: ev.code, reason: ev.reason, failed_pending: failedPending, attempt: this.reconnectAttempt },
        });
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
      // onclose 随后触发，统一走重连调度
    };
  }

  private sendOnce(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('WS 未连接'));
        return;
      }
      const id = `c-${Date.now()}-${++this.idSeq}`;
      const envelope: WsRequestEnvelope = { v: PROTOCOL_VERSION, id, type, ts: Date.now(), payload };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        pushLog({ level: 'warn', source: 'ws', message: `ack 超时（10s）：${type}`, data: { type, id } });
        reject(new Error(`ack 超时：${type}`)); // 10s 无 ack → 上层重试
      }, ACK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(envelope));
    });
  }

  private handleMessage(raw: string): void {
    this.lastRecvAt = Date.now();
    let env: WsAnyEnvelope;
    try {
      env = JSON.parse(raw) as WsAnyEnvelope;
    } catch {
      pushLog({ level: 'warn', source: 'ws', message: '收到非法 WS 帧（JSON 解析失败），已丢弃' });
      return; // 非法帧丢弃
    }
    if ('ack' in env) {
      // ack 成对回执（code 缺省视为 0：防御旧服务端 omitempty 省略成功码）
      const pending = this.pending.get(env.ack);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(env.ack);
        if ((env.code ?? 0) === 0) pending.resolve(env.payload);
        else pending.reject(new ApiError(env.code ?? 0, getErrorText(env.code ?? 0)));
      }
      return;
    }
    if (env.type === 'pong') return; // 心跳回执
    const set = this.handlers.get(env.type);
    if (set && set.size > 0) {
      set.forEach((h) => h(env.payload, env as WsPushEnvelope));
    } else {
      this.onUnknownType?.(env.type); // 未知 type：忽略 + 埋点
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      // 60s 无任何下行 → 判定半开，主动断开触发重连
      if (Date.now() - this.lastRecvAt > DEAD_AFTER_MS) {
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `c-hb-${++this.idSeq}`, type: 'ping', ts: Date.now(), payload: {} }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    this.setStatus('offline');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt += 1;
      this.open();
    }, backoffDelay(this.reconnectAttempt));
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // 未决请求全部失败（清空 ack 配对表）
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
    });
    this.pending.clear();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private setStatus(status: WsStatus): void {
    if (this.status === status) return;
    this.status = status;
    // 状态机变迁留痕（开发者模式·DevPanel 事件 Tab）；offline 由 onclose 的
    // 断开详情条覆盖（code/reason/未决数），不重复记
    if (status !== 'offline') {
      pushLog({
        level: 'info',
        source: 'ws',
        message:
          status === 'online'
            ? 'WS 已连接'
            : status === 'connecting'
              ? this.reconnectAttempt > 0
                ? `WS 重连中（第 ${this.reconnectAttempt + 1} 次）`
                : 'WS 连接中'
              : 'WS 已断开（登出/主动）',
        data: {
          status,
          attempt: this.reconnectAttempt,
          url: this.connectArgs ? maskUrl(this.connectArgs.url) : undefined,
        },
      });
    }
    this.onStateChange?.(status, this.reconnectAttempt);
  }
}

/** 全局单例：connection store 负责绑定状态与生命周期 */
export const wsClient = new WsClient();
