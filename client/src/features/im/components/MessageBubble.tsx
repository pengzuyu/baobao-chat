/**
 * 消息气泡族（D03 §3.2）：
 * - text：己方 primary 浅底 / 对方 gray-2，圆角 12 带 4 尾巴
 * - 附件类：文件卡片占位（图片/文件查看器在 D06 接入）
 * - system：居中弱化（PIM-12 样式集入口）
 * - 本地态尾标：sending 灰钟 → sent ✓ → 对方已读 ✓✓（msg.receipt，04 篇 §4.2）；failed 红叹号（点击重试，INT-IM-01a）
 */

import { AlertCircle, Check, CheckCheck, Clock3, FileText, RotateCcw } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { getErrorText } from '../../../shared/api/http';
import { digestOf } from '../store/im';
import type { Message } from '../model/types';

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  onRetry: (clientMsgId: string) => void;
  /** 对方已读游标（msg.receipt 维护）：mine 且 sent 且 seq ≤ 此值 → ✓✓ */
  peerReadSeq?: number;
}

/** 本地态/服务端态尾标（✓✓=对方已读，单聊回执） */
function StateTag({ message, onRetry, peerReadSeq = 0 }: { message: Message; onRetry: (id: string) => void; peerReadSeq?: number }) {
  if (!message.localState) return null;
  if (message.localState === 'sending')
    return (
      <span className="msg-state" title="发送中">
        <Clock3 size={13} />
      </span>
    );
  if (message.localState === 'sent')
    return (
      <span className="msg-state" title={peerReadSeq >= message.seq ? '对方已读' : '已送达'}>
        {peerReadSeq >= message.seq ? <CheckCheck size={14} /> : <Check size={14} />}
      </span>
    );
  return (
    <span
      className="msg-state msg-state--failed"
      title={getErrorText(3007)}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(message.clientMsgId);
      }}
    >
      <AlertCircle size={14} />
      <RotateCcw size={12} />
      重试
    </span>
  );
}

/** 附件类消息：文件卡片（图片/视频预览在 D06 图片查看器接入） */
function FileCard({ name }: { name: string }) {
  return (
    <div className="file-card">
      <div className="file-card__icon">
        <FileText size={20} />
      </div>
      <div className="file-card__meta">
        <div className="file-card__name">{name}</div>
        <div className="file-card__hint">附件 · 查看器后续接入（D06）</div>
      </div>
    </div>
  );
}

export function MessageBubble({ message, mine, onRetry, peerReadSeq = 0 }: MessageBubbleProps) {
  // 系统消息：居中弱化，不参与回执/右键（PIM-12）
  if (message.type === 'system') {
    const text = 'text' in message.body ? message.body.text : '系统消息';
    return <div className="msg-system">{text}</div>;
  }

  const isFile = message.type !== 'text';

  return (
    <div className={`msg-row${mine ? ' msg-row--mine' : ''}`}>
      <Avatar name={message.senderName} size={32} />
      <div className="msg-row__body">
        {/* 己方不显示发送者名（飞书/微信惯例）；群聊对方消息保留 */}
        {mine ? null : <span className="msg-row__sender">{message.senderName}</span>}
        {isFile ? (
          <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
            <FileCard name={'name' in message.body && message.body.name ? message.body.name : digestOf(message)} />
          </span>
        ) : (
          <span className={`bubble ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
            {'text' in message.body ? message.body.text : digestOf(message)}
          </span>
        )}
        {mine ? <StateTag message={message} onRetry={onRetry} peerReadSeq={peerReadSeq} /> : null}
      </div>
    </div>
  );
}
