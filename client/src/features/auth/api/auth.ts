/**
 * 认证 REST 封装（03 篇口径；端点字段以服务端联调为准）。
 * mock 数据集中在本文件（硬性要求：不散落在组件中）。
 */

import { ApiError, getErrorText, http } from '../../../shared/api/http';

/** 是否使用内置桩数据（默认开，VITE_USE_MOCK=0 切真实后端） */
export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

export interface AuthUser {
  uid: string;
  name: string;
  avatar?: string;
  /** 权限点列表（admin:* 等显隐判定，03 篇） */
  perms: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  /** 过期时间戳（ms），供静默刷新调度 */
  expiresAt: number;
  user: AuthUser;
}

export async function apiLogin(account: string, password: string): Promise<LoginResult> {
  if (USE_MOCK) {
    // 桩：账号 locked 演示 1007 错误锁定倒计时；其余任意账号口令可登录
    await delay(500);
    if (account === 'locked') {
      throw new ApiError(1007, getErrorText(1007), { retryAfterSec: 30 });
    }
    return {
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
      user: { uid: 'u-1001', name: '宝宝', perms: ['im:*', 'doc:read', 'kb:read'] },
    };
  }
  const data = await http.post<{ access_token: string; refresh_token?: string; expires_at: number; user: AuthUser }>(
    '/auth/login',
    { account, password },
  );
  // snake→camel 映射（同源 schema 生成后可移除，14 篇 §8）
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    user: data.user,
  };
}

/** 静默刷新骨架：真实端点待 03 篇定稿后补全 */
export async function apiRefresh(refreshToken: string): Promise<LoginResult> {
  if (USE_MOCK) {
    await delay(200);
    return {
      accessToken: 'mock-access-token-2',
      refreshToken,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000,
      user: { uid: 'u-1001', name: '宝宝', perms: ['im:*', 'doc:read', 'kb:read'] },
    };
  }
  const data = await http.post<{ access_token: string; refresh_token?: string; expires_at: number; user: AuthUser }>('/auth/refresh', {
    refresh_token: refreshToken,
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    user: data.user,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
