/**
 * 消息气泡族（D03 §3.2）：
 * - text：己方 primary 浅底 / 对方 gray-2，圆角 12 带 4 尾巴
 * - 引用条：reply_to_seq + ext.reply_digest 快照，点击定位原消息（INT-IM-04）
 * - 表情回应条：ext.reactions 全量快照渲染，点击增删本人（INT-IM-23）
 * - 已编辑角标 / 撤回占位（store 已转 system 形态）/ merge_forward 卡片
 * - @提及高亮：mentions.range 内文本主色+底纹（INT-IM-24）
 * - 悬浮操作条：快捷表情 + 更多菜单（回复/复制/编辑/撤回/转发，INT-IM-25 条件显隐）
 * - 本地态尾标：sending 灰钟 → sent ✓ → 对方已读 ✓✓（msg.receipt，04 篇 §4.2）；failed 红叹号（点击重试，INT-IM-01a）
 */

import { AlertCircle, Check, CheckCheck, Clock3, FileText, ListOrdered, RotateCcw, SmilePlus } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { getErrorText } from '../../../shared/api/http';
import { digestOf } from '../store/im';
import { systemMessageText } from '../pages/systemMessageRegistry';
import { ApplyCard } from './ApplyCard';
import type { MemberRole, Mention, Message, SystemBody } from '../model/types';

/** 快捷回应候选（与飞书同款常用集，选择器全集在 MsgActions） */
export const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏'] as const;

export interface BubbleActions {
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRecall: (m: Message) => void;
  onForward: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onLocate: (seq: number) => void;
}

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  onRetry: (clientMsgId: string) => void;
  /** 对方已读游标（msg.receipt 维护）：mine 且 sent 且 seq ≤ 此值 → ✓✓ */
  peerReadSeq?: number;
  /** 悬浮操作（system/撤回占位不出） */
  actions?: BubbleActions;
  /** 当前用户（回应是否已含本人的判定） */
  myUid: string;
  /** 系统消息上下文：审批卡（PIM-06）角色与终态回显 */
  myRole?: MemberRole;
  applyHandled?: 'approved' | 'rejected';
  onApplyHandled?: (applyId: string, result: 'approved' | 'rejected') => void;
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

/** @提及高亮渲染：mentions.range（INT-IM-24） */
function TextWithMentions({ text, mentions }: { text: string; mentions?: Mention[] }) {
  if (!mentions || mentions.length === 0) return <>{text}</>;
  const parts: Array<{ s: string; mention?: Mention }> = [];
  let cursor = 0;
  const sorted = [...mentions].sort((a, b) => a.range[0] - b.range[0]);
  for (const m of sorted) {
    const [s, e] = m.range;
    if (s < cursor || s >= text.length || e <= s) continue;
    if (s > cursor) parts.push({ s: text.slice(cursor, s) });
    parts.push({ s: text.slice(s, e), mention: m });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ s: text.slice(cursor) });
  return (
    <>
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className="msg-mention">
            {p.s}
          </span>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}

/** 引用条：ext.reply_digest 快照（点击定位；源已撤回时 digest 为固定文案） */
function ReplyQuote({ message, onLocate }: { message: Message; onLocate?: (seq: number) => void }) {
  const d = message.ext?.reply_digest;
  if (!d) return null;
  return (
    <div className="msg-quote" onClick={() => onLocate?.(d.seq)} role="button" tabIndex={0}>
      <span className="msg-quote__sender">{d.sender_name || d.sender_id}</span>
      <span className="msg-quote__digest">{d.digest}</span>
    </div>
  );
}

