/**
 * 插件市场 API（D22 §3.2 / 批次 L2）：
 * 服务端（catalog 检索/详情/安装/下载/卸载/我的）+ 本地落盘链
 * （downloadBlob → fflate 解压 → 客户端复跑轻校验 → invoke plugin_write_files）。
 * 客户端轻校验=清单三目录名识别 + JSON 可解析 + name/version 与服务端对账
 * （防中间篡改的基本面）；完整组件校验在服务端发布时（Go 校验器）。
 * 装配（skills/MCP 生效）随 L3——本层只管安装态与文件。
 */

import { invoke } from '@tauri-apps/api/core';
import { unzipSync, strFromU8 } from 'fflate';
import { downloadBlob, http, postMultipart } from '../../../shared/api/http';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

/** Tauri WebView 注入标记（无则落盘链不可用——web 预览仅市场浏览） */
function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 服务端 DTO（plugin.go 镜像）----

export interface PluginComponents {
  skills: number;
  mcpServers: number;
  commands: number;
  agents: number;
  hooks: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  components: PluginComponents;
  risk?: string;
  category?: string;
  netAllow?: string[];
  usesIdentity: boolean;
  configKeys?: string[];
  /** secret 型配置键（L4：客户端据此分流钥匙串） */
  configSecrets?: string[];
}

export interface PluginEntry {
  id: string;
  plugin_id: string;
  name: string;
  description: string;
  category: string;
  policy: number; // 1 force 2 recommend 3 optional
  status: string;
  current_version: string;
  manifest?: PluginManifest;
  /** >0=个人插件归属（方案 A：仅本人与管理员可见；0=公共） */
  owner_user_id?: number;
  created_at: number;
  installed: boolean;
  version?: string;
  has_update: boolean;
}

export interface PluginVersion {
  id: string;
  version: string;
  notes?: string;
  created_at: number;
}

export interface PluginInstallResp {
  plugin_id: string;
  version: string;
  download_url: string;
}

// ---- 插件斜杠命令（D22 §2/L5：commands/*.md，工作台输入框 / 渲染）----

export interface PluginCommand {
  pluginId: string;
  name: string;
  description: string;
  /** 提示词模板（$ARGUMENTS=全部参数拼接、$1..$9=位置参数） */
  template: string;
}

/** 命令表（空表=无插件命令，功能零成本；失败降级空） */
export async function fetchPluginCommands(): Promise<PluginCommand[]> {
  if (!isTauriAvailable()) return [];
  try {
    const list = await invoke<PluginCommand[]>('plugin_commands_list');
    return list ?? [];
  } catch {
    return [];
  }
}

/** `/name a b` → 模板渲染（$ARGUMENTS="a b"、$1=a、$2=b；未引用的占位符保留） */
export function renderCommand(cmd: PluginCommand, args: string[]): string {
  let out = cmd.template;
  const all = args.join(' ');
  out = out.replaceAll('$ARGUMENTS', all);
  args.slice(0, 9).forEach((a, i) => {
    out = out.replaceAll(`$${i + 1}`, a);
  });
  return out.trim();
}

// ---- 本地态（壳 plugin_local_state 镜像）----

export interface PluginLocalState {
  enabled: boolean;
  activeVersion: string;
  versions: string[];
  config: Record<string, string>;
}

// ---- 服务端调用 ----

export interface CatalogQuery {
  q?: string;
  category?: string;
  component?: '' | 'tool' | 'skill' | 'command' | 'agent';
}

