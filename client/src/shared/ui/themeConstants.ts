/**
 * 主题色值 TS 常量（与 src/styles/tokens.css :root 对齐，修改需双侧同步）。
 * 用途：antd ConfigProvider 的 JS 侧 token（CSS 变量无法直接注入 antd theme），
 * 消除 providers 中散落的硬编码色值（D01 §14 开放问题 2：AntD token 融合方案）。
 */

export const THEME = {
  primary: '#2e6be6',
  primaryHover: '#2456b8',
  success: '#23a55b',
  warning: '#e6a23c',
  danger: '#e5484d',
  fontFamily: `-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Inter', sans-serif`,
} as const;
