/**
 * 主题全局态（D01 §12.2-5：主题属全局态，归 shared/store）：
 * - mode 三态：light / dark / system（system 跟随 OS prefers-color-scheme）
 * - resolved 为实际生效值，驱动 <html data-theme> 与 antd ConfigProvider algorithm
 * - accent 主题色（D27 修订2）：六套预置主色，与 mode 正交组合；只影响主色系
 *   （primary/hover/light 三档，见 themeConstants ACCENTS 注册表），不动灰阶/语义色；
 *   无需 html 属性/防闪烁——providers 在首帧内容前经 ConfigProvider + CSS 变量注入生效
 * - 持久化：localStorage('bbc-theme' / 'bbc-accent')。主题是 UI 偏好而非业务数据，
 *   不受"业务数据禁止 localStorage（D01 §12.2-5）"红线约束；后续统一设置存储迁 Rust 层。
 * - 防闪烁：index.html 内联脚本在 React 挂载前已先行设置 data-theme。
 */

import { create } from 'zustand';
import { ACCENTS, DEFAULT_ACCENT, type ThemeAccent } from '../ui/themeConstants';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type { ThemeAccent };

const STORAGE_KEY = 'bbc-theme';
const ACCENT_STORAGE_KEY = 'bbc-accent';

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

function readInitialMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  // 2026-11-16 用户拍板：默认主题=亮色（11-14 曾拍暗色，真机嫌暗色难看后修订）；
  // 用户显式选过则尊重其选择
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'light';
}

function readInitialAccent(): ThemeAccent {
  const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
  // D27 修订2：默认晨蓝；注册表外的存量值（含旧键污染）一律回落默认
  return saved && saved in ACCENTS ? (saved as ThemeAccent) : DEFAULT_ACCENT;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  accent: ThemeAccent;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: ThemeAccent) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: readInitialMode(),
  resolved: resolveMode(readInitialMode()),
  accent: readInitialAccent(),
  setMode: (mode) => {
    const resolved = resolveMode(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    applyTheme(resolved);
    set({ mode, resolved });
  },
  setAccent: (accent) => {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    set({ accent });
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
