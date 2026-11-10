/**
 * 生态应用 API（0031 / E1 / 10 篇 §4.3）：
 * 用户面 catalog 差异同步 + 安装/卸载；管理面见 admin（eco/apps）。
 */

import { http } from '../../../shared/api/http';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EcoApp {
  id: string;
  app_id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'delisted';
  current_version: string;
  created_at: number;
}

export interface CatalogEntry extends EcoApp {
  action: 'install' | 'upgrade' | 'revoke' | 'noop';
  manifest?: string;
  installed_v?: string;
}

export interface InstalledApp extends EcoApp {
  version: string;
  installed_at: number;
}

/** catalog 差异（10 §4.3：登录/启动同步锚点） */
export async function fetchCatalog(): Promise<CatalogEntry[]> {
  if (USE_MOCK) {
    await delay(200);
    return [
      { id: '1', app_id: 'crm.sync', name: 'CRM 连接器（mock）', description: '客户数据同步工具', status: 'published', current_version: '1.1.0', created_at: Date.now(), action: 'install' },
      { id: '2', app_id: 'corp.tools', name: '办公工具集（mock）', description: '', status: 'published', current_version: '2.0.0', created_at: Date.now(), action: 'noop', installed_v: '2.0.0' },
    ];
  }
  const data = await http.get<{ items: CatalogEntry[] }>('/eco/apps/catalog');
  return data.items ?? [];
}

/** 安装/升级（agent:app:install；版本锚定当前发布版） */
export async function installApp(id: string): Promise<{ version: string }> {
  if (USE_MOCK) {
    await delay(200);
    return { version: '1.1.0' };
  }
  return http.post<{ version: string }>(`/eco/apps/${encodeURIComponent(id)}/install`, {});
}

/** 卸载（幂等） */
export async function uninstallApp(id: string): Promise<void> {
  if (USE_MOCK) {
    await delay(150);
    return;
  }
  await http.delete(`/eco/apps/${encodeURIComponent(id)}/install`);
}

/** 我的安装集 */
export async function fetchInstalled(): Promise<InstalledApp[]> {
  if (USE_MOCK) {
    await delay(150);
    return [{ id: '2', app_id: 'corp.tools', name: '办公工具集（mock）', description: '', status: 'published', current_version: '2.0.0', created_at: Date.now(), version: '2.0.0', installed_at: Date.now() - 86400_000 }];
  }
  const data = await http.get<{ items: InstalledApp[] }>('/eco/apps/installed');
  return data.items ?? [];
}
