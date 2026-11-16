/**
 * 认证 REST 封装（03 篇口径；端点字段以服务端联调为准）。
 * mock 数据集中在本文件（硬性要求：不散落在组件中）。
 */

import { ApiError, getErrorText, http } from '../../../shared/api/http';

/** 是否使用内置桩数据（默认连真实后端；显式 VITE_USE_MOCK=1 才走桩——D18 翻转） */
export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

export interface AuthUser {
  uid: string;
  name: string;
  avatar?: string;
  /** 权限点列表（admin:* 等显隐判定，03 篇） */
  perms: string[];
  /** 首登强制改密（D11：导入用户置位——登录页二步改密表单） */
  must_change_pwd?: boolean;
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  /** 过期时间戳（ms），供静默刷新调度 */
  expiresAt: number;
  user: AuthUser;
}

export async function apiLogin(account: string, password: string, did: string): Promise<LoginResult> {
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
    { account, password, did, device_name: 'BaobaoChat Desktop' },
  );
  // snake→camel 映射（同源 schema 生成后可移除，14 篇 §8）
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    user: data.user,
  };
}

/** 静默刷新（D28 批0：补 did 设备绑定——此前缺字段对真实后端必 400） */
export async function apiRefresh(refreshToken: string, did: string): Promise<LoginResult> {
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
    did,
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
    user: data.user,
  };
}

/** ── 登录页搜人（2026-11-12 账号改选人下拉；预登录公开检索） ── */

/** 通讯录卡片行（下拉一项：工号+姓名+组织链路名） */
export interface UserCard {
  employee_no: string;
  display_name: string;
  org_path: string;
}

/** 用户搜索页（cursor 翻页；next_cursor 空=到底） */
export interface UserSearchPage {
  items: UserCard[];
  next_cursor: string;
}

/** 搜人：q 命中 工号/姓名/拼音全拼/首字母（不区分大小写）；工号升序；搜索态与翻页可叠加 */
export async function apiSearchUsers(q: string, cursor?: string, limit = 20): Promise<UserSearchPage> {
  if (USE_MOCK) {
    await delay(150);
    const all: UserCard[] = [
      { employee_no: 'alice', display_name: 'Alice', org_path: '总公司/技术部' },
      { employee_no: 'bob', display_name: 'Bob（张伯）', org_path: '总公司/技术部/前端组' },
      { employee_no: 'zhangsan', display_name: '张三', org_path: '总公司/技术部/前端组' },
    ].filter(
      (u) =>
        !q ||
        u.employee_no.includes(q.toLowerCase()) ||
        u.display_name.toLowerCase().includes(q.toLowerCase()) ||
        u.org_path.toLowerCase().includes(q.toLowerCase()),
    );
    const start = cursor ? all.findIndex((u) => u.employee_no > cursor) : 0;
    const items = all.slice(Math.max(0, start), Math.max(0, start) + limit);
    return { items, next_cursor: items.length === limit ? items[items.length - 1].employee_no : '' };
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return http.get<UserSearchPage>(`/auth/users${params.size > 0 ? `?${params}` : ''}`);
}

/** ── 自助注册（M4，2026-11-12 用户裁决：开放注册；工号自动生成；回登录页登录） ── */

/**
 * 自助注册：姓名+自设口令 → 服务端自动生成工号（拼音基名+重名递增）；
 * 注册用户不挂部门=虚拟「未分组」（管理员后续调整）。返回分配的工号（登录账号）。
 */
export async function apiRegister(displayName: string, password: string): Promise<string> {
  if (USE_MOCK) {
    await delay(400);
    return `mock-${displayName.toLowerCase()}`;
  }
  const data = await http.post<{ employee_no: string }>('/auth/register', {
    display_name: displayName,
    password,
  });
  return data.employee_no;
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

/** 修改密码（D11：登录态；旧密码校验 → 清 must_change；1001 旧密码错/9001 规则） */
export async function apiChangePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (USE_MOCK) {
    await delay(300);
    return;
  }
  await http.post('/me/password', { old_password: oldPassword, new_password: newPassword });
}