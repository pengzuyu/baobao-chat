/**
 * 登录账号记忆 IPC 封装（QQ 式多账号 + 自动登录，2026-11-27）：命令前缀 auth_accounts_* /
 * auth_login_password_*。账号元数据落壳侧 auth-accounts.json（机器级），口令落 OS 钥匙串。
 * 非 Tauri（浏览器 dev/preview）降级：列表恒空、其余 no-op——登录页退化为纯组织搜索。
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from '../../agent/bridge/tauri';

/** 单条账号记忆（与壳侧 AuthAccount serde camelCase 对应） */
export interface RememberedAccount {
  account: string;
  name: string;
  /** 最近一次登录成功时间（epoch ms） */
  lastLoginAt: number;
  rememberPwd: boolean;
  autoLogin: boolean;
}

export async function authAccountsList(): Promise<RememberedAccount[]> {
  if (!isTauriAvailable()) return [];
  return invoke<RememberedAccount[]>('auth_accounts_list');
}

/** 记录一次登录成功（置顶+更名+标记）；autoLogin=false 时清所有账号的自动登录（登录即重申） */
export async function authAccountsUpsert(
  account: string,
  name: string,
  rememberPwd: boolean,
  autoLogin: boolean,
): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('auth_accounts_upsert', { account, name, rememberPwd, autoLogin });
}

/** 删除账号记忆（下拉 hover ×）：条目+其钥匙串口令一并清 */
export async function authAccountsRemove(account: string): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('auth_accounts_remove', { account });
}

/** 清自动登录标记（登出调用；账号记忆保留） */
export async function authAccountsClearAuto(): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('auth_accounts_clear_auto');
}

/** 取账号口令（记住密码回填/自动登录兜底；无存证=null） */
export async function authLoginPasswordGet(account: string): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  return invoke<string | null>('auth_login_password_get', { account });
}

export async function authLoginPasswordSet(account: string, password: string): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('auth_login_password_set', { account, password });
}

export async function authLoginPasswordDelete(account: string): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('auth_login_password_delete', { account });
}
