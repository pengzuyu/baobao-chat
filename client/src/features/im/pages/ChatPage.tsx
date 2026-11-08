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
import { ArrowDown, Bell, Megaphone, SquarePen, Star } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { dayKey, formatDayDivider } from '../../../shared/utils/time';
import { useConversationMessages, useConversations, useUnreadNotificationCount } from '../api/hooks';
import {
  fetchConvDetail,
  fetchMessagesBefore,
  editMessage,
  favoriteMessage,
  recallMessage,
  setReaction,
  type SearchHit,
} from '../api/im';
import { hydrateConv, hydrateLocal, hookSyncOnReconnect, resendOutbox, runSync } from '../api/local';
import type { Mention, Message } from '../model/types';
import { formatMuteUntil } from './systemMessageRegistry';
import { TYPING_TTL_MS, useImStore } from '../store/im';
import { ChatHeader } from '../components/ChatHeader';
import { ConversationList } from '../components/ConversationList';
import { ConvInfoSidebar } from '../components/ConvInfoSidebar';
import { CreateConvModal } from '../components/CreateConvModal';
import { FileSendPreview } from '../components/FileSendPreview';
import { MessageBubble, type BubbleActions } from '../components/MessageBubble';
import { MsgContextMenu, copyTextOf, type MenuAnchor, type MsgMenuActions } from '../components/stream/MsgContextMenu';
import { MessageInput } from '../components/MessageInput';
import { ForwardModal } from '../components/ForwardModal';
import { MultiSelectBar } from '../components/MultiSelectBar';
import { MergeForwardDrawer } from '../components/MergeForwardDrawer';
import { SearchPanel } from '../components/SearchPanel';

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
  /** 转发弹窗默认方式（批量条「合并转发」入口预置 merge；PIM-10b radio 可改） */
  const [forwardMode, setForwardMode] = useState<'merge' | 'one_by_one'>('one_by_one');
  /** PIM-11 合并转发详情抽屉：点击 merge_forward 气泡打开 */
  const [mergeDrawerMsg, setMergeDrawerMsg] = useState<Message | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** 附件发送（D06 阶段一）：file input → 预览弹层 → upload+msg.send */
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  /** @全体被策略拦截的提示条（3014，3s 自动消失） */
  const [mentionAllBlocked, setMentionAllBlocked] = useState(false);
  /** 收藏结果提示条（INT-IM-06 摘要 toast：已收藏/失败原因，3s 自动消失） */
  const [favToast, setFavToast] = useState<{ text: string; ok: boolean } | null>(null);
  /** 批量转发结果提示（INT-IM-05：成功 N 条/失败明细；点击跳目标会话，3.5s 自动消失） */
  const [fwdToast, setFwdToast] = useState<{ text: string; ok: boolean; targetConvId?: string } | null>(null);
  /** 编辑中随 @ 面板选择的提及（随发送携带；正式版按 range 精确重算） */
  const pendingMentionsRef = useRef<Array<{ uid: string; name: string }>>([]);
  /** PIM-07 全局搜索框（⌘K 聚焦目标） */
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 消息右键菜单态（INT-IM-25）：局部 useState 即可，不入全局 store */
  const [menuMsg, setMenuMsg] = useState<{ msg: Message; anchor: MenuAnchor } | null>(null);

  // ---- 服务端态（Query）----
  const convQuery = useConversations('all');
  const msgQuery = useConversationMessages(convId ?? null);
  // 通知未读数（PIM-09 铃铛红点：99+ 封顶；WS notification.new 触发失效重拉）
  const notifUnreadQuery = useUnreadNotificationCount();
  const notifUnread = notifUnreadQuery.data ?? 0;

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
  const setDraft = useImStore((s) => s.setDraft);
  const sendText = useImStore((s) => s.sendText);
  const retrySend = useImStore((s) => s.retrySend);
  const togglePin = useImStore((s) => s.togglePin);
  const toggleMute = useImStore((s) => s.toggleMute);
  // 多选模式（INT-IM-14/PIM-10）：选择集在 store（滚动/上翻不丢选择）
  const multiSelect = useImStore((s) => s.multiSelect);
  const enterMultiSelect = useImStore((s) => s.enterMultiSelect);
  const exitMultiSelect = useImStore((s) => s.exitMultiSelect);
  const toggleMultiSelectItem = useImStore((s) => s.toggleMultiSelectItem);
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
    // 切换会话清交互态（引用/编辑/多选/右键菜单不跨会话残留）
    setReplyTo(null);
    setEditing(null);
    setMenuMsg(null);
    if (useImStore.getState().multiSelect.isActive) exitMultiSelect();
    // 离开 /im（卸载）必须清 activeConvId：全局 msg.new 处理器（wsEvents.ts）
    // 据此判定"当前会话可见"才"可见即读"，否则在其它页面收消息被误判不计未读
    return () => setActiveConv(null);
  }, [convId, setActiveConv, exitMultiSelect]);

  // 已读时机①：进入会话且消息加载完成 → 上报至最新 seq（INT-IM-12）
  // （WS 事件绑定已上移至 MainLayout 常驻，任意页面均实时入流，见 store/wsEvents.ts）
  const markRead = useImStore((s) => s.markRead);
  useEffect(() => {
    if (!convId) return;
    const msgs = useImStore.getState().messagesByConv[convId] ?? [];
    const lastSeq = msgs.length > 0 ? msgs[msgs.length - 1].seq : 0;
    if (lastSeq > 0) markRead(convId, lastSeq);
  }, [convId, msgQuery.data, markRead]);

  // （WS 推送全事件接线已上移至 MainLayout 常驻的 store/wsEvents.ts——
  //  订阅不再随聊天页销毁，任意页面均实时入流/更新摘要与徽标，D03 §5.3）

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

  // ⌘K/Ctrl+K 聚焦全局搜索框（PIM-07，D03 §3.7；输入框聚焦时忽略）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 跨页定位消费（PIM-07 搜索/PIM-08 收藏点击跳转）：行已在流内 → 闪烁定位；
  // 目标不在已加载窗口 → 拉目标之前 40 条（含目标）补洞后由本 effect 复跑定位
  const pendingLocate = useImStore((s) => s.pendingLocate);
  const setPendingLocate = useImStore((s) => s.setPendingLocate);
  useEffect(() => {
    if (!convId || !pendingLocate || pendingLocate.convId !== convId) return;
    const msgs = useImStore.getState().messagesByConv[convId] ?? [];
    if (msgs.some((m) => m.seq === pendingLocate.seq)) {
      requestAnimationFrame(() => locateSeq(pendingLocate.seq));
      setPendingLocate(null);
      return;
    }
    // 未加载到窗口：补洞目标之前 40 条（prepend 触发 store 更新 → 本 effect 复跑）
    let cancelled = false;
    void fetchMessagesBefore(convId, pendingLocate.seq + 1, 40)
      .then((items) => {
        if (cancelled) return;
        if (items.length > 0) useImStore.getState().prependMessages(convId, items);
        setPendingLocate(null); // 空结果：目标不可达（已删/无权），放弃定位
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [convId, pendingLocate, messagesByConv, locateSeq, setPendingLocate]);

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
  // 单聊对端在线状态（presence store 投影；对端 uid=会话内非本人成员——由消息流推导）
  const peerStatus = useImStore((s) => {
    if (!activeConv || activeConv.type !== 1) return undefined;
    const msgs = s.messagesByConv[activeConv.id] ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const uid = msgs[i].senderId;
      if (uid !== s.myUid) return s.presence[uid];
    }
    return undefined;
  });
  const showTyping = !!typingUid && Date.now() - typingUid.at < TYPING_TTL_MS;

  // ---- 多选模式（INT-IM-14/PIM-10）----
  const msActive = multiSelect.isActive;
  /** 当前会话内选中消息（按 seq 升序；sending/failed 本地消息无 msgId 不参与批量） */
  const selectedMsgs = useMemo(
    () =>
      msActive
        ? messages
            .filter((m) => m.msgId && multiSelect.selectedIds.has(m.msgId))
            .sort((a, b) => a.seq - b.seq)
        : [],
    [msActive, messages, multiSelect.selectedIds],
  );
  /** 复制可用：选中全为 text（INT-IM-14） */
  const copyEnabled = msActive && selectedMsgs.length > 0 && selectedMsgs.every((m) => m.type === 'text');

  // Esc 退出多选（转发弹窗/详情抽屉打开时让位给各自的 Esc 关闭）
  useEffect(() => {
    if (!msActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (forwardIds || mergeDrawerMsg) return;
      exitMultiSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [msActive, forwardIds, mergeDrawerMsg, exitMultiSelect]);

  /** 批量收藏（INT-IM-06：逐条 favorite，失败逐条回报；幂等由服务端 UK 兜底） */
  const doBatchFavorite = useCallback(() => {
    const targets = selectedMsgs;
    if (targets.length === 0) return;
    let ok = 0;
    let failText = '';
    let dup = 0;
    void (async () => {
      for (const m of targets) {
        try {
          const r = await favoriteMessage(m.msgId);
          useImStore.getState().applyFavorite(m.msgId, true);
          ok++;
          if (r.duplicate) dup++;
        } catch (err) {
          const code = err instanceof ApiError ? err.code : 0;
          failText = code > 0 ? getErrorText(code) : '收藏失败，请重试';
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['im', 'favorites'] });
      const failed = targets.length - ok;
      setFavToast({
        text:
          failed > 0
            ? `已收藏 ${ok}/${targets.length} 条，${failed} 条失败：${failText}`
            : `已收藏 ${ok} 条${dup > 0 ? `（${dup} 条已在收藏中）` : ''}，可在收藏页查看`,
        ok: failed === 0,
      });
      setTimeout(() => setFavToast(null), 3500);
    })();
  }, [selectedMsgs, queryClient]);

  /** 批量复制（仅全 text）：拼接选中文本写剪贴板 */
  const doBatchCopy = useCallback(() => {
    if (!copyEnabled) return;
    const text = selectedMsgs
      .map((m) => ('text' in m.body ? m.body.text : ''))
      .filter(Boolean)
      .join('\n');
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setFavToast({ text: `已复制 ${selectedMsgs.length} 条文本`, ok: true });
    setTimeout(() => setFavToast(null), 3000);
  }, [copyEnabled, selectedMsgs]);

  /** 打开转发弹窗（批量条「转发」=默认逐条；「合并转发」=默认合并） */
  const openForward = useCallback(
    (mode: 'merge' | 'one_by_one') => {
      const ids = selectedMsgs.map((m) => m.msgId);
      if (ids.length === 0) return;
      setForwardMode(mode);
      setForwardIds(ids);
    },
    [selectedMsgs],
  );

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
    onForward: (m) => {
      setForwardMode('one_by_one');
      setForwardIds([m.msgId]);
    },
    onReact: (m, emoji) => {
      const has = m.ext?.reactions?.[emoji]?.includes(myUid);
      void setReaction(m.msgId, emoji, has ? 'remove' : 'add').catch(() => undefined);
    },
    onLocate: locateSeq,
    // 进入多选（INT-IM-14）：触发消息预选
    onMultiSelect: (m) => enterMultiSelect(m.msgId),
    // 合并转发详情抽屉（PIM-11）
    onOpenMergeDetail: (m) => setMergeDrawerMsg(m),
    // 收藏（PIM-08 INT-IM-06）：幂等；摘要 toast 含查看入口；超限 3022 → 错误文案
    onFavorite: (m) => {
      void favoriteMessage(m.msgId)
        .then((r) => {
          useImStore.getState().applyFavorite(m.msgId, true);
          // 前缀失效全部 type 筛选下的收藏缓存（['im','favorites',type]）
          void queryClient.invalidateQueries({ queryKey: ['im', 'favorites'] });
          setFavToast({
            text: r.duplicate ? '已在收藏中' : '已收藏，可在收藏页查看',
            ok: true,
          });
        })
        .catch((err: unknown) => {
          const code = err instanceof ApiError ? err.code : 0;
          setFavToast({ text: code > 0 ? getErrorText(code) : '收藏失败，请重试', ok: false });
        });
      setTimeout(() => setFavToast(null), 3000);
    },
  };

  // ---- 消息统一右键菜单（INT-IM-25）：右键/长按/悬浮条 ⋯ 三入口共开一份菜单 ----
  const openMsgMenu = useCallback((m: Message, at: MenuAnchor) => {
    setMenuMsg({ msg: m, anchor: at });
  }, []);
  /** 菜单动作：全部复用 bubbleActions 现有 handlers；回复/引用/复制为菜单新增语义 */
  const msgMenuActions: MsgMenuActions = {
    // 回复=携带引用发消息：插入引用条 + 聚焦输入框直接撰写（INT-IM-04）
    onReply: (m) => {
      bubbleActions.onReply(m);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('.message-input__textarea')?.focus();
      });
    },
    // 引用=只插入引用条，不预填文本不抢焦点（现 MessageInput 引用条支持）
    onQuote: (m) => {
      setEditing(null);
      setReplyTo(m);
    },
    // 复制：text 全文；非 text 类型化 digest；system 模板文案（copyTextOf 统一）
    onCopy: (m) => {
      void navigator.clipboard?.writeText(copyTextOf(m)).catch(() => undefined);
      setFwdToast({ text: '已复制到剪贴板', ok: true });
      setTimeout(() => setFwdToast(null), 2500);
    },
    onForward: bubbleActions.onForward,
    onFavorite: bubbleActions.onFavorite,
    onMultiSelect: bubbleActions.onMultiSelect,
    onEdit: bubbleActions.onEdit,
    onRecall: bubbleActions.onRecall,
  };

  // 搜索结果点击（PIM-07）：跳会话 + 定位闪烁（同会话也走 pendingLocate 统一路径）
  const onSearchSelect = useCallback(
    (hit: SearchHit) => {
      if (hit.msg.status === 2) return; // 撤回占位不可定位
      useImStore.getState().setPendingLocate({ convId: hit.msg.convId, seq: hit.msg.seq });
      navigate(`/im/c/${hit.msg.convId}`);
    },
    [navigate],
  );

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
    // 个人 @：@面板选择的提及随发送携带（uid + 首个命中位置作 range；正式版按光标精确重算）
    const picked = pendingMentionsRef.current;
    pendingMentionsRef.current = [];
    for (const p of picked) {
      const idx = text.indexOf(`@${p.name}`);
      if (idx < 0) continue; // 用户已删掉 @文本：视为放弃提及
      mentions.push({ uid: p.uid, all: false, range: [idx, idx + p.name.length + 1] });
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
        {/* PIM-07 服务端态搜索（点击/⌘K 聚焦；本地 FTS5 态属 Tauri/Rust 侧不在此） */}
        <SearchPanel inputRef={searchInputRef} onSelect={onSearchSelect} />
        <div className="im-list-col__header-actions">
          {/* 通知中心入口（PIM-09 D03 §3.9）：铃铛 + 未读红点数字（99+ 封顶） */}
          <button
            className="icon-btn bell-entry"
            title="通知中心"
            data-testid="notifications-entry"
            onClick={() => navigate('/im/notifications')}
          >
            <Bell size={16} />
            {notifUnread > 0 ? (
              <span className="bell-entry__badge" data-testid="notifications-badge">
                {notifUnread > 99 ? '99+' : notifUnread}
              </span>
            ) : null}
          </button>
          <button
            className="icon-btn"
            title="我的收藏"
            data-testid="favorites-entry"
            onClick={() => navigate('/im/favorites')}
          >
            <Star size={16} />
          </button>
          <button
            className="icon-btn"
            title="新建会话（单聊/建群）"
            onClick={() => setCreateOpen(true)}
            data-testid="create-conv-btn"
          >
            <SquarePen size={16} />
          </button>
        </div>
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
    <div
      className="message-stream"
      ref={streamRef}
      onScroll={onStreamScroll}
      onClick={(e) => {
        // 多选模式点空白退出（INT-IM-14；气泡行自身 stopPropagation 之外的空白区）
        if (msActive && e.target === e.currentTarget) exitMultiSelect();
      }}
    >
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
            onOpenMsgMenu={openMsgMenu}
            /* 多选：仅已落服务端消息参与（sending/failed 无 msgId，批量操作不可达） */
            multiSelect={
              msActive && m.type !== 'system' && m.status !== 2 && m.msgId
                ? { active: true, selected: multiSelect.selectedIds.has(m.msgId) }
                : undefined
            }
            onSelectToggle={(mm) => toggleMultiSelectItem(mm.msgId)}
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
      {msActive ? (
        /* 多选批量条替换会话头（PIM-10a，D03 §3.10） */
        <MultiSelectBar
          count={selectedMsgs.length}
          copyEnabled={copyEnabled}
          onForward={() => openForward('one_by_one')}
          onMergeForward={() => openForward('merge')}
          onFavorite={doBatchFavorite}
          onCopy={doBatchCopy}
          onCancel={exitMultiSelect}
        />
      ) : activeConv ? (
        <ChatHeader
          conv={activeConv}
          typing={showTyping ? '对方正在输入…' : undefined}
          peerStatus={peerStatus}
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

      {/* 收藏结果提示（PIM-08 INT-IM-06：摘要 toast；失败携带 3022 等错误文案） */}
      {favToast ? (
        <button
          type="button"
          className={`ann-banner${favToast.ok ? '' : ' ann-banner--warn'}`}
          data-testid="fav-toast"
          onClick={() => navigate('/im/favorites')}
          title="查看收藏"
        >
          {favToast.text}
          {favToast.ok ? <span className="ann-banner__more">去收藏页</span> : null}
        </button>
      ) : null}

      {/* 批量转发结果提示（INT-IM-05：成功/失败明细；点击跳目标会话查看） */}
      {fwdToast ? (
        <button
          type="button"
          className={`ann-banner${fwdToast.ok ? '' : ' ann-banner--warn'}`}
          data-testid="fwd-toast"
          onClick={() => {
            if (fwdToast.targetConvId) {
              setFwdToast(null);
              navigate(`/im/c/${fwdToast.targetConvId}`);
            }
          }}
          title={fwdToast.targetConvId ? '查看目标会话' : undefined}
        >
          {fwdToast.text}
          {fwdToast.ok && fwdToast.targetConvId ? <span className="ann-banner__more">查看</span> : null}
        </button>
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
          /* 禁用三态：广播群非 publisher / 单人禁言 / 全员禁言（非 owner/admin），D03 §3.3；
           * 多选模式同样禁用（避免与批量操作抢 Esc/焦点，飞书同款） */
          disabled={inputDisabled || msActive}
          disabledHint={msActive ? '多选模式中，退出后可继续输入' : inputDisabledHint}
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
          onPickFile={setPickedFile}
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
      {/* 消息统一右键菜单（INT-IM-25）：portal 到 body，视口定位+边缘翻转在组件内处理 */}
      {menuMsg ? (
        <MsgContextMenu
          message={menuMsg.msg}
          myUid={myUid}
          anchor={menuMsg.anchor}
          onClose={() => setMenuMsg(null)}
          {...msgMenuActions}
        />
      ) : null}
      {forwardIds ? (
        <ForwardModal
          convs={convs}
          msgIds={forwardIds}
          defaultMode={forwardMode}
          onClose={() => setForwardIds(null)}
          onDone={(res) => {
            // INT-IM-05：成功 toast（含跳目标会话入口）；有成功即退出多选（选择已完成使命）
            setForwardIds(null);
            if (res.sent > 0) exitMultiSelect();
            setFwdToast({
              text:
                res.failed > 0
                  ? `已转发 ${res.sent} 条，${res.failed} 条失败（已撤回/无权限的消息不可转发）`
                  : `已转发 ${res.sent} 条消息`,
              ok: res.failed === 0,
              targetConvId: res.targetConvId,
            });
            setTimeout(() => setFwdToast(null), 3500);
          }}
        />
      ) : null}
      {mergeDrawerMsg ? (
        <MergeForwardDrawer message={mergeDrawerMsg} onClose={() => setMergeDrawerMsg(null)} />
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
      {pickedFile && convId ? (
        <FileSendPreview convId={convId} file={pickedFile} onClose={() => setPickedFile(null)} />
      ) : null}
    </div>
  );
}
