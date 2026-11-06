/** 设计基元：按钮（哑组件，样式令牌见 tokens.css） */

import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({ variant = 'primary', loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button className={`bbw-btn bbw-btn--${variant}`} disabled={disabled || loading} {...rest}>
      {loading ? (
        <>
          <Loader2 size={14} className="bbw-spin" aria-hidden />
          {children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
