/**
 * doc 域轻量 toast（阶段一：右下角浮层，3.5s 自动消失；与 ChatPage fav-toast
 * 同款 ann-banner 视觉语言。antd message 全局接线阶段二统一，登记）。
 */

import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

export interface DocToastState {
  ok: boolean;
  text: string;
}

export function DocToast({ toast, onDone }: { toast: DocToastState | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDone, 3500);
    return () => clearTimeout(timer);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div className={`doc-toast${toast.ok ? '' : ' doc-toast--warn'}`} data-testid="doc-toast" role="status">
      {toast.ok ? <CheckCircle2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
      <span>{toast.text}</span>
    </div>
  );
}
