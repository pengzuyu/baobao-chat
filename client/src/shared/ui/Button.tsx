/**
 * 按钮基元（D26-O1 包装化）：内部换 antd Button，对外 API 不动（variant/loading/原生属性），
 * 调用点零改动。观感随 antd theme（antdThemeFrom 单源）——旧 bbw-btn 自研样式已退役
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
}

/** variant → antd：primary→primary、secondary→default、text→text、danger→primary+danger（实底红） */
export function Button({ variant = 'primary', loading = false, disabled, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <AntdButton
      type={variant === 'secondary' ? 'default' : variant === 'danger' ? 'primary' : variant}
      danger={variant === 'danger'}
      loading={loading}
      disabled={disabled}
      htmlType={type}
      {...rest}
    >
      {children}
    </AntdButton>
  );
}
