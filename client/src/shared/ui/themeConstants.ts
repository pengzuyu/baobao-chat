/**
 * 主题单源（D26 §2）：antd theme 亮/暗令牌全部由本文件产出，providers 只调 antdThemeFrom(mode)。
 * 色值与 src/styles/tokens.css --bbw-* 对齐（修改需双侧同步）。
 * 口径（2026-11-13 用户补充拍板）：组件级自研样式一律退役走 antd 原生观感，
 * 本层只保留品牌基线（主色/灰阶/圆角/字号/控件高）——后续观感微调改这里即可。
 */

import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';

/** 亮色基线（= tokens.css :root） */
const LIGHT = {
  primary: '#2e6be6',
  success: '#23a55b',
  warning: '#e6a23c',
  danger: '#e5484d',
  gray1: '#ffffff', // 容器表面
  gray2: '#f2f3f5', // 布局底
  gray3: '#e5e6eb', // 边框
  gray8: '#4e5969', // 次要文字
  gray9: '#272e3b', // 主文字
} as const;

/** 暗色（= tokens.css [data-theme='dark']） */
const DARK = {
  primary: '#4c84f0',
  success: '#3cbf74',
  warning: '#f0b45c',
  danger: '#f0656a',
  gray1: '#1f2329',
  gray2: '#272e38',
  gray3: '#343b46',
  gray8: '#c9ced6',
  gray9: '#e2e6ea',
} as const;

export const THEME = {
  primary: LIGHT.primary,
  primaryHover: '#2456b8',
  success: LIGHT.success,
  warning: LIGHT.warning,
  danger: LIGHT.danger,
  fontFamily: `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Inter', sans-serif`,
} as const;

/** antd ThemeConfig 单源工厂：亮/暗同一映射函数读对应令牌组（D26 §2） */
export function antdThemeFrom(mode: 'light' | 'dark'): ThemeConfig {
  const c = mode === 'dark' ? DARK : LIGHT;
  return {
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: c.primary,
      colorInfo: c.primary,
      colorSuccess: c.success,
      colorWarning: c.warning,
      colorError: c.danger,
      colorText: c.gray9,
      colorTextSecondary: c.gray8,
      colorBorder: c.gray3,
      colorBorderSecondary: c.gray2,
      colorBgContainer: c.gray1,
      colorBgLayout: c.gray2,
      borderRadius: 6, // = --bbw-radius-control
      fontSize: 14, // = --bbw-font-14
      controlHeight: 32,
      fontFamily: THEME.fontFamily,
    },
    components: {
      Button: { borderRadius: 6 },
      Modal: { titleFontSize: 16 }, // = --bbw-font-16
      Table: { headerBg: c.gray2 },
    },
  };
}