export async function fetchPluginCatalog(query: CatalogQuery = {}): Promise<PluginEntry[]> {
  if (USE_MOCK) {
    await delay(200);
    return [
      {
        id: '1', plugin_id: 'deploy-helper', name: 'deploy-helper', description: '发布助手（mock）：技能+工具+专家一包',
        category: 'devops', policy: 2, status: 'published', current_version: '1.2.0', created_at: Date.now(),
        manifest: { name: 'deploy-helper', version: '1.2.0', description: '', components: { skills: 1, mcpServers: 2, commands: 1, agents: 1, hooks: false }, category: 'devops', usesIdentity: true, configKeys: ['gitlab_token'] },
        installed: false, has_update: false,
      },
      {
        id: '2', plugin_id: 'kb-boost', name: 'kb-boost', description: '知识库增强技能（mock）',
        category: 'kb', policy: 3, status: 'published', current_version: '0.3.0', created_at: Date.now(),
        manifest: { name: 'kb-boost', version: '0.3.0', description: '', components: { skills: 2, mcpServers: 0, commands: 0, agents: 0, hooks: false }, usesIdentity: false },
        installed: true, version: '0.2.0', has_update: true,
      },
    ];
  }
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.category) params.set('category', query.category);
  if (query.component) params.set('component', query.component);
  const qs = params.toString();
  const data = await http.get<{ items: PluginEntry[] }>(`/eco/plugins/catalog${qs ? `?${qs}` : ''}`);
  return data.items ?? [];
}

export async function fetchPluginDetail(pluginId: string): Promise<{ plugin: PluginEntry; versions: PluginVersion[] }> {
  if (USE_MOCK) {
    await delay(150);
    return {
      plugin: (await fetchPluginCatalog()).find((p) => p.plugin_id === pluginId) ?? (await fetchPluginCatalog())[0],
      versions: [{ id: '1', version: '1.2.0', notes: '首版', created_at: Date.now() }],
    };
  }
  return http.get<{ plugin: PluginEntry; versions: PluginVersion[] }>(`/eco/plugins/${encodeURIComponent(pluginId)}`);
}

export async function installOnServer(pluginId: string, version?: string): Promise<PluginInstallResp> {
  if (USE_MOCK) {
    await delay(150);
    return { plugin_id: pluginId, version: version ?? '1.2.0', download_url: '' };
  }
  return http.post<PluginInstallResp>(`/eco/plugins/${encodeURIComponent(pluginId)}/install`, { version });
}

/** 个人上传（方案 A：draft 即仅本人可见可装；管理员审核 publish 后进公共市场） */
export async function uploadMyPlugin(file: File, notes: string): Promise<PluginEntry> {
  if (USE_MOCK) {
    await delay(300);
    return {
      id: '99', plugin_id: file.name.replace(/\.zip$/, ''), name: file.name.replace(/\.zip$/, ''),
      description: notes || '（个人上传 mock）', category: '', policy: 3, status: 'draft',
      current_version: '0.1.0', created_at: Date.now(), installed: false, has_update: false, owner_user_id: 1,
    };
  }
  const fd = new FormData();
  fd.append('package', file);
  if (notes) fd.append('notes', notes);
  return postMultipart<PluginEntry>('/eco/plugins', fd);
}

export async function uninstallOnServer(pluginId: string): Promise<void> {
  if (USE_MOCK) {
    await delay(120);
    return;
  }
  await http.delete(`/eco/plugins/${encodeURIComponent(pluginId)}/install`);
}

export async function fetchMyPlugins(): Promise<PluginEntry[]> {
  if (USE_MOCK) {
    await delay(150);
    const all = await fetchPluginCatalog();
    return all.filter((p) => p.installed);
  }
  const data = await http.get<{ items: PluginEntry[] }>('/eco/plugins/mine');
  return data.items ?? [];
}

// ---- 安装全链（服务端 install → 下载 → 解压 → 复跑校验 → 壳落盘）----

