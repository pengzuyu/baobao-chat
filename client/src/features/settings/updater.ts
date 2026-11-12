/**
 * 应用更新（D21）：tauri-plugin-updater 前端服务 + zustand 状态。
 *
 * 流程：check → download（进度）→ install → relaunch（plugin-process）。
 * - 静默检查：App 挂载 startUpdaterAutoCheck（延迟 3s + 每 6h 复查，16 篇 §4.2），
 *   发现新版 → 回调 onUpdateFound（App 层发系统通知，避免 settings→agent 横向 import）。
 * - 手动入口：设置·关于「检查更新」。
 * - 降级口径：非 Tauri 宿主（浏览器 dev/mock）与 updater 未启用（pubkey 空=壳侧
 *   未注册插件，lib.rs 条件注册）一律静默/报错不炸；更新是增益不是依赖。
 * - Linux deb/rpm 安装（非 AppImage）install 阶段会失败——error 时关于页给官网
 *   下载引导（Tauri 限制：仅 AppImage 支持应用内自更新）。
 */

import { create } from 'zustand';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/** Tauri 宿主判定（同库内四处局部惯例：不引 features/agent 桥，settings 域自治） */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface UpdateInfo {
  version: string;
  /** 更新说明（manifest notes；可空） */
  notes: string;
  date: string | null;
}

interface UpdaterStore {
  checking: boolean;
  downloading: boolean;
  /** 下载进度：received 累计字节；total 可能未知（服务端无 content-length） */
  progress: { received: number; total: number | null } | null;
  available: UpdateInfo | null;
  readyToInstall: boolean;
  /** 最近一次手动检查确认无更新（展示「已是最新」；静默检查不点亮） */
  upToDate: boolean;
  error: string | null;
  manualCheck: () => Promise<void>;
  download: () => Promise<void>;
  installAndRelaunch: () => Promise<void>;
}

/** 待安装的 Update 实例（含 download/install 句柄；模块级单例不进 store——不可序列化） */
let pending: Update | null = null;

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  checking: false,
  downloading: false,
  progress: null,
  available: null,
  readyToInstall: false,
  upToDate: false,
  error: null,

  manualCheck: async () => {
    if (get().checking) return;
    if (!isTauri()) {
      set({ error: '当前环境不支持应用内更新（仅桌面端）' });
      return;
    }
    set({ checking: true, error: null, upToDate: false });
    try {
      const update = await check();
      if (update) {
        pending = update;
        set({
          available: {
            version: update.version,
            notes: update.body ?? '',
            date: update.date ?? null,
          },
          readyToInstall: false,
          progress: null,
        });
      } else {
        pending = null;
        set({ available: null, upToDate: true });
      }
    } catch (e) {
      // 壳侧 pubkey 空（插件未注册）/ manifest 拉取失败等
      set({ error: String(e) });
    } finally {
      set({ checking: false });
    }
  },

  download: async () => {
    if (!pending || get().downloading) return;
    set({ downloading: true, error: null, progress: { received: 0, total: null } });
    let received = 0;
    let total: number | null = null;
    const onEvent = (event: DownloadEvent) => {
      if (event.event === 'Started' && event.data.contentLength) {
        total = event.data.contentLength;
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength;
      }
      set({ progress: { received, total } });
    };
    try {
      await pending.download(onEvent);
      set({ readyToInstall: true });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ downloading: false });
    }
  },

  installAndRelaunch: async () => {
    if (!pending) return;
    set({ error: null });
    try {
      await pending.install();
      await relaunch();
    } catch (e) {
      // Linux deb/rpm（非 AppImage）在此失败属预期——关于页给官网引导
      set({ error: String(e) });
    }
  },
}));

// ── 静默自动检查（App 挂载调一次）──

const FIRST_CHECK_DELAY_MS = 3_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 已通知过的版本（去重：6h 复查同一版本不重复弹系统通知） */
let lastNotifiedVersion: string | null = null;
let autoCheckStarted = false;

/**
 * 启动静默检查循环。onUpdateFound 由 App 层注入（发系统通知等 UI 触达），
 * 仅在「新发现且未通知过」的版本上回调一次。
 */
export function startUpdaterAutoCheck(onUpdateFound: (info: UpdateInfo) => void): void {
  if (autoCheckStarted || !isTauri()) return;
  autoCheckStarted = true;

  const doCheck = async () => {
    try {
      const update = await check();
      const store = useUpdaterStore.getState();
      if (!update) return;
      // 已在下载/待装状态（关于页走了一半）不打扰
      if (store.downloading || store.readyToInstall) return;
      pending = update;
      const info: UpdateInfo = {
        version: update.version,
        notes: update.body ?? '',
        date: update.date ?? null,
      };
      useUpdaterStore.setState({ available: info, error: null });
      if (info.version !== lastNotifiedVersion) {
        lastNotifiedVersion = info.version;
        onUpdateFound(info);
      }
    } catch {
      // 静默吞（插件未注册/网络失败/服务器无 manifest——更新是增益不是依赖）
    }
  };

  window.setTimeout(() => void doCheck(), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void doCheck(), RECHECK_INTERVAL_MS);
}
