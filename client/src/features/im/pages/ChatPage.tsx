/**
 * PIM-01 消息主页（D03 §3.1）：会话列表 264px / 消息流 flex:1 / 详情侧栏 304px。
 * - 断点（D01 §5.2）：XL 三栏全展开；L 详情浮层化；M 列表收窄 56px 图标条（CSS）；S 列表⇄内容两级导航
 * - 六态（D01 §7）：列表栏与消息流各自经 StateView 呈现，offline/degraded 保留缓存内容
 * - WS：msg.new/recall/updated/reaction.new/typing/receipt/conv.updated 全事件接线
 * - 交互：引用回复/编辑/撤回/表情回应/转发（PIM-10 简版）/上翻加载更早/未读分隔线/定位闪烁
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Divider, Dropdown, FloatButton, Modal, Typography, message } from 'antd';
import { ArrowDown, Bell, Megaphone, Plus, Star, UserPlus, Users } from 'lucide-react';
import { ApiError, errText, getErrorText } from '../../../shared/api/http';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useConnectionStore } from '../../../shared/store/connection';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { dayKey, formatDayDivider } from '../../../shared/utils/time';
import { useConversationMessages, useConversations, useUnreadNotificationCount } from '../api/hooks';
import {
  convCreate,
  fetchConvDetail,
  fetchMessagesBefore,
  editMessage,
  favoriteMessage,
  recallMessage,
  sendFileMessage,
  setReaction,
  type SearchHit,
} from '../api/im';
import { uploadFileSmart } from '../api/files';
import { sendStickerMessage } from '../api/stickers';
import { hydrateConv, hydrateLocal, hookSyncOnReconnect, resendOutbox, runSync } from '../api/local';
import type { Mention, Message } from '../model/types';
import { formatMuteUntil } from './systemMessageRegistry';
import { TYPING_TTL_MS, useImStore } from '../store/im';
import { ChatHeader } from '../components/ChatHeader';
import { ConversationList } from '../components/ConversationList';
import { ConvInfoSidebar } from '../components/ConvInfoSidebar';
import { CreateConvModal } from '../components/CreateConvModal';
import { PersonPickerModal } from '../components/PersonPicker';
import type { DirectoryUser } from '../../contacts/api/contacts';
import { FileSendPreview } from '../components/FileSendPreview';
import { MessageBubble, type BubbleActions } from '../components/MessageBubble';
import { MsgContextMenu, copyTextOf, type MenuAnchor, type MsgMenuActions } from '../components/stream/MsgContextMenu';
import { ingestFromIm } from '../../kb/api/kb';
import { MessageInput } from '../components/MessageInput';
import { EmbeddedAgentSync } from '../agent/EmbeddedAgentSync';
import { EmbeddedPrivateCards } from '../agent/EmbeddedPrivateCards';
import type { AgentCardBody } from '../../../shared/components/AgentProcessCard';
import { AGENT_LIVE_STATUSES, embeddedTitle, getEmbeddedSessionId, setEmbeddedSessionId } from '../agent/embedded';
import { useAgentStore } from '../../agent/store/agent';
import { ForwardModal } from '../components/ForwardModal';
import { ReadReceiptModal } from '../components/ReadReceiptModal';
import { MultiSelectBar } from '../components/MultiSelectBar';
import { MergeForwardDrawer } from '../components/MergeForwardDrawer';
import { SearchPanel } from '../components/SearchPanel';

/** 消息流 forbidden 判定：被移出(3001)/会话不存在(3019)/群解散(3002)（D03 PIM-02 六态） */
/** 贴底判定阈值（agent-web 同款 80px：距底不足此值视为贴底，恢复跟随） */
const NEAR_BOTTOM_PX = 80;

