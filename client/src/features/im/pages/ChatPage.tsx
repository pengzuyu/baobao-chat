/**
 * PIM-01 消息主页（D03 §3.1）：会话列表 264px / 消息流 flex:1 / 详情侧栏 304px。
 * - 断点（D01 §5.2）：XL 三栏全展开；L 详情浮层化；M 列表收窄 56px 图标条（CSS）；S 列表⇄内容两级导航
 * - 六态（D01 §7）：列表栏与消息流各自经 StateView 呈现，offline/degraded 保留缓存内容
 * - WS：msg.new/recall/updated/reaction.new/typing/receipt/conv.updated 全事件接线
 * - 交互：引用回复/编辑/撤回/表情回应/转发（PIM-10 简版）/上翻加载更早/未读分隔线/定位闪烁
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Megaphone, Search, SquarePen } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { wsClient } from '../../../shared/api/ws';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { dayKey, formatDayDivider } from '../../../shared/utils/time';
import { useConversationMessages, useConversations } from '../api/hooks';
import { fetchConvDetail, fetchMessagesBefore, mapMsgNew, editMessage, recallMessage, setReaction } from '../api/im';
import { hydrateConv, hydrateLocal, hookSyncOnReconnect, resendOutbox, runSync } from '../api/local';
import type {
  ConvStatePushPayload,
  ConvUpdatedPushPayload,
  Mention,
  Message,
  MsgNewPayload,
  MsgReactionNewPayload,
  MsgRecallPayload,
  MsgUpdatedPayload,
  TypingPushPayload,
} from '../model/types';
import { formatMuteUntil } from './systemMessageRegistry';
import { TYPING_TTL_MS, useImStore } from '../store/im';
import { ChatHeader } from '../components/ChatHeader';
import { ConversationList } from '../components/ConversationList';
import { ConvInfoSidebar } from '../components/ConvInfoSidebar';
import { CreateConvModal } from '../components/CreateConvModal';
import { MessageBubble, type BubbleActions } from '../components/MessageBubble';
import { MessageInput } from '../components/MessageInput';
import { ForwardModal } from '../components/ForwardModal';

/** 消息流 forbidden 判定：被移出(3001)/会话不存在(3019)/群解散(3002)（D03 PIM-02 六态） */
function isForbiddenError(err: unknown): boolean {
  return err instanceof ApiError && [3001, 3019, 3002].includes(err.code);
}

