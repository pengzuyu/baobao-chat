/**
 * 认证状态（token 仅内存持有，D01 §12.2-5：禁止 localStorage 存业务数据）：
 * - login：成功持有 token；1007 错误锁定时记录 lockUntil 供倒计时展示
 * - 静默刷新骨架：过期前 60s 定时 apiRefresh（真实端点待 03 篇定稿）
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { setTokenProvider, setUnauthorizedHandler, ApiError } from '../../../shared/api/http';
import { apiChangePassword, apiLogin, apiMyPermissions, apiRefresh, type AuthUser, type LoginResult } from '../api/auth';

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
      const result = await apiRefresh(refreshToken);
      useAuthStore.setState(applyLogin(result));
      scheduleSilentRefresh(() => useAuthStore.getState()); // 续期后重排
    } catch {
      useAuthStore.getState().logout(); // 刷新失败：回登录页
    }
  }, wait);
}

function applyLogin(result: LoginResult) {
  // Tauri 宿主同步 token（→ obo.token 下发 Runtime；浏览器环境为 no-op）
  if (result.accessToken && isTauriHost()) {
    void invoke('auth_set_token', { token: result.accessToken, expiresAt: result.expiresAt }).catch(() => undefined);
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

  login: async (account, password) => {
    set({ loginStatus: 'submitting', error: null });
    try {
      const result = await apiLogin(account, password);
      set(applyLogin(result));
      scheduleSilentRefresh(() => useAuthStore.getState()); // 静默刷新骨架
    } catch (err) {
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
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    set({ token: null, refreshToken: null, expiresAt: null, user: null, loginStatus: 'idle', error: null, lockUntil: 0 });
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
