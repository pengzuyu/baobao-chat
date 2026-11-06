/** 空态基元（D01 §7 empty：图标 + 一行说明 + 主 CTA） */

import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyProps {
  text: string;
  /** 主 CTA（如"发起单聊"），由业务方传入 */
  action?: ReactNode;
}

export function Empty({ text, action }: EmptyProps) {
  return (
    <div className="state-view__inner">
      <div className="state-view__icon" aria-hidden>
        <Inbox size={40} strokeWidth={1.4} />
      </div>
      <div className="state-view__text">{text}</div>
      {action ? <div className="state-view__action">{action}</div> : null}
    </div>
  );
}
