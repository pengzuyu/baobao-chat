/**
 * 认证状态（token 仅内存持有，D01 §12.2-5：禁止 localStorage 存业务数据）：
 * - login：成功持有 token；1007 错误锁定时记录 lockUntil 供倒计时展示
 * - 静默刷新骨架：过期前 60s 定时 apiRefresh（真实端点待 03 篇定稿）
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { setTokenProvider, setUnauthorizedHandler, ApiError } from '../../../shared/api/http';
import { ensureDeviceId, getDeviceId } from '../../../shared/deviceId';
import { apiChangePassword, apiLogin, apiLogout, apiMyPermissions, apiRefresh, USE_MOCK, type AuthUser, type LoginResult } from '../api/auth';

type LoginStatus = 'idle' | 'submitting' | 'locked';

interface AuthState {
  /** access token：仅内存（进程级），刷新页面即失效需重登（正式版配合 Rust 钥匙串） */
  token: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  user: AuthUser | null;
  loginStatus: LoginStatus;
  /** 最近一次登录错误（LoginPage 展示） */
  error: ApiError | null;
  /** 1007 锁定截止时间戳（ms），倒计时展示用 */
  lockUntil: number;
  /** 启动静默恢复中（D28 批0）：App 壳显示占位防登录页闪跳 */
  restoring: boolean;

  login: (account: string, password: string) => Promise<void>;
  /** 首登/自助改密（D11）：成功后清 user.must_change_pwd */
  changePassword: (oldPwd: string, newPwd: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
  /** 重拉权限摘要（perm.changed 推送后；导航显隐实时收窄，03 篇 §4） */
  refreshPerms: () => Promise<void>;
}

/** 静默刷新定时器（模块级，登出即清） */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSilentRefresh(getState: () => AuthState): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const { refreshToken, expiresAt } = getState();
  if (!refreshToken || !expiresAt) return;
  const wait = expiresAt - Date.now() - 60_000; // 过期前 60s 触发
  if (wait <= 0) return;
  refreshTimer = setTimeout(async () => {
    try {
      const did = await ensureDeviceId();
      const result = await apiRefresh(refreshToken, did);
      useAuthStore.setState(applyLogin(result));
      scheduleSilentRefresh(() => useAuthStore.getState()); // 续期后重排
    } catch {
      useAuthStore.getState().logout(); // 刷新失败：回登录页
    }
  }, wait);
}

function applyLogin(result: LoginResult) {
  // Tauri 宿主同步 token（→ 宿主试签 OBO → obo.token 下发 Runtime；浏览器环境为 no-op）
  if (result.accessToken && isTauriHost()) {
    void invoke('auth_set_token', {
      token: result.accessToken,
      expiresAt: result.expiresAt,
      userId: result.user?.uid,
      userName: result.user?.name,
      did: getDeviceId() ?? undefined, // OBO agent_session_id 归因前缀（D28 批0）
      perms: result.user?.perms, // OBO scope=用户权限集（服务端子集校验）
    }).catch(() => undefined);
  }
  // refresh 落 OS 钥匙串（D28 批0/Q0-1）：唯一落盘点，启动恢复依据；
  // 失败降级=下次启动重输口令（会话内静默刷新不受影响）
  if (result.refreshToken && isTauriHost()) {
    void invoke('auth_save_login', { refreshToken: result.refreshToken }).catch(() => undefined);
  }
  return {
    token: result.accessToken,
    refreshToken: result.refreshToken ?? null,
    expiresAt: result.expiresAt,
    user: result.user,
    loginStatus: 'idle' as LoginStatus,
    error: null,
    lockUntil: 0,
  };
}

