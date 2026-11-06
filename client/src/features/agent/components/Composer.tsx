/**
 * 工作台输入区（PAG-03 §3.3 输入框规范）：
 * - Enter 发送 / Shift+Enter 换行
 * - 暂停/等待审批/运行中/已结束等态禁用（禁用规则见 store.composerDisabledFor）
 * - 紧急停止按钮为红色（INT-AG-12 三入口之一）
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

interface ComposerProps {
  disabled: boolean;
  disabledHint?: string;
  /** 运行/等待审批/暂停时展示红色紧急停止 */
  canStop: boolean;
  onSend: (text: string) => void;
  onEmergencyStop: () => void;
}

export function Composer({ disabled, disabledHint, canStop, onSend, onEmergencyStop }: ComposerProps) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="agent-composer">
      <textarea
        ref={taRef}
        className="agent-composer__textarea"
        value={text}
        rows={2}
        placeholder={disabled ? (disabledHint ?? '当前状态不可输入') : '输入任务，Enter 发送（Shift+Enter 换行）'}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Agent 会话输入框"
      />
      <div className="agent-composer__foot">
        <span className="agent-composer__hint">{disabled ? (disabledHint ?? '') : '/ 指令 · Enter 发送'}</span>
        <div className="agent-composer__actions">
          {/* 紧急停止（红色）：会话运行/等待审批/暂停中出现 */}
          {canStop ? (
            <Button variant="danger" onClick={onEmergencyStop} className="agent-composer__stop">
              <Square size={12} aria-hidden />
              紧急停止
            </Button>
          ) : null}
          <Button variant="primary" onClick={submit} disabled={disabled || !text.trim()}>
            <Send size={12} aria-hidden />
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}
