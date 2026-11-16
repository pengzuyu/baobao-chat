/**
 * 主题单源（D27 主题机制与色彩规范——见 docs/detail/D27-主题机制与色彩规范.md）：
 * 1) antd theme：providers 只调 antdThemeFrom(mode, accent)，antd 组件取色全走 ConfigProvider；
 * 2) CSS 变量：cssVarsFrom(mode, accent) 由 providers 注入 document root 的 --bbw-*，
 *    残余自研 CSS（气泡/markdown 等）与 antd 组件**同一份令牌源**，切主题即时联动。
 * tokens.css 仅作 React 挂载前的首屏兜底基线（值=默认 accent 晨蓝，与本文件一致）。
 *
 * 色彩方向（2026-11-14 黑白反色 → 11-16 修订1 暗色蓝调 → 11-16 修订2 accent 化）：
 * - 双维矩阵：mode（light/dark：表面分层+灰阶+语义色）× accent（六套主题色，只主色系跟随）；
 * - 亮色弃纯黑主色：纯黑遇 antd 调色板派生（colorPrimaryBg 每档仅 +5% 明度）产出炭灰
 *   选中底→黑块，故亮色默认晨蓝 #1677ff（antd 官方蓝）；
 * - 墨黑 accent 保留原黑白反色极简风（Menu 选中态显式覆写后观感正常）；
 * - 语义色（success/warning/danger）按底色调亮度（暗底提亮、白底压深），不随 accent 变。
 */

import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

export type Mode = 'light' | 'dark';

/** 主题色 accent：六套预置，主色系（primary/hover/light）随其切换，其余令牌不动 */
export type ThemeAccent = 'blue' | 'violet' | 'teal' | 'orange' | 'rose' | 'graphite';

/** 单档主色（light 档=选中浅底 / 己方气泡底） */
interface AccentTone {
  primary: string;
  hover: string;
  light: string;
}

/**
 * 主题色注册表（D27 修订2 唯一主色源）：每套 × 亮/暗各 3 档。
 * 亮档=白底压深（antd 官方蓝 #1677ff 系）；暗档=暗底提亮一档 + accent 调深底作选中/气泡。
 * 其余派生档（colorPrimaryBg/hover 等）由 antd 算法从 primary 自动生成。
 */
export const ACCENTS: Record<ThemeAccent, { label: string; light: AccentTone; dark: AccentTone }> = {
  blue: {
    label: '晨蓝',
    light: { primary: '#1677ff', hover: '#4096ff', light: '#e6f4ff' },
    dark: { primary: '#5b8cff', hover: '#7ba3ff', light: '#1d2739' },
  },
  violet: {
    label: '紫罗兰',
    light: { primary: '#7c3aed', hover: '#6d28d9', light: '#f1eafd' },
    dark: { primary: '#a78bfa', hover: '#c0aefb', light: '#272145' },
  },
  teal: {
    label: '青碧',
    light: { primary: '#0d9488', hover: '#0f766e', light: '#e5f5f2' },
    dark: { primary: '#2dd4bf', hover: '#57e0cf', light: '#10312f' },
  },
  orange: {
    label: '暖橙',
    light: { primary: '#ea580c', hover: '#c2410c', light: '#fdeee2' },
    dark: { primary: '#fb923c', hover: '#fdb074', light: '#37210f' },
  },
  rose: {
    label: '玫红',
    light: { primary: '#e11d48', hover: '#be123c', light: '#fce8ee' },
    dark: { primary: '#fb7185', hover: '#fda0ae', light: '#361626' },
  },
  graphite: {
    label: '墨黑',
    light: { primary: '#171717', hover: '#262626', light: '#f0f0f0' },
    dark: { primary: '#e8eaf0', hover: '#dde2ec', light: '#232a36' },
  },
};

export const DEFAULT_ACCENT: ThemeAccent = 'blue';

/** 亮色基线（= tokens.css :root；灰阶中性） */
const LIGHT = {
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  bgLayout: '#f5f5f5',
  bgContainer: '#ffffff',
  gray: ['#ffffff', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#3f3f3f', '#262626', '#171717'],
} as const;

/** 暗色（= tokens.css [data-theme='dark']；蓝调分层黑） */
const DARK = {
  success: '#4ade80',
  warning: '#fbbf24',
  danger: '#f87171',
  bgLayout: '#0b0e14',
  bgContainer: '#11151d',
  gray: ['#11151d', '#161b26', '#232a36', '#2c3442', '#3d4757', '#8a93a5', '#9aa3b2', '#c6ccd8', '#dde2ec', '#e8eaf0'],
} as const;

const of = (mode: Mode) => (mode === 'dark' ? DARK : LIGHT);
const toneOf = (mode: Mode, accent: ThemeAccent) => ACCENTS[accent][mode];

const FONT_FAMILY = `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Inter', sans-serif`;

/** antd ThemeConfig 单源工厂（D26 §2 起沿用；D27 修订2 扩 accent 维度） */
export function antdThemeFrom(mode: Mode, accent: ThemeAccent = DEFAULT_ACCENT): ThemeConfig {
  const c = of(mode);
  const t = toneOf(mode, accent);
  return {
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: t.primary,
      colorInfo: t.primary,
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
      fontFamily: FONT_FAMILY,
    },
    components: {
      Button: { borderRadius: 6 },
      Modal: { titleFontSize: 16 }, // = --bbw-font-16
      Table: { headerBg: mode === 'dark' ? '#151a24' : '#f5f5f5' },
      // D27 修订2：显式覆写选中态——antd 默认 itemSelectedBg=colorPrimaryBg（主色调色板派生
      // 第 1 档），纯黑/近白主色派生异常（炭灰黑块），走 accent 注册表三档才可控；
      // 全局生效（主导航竖排 + 设置页/管理页水平菜单）
      Menu: { itemSelectedBg: t.light, itemSelectedColor: t.primary },
    },
  };
}

/**
 * CSS 变量注入源（D27 机制核心）：providers 在主题/accent 切换时把本表写入 document root，
 * 使残余自研 CSS（var(--bbw-*)）与 antd 组件同源取色。键名与 tokens.css 对齐。
 */
export function cssVarsFrom(mode: Mode, accent: ThemeAccent = DEFAULT_ACCENT): Record<string, string> {
  const c = of(mode);
  const t = toneOf(mode, accent);
  const vars: Record<string, string> = {
    '--bbw-primary': t.primary,
    '--bbw-primary-hover': t.hover,
    '--bbw-primary-light': t.light,
    '--bbw-success': c.success,
    '--bbw-warning': c.warning,
    '--bbw-danger': c.danger,
    '--bbw-info': t.primary, // info 跟随主题色
  };
  c.gray.forEach((v, i) => {
    vars[`--bbw-gray-${i + 1}`] = v;
  });
  return vars;
}
