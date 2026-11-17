/**
 * 按钮基元（D26-O1 包装化）：内部换 antd Button，对外 API 不动（variant/loading/原生属性），
 * 调用点零改动。观感随 antd theme（antdThemeFrom 单源）——旧 bbc-btn 自研样式已退役
 * （2026-11-13 拍板：不自带样式，统一 antd 原生，微调走 theme）。
 */

import { Button as AntdButton } from 'antd';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger';

// Omit type（与 antd type 冲突，经 variant 映射）/ size（HTML number 型，antd 为 SizeType）/
// color（HTML string 型，antd 为预设枚举）
interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'size' | 'color'> {
  variant?: ButtonVariant;
  loading?: boolean;
  children?: ReactNode;
  /** 原生 button type（submit/reset），默认 button */
  type?: 'submit' | 'reset' | 'button';
  /** antd 尺寸（D26-O2 增补：树行/表单内紧凑按钮用 small；HTML number 型冲突已 Omit） */
  size?: 'small' | 'middle' | 'large';
  /** antd 图标位（D26-O2 增补：树行 icon-only 按钮） */
  icon?: ReactNode;
  /** antd 危险色（D26-O2 增补：配合 text/secondary 变体做红字/红边，非实底） */
  danger?: boolean;
}

/** variant → antd：primary→primary、secondary→default、text→text、danger→primary+danger（实底红） */
export function Button({ variant = 'primary', loading = false, disabled, children, type = 'button', size, icon, danger, ...rest }: ButtonProps) {
  return (
    <AntdButton
      type={variant === 'secondary' ? 'default' : variant === 'danger' ? 'primary' : variant}
      danger={danger || variant === 'danger'}
      loading={loading}
      disabled={disabled}
      htmlType={type}
      size={size}
      icon={icon}
      {...rest}
    >
      {children}
    </AntdButton>
  );
}
