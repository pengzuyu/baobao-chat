/**
 * 转发面板（PIM-10b 完整版，D03 §3.10 / INT-IM-05）：
 * - 搜索会话 + 最近会话 chip + 会话列表单选
 * - 方式 radio（>1 条出现：合并转发 ≤30 / 逐条转发）；附言 textarea ≤500
 * - 合并 >30 条前端拦截（3021 文案 toast，不发请求）；目标广播群非 publisher 前置隐藏（3013）
 * - 六态：loading=发送中按钮态 / empty=无会话提示 / error=3013 等错误码文案 + 逐条失败明细 /
 *   offline=禁发提示 / forbidden=广播群目标过滤 / degraded 不适用（登记）
 */

import { useEffect, useMemo, useState } from 'react';
import { Search, Send, X } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { useConnectionStore } from '../../../shared/store/connection';
import { forwardMessages } from '../api/im';
import type { Conversation } from '../model/types';

/** 合并转发条数上限（3021，D03 INT-IM-05；服务端同规则兜底） */
export const MERGE_FORWARD_LIMIT = 30;
/** 3021 文案（shared ERROR_TEXT 未登记 3021，本域内置） */
const MERGE_LIMIT_TEXT = '合并转发超限（≤30 条）';
/** 最近会话 chip 数量 */
const RECENT_CHIPS = 5;
/** 附言上限（INT-IM-05） */
const NOTE_MAX = 500;

interface ForwardModalProps {
  convs: Conversation[];
  /** 转发消息 msgId 列表（单条或多选） */
  msgIds: string[];
  /** 打开时的默认方式（批量条「合并转发」入口预置 merge；单条固定逐条） */
  defaultMode?: 'merge' | 'one_by_one';
  onClose: () => void;
  onDone: (result: { sent: number; failed: number; targetConvId: string }) => void;
}

export function ForwardModal({ convs, msgIds, defaultMode, onClose, onDone }: ForwardModalProps) {
  // 单条转发无方式选择（合并无意义），>1 条默认合并（飞书同款）
  const [mode, setMode] = useState<'merge' | 'one_by_one'>(
    defaultMode ?? (msgIds.length > 1 ? 'merge' : 'one_by_one'),
  );
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState('');
  const offline = useConnectionStore((s) => s.status) === 'offline';

  // Esc 关闭（弹窗自身优先；多选模式的 Esc 由 ChatPage 在弹窗关闭后接管）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 目标候选：active 会话；广播群前置隐藏（非 publisher 转发必被 3013 拦截，PIM-10 六态 forbidden）
  const candidates = useMemo(
    () => convs.filter((c) => c.status === 1 && !(c.type === 3 && c.myRole !== 4)),
    [convs],
  );
  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(kw.toLowerCase()));
  }, [candidates, keyword]);
  // 最近会话 chip：按最近活跃排序取前 N（同样走 3013 前置过滤）
  const recents = useMemo(
    () => [...candidates].sort((a, b) => (b.lastMsgTs ?? 0) - (a.lastMsgTs ?? 0)).slice(0, RECENT_CHIPS),
    [candidates],
  );

  const doForward = async () => {
    if (!target || sending || offline) return;
    // 合并 ≤30 前端拦截（3021 文案；服务端同规则兜底）
    if (mode === 'merge' && msgIds.length > MERGE_FORWARD_LIMIT) {
      setErrorText(`${MERGE_LIMIT_TEXT}（已选 ${msgIds.length} 条）`);
      return;
    }
    setSending(true);
    setErrorText('');
    try {
      const res = await forwardMessages(target, msgIds, mode, note.trim() || undefined);
      onDone({ sent: res.sentCount, failed: res.failed.length, targetConvId: target });
    } catch (err) {
      // 整单失败：3013 只读 / 3021 超限 / 3006 禁言等按错误码映射，保留弹窗可重试
      const code = err instanceof ApiError ? err.code : 0;
      setErrorText(code > 0 ? getErrorText(code) : '转发失败，请重试');
      setSending(false);
    }
  };

  const convLabel = (c: Conversation) => (c.type === 1 ? c.name : `${c.name} (${c.memberCount})`);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="forward-modal" data-testid="forward-modal" onClick={(e) => e.stopPropagation()}>
        <div className="forward-modal__head">
          <span>转发 {msgIds.length > 1 ? `${msgIds.length} 条消息` : '消息'}</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        {/* 搜索会话（PIM-10 弹窗规格） */}
        <div className="forward-modal__search">
          <Search size={14} />
          <input
            data-testid="forward-search"
            placeholder="搜索会话"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        {/* 最近会话 chip */}
        {recents.length > 0 ? (
          <div className="forward-modal__chips">
            {recents.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`forward-modal__chip${target === c.id ? ' forward-modal__chip--active' : ''}`}
                data-testid="forward-chip"
                title={convLabel(c)}
                onClick={() => setTarget(c.id)}
              >
                {convLabel(c)}
              </button>
            ))}
          </div>
        ) : null}

        {/* 会话列表（单选；empty 六态） */}
        <div className="forward-modal__list">
          {filtered.length === 0 ? (
            <div className="forward-modal__empty">没有可转发的会话</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`forward-modal__item${target === c.id ? ' forward-modal__item--active' : ''}`}
                data-testid="forward-item"
                onClick={() => setTarget(c.id)}
              >
                <span className="forward-modal__name">{convLabel(c)}</span>
                <span className="forward-modal__hint">{c.lastMsgDigest?.slice(0, 20) ?? ''}</span>
              </button>
            ))
          )}
        </div>

        {/* 方式 radio：>1 条时出现（D03 §3.10） */}
        {msgIds.length > 1 ? (
          <div className="forward-modal__mode" role="radiogroup" aria-label="转发方式">
            <label className="forward-modal__radio" data-testid="forward-mode-merge">
              <input
                type="radio"
                name="forward-mode"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
              />
              合并转发（≤30 条）
            </label>
            <label className="forward-modal__radio" data-testid="forward-mode-one">
              <input
                type="radio"
                name="forward-mode"
                checked={mode === 'one_by_one'}
                onChange={() => setMode('one_by_one')}
              />
              逐条转发
            </label>
          </div>
        ) : null}

        {/* 附言 ≤500（INT-IM-05；随首条发送，服务端同规则兜底） */}
        <div className="forward-modal__note-wrap">
          <textarea
            className="forward-modal__note"
            data-testid="forward-note"
            rows={2}
            maxLength={NOTE_MAX}
            placeholder="附言（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="forward-modal__note-meta">
            {note.length}/{NOTE_MAX}
          </span>
        </div>

        {/* 错误/离线提示（error/offline 六态） */}
        {errorText ? (
          <div className="forward-modal__error" data-testid="forward-error">
            {errorText}
          </div>
        ) : offline ? (
          <div className="forward-modal__error">离线中，暂不能转发</div>
        ) : null}

        <div className="forward-modal__foot">
          <Button onClick={onClose} disabled={sending}>
            取消
          </Button>
          <Button
            onClick={() => void doForward()}
            disabled={!target || sending || offline}
            data-testid="forward-send"
          >
            <Send size={14} />
            {sending ? '转发中…' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  );
}