export function ChatPage() {
  const { convId } = useParams<{ convId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bp = useBreakpoint();
  const [detailOpen, setDetailOpen] = useState(false);
  /** 详情栏初始 tab（公告横幅入口直达公告 tab） */
  const [detailTab, setDetailTab] = useState<'info' | 'announcement'>('info');

  // ---- 交互态（引用/编辑/转发/建会话）----
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [forwardIds, setForwardIds] = useState<string[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** @全体被策略拦截的提示条（3014，3s 自动消失） */
  const [mentionAllBlocked, setMentionAllBlocked] = useState(false);
  /** 编辑中随 @ 面板选择的提及（随发送携带；正式版按 range 精确重算） */
  const pendingMentionsRef = useRef<Array<{ uid: string; name: string }>>([]);

  // ---- 服务端态（Query）----
  const convQuery = useConversations('all');
  const msgQuery = useConversationMessages(convId ?? null);

  // ---- 端内投影（feature store）----
  const convs = useImStore((s) => s.convs);
  const myUid = useImStore((s) => s.myUid);
  const messagesByConv = useImStore((s) => s.messagesByConv);
  const drafts = useImStore((s) => s.drafts);
  const peerReadSeq = useImStore((s) => s.peerReadSeq);
  const typingMap = useImStore((s) => s.typing);
  const setConvs = useImStore((s) => s.setConvs);
  const setActiveConv = useImStore((s) => s.setActiveConv);
  const replaceMessages = useImStore((s) => s.replaceMessages);
  const appendIncoming = useImStore((s) => s.appendIncoming);
  const setDraft = useImStore((s) => s.setDraft);
  const sendText = useImStore((s) => s.sendText);
  const retrySend = useImStore((s) => s.retrySend);
  const applyTyping = useImStore((s) => s.applyTyping);
  const togglePin = useImStore((s) => s.togglePin);
  const toggleMute = useImStore((s) => s.toggleMute);
  // 撤回/编辑/回应在事件回调内经 getState 调用（免闭包依赖，下同）

  // Query 成功 → 写入端内投影
  useEffect(() => {
    if (convQuery.data) setConvs(convQuery.data.items);
  }, [convQuery.data, setConvs]);
  // 本地缓存编排（D03 §6.2/API-IM-01）：启动恢复 outbox + 首开缓存上屏 + 重连增量同步。
  // 注意：挂载时 WS 可能已在线（登录流程先于本页），offline→online 转换错过——须查当前态兜底
  useEffect(() => {
    void hydrateLocal().then(() => {
      if (useConnectionStore.getState().status === 'online') {
        void runSync().then(() => resendOutbox());
      }
    });
    return hookSyncOnReconnect();
  }, []);
  useEffect(() => {
    if (convId) void hydrateConv(convId);
  }, [convId]);
  useEffect(() => {
    if (convId && msgQuery.data) replaceMessages(convId, msgQuery.data.items);
  }, [convId, msgQuery.data, replaceMessages]);
  useEffect(() => {
    setActiveConv(convId ?? null);
    // 切换会话清交互态（引用/编辑不跨会话残留）
    setReplyTo(null);
    setEditing(null);
    // 离开 /im（卸载）必须清 activeConvId：否则在其它页面收消息被误判
    // "当前会话可见"而不计未读（appendIncoming/markRead 的可见性判定依据）
    return () => setActiveConv(null);
  }, [convId, setActiveConv]);

  // 已读时机①：进入会话且消息加载完成 → 上报至最新 seq（INT-IM-12）
  const markRead = useImStore((s) => s.markRead);
  useEffect(() => {
    if (!convId) return;
    const msgs = useImStore.getState().messagesByConv[convId] ?? [];
    const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : 0;
    if (lastSeq > 0) markRead(convId, lastSeq);
  }, [convId, msgQuery.data, markRead]);

  // ---- WS 推送全事件接线（D03 §5.3）----
  useEffect(() => {
    const offs = [
      wsClient.on<MsgNewPayload>('msg.new', (payload) => {
        appendIncoming(mapMsgNew(payload));
        void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
        // 已读时机②：当前会话收到新消息（可见即读）
        if (payload.conv_id === useImStore.getState().activeConvId) markRead(payload.conv_id, payload.seq);
      }),
      // 对方已读回执 → ✓✓ 渲染依据（04 篇 §4.2）
      wsClient.on<{ conv_id: string; user_id: string; read_seq: number }>('msg.receipt', (p) => {
        useImStore.getState().applyReceipt(p.conv_id, p.user_id, p.read_seq);
      }),
      // 撤回占位（INT-IM-03：seq 不断裂，原地转 system 形态）
      wsClient.on<MsgRecallPayload>('msg.recall', (p) => {
        useImStore.getState().applyRecall(p.conv_id, p.msg_id, p.operator_id);
        void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
      }),
      // 编辑原地更新（INT-IM-02："已编辑"角标）
      wsClient.on<MsgUpdatedPayload>('msg.updated', (p) => {
        useImStore.getState().applyUpdated(p.conv_id, p.msg_id, p.body, p.edited_at, p.edit_version);
        void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
      }),
      // 表情回应全量快照（INT-IM-23：端侧幂等合并）
      wsClient.on<MsgReactionNewPayload>('msg.reaction.new', (p) => {
        useImStore.getState().applyReactions(p.conv_id, p.msg_id, p.reactions);
      }),
      // 正在输入（INT-IM-11：TTL 5s 端内过期）
      wsClient.on<TypingPushPayload>('msg.typing', (p) => {
        if (p.user_id !== useImStore.getState().myUid) applyTyping(p.conv_id, p.user_id);
      }),
      // 会话事件分发（D03 §5.3）：kind=state 仅本人多端；meta/member/setting/status/announcement 全端
      wsClient.on<ConvStatePushPayload | ConvUpdatedPushPayload>('conv.updated', (p) => {
        if (p.kind === 'state') {
          const state = p as ConvStatePushPayload;
          const store = useImStore.getState();
          store.setConvs(
            store.convs.map((c) =>
              c.id === state.conv_id && c.my ? { ...c, my: { ...c.my, ...state.applied } } : c,
            ),
          );
          return;
        }
        // 群管理事件：快照/members_delta 合并（成员数、角色、公告、解散置灰）
        useImStore.getState().applyConvUpdated(p as ConvUpdatedPushPayload);
        void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
      }),
      wsClient.on('badge.updated', () => void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] })),
    ];
    return () => offs.forEach((off) => off());
  }, [queryClient, appendIncoming, markRead, applyTyping]);

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

  // ---- 群详情拉取（PIM-05 数据源 + 输入框禁用判定依据：group_setting/myRole/myMuteUntil）----
  useEffect(() => {
    if (!convId || !activeConv || activeConv.type === 1) return;
    void fetchConvDetail(convId)
      .then((d) => {
        useImStore.getState().mergeConvDetail(convId, {
          ownerId: d.ownerId,
          memberCount: d.memberCount,
          groupSetting: d.groupSetting,
          myRole: d.myRole,
          myMuteUntil: d.myMuteUntil || undefined,
        });
      })
      .catch(() => undefined); // 3001/3019：已被移出——六态已有兜底
  }, [convId, activeConv?.type, activeConv?.memberCount, activeConv?.status, activeConv?.groupSetting?.announcementTs]);

  // 我的角色/禁言派生（成员事件与详情合并共同维护）
  const myRole = activeConv?.myRole;
  const myMutedUntil = activeConv?.myMuteUntil ?? 0;
  const muteAllUntil = activeConv?.groupSetting?.muteAllUntil ?? 0;
  const isMgr = myRole === 1 || myRole === 2;
  const nowMs = Date.now();
  const inputDisabled =
    (activeConv?.type === 3 && myRole !== 4) ||
    myMutedUntil > nowMs ||
    (muteAllUntil > nowMs && !isMgr);
  const inputDisabledHint =
    myMutedUntil > nowMs
      ? `已被禁言至 ${formatMuteUntil(myMutedUntil)}`
      : muteAllUntil > nowMs && !isMgr
        ? `全员禁言中（至 ${formatMuteUntil(muteAllUntil)}）`
        : '该会话仅发布者可发言';

  // @全体权限（04 篇 §4.5.4）：1 全员 / 2 仅管理 / 3 禁用；广播群不支持 @
  const mentionAllPolicy = activeConv?.groupSetting?.mentionAllPolicy ?? 2;
  const allowMentionAll =
    activeConv?.type === 2 && (mentionAllPolicy === 1 || (mentionAllPolicy === 2 && isMgr));

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

  // ---- 滚动：吸底跟随 / 上翻加载更早（INT-IM-13）/ 回到底部浮标 ----
  const streamRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);
  const stickBottomRef = useRef(true);
  const [awayCount, setAwayCount] = useState(0);
  const [hasOlder, setHasOlder] = useState(true);
  const loadingOlderRef = useRef(false);
  const oldestSeqRef = useRef<number | null>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el && messages.length !== prevCountRef.current) {
      const added = messages.length > prevCountRef.current;
      if (added && stickBottomRef.current) {
        el.scrollTop = el.scrollHeight; // 底部跟随（用户未上滚）
      } else if (added) {
        setAwayCount((n) => n + 1); // 用户在上方 → 浮标计数
      }
      prevCountRef.current = messages.length;
    }
  }, [messages.length]);

  /** 触顶加载更早（INT-IM-13：上滑翻页 prepend；滚动触发与提示条点击共用） */
  const loadOlder = useCallback(() => {
    const el = streamRef.current;
    if (!el || !convId || !hasOlder || loadingOlderRef.current) return;
    const msgs = useImStore.getState().messagesByConv[convId] ?? [];
    const oldest = msgs.find((m) => m.seq > 0);
    if (!oldest) return;
    if (oldestSeqRef.current === oldest.seq) return; // 同锚点已试过，无更多
    loadingOlderRef.current = true;
    const prevHeight = el.scrollHeight;
    void fetchMessagesBefore(convId, oldest.seq, 20)
      .then((items) => {
        if (items.length === 0) setHasOlder(false);
        useImStore.getState().prependMessages(convId, items);
        if (items.length < 20) setHasOlder(false);
        oldestSeqRef.current = oldest.seq;
        // 保持视口锚定在原顶部（prepend 后回滚高度差）
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        loadingOlderRef.current = false;
      });
  }, [convId, hasOlder]);

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickBottomRef.current = atBottom;
    if (atBottom) setAwayCount(0);
    if (el.scrollTop <= 40) loadOlder();
  }, [loadOlder]);

  // 原生滚动监听（WebKit 下 React onScroll 委托在程序化滚动场景偶发不触发，双保险）
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    el.addEventListener("scroll", onStreamScroll, { passive: true });
    return () => el.removeEventListener("scroll", onStreamScroll);
  }, [onStreamScroll, convId]);

  // 引用定位：滚动到原消息 + 闪烁 2s（INT-IM-04）
  const locateSeq = useCallback((seq: number) => {
    const el = streamRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('msg-row--flash');
    setTimeout(() => el.classList.remove('msg-row--flash'), 2000);
  }, []);

  // 未读分隔线锚点：进入会话时 my.readSeq（INT-IM-08 简版）
  const unreadAnchorSeq = useMemo(() => {
    if (!convId || !activeConv) return null;
    const read = activeConv.my?.readSeq ?? 0;
    return read > 0 ? read : null;
  }, [convId, activeConv]);

  // typing 展示（TTL 内且有对方在输入）
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const typingUid = convId ? typingMap[convId] : undefined;
  const showTyping = !!typingUid && Date.now() - typingUid.at < TYPING_TTL_MS;

  // ---- 气泡操作集（INT-IM-25 条件显隐在 Bubble 内判定）----
  const bubbleActions: BubbleActions = {
    onReply: (m) => {
      setEditing(null);
      setReplyTo(m);
    },
    onEdit: (m) => {
      setReplyTo(null);
      setEditing(m);
    },
    onRecall: (m) => {
      void recallMessage(m.msgId)
        .then(() => useImStore.getState().applyRecall(m.convId, m.msgId, myUid))
        .catch(() => undefined);
    },
    onForward: (m) => setForwardIds([m.msgId]),
    onReact: (m, emoji) => {
      const has = m.ext?.reactions?.[emoji]?.includes(myUid);
      void setReaction(m.msgId, emoji, has ? 'remove' : 'add').catch(() => undefined);
    },
    onLocate: locateSeq,
  };

  const doSend = (text: string) => {
    if (!convId) return;
    // @全体：文本包含「@全体」即携带 all mention（服务端按 mention_all_policy 校验 3014）
    const mentions: Mention[] = [];
    const at = text.indexOf('@全体');
    if (at >= 0) {
      if (!allowMentionAll) {
        setMentionAllBlocked(true);
        setTimeout(() => setMentionAllBlocked(false), 3000);
        return;
      }
      mentions.push({ uid: '', all: true, range: [at, at + 3] });
    }
    void sendText(convId, text, replyTo?.seq, mentions.length > 0 ? mentions : undefined);
    setReplyTo(null);
  };
  const doEditSubmit = (text: string) => {
    if (!editing) return;
    const m = editing;
    setEditing(null);
    void editMessage(m.msgId, text)
      .then((r) => useImStore.getState().applyUpdated(m.convId, m.msgId, { text }, r.editedAt, r.editVersion))
      .catch(() => undefined);
  };

  // @提及候选：已加载消息去重发送者（正式版走 API-IM-05 成员表）+「@全体」受策略显隐
  const mentionCandidates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of messages) {
      if (m.senderId !== myUid && m.senderId && !seen.has(m.senderId)) seen.set(m.senderId, m.senderName);
    }
    const list = [...seen].map(([uid, name]) => ({ uid, name }));
    if (allowMentionAll) list.unshift({ uid: '__all__', name: '全体' });
    return list;
  }, [messages, myUid, allowMentionAll]);

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
        <button
          className="icon-btn"
          title="新建会话（单聊/建群）"
          onClick={() => setCreateOpen(true)}
          data-testid="create-conv-btn"
        >
          <SquarePen size={16} />
        </button>
      </div>
      {listState === 'ok' ? (
        <ConversationList
          convs={convs}
          activeId={convId ?? null}
          onSelect={(id) => navigate(`/im/c/${id}`)}
          onTogglePin={togglePin}
          onToggleMute={toggleMute}
        />
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
          <ConversationList
            convs={convs}
            activeId={convId ?? null}
            onSelect={(id) => navigate(`/im/c/${id}`)}
            onTogglePin={togglePin}
            onToggleMute={toggleMute}
          />
        </StateView>
      )}
    </section>
  );

  const messageStream = (
    <div className="message-stream" ref={streamRef} onScroll={onStreamScroll}>
      {hasOlder && messages.length > 0 ? (
        <button type="button" className="load-older-hint" onClick={loadOlder}>
          上滑或点击加载更早消息
        </button>
      ) : null}
      {messages.map((m, i) => (
        <Fragment key={`${convId}:${m.seq}`}>
          {/* 日期分隔条 */}
          {i === 0 || dayKey(m.ts) !== dayKey(messages[i - 1].ts) ? (
            <div className="date-divider">{formatDayDivider(m.ts)}</div>
          ) : null}
          {/* 未读分隔线（INT-IM-08 简版：首条未读之前插入一次） */}
          {unreadAnchorSeq !== null && m.seq > unreadAnchorSeq && (i === 0 || messages[i - 1].seq <= unreadAnchorSeq) ? (
            <div className="unread-divider">以下为未读消息</div>
          ) : null}
          <MessageBubble
            message={m}
            mine={m.senderId === myUid && m.type !== 'system'}
            onRetry={(clientMsgId) => convId && void retrySend(convId, clientMsgId)}
            peerReadSeq={(convId && peerReadSeq[convId]) || 0}
            actions={m.type === 'system' ? undefined : bubbleActions}
            myUid={myUid}
            myRole={myRole}
            applyHandled={
              m.type === 'system' && 'kind' in m.body && m.body.kind === 'apply.submitted' && 'apply_id' in m.body && m.body.apply_id
                ? useImStore.getState().handledApplies[m.body.apply_id]
                : undefined
            }
            onApplyHandled={(applyId, result) => {
              useImStore.getState().markApplyHandled(applyId, result);
              void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
            }}
          />
        </Fragment>
      ))}
    </div>
  );

  const streamNode = (
    <section className="im-content-col">
      {activeConv ? (
        <ChatHeader
          conv={activeConv}
          typing={showTyping ? '对方正在输入…' : undefined}
          onBack={bp === 'S' ? () => navigate('/im') : undefined}
          onToggleDetail={() => setDetailOpen((v) => !v)}
        />
      ) : null}

      {/* 公告横幅（INT-IM-18：更新即时红点+摘要，全文在详情栏公告 tab） */}
      {activeConv?.groupSetting?.announcement && activeConv.status === 1 ? (
        <button
          type="button"
          className="ann-banner"
          data-testid="ann-banner"
          onClick={() => {
            setDetailOpen(true);
            setDetailTab('announcement');
          }}
          title="点击查看全文"
        >
          <Megaphone size={14} />
          <span className="ann-banner__dot" aria-hidden />
          <span className="ann-banner__text">{activeConv.groupSetting.announcement}</span>
          <span className="ann-banner__more">查看全文</span>
        </button>
      ) : null}

      {/* @全体被策略拦截提示（3014，INT-IM-24） */}
      {mentionAllBlocked ? (
        <div className="ann-banner ann-banner--warn" data-testid="mention-all-blocked">
          当前群策略不允许你使用 @全体
        </div>
      ) : null}

      {streamState === 'none' ? (
        <StateView state="empty" emptyText="从左侧选择一个会话开始聊天" />
      ) : streamState === 'ok' ? (
        <>
          {messageStream}
          {/* 回到底部浮标（INT-IM-13：用户上滚停随后出现 + 新消息计数） */}
          {awayCount > 0 ? (
            <button
              type="button"
              className="scroll-bottom-fab"
              onClick={() => {
                const el = streamRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                stickBottomRef.current = true;
                setAwayCount(0);
              }}
            >
              <ArrowDown size={14} />
              {awayCount > 0 ? `${awayCount > 99 ? '99+' : awayCount} 条新消息` : '回到底部'}
            </button>
          ) : null}
        </>
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
          {messageStream}
        </StateView>
      )}

      {convId ? (
        <MessageInput
          convId={convId}
          /* 禁用三态：广播群非 publisher / 单人禁言 / 全员禁言（非 owner/admin），D03 §3.3 */
          disabled={inputDisabled}
          disabledHint={inputDisabledHint}
          draft={drafts[convId] ?? ''}
          onDraftChange={(text) => setDraft(convId, text)}
          onSend={doSend}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onEditSubmit={doEditSubmit}
          mentionCandidates={mentionCandidates}
          onMentionPicked={(uid, name) => pendingMentionsRef.current.push({ uid, name })}
        />
      ) : null}
    </section>
  );

  const detailNode = detailOpen && activeConv ? (
    bp === 'XL' ? (
      <aside className="im-detail-col">
        <ConvInfoSidebar
          conv={activeConv}
          myUid={myUid}
          initialTab={detailTab}
          onClose={() => setDetailOpen(false)}
          onLeft={() => {
            setDetailOpen(false);
            navigate('/im');
            void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
          }}
        />
      </aside>
    ) : (
      <>
        <div className="im-detail-mask" onClick={() => setDetailOpen(false)} />
        <aside className="im-detail-col im-detail-col--overlay">
          <ConvInfoSidebar
            conv={activeConv}
            myUid={myUid}
            initialTab={detailTab}
            onClose={() => setDetailOpen(false)}
            onLeft={() => {
              setDetailOpen(false);
              navigate('/im');
              void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
            }}
          />
        </aside>
      </>
    )
  ) : null;

  return (
    <div className="im-page">
      {showList ? convListNode : null}
      {showStream ? streamNode : null}
      {detailNode}
      {forwardIds ? (
        <ForwardModal
          convs={convs}
          msgIds={forwardIds}
          onClose={() => setForwardIds(null)}
          onDone={() => setForwardIds(null)}
        />
      ) : null}
      {createOpen ? (
        <CreateConvModal
          onClose={() => setCreateOpen(false)}
          onCreated={(convId2) => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
            navigate(`/im/c/${convId2}`);
          }}
        />
      ) : null}
    </div>
  );
}
