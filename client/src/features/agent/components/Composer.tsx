/**
 * 工作台输入区（PAG-03 §3.3 输入框规范）：
 * - Enter 发送 / Shift+Enter 换行
 * - 暂停/等待审批/运行中/已结束等态禁用（禁用规则见 store.composerDisabledFor）
 * - 停止按钮为红色（2026-11-11：中断当前轮=收口 idle 可继续，取代旧「紧急停止」
 *   杀进程语义——杀进程兜底退居 ⌘⇧. 全局快捷键）
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useImeGuard } from '../../../shared/hooks/useImeGuard';

interface ComposerProps {
  disabled: boolean;
  disabledHint?: string;
  /** 运行/等待审批/子任务/委派中展示红色停止（中断当前轮） */
  canStop: boolean;
  onSend: (text: string) => void;
  /** 停止当前会话正在生成的回答（interrupt；会话保留可继续追问） */
  onStop: () => void;
  /** 权限模式选择（2026-11-11 挪入输入框：页面注入 Dropdown 节点） */
  modePicker?: ReactNode;
  /** 模型+思考强度选择（2026-11-11 zcode 同款合体 Popover：页面注入 ModelThinkPicker） */
  modelPicker?: ReactNode;
}

export function Composer({ disabled, disabledHint, canStop, onSend, onStop, modePicker, modelPicker }: ComposerProps) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { imeComposing, imeCompositionProps } = useImeGuard();

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 确认键防误发：WKWebView 上 isComposing 常缺，组合窗跟踪兜底（useImeGuard）
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !imeComposing()) {
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
        {...imeCompositionProps}
        aria-label="Agent 会话输入框"
      />
      <div className="agent-composer__foot">
        {modePicker}
        {modelPicker}
        <div className="agent-composer__actions">
          {/* 停止（红色）：中断当前回答，会话保留可继续 */}
          {canStop ? (
            <Button variant="danger" onClick={onStop} className="agent-composer__stop">
              <Square size={12} aria-hidden />
              停止
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