/** 表情回应条（INT-IM-23：不占 seq/不计未读；点击切换本人增删） */
function ReactionBar({ message, myUid, onReact }: { message: Message; myUid: string; onReact?: (emoji: string) => void }) {
  const reactions = message.ext?.reactions;
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div className="msg-reactions">
      {Object.entries(reactions).map(([emoji, uids]) => (
        <button
          key={emoji}
          className={`msg-reactions__item${uids.includes(myUid) ? ' msg-reactions__item--mine' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onReact?.(emoji);
          }}
          title={uids.join('、')}
          type="button"
        >
          <span>{emoji}</span>
          {uids.length > 1 ? <span className="msg-reactions__count">{uids.length}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 合并转发卡片（PIM-11 抽屉后续接入，先卡片摘要） */
function MergeForwardCard({ message }: { message: Message }) {
  const b = message.body as { title?: string; count?: number };
  return (
    <div className="msg-merge">
      <div className="msg-merge__title">
        <ListOrdered size={14} />
        {b.title ?? '聊天记录'}
      </div>
      <div className="msg-merge__hint">共 {b.count ?? 0} 条消息</div>
    </div>
  );
}

export function MessageBubble({
  message,
  mine,
  onRetry,
  peerReadSeq = 0,
  actions,
  myUid,
  myRole,
  applyHandled,
  onApplyHandled,
}: MessageBubbleProps) {
  // 系统消息/撤回占位：居中弱化，不参与回执/右键（PIM-12）
  if (message.type === 'system') {
    // 服务端下发的占位消息：按 body.kind 套注册表模板（systemMessageRegistry）
    if ('kind' in message.body && message.body.kind) {
      const body = message.body as SystemBody;
      if (body.kind === 'apply.submitted' && body.apply_id && onApplyHandled) {
        // 审批卡（PIM-06）：owner/admin 可见按钮，member 只读
        return (
          <div className="msg-system msg-system--card">
            <ApplyCard
              body={body}
              submittedAt={message.ts}
              myRole={myRole}
              handled={applyHandled}
              onHandled={onApplyHandled}
            />
          </div>
        );
      }
      return <div className="msg-system">{systemMessageText(body)}</div>;
    }
    // 撤回占位等本地生成的 system 形态（body={text}）
    const text = 'text' in message.body ? message.body.text : '群通知';
    return <div className="msg-system">{text}</div>;
  }
  // 历史拉取路径的已撤回消息（服务端真值 status=2，type 仍为原文案类型）：
  // 与实时 msg.recall 推送同款占位（实时路径由 store 转 system 形态，此处兜底）
  if (message.status === 2) {
    return (
      <div className="msg-system">
        {mine ? '你撤回了一条消息' : `${message.senderName} 撤回了一条消息`}
      </div>
    );
  }

  const isText = message.type === 'text';
  const isMerge = message.type === 'merge_forward';
  // 编辑窗口（5min）与本人判定：编辑入口显隐（INT-IM-02；撤回态已在上方早退）
  const editable = mine && isText && Date.now() - message.ts < 5 * 60 * 1000;
  const recallable = mine && Date.now() - message.ts < 24 * 60 * 60 * 1000;
  const text = isText && 'text' in message.body ? message.body.text : '';

  /** 回应切换：add/remove 由调用方按 ext.reactions 现态判定（全量快照回收保证一致） */
  const doReact = (emoji: string) => actions?.onReact(message, emoji);

  return (
    <div className={`msg-row${mine ? ' msg-row--mine' : ''}`} data-seq={message.seq}>
      <Avatar name={message.senderName} size={32} />
      <div className="msg-row__body">
        {mine ? null : <span className="msg-row__sender">{message.senderName}</span>}
        <div className="msg-row__bubble-wrap">
          {isText ? (
            <span className={`bubble ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <ReplyQuote message={message} onLocate={actions?.onLocate} />
              <TextWithMentions text={text} mentions={message.mentions} />
              {message.status === 3 ? <span className="msg-edited-tag">已编辑</span> : null}
            </span>
          ) : isMerge ? (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <MergeForwardCard message={message} />
            </span>
          ) : (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <div className="file-card">
                <div className="file-card__icon">
                  <FileText size={20} />
                </div>
                <div className="file-card__meta">
                  <div className="file-card__name">{'name' in message.body && message.body.name ? message.body.name : digestOf(message)}</div>
                  <div className="file-card__hint">附件 · 查看器后续接入（D06）</div>
                </div>
              </div>
            </span>
          )}

          {/* 悬浮操作条（INT-IM-25）：快捷表情 + 回复/编辑/撤回/转发（撤回态已早退） */}
          {actions ? (
            <div className="msg-actions">
              {QUICK_EMOJIS.slice(0, 3).map((e) => (
                <button
                  key={e}
                  type="button"
                  className="msg-actions__emoji"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    doReact(e);
                  }}
                >
                  {e}
                </button>
              ))}
              <button type="button" className="msg-actions__btn" title="更多表情" onClick={() => doReact(QUICK_EMOJIS[3])}>
                <SmilePlus size={14} />
              </button>
              <button type="button" className="msg-actions__btn" title="回复" onClick={() => actions.onReply(message)}>
                回复
              </button>
              {editable ? (
                <button type="button" className="msg-actions__btn" title="编辑" onClick={() => actions.onEdit(message)}>
                  编辑
                </button>
              ) : null}
              {recallable ? (
                <button type="button" className="msg-actions__btn msg-actions__btn--danger" title="撤回" onClick={() => actions.onRecall(message)}>
                  撤回
                </button>
              ) : null}
              <button type="button" className="msg-actions__btn" title="转发" onClick={() => actions.onForward(message)}>
                转发
              </button>
            </div>
          ) : null}
        </div>
        <ReactionBar message={message} myUid={myUid} onReact={(e) => doReact(e)} />
        {mine ? <StateTag message={message} onRetry={onRetry} peerReadSeq={peerReadSeq} /> : null}
      </div>
    </div>
  );
}
