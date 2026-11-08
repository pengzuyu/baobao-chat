/**
 * PIM-01 消息主页（D03 §3.1）：会话列表 264px / 消息流 flex:1 / 详情侧栏 304px。
 * - 断点（D01 §5.2）：XL 三栏全展开；L 详情浮层化；M 列表收窄 56px 图标条（CSS）；S 列表⇄内容两级导航
 * - 六态（D01 §7）：列表栏与消息流各自经 StateView 呈现，offline/degraded 保留缓存内容
 * - WS：msg.new 入流 + conv/badge 精准失效（key 见 shared/api/keys.ts）
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, SquarePen } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { dayKey, formatDayDivider } from '../../../shared/utils/time';
import { useConversationMessages, useConversations } from '../api/hooks';
import { useImStore } from '../store/im';
import { ChatHeader } from '../components/ChatHeader';
import { ConversationList } from '../components/ConversationList';
import { ConvInfoSidebar } from '../components/ConvInfoSidebar';
import { MessageBubble } from '../components/MessageBubble';
import { MessageInput } from '../components/MessageInput';

/** 消息流 forbidden 判定：被移出(3001)/会话不存在(3019)/群解散(3002)（D03 PIM-02 六态） */
function isForbiddenError(err: unknown): boolean {
  return err instanceof ApiError && [3001, 3019, 3002].includes(err.code);
}