/** Tauri WebView 探测（与 agent bridge/index.ts 同口径的轻量版，避免跨 feature 依赖） */
function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  refreshToken: null,
  expiresAt: null,
  user: null,
  loginStatus: 'idle',
  error: null,
  lockUntil: 0,
  restoring: false,

  login: async (account, password) => {
    set({ loginStatus: 'submitting', error: null });
    try {
      const did = await ensureDeviceId(); // 稳定设备号：登录请求携带（03 §2.2 设备绑定）
      const result = await apiLogin(account, password, did);
      set(applyLogin(result));
      scheduleSilentRefresh(() => useAuthStore.getState()); // 静默刷新骨架
    } catch (err) {
      err instanceof ApiError && err.claim(); // 表单自展示——认领防全局兜底双显
      const apiError = err instanceof ApiError ? err : new ApiError(9004, '登录失败，请稍后重试');
      // 1007：错误锁定，展示倒计时（retry_after 秒）
      if (apiError.code === 1007 && apiError.retryAfterSec) {
        set({ loginStatus: 'locked', error: apiError, lockUntil: Date.now() + apiError.retryAfterSec * 1000 });
      } else {
        set({ loginStatus: 'idle', error: apiError });
      }
    }
  },

  changePassword: async (oldPwd, newPwd) => {
    await apiChangePassword(oldPwd, newPwd);
    const u = useAuthStore.getState().user;
    if (u) set({ user: { ...u, must_change_pwd: false } });
  },

  logout: () => {
    const { token } = useAuthStore.getState();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    set({ token: null, refreshToken: null, expiresAt: null, user: null, loginStatus: 'idle', error: null, lockUntil: 0 });
    // 服务端吊销 refresh（D28 批0：fire-and-forget——本地态已清，失败由 30 天自然过期兜底）
    if (token && !USE_MOCK) {
      void ensureDeviceId().then((did) => apiLogout(did).catch(() => undefined));
    }
    // Rust 宿主 token 缓存清理（此前登出残留至下次登录）+ 钥匙串弃凭据（显式登出=下次启动不再免密）
    if (isTauriHost()) {
      void invoke('auth_clear_token').catch(() => undefined);
      void invoke('auth_clear_login').catch(() => undefined);
    }
    // 本地缓存清理（IM 消息/outbox/游标随账号退出抹除，D03 §6.2 隐私面）
    void import('../../im/api/local').then((m) => m.localLogoutCleanup());
  },

  clearError: () => set({ error: null }),

  refreshPerms: async () => {
    const { token, user } = useAuthStore.getState();
    if (!token || !user) return;
    try {
      const perms = await apiMyPermissions();
      // 仅权限变化才写（避免无谓重渲染导航）
      if (perms.length !== user.perms.length || perms.some((p, i) => p !== user.perms[i])) {
        useAuthStore.setState({ user: { ...user, perms } });
      }
    } catch {
      // 拉取失败保持现状——权限判定以服务端守卫为准（2001/2003 拒绝兜底）
    }
  },
}));

/** 应用装配期调用（main.tsx）：注入 token 提供者与 401 处理（避免 shared→features 反向依赖） */
export function installHttpAuthBridge(): void {
  setTokenProvider(() => useAuthStore.getState().token);
  setUnauthorizedHandler(() => useAuthStore.getState().logout());
}

let restoreStarted = false;

/**
 * 启动静默恢复（D28 批0/Q0-1，03 §2.3 落地）：钥匙串 refresh → /auth/refresh
 * → 直达主界面；失败（过期/吊销/重放）清钥匙串回登录页。main.tsx 装配期调用一次。
 */
export async function restoreLogin(): Promise<void> {
  if (restoreStarted) return;
  restoreStarted = true;
  if (USE_MOCK || !isTauriHost()) return;
  useAuthStore.setState({ restoring: true });
  try {
    const saved = await invoke<string | null>('auth_load_login');
    if (saved) {
      const did = await ensureDeviceId();
      const result = await apiRefresh(saved, did);
      useAuthStore.setState(applyLogin(result));
      scheduleSilentRefresh(() => useAuthStore.getState());
    }
  } catch {
    void invoke('auth_clear_login').catch(() => undefined); // 恢复失败即弃凭据
  } finally {
    useAuthStore.setState({ restoring: false });
  }
}
