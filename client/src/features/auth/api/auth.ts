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

/** ── setup 初始化向导（16 篇 §2.2 Web 化：空系统引导首个管理员） ── */

/** 系统是否已初始化（租户内已有用户）。mock 模式恒已初始化——纯前端走查不被向导打断 */
export async function apiSetupStatus(): Promise<{ initialized: boolean }> {
  if (USE_MOCK) return { initialized: true };
  return http.get<{ initialized: boolean }>('/setup/status');
}

/**
 * 建首个管理员（仅未初始化时可用，1014=已初始化）。
 * 成功后由调用方自动走 apiLogin 进系统（口令仍在内存中，无需再输一遍）
 */
export async function apiSetupBootstrap(employeeNo: string, displayName: string, password: string): Promise<void> {
  if (USE_MOCK) {
    await delay(500);
    throw new ApiError(1014, 'mock 模式不支持初始化向导');
  }
  await http.post('/setup/bootstrap', {
    employee_no: employeeNo,
    display_name: displayName,
    password,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 当前用户权限摘要（03 篇 §7；RBAC 阶段二——perm.changed 后重拉，导航显隐实时收窄） */
export async function apiMyPermissions(): Promise<string[]> {
  if (USE_MOCK) return ['im:*', 'doc:read', 'kb:read'];
  const data = await http.get<{ perms: string[] }>('/me/permissions');
  return data.perms;
}