/** 清单识别（三目录名，兼容顶层单目录；服务端 Go 校验器同口径的轻量子集） */
function findManifest(files: Record<string, Uint8Array>): { base: string; manifest: Record<string, unknown> } | null {
  for (const dir of ['.bbc-plugin', '.claude-plugin', '.zcode-plugin']) {
    const direct = `${dir}/plugin.json`;
    if (files[direct]) {
      try {
        return { base: '', manifest: JSON.parse(strFromU8(files[direct])) as Record<string, unknown> };
      } catch {
        return null;
      }
    }
    for (const path of Object.keys(files)) {
      const parts = path.split('/');
      if (parts.length === 3 && parts[1] === dir && parts[2] === 'plugin.json') {
        try {
          return { base: parts[0], manifest: JSON.parse(strFromU8(files[path])) as Record<string, unknown> };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * 安装/更新到本地（D22 §5.2）：
 * 下载 → 解压 → 清单复跑校验（存在+可解析+name/version 对账）→ 壳分批写入。
 * 落盘成功即激活该版（plugin_write_files 全量成功才切 activeVersion）。
 */
export async function installLocal(
  pluginId: string,
  version: string,
  downloadUrl: string,
): Promise<void> {
  if (!isTauriAvailable()) {
    throw new Error('插件安装需要桌面端（当前为 Web 预览环境）');
  }
  if (!downloadUrl && !USE_MOCK) {
    throw new Error('下载地址缺失');
  }
  // download_url 服务端自带 /api/v1 前缀，而 downloadBlob 内部会拼 API_BASE
  // （已含 /api/v1）——双拼 404，剥掉前缀走相对路径
  const rel = downloadUrl.startsWith('/api/v1/') ? downloadUrl.slice(7) : downloadUrl;
  const blob = await downloadBlob(rel);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const files = unzipSync(buf);
  const found = findManifest(files);
  if (!found) {
    throw new Error('插件包无效：未找到 plugin.json 或解析失败');
  }
  const name = String(found.manifest.name ?? '');
  const ver = String(found.manifest.version ?? '');
  if (name !== pluginId || ver !== version) {
    throw new Error(`插件包对账失败：包内 ${name}@${ver} ≠ 请求 ${pluginId}@${version}`);
  }
  // 组装传输清单（剥离顶层目录前缀；目录条目 unzipSync 已不含——只出文件）
  const payload = Object.entries(files)
    .filter(([p]) => !p.endsWith('/'))
    .map(([p, bytes]) => ({
      path: found.base && p.startsWith(`${found.base}/`) ? p.slice(found.base.length + 1) : p,
      contentB64: toB64(bytes),
    }));
  // 分批传输（单批 ≤256 条防 IPC 载荷过大；中间批 finalize=false 只写文件，
  // 末批 finalize=true 才切 activeVersion——中途失败旧版不受影响）
  const BATCH = 256;
  for (let i = 0; i < payload.length; i += BATCH) {
    const isLast = i + BATCH >= payload.length;
    await invoke('plugin_write_files', {
      pluginId,
      version,
      files: payload.slice(i, i + BATCH),
      finalize: isLast,
    });
  }
}

/** 一键安装（服务端记态 + 本地落盘） */
export async function installPlugin(pluginId: string, version?: string): Promise<void> {
  const resp = await installOnServer(pluginId, version);
  await installLocal(resp.plugin_id, resp.version, resp.download_url);
}

/** 卸载（服务端记态 + 删本地目录；keepConfig 默认保留用户配置 D22 §5.2） */
export async function uninstallPlugin(pluginId: string, keepConfig = true): Promise<void> {
  if (isTauriAvailable()) {
    await invoke('plugin_remove_local', { pluginId, keepConfig });
  }
  await uninstallOnServer(pluginId);
}

// ---- 本地态（壳 command 包装）----

export async function fetchLocalState(pluginId: string): Promise<PluginLocalState | null> {
  if (!isTauriAvailable()) return null;
  const state = await invoke<PluginLocalState | null>('plugin_local_state', { pluginId });
  return state;
}

export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  if (!isTauriAvailable()) throw new Error('需要桌面端');
  await invoke('plugin_set_enabled', { pluginId, enabled });
}

export async function writePluginConfig(
  pluginId: string,
  values: Record<string, string>,
  secretKeys: string[] = [],
): Promise<void> {
  if (!isTauriAvailable()) throw new Error('需要桌面端');
  // 壳侧分流：secret 键入钥匙串（config.json 空串占位），非 secret 直写（D22 §6.1/L4）
  await invoke('plugin_write_config', { pluginId, values, secretKeys });
}
