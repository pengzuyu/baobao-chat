/**
 * 合并转发详情抽屉（PIM-11，D03 §3.11）：点击 merge_forward 气泡 → 右侧 Drawer 400。
 * - 标题 + count + 逐条子列表（sender/类型 digest 图标）
 * - 子条目点击 → fetchOriginSnapshot(origin_conv, origin_seq) 拉该条全文 + 前 2 条上下文展开
 * - 无权限/已退群（3001/3019/3002）或快照内找不到原 seq（已物理清理）→ 该条置灰「原消息不可见」
 * - Esc / 遮罩关闭
 * - 六态：loading=子条快照 spinner / empty 不适用（登记） / error=置灰+可重试 /
 *   offline=请求失败同样置灰（只读已缓存 digest） / forbidden=条目级置灰（不整页锁）/ degraded 不适用（登记）
 */

import { useEffect, useState } from 'react';
import { Ban, ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react';
import { fetchOriginSnapshot } from '../api/im';
import { digestOf } from '../store/im';
import { mergeTypeIcon } from './MessageBubble';
import type { Message, MergeForwardBody, MergeItem } from '../model/types';

interface MergeForwardDrawerProps {
  message: Message;
  onClose: () => void;
}

/** 单条子条目快照态（六态收敛：loading/ok/error(置灰)） */
interface ItemState {
  status: 'loading' | 'ok' | 'error';
  /** 快照窗口（目标条 + 上下文，升序）；ok 时必有 */
  msgs?: Message[];
  /** 目标 seq 在快照中的下标（ok 时必有） */
  targetIdx?: number;
}

export function MergeForwardDrawer({ message, onClose }: MergeForwardDrawerProps) {
  const body: MergeForwardBody = 'items' in message.body ? message.body : {};
  const items: MergeItem[] = body.items ?? [];
  /** 展开态：子条目下标 → 快照 */
  const [expanded, setExpanded] = useState<Record<number, ItemState>>({});

  // Esc 关闭（遮罩点击同）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 子条目点击：已展开 → 收起；否则拉快照展开全文上下文 */
  const onItemClick = async (idx: number, item: MergeItem) => {
    const cur = expanded[idx];
    if (cur?.status === 'ok' || cur?.status === 'error') {
      setExpanded((s) => {
        const next = { ...s };
        delete next[idx];
        return next;
      });
      return;
    }
    if (cur?.status === 'loading') return;
    setExpanded((s) => ({ ...s, [idx]: { status: 'loading' } }));
    try {
      const msgs = await fetchOriginSnapshot(item.origin_conv, item.origin_seq, 3);
      const targetIdx = msgs.findIndex((m) => m.seq === item.origin_seq);
      if (targetIdx < 0) {
        // 快照窗口内无原 seq：已物理清理等
        setExpanded((s) => ({ ...s, [idx]: { status: 'error' } }));
        return;
      }
      setExpanded((s) => ({ ...s, [idx]: { status: 'ok', msgs, targetIdx } }));
    } catch {
      // 3001/3019/3002（已退群/无权限/解散）等 → 条目级置灰（PIM-11 forbidden 六态）
      setExpanded((s) => ({ ...s, [idx]: { status: 'error' } }));
    }
  };

  /** 快照消息渲染：上下文弱化 + 目标条高亮全文（撤回占位/类型化 digest 兜底） */
  const renderSnapshotMsg = (m: Message, isTarget: boolean) => {
    const recalled = m.status === 2;
    const fullText = !recalled && m.type === 'text' && 'text' in m.body ? m.body.text : digestOf(m);
    return (
      <div key={m.seq} className={`merge-drawer__snap-msg${isTarget ? ' merge-drawer__snap-msg--target' : ''}`}>
        <span className="merge-drawer__snap-sender">{m.senderName}</span>
        <span className="merge-drawer__snap-text">
          {recalled ? '（原消息已撤回）' : fullText}
        </span>
      </div>
    );
  };

  return (
    <>
      <div className="merge-drawer__mask" onClick={onClose} />
      <aside className="merge-drawer" data-testid="merge-drawer" aria-label="合并转发详情">
        <header className="merge-drawer__head">
          <div className="merge-drawer__title" data-testid="merge-drawer-title">
            {body.title ?? '聊天记录'} · {body.count ?? items.length} 条消息
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭" data-testid="merge-drawer-close">
            <X size={16} />
          </button>
        </header>
        <div className="merge-drawer__body">
          {items.map((it, idx) => {
            const st = expanded[idx];
            const isOpen = st?.status === 'ok' || st?.status === 'error';
            return (
              <div key={idx} className="merge-drawer__entry">
                <button
                  type="button"
                  className="merge-drawer__item"
                  data-testid={`merge-drawer-item-${idx}`}
                  onClick={() => void onItemClick(idx, it)}
                  title="点击展开原文上下文"
                >
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="merge-drawer__sender">{it.sender_name || it.sender_id}</span>
                  <span className="merge-drawer__digest">
                    {mergeTypeIcon(it.type)}
                    {it.digest}
                  </span>
                </button>
                {/* 快照展开区 */}
                {st?.status === 'loading' ? (
                  <div className="merge-drawer__snap merge-drawer__snap--loading">
                    <span className="skeleton-block" /> 拉取原文…
                  </div>
                ) : st?.status === 'error' ? (
                  <div className="merge-drawer__snap merge-drawer__snap--error" data-testid={`merge-drawer-error-${idx}`}>
                    <Ban size={13} />
                    原消息不可见（无权限、已退群或已清理）
                    <button
                      type="button"
                      className="merge-drawer__retry"
                      onClick={() => void onItemClick(idx, it)}
                      title="重试"
                    >
                      <RotateCcw size={12} />
                      重试
                    </button>
                  </div>
                ) : st?.status === 'ok' && st.msgs ? (
                  <div className="merge-drawer__snap" data-testid={`merge-drawer-snapshot-${idx}`}>
                    {st.msgs.map((m, i) => renderSnapshotMsg(m, i === st.targetIdx))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <footer className="merge-drawer__foot">点击条目可展开原文及上下文</footer>
      </aside>
    </>
  );
}
