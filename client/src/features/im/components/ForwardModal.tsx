/**
 * 转发面板（PIM-10 简版）：目标会话单选 + 附言；逐条转发（合并转发 ≤30 后续接入）。
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { forwardMessages } from '../api/im';
import type { Conversation } from '../model/types';

interface ForwardModalProps {
  convs: Conversation[];
  /** 转发消息 msgId 列表（单条或多选） */
  msgIds: string[];
  onClose: () => void;
  onDone: (sent: number) => void;
}

export function ForwardModal({ convs, msgIds, onClose, onDone }: ForwardModalProps) {
  const [target, setTarget] = useState<string>('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const doForward = async () => {
    if (!target || sending) return;
    setSending(true);
    try {
      const res = await forwardMessages(target, msgIds, 'one_by_one', note.trim() || undefined);
      onDone(res.sentCount);
    } catch {
      onDone(0);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="forward-modal" onClick={(e) => e.stopPropagation()}>
        <div className="forward-modal__head">
          <span>转发 {msgIds.length > 1 ? `${msgIds.length} 条消息` : '消息'}</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="forward-modal__list">
          {convs
            .filter((c) => c.status === 1)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className={`forward-modal__item${target === c.id ? ' forward-modal__item--active' : ''}`}
                onClick={() => setTarget(c.id)}
              >
                <span className="forward-modal__name">
                  {c.type === 1 ? c.name : `${c.name} (${c.memberCount})`}
                </span>
                <span className="forward-modal__hint">{c.lastMsgDigest?.slice(0, 20) ?? ''}</span>
              </button>
            ))}
        </div>
        <textarea
          className="forward-modal__note"
          rows={2}
          placeholder="附言（可选，≤500 字）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="forward-modal__foot">
          <Button onClick={onClose}>取消</Button>
          <Button onClick={() => void doForward()} disabled={!target || sending}>
            {sending ? '转发中…' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  );
}