/** 消息身份键（本地 sending 无 msgId 用 clientMsgId；ack 回填后键不变） */
function msgKeyOf(m: Message): string {
  return m.msgId || m.clientMsgId;
}

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
  /** 已读面板（API-IM-06）：seq 非 0 即打开；仅群/广播群开入口（单聊 ✓✓ 已足够） */
  const [receiptSeq, setReceiptSeq] = useState(0);
  /** 转发弹窗默认方式（批量条「合并转发」入口预置 merge；PIM-10b radio 可改） */
  const [forwardMode, setForwardMode] = useState<'merge' | 'one_by_one'>('one_by_one');
  /** PIM-11 合并转发详情抽屉：点击 merge_forward 气泡打开 */
  const [mergeDrawerMsg, setMergeDrawerMsg] = useState<Message | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** 发起单聊选人器（M3：「+」菜单/搜索框联系人/空态入口共用） */
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  /** 附件发送（D06 阶段一）：file input → 预览弹层 → upload+msg.send */
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  /**
   * 提示条 D26-O5 antd message 化（原 ann-banner 自研条退役）：
   * - showFavToast：收藏/入库/复制结果（INT-IM-06 摘要 toast；成功带「去收藏页」入口）
   * - showFwdToast：转发/置顶上限/发送失败结果（INT-IM-05；成功带「查看」跳目标会话）
   * - @全体被 3014 拦截 → message.warning（原 3s 提示条等价）
   */
  const showFavToast = (text: string, ok: boolean, duration = 3) => {
    (ok ? message.success : message.error)(
      <span data-testid="fav-toast" onClick={() => navigate('/im/favorites')} style={{ cursor: 'pointer' }}>
        {text}
        {ok ? <span style={{ marginInlineStart: 8, textDecoration: 'underline' }}>去收藏页</span> : null}
      </span>,
      duration,
    );
  };
  const showFwdToast = (text: string, ok: boolean, targetConvId?: string, duration = 3.5) => {
    (ok ? message.success : message.error)(
      <span
        data-testid="fwd-toast"
        onClick={() => {
          if (targetConvId) navigate(`/im/c/${targetConvId}`);
        }}
        style={targetConvId ? { cursor: 'pointer' } : undefined}
      >
        {text}
        {ok && targetConvId ? <span style={{ marginInlineStart: 8, textDecoration: 'underline' }}>查看</span> : null}
      </span>,
      duration,
    );
  };
  /** 编辑中随 @ 面板选择的提及（随发送携带；正式版按 range 精确重算） */
  const pendingMentionsRef = useRef<Array<{ uid: string; name: string }>>([]);
  /** PIM-07 全局搜索框（⌘K 聚焦目标） */
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 消息右键菜单态（INT-IM-25）：局部 useState 即可，不入全局 store */
  const [menuMsg, setMenuMsg] = useState<{ msg: Message; anchor: MenuAnchor } | null>(null);

  // ---- 服务端态（Query）----
  const convQuery = useConversations('all');
  const msgQuery = useConversationMessages(convId ?? null);
  // 左栏拖拽调宽（L/XL 生效；M 档媒体查询收窄 56px、S 档全宽均不参与——
  // 设 CSS 变量而非 width，M 档 width 覆盖规则不受影响）
  const listSplit = useSplitWidth('im-list', 264, 200, 420);
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
  /** 置顶 3023 上限提示（OQ-B06：拒绝不替换最旧；antd message 3s） */
  const handleTogglePin = (convId: string) => {
    void togglePin(convId).then((ok) => {
      if (!ok) {
        showFwdToast('置顶会话已达上限 30，先取消其他置顶再试', false, undefined, 3);
      }
    });
  };
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
  // ── 内嵌 Agent（D18；2026-11-14 隐私裁决：默认零落流——问题/过程/回答全程
  //    仅本机可见，回合收口入待同步池，手动「同步」才把仅结论卡发进会话；
  //    EmbeddedAgentSync 常驻（映射存在即挂）管收口写入/重载对账/审批弹框，
  //    EmbeddedPrivateCards 在消息流尾部渲染私密实时卡与待同步卡；
  //    发消息走输入框（🤖 按钮//agent 命令），进工作台走 ChatHeader 🤖 图标） ──
  const [agentMode, setAgentMode] = useState(false);
  const [embeddedActive, setEmbeddedActive] = useState<string | null>(null);
  useEffect(() => {
    setAgentMode(false);
    setEmbeddedActive(null);
    if (!convId) return;
    void getEmbeddedSessionId(convId).then((sid) => {
      // 任意状态均挂载：idle 静默，新一轮自然出实时卡；审批弹框恒有宿主
      if (sid) setEmbeddedActive(sid);
    });
  }, [convId]);

  /** 取/建本会话 embedded Agent 会话。2026-11-11「会话不死」裁决：会话=上下文，
   * ended/error 只是当前未活跃的标记——恒定复用同一会话 id，RT 侧 input 自动
   * 重放事件镜像复活续上下文（不再因死态重建新会话丢历史）。
   * 事件订阅不在此等待 init（其数据加载=会话/记忆/日报多次 REQ 往返，bbrt 冷启
   * 时含进程拉起+MCP 超时——发送路径曾被串行卡住数百 ms~秒级）：App 挂载即已
   * ensureAgentEventSubscribed（2026-11-11 根因修复），此处只读映射直发 */
  const ensureEmbeddedSession = async (): Promise<string> => {
    void useAgentStore.getState().init(); // 数据预取并行（左栏/记忆页用）；不 await
    const sid = await getEmbeddedSessionId(convId!);
    if (sid) return sid; // 映射在=库里有行，RT 复活兜底
    // 2026-11-12 日常口径（ZCode 式）：IM embedded 会话恒日常——不跟随项目
    // （旧「沿用最近项目会话目录」废除：sessions 未加载完时必落空，且口径
    // 已改为不跟项目走）。日常=bbrt 侧默认用户工作空间 ~/.baobaowork/workspace；
    // 要操作具体项目目录=ChatHeader 🤖 进工作台开项目会话。
    // 创建即带来源标题（与xxx的对话/xxx · 群聊）——工作台左栏可辨识
    const created = await useAgentStore.getState().createSession({
      workspace: '',
      mode: 'ask',
      title: embeddedTitle(activeConv?.name ?? '', activeConv?.type ?? 1),
    });
    await setEmbeddedSessionId(convId!, created.id);
    return created.id;
  };

  /** Agent 流程（D18 §2/§3.1；2026-11-14 隐私裁决）：问题**不落流**，仅交本会话
   *  embedded Agent（本机处理）——实时过程与回答只在 EmbeddedPrivateCards 私密卡
   *  可见；收口入待同步池，用户手动同步才把仅结论卡发进会话 */
  const agentFlow = async (rawText: string) => {
    if (!convId) return;
    const question = rawText.replace(/^\/agent\s*/, '').trim() || rawText;
    const sid = await ensureEmbeddedSession();
    setEmbeddedActive(sid);
    await useAgentStore.getState().sendTextTo(sid, question);
  };

  /** 聊天头部 🤖 入口（2026-11-11）：跳工作台对应 embedded 会话；无则新建后跳转 */
  const openAgentWorkbench = async () => {
    if (!convId) return;
    const sid = await ensureEmbeddedSession();
    navigate(`/agent/s/${sid}`);
  };

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

  // ---- 滚动：智能跟随 / 上翻加载更早（INT-IM-13）/ 回到底部浮标 ----
  // 口径对齐 agent-web ChatPage 智能滚动：贴底跟随新内容；用户上滚浏览历史时不再
  // 抢滚动条；浮标常显（新消息计数/AI 回答中/回到底部三态），点击回底恢复跟随。
  const streamRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true); // ref 供轮询读，state 供浮标渲染
  const [awayCount, setAwayCount] = useState(0);
  const [hasOlder, setHasOlder] = useState(true);
  const loadingOlderRef = useRef(false);
  const oldestSeqRef = useRef<number | null>(null);
  /** 尾键追踪（替代 length 计数）：prepend 不动尾键天然不误计/不触发滚动 */
  const prevTailKeyRef = useRef<string | null | undefined>(undefined);

  // 切会话重置跟随态（2026-11-11 修「首次进入停在顶部」第二半）：尾键置 undefined
  // 让新会话首屏必触发吸底跳转（两条会话缓存条数相同也不再漏跳）；上翻游标/还有
  // 更早标记随会话重置——沿用上一会话的 hasOlder=false 会让新会话无法加载更早
  useEffect(() => {
    prevTailKeyRef.current = undefined;
    stickBottomRef.current = true;
    setAtBottom(true);
    setAwayCount(0);
    setHasOlder(true);
    oldestSeqRef.current = null;
  }, [convId]);

  // 消息流容器是否已挂载（骨架/空态分支不渲染 messageStream，streamRef 为 null——
  // 2026-11-11 修「首次进入停在顶部」主根因：缓存消息先于容器入 store 时，吸底
  // effect 在骨架期空跑且不记尾键，容器挂载后尾键不变则永不复跑）
  const streamMounted = streamState === 'ok' || streamState === 'degraded' || streamState === 'offline';
  const tailKey = messages.length > 0 ? msgKeyOf(messages[messages.length - 1]) : null;
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return; // 容器未挂：不记尾键，挂载后本 effect 复跑补做首跳
    const prevKey = prevTailKeyRef.current;
    if (prevKey === tailKey) return;
    prevTailKeyRef.current = tailKey;
    if (tailKey == null) return; // 空列表：只记键不动作
    if (prevKey === undefined || stickBottomRef.current) {
      el.scrollTop = el.scrollHeight; // 底部跟随（用户未上滚）/ 首跳最新
    } else {
      // 用户在上方 → 按旧尾键之后的实际条数计数（批量一次到达不漏计；旧尾键
      // 已被撤回等找不到时按 1 兜底）
      const prevIdx = messages.findIndex((m) => msgKeyOf(m) === prevKey);
      const added = prevIdx === -1 ? 1 : messages.length - 1 - prevIdx;
      if (added > 0) setAwayCount((n) => n + added);
    }
  }, [convId, tailKey, streamMounted, messages]);

  // AI 回答期间周期跟随（agent-web 同款）：agent 卡原地长高不增条数，length/
  // 尾键 effect 触发不了——300ms 轮询补跟随；内部判贴底才滚，用户上滚即自然
  // 停跟（不抢滚动条），滚回底部恢复跟随。cleanup 补滚一次兜住收口的最后一次长高。
  // 2026-11-14 隐私裁决：私密实时卡不再落流（messages 恒无 running agent_card，
  // 旧存量卡除外）——判定并入 embedded 会话运行态，滚动跟随/浮标口径不变。
  const embeddedSession = useAgentStore((s) => (embeddedActive ? s.sessions.find((x) => x.id === embeddedActive) : undefined));
  const agentRunning = useMemo(
    () =>
      messages.some((m) => m.type === 'agent_card' && (m.body as AgentCardBody).status === 'running') ||
      (!!embeddedActive && AGENT_LIVE_STATUSES.has(embeddedSession?.status ?? '')),
    [messages, embeddedActive, embeddedSession],
  );
  useEffect(() => {
    if (!agentRunning) return;
    const follow = () => {
      const el = streamRef.current;
      if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
    };
    const timer = setInterval(follow, 300);
    return () => {
      clearInterval(timer);
      follow(); // 终态收口兜底
    };
  }, [agentRunning]);

  /** 首屏即判历史尽头：初始页不足一页（50 条）= 更早已无记录——短会话不必等触顶
   *  尝试才知道到底（2026-11-12 用户口径：到底即顶部居中提示）。已翻过页
   *  （oldestSeqRef 有锚）则不重置——避免会话数据刷新把已判定的尽头翻回去 */
  useEffect(() => {
    if (msgQuery.data && oldestSeqRef.current === null) {
      setHasOlder(msgQuery.data.items.length >= 50);
    }
  }, [msgQuery.data]);

  /** 触顶加载更早（INT-IM-13：上滑翻页 prepend；滚动触顶 40px 静默触发） */
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
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    stickBottomRef.current = near;
    setAtBottom((v) => (v === near ? v : near)); // 同值不重渲染
    if (near) setAwayCount(0);
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
      // D01 §9 双键位：Cmd+K 全局搜索 / Cmd+F 当前会话内搜索（OQ-C30 拍板"前缀
      // 过滤"=维持工具名/文件名/文本前缀，不做 agent_event 全文索引——D08 §686）
      const hit = (e.metaKey || e.ctrlKey) && ['k', 'f'].includes(e.key.toLowerCase());
      if (hit) {
        e.preventDefault(); // Cmd+F 覆盖浏览器查找（IM 页面会话搜索为本意）
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
      showFavToast(
        failed > 0
          ? `已收藏 ${ok}/${targets.length} 条，${failed} 条失败：${failText}`
          : `已收藏 ${ok} 条${dup > 0 ? `（${dup} 条已在收藏中）` : ''}，可在收藏页查看`,
        failed === 0,
        3.5,
      );
    })();
  }, [selectedMsgs, queryClient, showFavToast]);

  /** 批量复制（仅全 text）：拼接选中文本写剪贴板 */
  const doBatchCopy = useCallback(() => {
    if (!copyEnabled) return;
    const text = selectedMsgs
      .map((m) => ('text' in m.body ? m.body.text : ''))
      .filter(Boolean)
      .join('\n');
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    showFavToast(`已复制 ${selectedMsgs.length} 条文本`, true);
  }, [copyEnabled, selectedMsgs, showFavToast]);

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
          showFavToast(r.duplicate ? '已在收藏中' : '已收藏，可在收藏页查看', true);
        })
        .catch((err: unknown) => {
          const code = err instanceof ApiError ? err.code : 0;
          showFavToast(code > 0 ? getErrorText(code) : '收藏失败，请重试', false);
        });
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
        // D26-O7：textarea 已换 antd Input.TextArea（data-testid 直挂 textarea），聚焦锚点同口径迁移
        document.querySelector<HTMLTextAreaElement>('textarea[data-testid="chat-input-textarea"]')?.focus();
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
      showFwdToast('已复制到剪贴板', true, undefined, 2.5);
    },
    onForward: bubbleActions.onForward,
    onFavorite: bubbleActions.onFavorite,
    // 存入知识库（D24 N6）：文本消息→我的笔记（保存/投稿分离——默认落个人维度）
    onSaveToKb: (m) => {
      if (m.type !== 'text' || !('text' in m.body)) return;
      void ingestFromIm({ msg_id: m.msgId, text: m.body.text })
        .then((doc) => {
          showFavToast(
            doc.status === 'ready' ? `已存入「我的笔记」：《${doc.title}》` : `入库失败：${doc.error_msg ?? '嵌入服务不可用'}`,
            doc.status === 'ready',
          );
        })
        .catch((err: unknown) => {
          const code = err instanceof ApiError ? err.code : 0;
          showFavToast(code > 0 ? getErrorText(code) : '入库失败，请重试', false);
        });
    },
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

  // 发起单聊（M3）：「+」菜单/搜索框联系人命中/空态入口共用——服务端同对成员已有单聊幂等复用
  const startDm = useCallback(
    async (uid: string) => {
      try {
        const conv = await convCreate({ type: 1, memberIds: [uid] });
        await queryClient.invalidateQueries({ queryKey: ['im', 'convs'] });
        navigate(`/im/c/${conv.id}`);
      } catch (e) {
        Modal.error({ title: '发起会话失败', content: errText(e, '请稍后重试') });
      }
    },
    [queryClient, navigate],
  );

  // 搜索框联系人命中（M3）：搜人即聊——点人发起单聊直达
  const onPickPerson = useCallback((u: DirectoryUser) => void startDm(u.uid), [startDm]);

  const doSend = (text: string) => {
    if (!convId) return;
    // Agent 模式 / /agent 前缀（2026-11-11 命令口径；@Agent 触发已下线留作他用）。
    // 2026-11-14 隐私裁决：**完全私密**——问题不落流（mentions/回复引用对不存在的
    // 消息无意义，一并跳过），仅交本机 embedded Agent；回答收口后经私密卡手动同步
    if (agentMode || /^\/agent([\s　]|$)/.test(text)) {
      setReplyTo(null);
      void agentFlow(text);
      return;
    }
    // @全体：文本包含「@全体」即携带 all mention（服务端按 mention_all_policy 校验 3014）
    const mentions: Mention[] = [];
    const at = text.indexOf('@全体');
    if (at >= 0) {
      if (!allowMentionAll) {
        message.warning(<span data-testid="mention-all-blocked">当前群策略不允许你使用 @全体</span>, 3);
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

  /** 语音条发送（audio_clip）：智能上传 → msg.send；气泡由 msg.new 回流（同 file 链路） */
  const sendVoiceFlow = async (file: File, durationMs: number) => {
    if (!convId) return;
    try {
      const up = await uploadFileSmart(file, convId);
      await sendFileMessage(convId, crypto.randomUUID(), 'audio_clip', {
        file_id: up.id,
        name: file.name,
        size: up.size,
        ext: up.ext,
        duration_ms: durationMs,
        ...(up.contentType ? { contentType: up.contentType } : {}),
      });
    } catch {
      showFwdToast('语音发送失败，请重试', false);
    }
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
    <section
      className="im-list-col"
      style={
        bp === 'S'
          ? { width: '100%', borderRight: 'none' }
          : ({ '--bbw-list-width': `${listSplit.width}px` } as CSSProperties)
      }
    >
      <div className="im-list-col__header">
        {/* PIM-07 服务端态搜索（点击/⌘K 聚焦；M3 起联系人/消息双段结果——搜人即聊） */}
        <SearchPanel inputRef={searchInputRef} onSelect={onSearchSelect} onPickPerson={onPickPerson} />
        <div className="im-list-col__header-actions">
          {/* 通知中心入口（PIM-09 D03 §3.9）：铃铛 + 未读红点数字（99+ 封顶） */}
          <button
            className="icon-btn bell-entry"
            title="通知中心"
            data-testid="notifications-entry"
            onClick={() => navigate('/notifications')}
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
          {/* 新建会话（M3 2026-11-12 用户口径）：「+」下拉菜单——发起单聊直达选人器/发起群聊 */}
          <Dropdown
            menu={{
              items: [
                { key: 'single', icon: <UserPlus size={14} />, label: '发起单聊' },
                { key: 'group', icon: <Users size={14} />, label: '发起群聊' },
              ],
              onClick: ({ key }) => (key === 'single' ? setDmPickerOpen(true) : setCreateOpen(true)),
            }}
            trigger={['click']}
            placement="bottomRight"
          >
            <button className="icon-btn" title="新建会话" data-testid="create-conv-btn">
              <Plus size={16} />
            </button>
          </Dropdown>
        </div>
      </div>
      {listState === 'ok' ? (
        <ConversationList
          convs={convs}
          activeId={convId ?? null}
          onSelect={(id) => navigate(`/im/c/${id}`)}
          onTogglePin={handleTogglePin}
          onToggleMute={toggleMute}
        />
      ) : (
        <StateView
          state={listState}
          skeleton={<SkeletonList count={8} />}
          error={convQuery.error}
          onRetry={() => void convQuery.refetch()}
          emptyText="还没有会话，发起第一个会话吧"
          emptyAction={<Button onClick={() => setDmPickerOpen(true)}>发起单聊</Button>}
          offlineText="离线中，可浏览本地缓存的会话"
          degradedText={degradedText ?? undefined}
        >
          <ConversationList
            convs={convs}
            activeId={convId ?? null}
            onSelect={(id) => navigate(`/im/c/${id}`)}
            onTogglePin={handleTogglePin}
            onToggleMute={toggleMute}
          />
        </StateView>
      )}
    </section>
  );

  // 消息流容器（D26-O7 自研类退役：内联滚动容器；定位闪烁锚点 data-seq 不变）
  const messageStream = (
    <div
      ref={streamRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
      onScroll={onStreamScroll}
      onClick={(e) => {
        // 多选模式点空白退出（INT-IM-14；气泡行自身 stopPropagation 之外的空白区）
        if (msActive && e.target === e.currentTarget) exitMultiSelect();
      }}
    >
      {/* 历史尽头提示（2026-11-12 用户口径：去掉「上滑/点击加载」提醒——滑到顶 40px
          已静默自动加载；没有更早历史时顶部居中提示到底） */}
      {messages.length > 0 && !hasOlder ? (
        <Typography.Text
          type="secondary"
          data-testid="no-more-hint"
          style={{ display: 'block', textAlign: 'center', fontSize: 12, padding: '8px 0 12px' }}
        >
          已经没有更多聊天记录了
        </Typography.Text>
      ) : null}
      {messages.map((m, i) => (
        <Fragment key={`${convId}:${m.seq}`}>
          {/* 日期分隔条（D26-O7：antd Divider plain 化） */}
          {i === 0 || dayKey(m.ts) !== dayKey(messages[i - 1].ts) ? (
            <Divider plain style={{ margin: '4px 0', fontSize: 12 }}>
              {formatDayDivider(m.ts)}
            </Divider>
          ) : null}
          {/* 未读分隔线（INT-IM-08 简版：首条未读之前插入一次；主色文案） */}
          {unreadAnchorSeq !== null && m.seq > unreadAnchorSeq && (i === 0 || messages[i - 1].seq <= unreadAnchorSeq) ? (
            <Divider style={{ margin: '8px 0' }}>
              <span style={{ color: 'var(--bbw-primary)', fontSize: 12 }}>以下为未读消息</span>
            </Divider>
          ) : null}
          <MessageBubble
            message={m}
            /* agent_card 恒按对方样式渲染（2026-11-11 用户口径：AI 回答左对齐+头像
             * 在左——即使发起人是自己，回答主体是 Agent；顺带不显示发送回执尾标） */
            mine={m.senderId === myUid && m.type !== 'system' && m.type !== 'agent_card'}
            onRetry={(clientMsgId) => convId && void retrySend(convId, clientMsgId)}
            peerReadSeq={(convId && peerReadSeq[convId]) || 0}
            actions={m.type === 'system' ? undefined : bubbleActions}
            myUid={myUid}
            myRole={myRole}
            onOpenMsgMenu={openMsgMenu}
            onOpenReceipts={activeConv && activeConv.type !== 1 ? (m) => setReceiptSeq(m.seq) : undefined}
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
      {/* 私密卡区（2026-11-14 隐私裁决）：embedded Agent 实时过程卡 + 待同步轮卡，
          仅本人可见的本地渲染（非消息、不落库不扇出）；流尾常驻，收口后可手动同步 */}
      {convId && embeddedActive ? <EmbeddedPrivateCards convId={convId} sessionId={embeddedActive} /> : null}
    </div>
  );

  // 回到底部浮标（agent-web 口径，D26-O7 antd FloatButton 化）：上滚即常显；
  // 未读计数 Badge / AI 回答中红点 / tooltip 三态文案；点击回底并恢复贴底跟随
  const scrollFab = !atBottom ? (
    <FloatButton
      data-testid="scroll-bottom-fab"
      icon={<ArrowDown size={14} />}
      tooltip={
        awayCount > 0
          ? `${awayCount > 99 ? '99+' : awayCount} 条新消息`
          : agentRunning
            ? 'AI 回答中 · 回到底部'
            : '回到底部'
      }
      badge={
        awayCount > 0
          ? { count: awayCount > 99 ? '99+' : awayCount, size: 'small' }
          : agentRunning
            ? { count: 0, dot: true, size: 'small' }
            : undefined
      }
      onClick={() => {
        const el = streamRef.current;
        stickBottomRef.current = true;
        setAtBottom(true);
        setAwayCount(0);
        if (el) el.scrollTop = el.scrollHeight;
      }}
      style={{ position: 'absolute', right: 24, bottom: 12, zIndex: 10 }}
    />
  ) : null;

  // 滚动区包裹层（agent-web messages-wrap 同构）：浮标以此为定位祖先，恒浮于
  // 输入框正上方（不猜输入区高度）；ok 与 degraded/offline 两分支共用（内联化）
  const messageStreamWrap = (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {messageStream}
      {scrollFab}
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
          onOpenAgent={() => void openAgentWorkbench()}
          onToggleDetail={() => setDetailOpen((v) => !v)}
        />
      ) : null}

      {/* 公告横幅（INT-IM-18：更新即时摘要，全文在详情栏公告 tab；D26-O5→antd Alert banner） */}
      {activeConv?.groupSetting?.announcement && activeConv.status === 1 ? (
        <Alert
          banner
          type="info"
          icon={<Megaphone size={14} />}
          message={activeConv.groupSetting.announcement}
          action={<span>查看全文</span>}
          data-testid="ann-banner"
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setDetailOpen(true);
            setDetailTab('announcement');
          }}
        />
      ) : null}

      {streamState === 'none' ? (
        <StateView state="empty" emptyText="从左侧选择一个会话开始聊天" />
      ) : streamState === 'ok' ? (
        messageStreamWrap
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
          {messageStreamWrap}
        </StateView>
      )}

      {/* 内嵌 Agent 同步控制器（无头：回合收口入待同步池/重载对账/审批与提问弹框） */}
      {convId && embeddedActive ? <EmbeddedAgentSync convId={convId} sessionId={embeddedActive} /> : null}

      {convId ? (
        <MessageInput
          convId={convId}
          agentMode={agentMode}
          onToggleAgentMode={() => setAgentMode((v) => !v)}
          /* typing 上报仅单聊（OQ-B03 拍板：群聊默认关——大群广播扰动高；广播群本就只读） */
          typingEnabled={activeConv?.type === 1}
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
          onSendVoice={(file, durationMs) => void sendVoiceFlow(file, durationMs)}
          onPickSticker={(item) => {
            if (!convId) return;
            sendStickerMessage(convId, item).catch(() => {
              showFwdToast('表情发送失败，请重试', false);
            });
          }}
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
      {showList ? (
        <>
          {convListNode}
          {bp === 'L' || bp === 'XL' ? <SplitHandle bind={listSplit.bind} /> : null}
        </>
      ) : null}
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
            showFwdToast(
              res.failed > 0
                ? `已转发 ${res.sent} 条，${res.failed} 条失败（已撤回/无权限的消息不可转发）`
                : `已转发 ${res.sent} 条消息`,
              res.failed === 0,
              res.targetConvId,
            );
          }}
        />
      ) : null}
      {receiptSeq > 0 && convId ? (
        <ReadReceiptModal convId={convId} seq={receiptSeq} onClose={() => setReceiptSeq(0)} />
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
      {/* 发起单聊选人器（M3：「+」菜单/空态入口；点人即建单聊直达） */}
      <PersonPickerModal
        open={dmPickerOpen}
        title="发起单聊"
        onClose={() => setDmPickerOpen(false)}
        onConfirm={(picked) => {
          if (picked[0]) void startDm(picked[0].uid);
        }}
      />
      {pickedFile && convId ? (
        <FileSendPreview convId={convId} file={pickedFile} onClose={() => setPickedFile(null)} />
      ) : null}
    </div>
  );
}
