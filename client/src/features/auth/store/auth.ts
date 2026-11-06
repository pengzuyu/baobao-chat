/**
 * 认证状态（token 仅内存持有，D01 §12.2-5：禁止 localStorage 存业务数据）：
 * - login：成功持有 token；1007 错误锁定时记录 lockUntil 供倒计时展示
 * - 静默刷新骨架：过期前 60s 定时 apiRefresh（真实端点待 03 篇定稿）
 */

import { create } from 'zustand';
import { setTokenProvider, setUnauthorizedHandler, ApiError } from '../../../shared/api/http';
import { apiLogin, apiRefresh, type AuthUser, type LoginResult } from '../api/auth';

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
  logout: () => void;
  clearError: () => void;
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

  logout: () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    set({ token: null, refreshToken: null, expiresAt: null, user: null, loginStatus: 'idle', error: null, lockUntil: 0 });
  },

  clearError: () => set({ error: null }),
}));

/** 应用装配期调用（main.tsx）：注入 token 提供者与 401 处理（避免 shared→features 反向依赖） */
export function installHttpAuthBridge(): void {
  setTokenProvider(() => useAuthStore.getState().token);
  setUnauthorizedHandler(() => useAuthStore.getState().logout());
}
