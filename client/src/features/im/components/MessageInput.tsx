/**
 * 消息输入区（D03 §3.1）：
 * - Enter 发送 / Shift+Enter 换行（D01 §9）
 * - 草稿存 feature store（切换会话即存；正式版 500ms 防抖 + PATCH state 多端同步）
 * - 发送按钮态：可发送（主色）/ 不可发送（禁用）；禁言态（3006）后续接入
 */

import { useState, type KeyboardEvent } from 'react';
import { AtSign, Mic, Paperclip, Smile } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

interface MessageInputProps {
  convId: string;
  /** 广播群普通成员等只读场景（PIM-04：仅发布者可发言） */
  disabled?: boolean;
  disabledHint?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
}

export function MessageInput({ convId, disabled = false, disabledHint, draft, onDraftChange, onSend }: MessageInputProps) {
  const [sending, setSending] = useState(false);

  const doSend = () => {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    onSend(text);
    onDraftChange(''); // 清空草稿（发送成功或手动清空同步空串，INT-IM-10）
    setSending(true);
    setTimeout(() => setSending(false), 300); // 乐观更新即时上屏，此处仅做按钮态节流
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  if (disabled) {
    return (
      <div className="message-input">
        <div className="message-input__muted">{disabledHint ?? '该会话仅发布者可发言'}</div>
      </div>
    );
  }

  return (
    <div className="message-input">
      {/* TODO(D03)：表情面板 / @选择器 / 截图粘贴预览 / 语音条（INT-IM-24/26/27） */}
      <div className="message-input__tools">
        <button className="tool-btn" title="表情" type="button">
          <Smile size={17} />
        </button>
        <button className="tool-btn" title="提及 @" type="button">
          <AtSign size={17} />
        </button>
        <button className="tool-btn" title="附件" type="button">
          <Paperclip size={17} />
        </button>
        <button className="tool-btn" title="语音" type="button">
          <Mic size={17} />
        </button>
      </div>
      <textarea
        className="message-input__textarea"
        rows={3}
        placeholder={`写入 ${convId} …`}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="message-input__foot">
        <span className="message-input__hint">Enter 发送，Shift + Enter 换行</span>
        <Button onClick={doSend} disabled={!draft.trim() || sending}>
          发送
        </Button>
      </div>
    </div>
  );
}
