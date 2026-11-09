/**
 * 已读回执面板（API-IM-06）：消息尾标点击弹出，已读/未读两 tab 成员名单。
 * 拉取时机=打开时（名单为查询时点快照，不订阅增量——面板短生命周期）。
 */

import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { getErrorText } from '../../../shared/api/http';
import { Avatar } from '../../../shared/ui/Avatar';
import { fetchReceiptPanel, type ReceiptPanelRow } from '../api/im';

interface ReadReceiptModalProps {
  convId: string;
  seq: number;
  onClose: () => void;
}

export function ReadReceiptModal({ convId, seq, onClose }: ReadReceiptModalProps) {
  const [tab, setTab] = useState<'read' | 'unread'>('read');
  const [rows, setRows] = useState<{ read: ReceiptPanelRow[]; unread: ReceiptPanelRow[] } | null>(null);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErrorText('');
    fetchReceiptPanel(convId, seq)
      .then((r) => alive && setRows(r))
      .catch((err) => alive && setErrorText(getErrorText((err as { code?: number }).code ?? 9004)));
    return () => {
      alive = false;
    };
  }, [convId, seq]);

  const list = rows ? (tab === 'read' ? rows.read : rows.unread) : [];

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="receipt-modal" data-testid="receipt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="receipt-modal__head">
          <span className="receipt-modal__title">消息已读情况</span>
          <button type="button" className="receipt-modal__close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="receipt-modal__tabs">
          <button
            type="button"
            className={`receipt-modal__tab${tab === 'read' ? ' receipt-modal__tab--active' : ''}`}
            onClick={() => setTab('read')}
          >
            已读 {rows ? rows.read.length : '…'}
          </button>
          <button
            type="button"
            className={`receipt-modal__tab${tab === 'unread' ? ' receipt-modal__tab--active' : ''}`}
            onClick={() => setTab('unread')}
          >
            未读 {rows ? rows.unread.length : '…'}
          </button>
        </div>
        <div className="receipt-modal__list">
          {errorText ? <div className="receipt-modal__empty">{errorText}</div> : null}
          {!errorText && !rows ? <div className="receipt-modal__empty">加载中…</div> : null}
          {!errorText && rows && list.length === 0 ? (
            <div className="receipt-modal__empty">{tab === 'read' ? '暂无已读' : '全部已读 🎉'}</div>
          ) : null}
          {list.map((m) => (
            <div key={m.uid} className="receipt-modal__row">
              <Avatar name={m.displayName} size={24} />
              <span className="receipt-modal__name">{m.displayName}</span>
              {tab === 'read' ? (
                <Check size={14} className="receipt-modal__check" />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