export function ChatPage() {
  const { convId } = useParams<{ convId: string }>();
  const navigate = useNavigate();
  const bp = useBreakpoint();
  const [detailOpen, setDetailOpen] = useState(false);

  // ---- 服务端态（Query）----
  const convQuery = useConversations('all');
  const msgQuery = useConversationMessages(convId ?? null);

  // ---- 端内投影（feature store）----
  const convs = useImStore((s) => s.convs);
  const myUid = useImStore((s) => s.myUid);
  const messagesByConv = useImStore((s) => s.messagesByConv);
  const drafts = useImStore((s) => s.drafts);
  const peerReadSeq = useImStore((s) => s.peerReadSeq);
  const setConvs = useImStore((s) => s.setConvs);
  const setActiveConv = useImStore((s) => s.setActiveConv);
  const replaceMessages = useImStore((s) => s.replaceMessages);
  const setDraft = useImStore((s) => s.setDraft);
  const sendText = useImStore((s) => s.sendText);
  const retrySend = useImStore((s) => s.retrySend);

  // Query 成功 → 写入端内投影
  useEffect(() => {
    if (convQuery.data) setConvs(convQuery.data.items);
  }, [convQuery.data, setConvs]);
  useEffect(() => {
    if (convId && msgQuery.data) replaceMessages(convId, msgQuery.data.items);
  }, [convId, msgQuery.data, replaceMessages]);
  useEffect(() => {
    setActiveConv(convId ?? null);
    // 离开聊天页清空激活会话：全局 msg.new 处理器据此判定"可见即读"（见 wsEvents.ts）
    return () => setActiveConv(null);
  }, [convId, setActiveConv]);

  // 已读时机①：进入会话且消息加载完成 → 上报至最新 seq（INT-IM-12）
  // （WS 事件绑定已上移至 MainLayout 常驻，任意页面均实时入流，见 store/wsEvents.ts）
  const markRead = useImStore((s) => s.markRead);
  useEffect(() => {
    if (!convId) return;
    const msgs = useImStore.getState().messagesByConv[convId] ?? [];
    const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : 0;
    if (lastSeq > 0) markRead(convId, lastSeq);
  }, [convId, msgQuery.data, markRead]);

  // ---- 六态推导 ----
  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);

  const listState: ViewState | 'ok' = convQuery.isPending
    ? 'loading'
    : convQuery.isError
      ? 'error'
      : convs.length === 0
        ? 'empty'
        : degradedText
          ? 'degraded'
          : connStatus === 'offline'
            ? 'offline'
            : 'ok';

  const activeConv = convs.find((c) => c.id === convId) ?? null;
  const messages = convId ? (messagesByConv[convId] ?? []) : [];

  const streamState: ViewState | 'ok' | 'none' = !convId
    ? 'none'
    : msgQuery.isPending
      ? 'loading'
      : msgQuery.isError
        ? isForbiddenError(msgQuery.error)
          ? 'forbidden'
          : 'error'
        : messages.length === 0
          ? 'empty'
          : degradedText
            ? 'degraded'
            : connStatus === 'offline'
              ? 'offline'
              : 'ok';

  // 新消息自动吸底（TODO INT-IM-13：用户上滚停随 + 回到底部浮标 + react-virtuoso 虚拟滚动）
  const streamRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  useEffect(() => {
    const el = streamRef.current;
    if (el && messages.length !== prevCountRef.current) {
      el.scrollTop = el.scrollHeight;
      prevCountRef.current = messages.length;
    }
  }, [messages.length]);

  // ---- 布局（断点）----
  // S 档：列表⇄内容两级导航；M/L 档：列表栏收窄由 CSS media query 处理
  const showList = bp !== 'S' || !convId;
  const showStream = bp !== 'S' || !!convId;

  const convListNode = (
    <section className="im-list-col" style={bp === 'S' ? { width: '100%', borderRight: 'none' } : undefined}>
      <div className="im-list-col__header">
        {/* TODO(PIM-07)：搜索框点击进入全局搜索态（Cmd+K） */}
        <div className="bbw-input bbw-input--search">
          <Search size={14} aria-hidden />
          <input placeholder="搜索（⌘K）" disabled />
          <kbd>⌘K</kbd>
        </div>
        <button className="icon-btn" title="新建会话（单聊/建群）">
          <SquarePen size={16} />
        </button>
      </div>
      {listState === 'ok' ? (
        <ConversationList convs={convs} activeId={convId ?? null} onSelect={(id) => navigate(`/im/c/${id}`)} />
      ) : (
        <StateView
          state={listState}
          skeleton={<SkeletonList count={8} />}
          error={convQuery.error}
          onRetry={() => void convQuery.refetch()}
          emptyText="还没有会话，发起第一个会话吧"
          emptyAction={<Button onClick={() => navigate('/im')}>发起单聊</Button>}
          offlineText="离线中，可浏览本地缓存的会话"
          degradedText={degradedText ?? undefined}
        >
          <ConversationList convs={convs} activeId={convId ?? null} onSelect={(id) => navigate(`/im/c/${id}`)} />
        </StateView>
      )}
    </section>
  );

  const streamNode = (
    <section className="im-content-col">
      {activeConv ? (
        <ChatHeader
          conv={activeConv}
          onBack={bp === 'S' ? () => navigate('/im') : undefined}
          onToggleDetail={() => setDetailOpen((v) => !v)}
        />
      ) : null}

      {streamState === 'none' ? (
        <StateView state="empty" emptyText="从左侧选择一个会话开始聊天" />
      ) : streamState === 'ok' ? (
        <div className="message-stream" ref={streamRef}>
          {messages.map((m, i) => (
            <Fragment key={`${convId}:${m.seq}`}>
              {/* 日期分隔条 */}
              {i === 0 || dayKey(m.ts) !== dayKey(messages[i - 1].ts) ? (
                <div className="date-divider">{formatDayDivider(m.ts)}</div>
              ) : null}
              <MessageBubble
                message={m}
                mine={m.senderId === myUid && m.type !== 'system'}
                onRetry={(clientMsgId) => convId && void retrySend(convId, clientMsgId)}
              />
            </Fragment>
          ))}
        </div>
      ) : (
        <StateView
          state={streamState}
          skeleton={<SkeletonStream count={6} />}
          error={msgQuery.error}
          onRetry={() => void msgQuery.refetch()}
          emptyText="打个招呼吧"
          forbiddenText={activeConv?.status === 2 || isForbiddenError(msgQuery.error) ? '你已不在该会话中，历史消息只读' : '无权访问该会话'}
          offlineText="离线中，消息进入待发队列"
          degradedText={degradedText ?? undefined}
        >
          <div className="message-stream">
            {messages.map((m) => (
              <MessageBubble
                key={`${convId}:${m.seq}`}
                message={m}
                mine={m.senderId === myUid && m.type !== 'system'}
                onRetry={() => undefined}
                peerReadSeq={(convId && peerReadSeq[convId]) || 0}
              />
            ))}
          </div>
        </StateView>
      )}

      {convId ? (
        <MessageInput
          convId={convId}
          /* 广播群只读：普通成员不可发言（publisher 判定 TODO，PIM-04） */
          disabled={activeConv?.type === 3}
          draft={drafts[convId] ?? ''}
          onDraftChange={(text) => setDraft(convId, text)}
          onSend={(text) => void sendText(convId, text)}
        />
      ) : null}
    </section>
  );

  const detailNode = detailOpen && activeConv ? (
    bp === 'XL' ? (
      <aside className="im-detail-col">
        <ConvInfoSidebar conv={activeConv} onClose={() => setDetailOpen(false)} />
      </aside>
    ) : (
      <>
        <div className="im-detail-mask" onClick={() => setDetailOpen(false)} />
        <aside className="im-detail-col im-detail-col--overlay">
          <ConvInfoSidebar conv={activeConv} onClose={() => setDetailOpen(false)} />
        </aside>
      </>
    )
  ) : null;

  return (
    <div className="im-page">
      {showList ? convListNode : null}
      {showStream ? streamNode : null}
      {detailNode}
    </div>
  );
}
