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
import WebSocketPlugin from '@tauri-apps/plugin-websocket';

export const PROTOCOL_VERSION = 1;

/** Tauri 宿主判定（updater.ts 同款局部惯例）：插件传输仅 Tauri 宿主可用 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 传输层抽象（0.1.4）：macOS WKWebView 拒绝 tauri:// 自定义 scheme 页面的 ws://
 * 出站（custom scheme origin 的 socket 限制；dev 的 http://localhost:5173 无此问题，
 * 生产包 IM 实时链全断，2026-11-27 真机实锤）——Tauri 宿主改走
 * tauri-plugin-websocket（Rust 侧连接），浏览器 dev 仍走原生 WebSocket。
 * 两实现共用 onData/onDisconnected 回调：状态机/心跳/ack/重连逻辑零改动。
 */
interface WsTransport {
  /** 连接可用（可 send）——插件路径无 readyState，自维护 */
  readonly open: boolean;
  /** 发送文本帧；抛异常=发送失败（上层转 failed 态） */
  send(text: string): void;
  /** 主动关闭（登出/清理）：幂等，触发前先摘回调防循环 */
  close(): void;
}

class NativeTransport implements WsTransport {
  private ws: WebSocket | null;
  constructor(
    ws: WebSocket,
    onData: (text: string) => void,
    onDisconnected: (code: number, reason: string) => void,
  ) {
    this.ws = ws;
    ws.onmessage = (ev) => onData(String(ev.data));
    ws.onclose = (ev) => {
      this.ws = null; // 先摘：onclose 链路里的 cleanup 不会再 close 一次
      onDisconnected(ev.code, ev.reason);
    };
    // onerror 统一走随后触发的 onclose（与既有语义一致）
  }
  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  send(text: string): void {
    if (!this.ws) throw new Error('WS 未连接');
    this.ws.send(text);
  }
  close(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
    }
  }
}

class PluginTransport implements WsTransport {
  private opened = false;
  private closed = false;
  private unlisten: (() => void) | null = null;
  constructor(
    private readonly pws: WebSocketPlugin,
    onData: (text: string) => void,
    onDisconnected: (code: number, reason: string) => void,
  ) {
    // connect resolve 即已打开；断开/错误以 'Close' tagged message 进 listener
    this.opened = true;
    this.unlisten = pws.addListener((msg) => {
      if (msg.type === 'Text') onData(msg.data);
      else if (msg.type === 'Close') {
        if (this.closed) return;
        this.closed = true;
        this.opened = false;
        onDisconnected(msg.data?.code ?? 1006, msg.data?.reason ?? '');
      }
      // Ping/Pong 协议帧由 tungstenite 自动应答/忽略；Binary 信封协议不用
    });
  }
  get open(): boolean {
    return this.opened;
  }
  send(text: string): void {
    if (!this.opened) throw new Error('WS 未连接');
    // 插件 send 为异步：失败即连接已坏（断开详情由插件 'Close' 消息保证送达），
    // 这里仅防未处理 rejection，ack 配对交给 10s 超时兜底
    this.pws.send(text).catch((err) => {
      pushLog({ level: 'warn', source: 'ws', message: `WS 发送失败：${String(err)}`, data: {} });
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    const u = this.unlisten;
    this.unlisten = null;
    u?.();
    this.pws.disconnect().catch(() => {}); // fire-and-forget
  }
}

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
  private transport: WsTransport | null = null;
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
    const url2 = `${url}?token=${encodeURIComponent(token)}&did=${encodeURIComponent(deviceId)}&v=${PROTOCOL_VERSION}`;
    const onData = (text: string) => this.handleMessage(text);
    const onDisconnected = (code: number, reason: string) => {
      const failedPending = this.pending.size; // cleanup 清空前取数：并进断开详情条
      this.cleanup();
      // 认证失败 4001：服务端关闭且不重连（14 篇 §2.1）
      if (code === 4001) {
        pushLog({
          level: 'error',
          source: 'ws',
          message: 'WS 认证失败被服务端关闭（code 4001），已触发登出',
          data: { code, reason, failed_pending: failedPending },
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
          message: `WS 连接断开（code ${code}${reason ? `：${reason}` : ''}，${failedPending} 个未决请求失败），稍后重连`,
          data: { code, reason, failed_pending: failedPending, attempt: this.reconnectAttempt },
        });
        this.scheduleReconnect();
      }
    };
    if (isTauri()) {
      // 插件传输（0.1.4）：Rust 侧连接绕开 WKWebView 对 tauri:// 页面的 ws:// 限制。
      // connect resolve=已打开；握手失败（网络/401 拒）走 catch，按 1006 断开处理
      WebSocketPlugin.connect(url2)
        .then((pws) => {
          if (this.manualClosed || this.transport !== null) {
            pws.disconnect().catch(() => {}); // 连接返回前已登出/清理：直接丢弃
            return;
          }
          this.transport = new PluginTransport(pws, onData, onDisconnected);
          this.handleOpened();
        })
        .catch((err) => {
          if (this.manualClosed) return;
          onDisconnected(1006, String(err));
        });
    } else {
      // 浏览器 dev：原生 WebSocket（http://localhost:5173 页面无 scheme 限制）
      const ws = new WebSocket(url2);
      this.transport = new NativeTransport(ws, onData, onDisconnected);
      ws.onopen = () => this.handleOpened();
    }
  }

  /** 连接/重连成功（两传输共用）：复位重连计数 + 心跳 + 增量同步 */
  private handleOpened(): void {
    this.reconnectAttempt = 0;
    this.lastRecvAt = Date.now();
    this.setStatus('online');
    this.startHeartbeat();
    this.onResync?.(); // 连接/重连成功 → 增量同步（14 篇 §4.2）
  }

  private sendOnce(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.transport || !this.transport.open) {
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
      this.transport.send(JSON.stringify(envelope));
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
      const transport = this.transport;
      if (!transport || !transport.open) return;
      // 60s 无任何下行 → 判定半开，主动断开触发重连
      // （close 内部已摘断开回调，onclose 链不会走——显式清 pending 并调度重连）
      if (Date.now() - this.lastRecvAt > DEAD_AFTER_MS) {
        transport.close();
        this.cleanup();
        this.scheduleReconnect();
        return;
      }
      transport.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `c-hb-${++this.idSeq}`, type: 'ping', ts: Date.now(), payload: {} }));
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
    if (this.transport) {
      const transport = this.transport;
      this.transport = null;
      transport.close(); // 两实现内部各自摘断开回调，close 后不再回环触发 onDisconnected
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
