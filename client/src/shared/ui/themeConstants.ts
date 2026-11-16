/**
 * 主题单源（D27 主题机制与色彩规范——见 docs/detail/D27-主题机制与色彩规范.md）：
 * 1) antd theme：providers 只调 antdThemeFrom(mode)，antd 组件取色全走 ConfigProvider；
 * 2) CSS 变量：cssVarsFrom(mode) 由 providers 注入 document root 的 --bbw-*，
 *    残余自研 CSS（气泡/markdown 等）与 antd 组件**同一份令牌源**，切主题即时联动。
 * tokens.css 仅作 React 挂载前的首屏兜底基线（值与本文件一致）。
 *
 * 色彩方向（2026-11-14 拍板黑白反色 → 2026-11-16 修订：用户嫌暗色难看）：
 * - 亮色保持黑白反色（Vercel 风）：主色纯黑、白底；
 * - 暗色改**蓝调分层黑 + 彩色主色**（Slack/Linear 风）：布局 #0b0e14 → 容器 #11151d，
 *   主色柔蓝 #5b8cff，文字米白 #e8eaf0（非纯白）——聊天应用不再冷硬无焦点；
 * - 语义色按底色调亮度（暗底提亮、白底压深）。
 */

import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

/** 亮色基线（= tokens.css :root；主色黑、灰阶中性） */
const LIGHT = {
  primary: '#000000',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  bgLayout: '#f5f5f5',
  bgContainer: '#ffffff',
  gray: ['#ffffff', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#3f3f3f', '#262626', '#171717'],
} as const;

/** 暗色（= tokens.css [data-theme='dark']；蓝调分层黑 + 彩色主色） */
const DARK = {
  primary: '#5b8cff',
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
  bgLayout: '#0b0e14',
  bgContainer: '#11151d',
  gray: ['#11151d', '#161b26', '#232a36', '#2c3442', '#3d4757', '#8a93a5', '#9aa3b2', '#c6ccd8', '#dde2ec', '#e8eaf0'],
} as const;

type Mode = 'light' | 'dark';

const of = (mode: Mode) => (mode === 'dark' ? DARK : LIGHT);

export const THEME = {
  primary: LIGHT.primary,
  primaryHover: '#262626',
  success: LIGHT.success,
  warning: LIGHT.warning,
  danger: LIGHT.danger,
  fontFamily: `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Inter', sans-serif`,
} as const;

/** 主色 hover/light 派生（气泡底/选中浅底；亮=灰阶 2 档、暗=蓝调深底一档） */
const primaryHoverOf = (mode: Mode) => (mode === 'dark' ? '#7ba3ff' : '#262626');
const primaryLightOf = (mode: Mode) => (mode === 'dark' ? '#1d2739' : '#f0f0f0');

/** antd ThemeConfig 单源工厂（D26 §2 起沿用；D27 分层黑修订） */
export function antdThemeFrom(mode: Mode): ThemeConfig {
  const c = of(mode);
  return {
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: c.primary,
      colorInfo: c.primary,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.danger,
      colorText: c.gray[9],
      colorTextSecondary: c.gray[6],
      colorBorder: c.gray[2],
      colorBorderSecondary: mode === 'dark' ? '#1a2030' : '#f0f0f0',
      colorBgContainer: c.bgContainer,
      colorBgLayout: c.bgLayout,
      colorBgBase: mode === 'dark' ? '#0b0e14' : '#ffffff',
      borderRadius: 6, // = --bbw-radius-control
      fontSize: 14, // = --bbw-font-14
      controlHeight: 32,
      fontFamily: THEME.fontFamily,
    },
    components: {
      Button: { borderRadius: 6 },
      Modal: { titleFontSize: 16 }, // = --bbw-font-16
      Table: { headerBg: mode === 'dark' ? '#151a24' : '#f5f5f5' },
    },
  };
}

/**
 * CSS 变量注入源（D27 机制核心）：providers 在主题切换时把本表写入 document root，
 * 使残余自研 CSS（var(--bbw-*)）与 antd 组件同源取色。键名与 tokens.css 对齐。
 */
export function cssVarsFrom(mode: Mode): Record<string, string> {
  const c = of(mode);
  const vars: Record<string, string> = {
    '--bbw-primary': c.primary,
    '--bbw-primary-hover': primaryHoverOf(mode),
    '--bbw-primary-light': primaryLightOf(mode),
    '--bbw-success': c.success,
    '--bbw-warning': c.warning,
    '--bbw-danger': c.danger,
    '--bbw-info': c.primary, // 黑白反色系 info 跟随主色
  };
  c.gray.forEach((v, i) => {
    vars[`--bbw-gray-${i + 1}`] = v;
  });
  return vars;
}
