/**
 * 主题全局态（D01 §12.2-5：主题属全局态，归 shared/store）：
 * - mode 三态：light / dark / system（system 跟随 OS prefers-color-scheme）
 * - resolved 为实际生效值，驱动 <html data-theme> 与 antd ConfigProvider algorithm
 * - 持久化：localStorage('bbw-theme')。主题是 UI 偏好而非业务数据，
 *   不受"业务数据禁止 localStorage（D01 §12.2-5）"红线约束；后续统一设置存储迁 Rust 层。
 * - 防闪烁：index.html 内联脚本在 React 挂载前已先行设置 data-theme。
 */

import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bbw-theme';

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

function readInitialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readInitialMode(),
  resolved: resolveMode(readInitialMode()),
  setMode: (mode) => {
    const resolved = resolveMode(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    applyTheme(resolved);
    set({ mode, resolved });
  },
}));

// system 模式跟随 OS 实时切换（模块级注册一次，随应用生命周期存活）
// 注意：此处位于 create 回调外，set/get 不可见——必须经 getState/setState（曾因裸用 get 白屏）
if (typeof window !== 'undefined') {
  const followSystem = () => {
    const s = useThemeStore.getState();
    if (s.mode !== 'system') return;
    const resolved = resolveMode('system');
    applyTheme(resolved);
    useThemeStore.setState({ resolved });
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', followSystem);
  // 挂载时校正一次（防闪烁脚本仅推导初始值，此处以 store 为准）
  applyTheme(useThemeStore.getState().resolved);
}
