/**
 * PAG-01/02/03 Agent 工作台（/agent[/s/:sessionId]，D08 §3.1/§3.3）：
 * - 左：会话列表（窄栏 + 新建 + 二级导航入口；2026-11-19 起 run 记录不再进左栏）
 * - 中：会话视图（头部状态徽标 + 会话流 + 输入区；停止唯一入口=发送旁）；
 *   /agent/new=新建会话页（2026-11-23 懒创建裁决：点 + 只进页不建会话，首条
 *   消息发送时才 createSession——zcode 同款居中输入；空会话同居中口径）
 * - 右：**内容坞**（D33 2026-11-19 修订）：无固定 tab，按需打开子 agent 过程
 *   （多子 agent=多 tab，按主会话归属/隔离）；可拖宽、右上角完全收起/展开；
 *   未来 browser/文件等内容同坞扩展
 * - 会话流渲染（2026-11-17 D33 平铺流）：无气泡全宽消息流——用户消息平铺块 +
 *   类型化过程块（思考/工具族/技能/审批/子任务/中间正文），收口折叠一行统计，
 *   最终回答常开（AgentStreamView/TurnBlock；回合气泡/AgentProcessCard 归 IM 专用）
 * - 六态：列表与中栏各自 StateView（forbidden 不适用于本域：页面准入权限点由设置域登记）
 * - offline：Agent 不依赖 WSS（D08 §1.3），mock 桥本地照常，仅提示
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Dropdown, Flex, FloatButton, Modal, Tag, Typography, message, theme, type MenuProps } from 'antd';
import { ArrowDown, History, MessageCircle, PanelLeftOpen, PanelRightOpen, Plus, ShieldCheck } from 'lucide-react';
import { open as openDirectory } from '@tauri-apps/plugin-dialog';
import { Button } from '../../../shared/ui/Button';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore, selectActiveSession, composerDisabledFor, type StreamItem } from '../store/agent';
import { AGENT_MODE_OPTIONS, RUN_KIND_LABELS, RUN_STATUS_LABELS, SESSION_STATUS_LABELS } from '../bridge/types';
import type { PermissionMode, RunInfo } from '../bridge/types';
import { fetchMyProviders, fetchSharedProviders } from '../../settings/api/ai';
import type { AIProvider } from '../../admin/model/types';
import { AgentSubNav } from '../components/AgentSubNav';
import { AgentSessionList } from '../components/AgentSessionList';
import { AgentComposeView } from '../components/AgentComposeView';
import { AgentRightDock } from '../components/AgentRightDock';
import { AgentStreamView } from '../components/stream/AgentStreamView';
import type { PermissionDecision } from '../components/PermissionCard';
import { ModelThinkPicker } from '../components/ModelThinkPicker';
import { ContextUsageMeter } from '../components/ContextUsageMeter';
import { convIdOfSession } from '../../im/agent/embedded';
import { sendBotText } from '../../im/api/im';
import { useImStore } from '../../im/store/im';
import { Composer } from '../components/Composer';
import { fetchPluginCommands, type PluginCommand } from '../../eco/api/plugins';

/** 回合进行中的会话状态集（回合气泡 active 判定） */
const TURN_ACTIVE_STATUSES = new Set<string>(['running', 'waiting_permission', 'waiting_clarify', 'subagent_fanout']);

/** 空流常量（selector 稳定返回：无会话/无条目时不随渲染新建引用） */
const EMPTY_ITEMS: StreamItem[] = [];
/** 空 run 常量（同上：稳定引用让 useMemo/子组件免无谓重算） */
const EMPTY_RUNS: RunInfo[] = [];

/** 会话状态徽标色（原 agent-status-badge--* 口径：运行=绿/等待=橙/错误=红/其余灰） */
function statusTagColor(status: string): string | undefined {
  if (status === 'running' || status === 'subagent_fanout') return 'success';
  if (status === 'waiting_permission' || status === 'waiting_clarify' || status === 'starting') return 'warning';
  if (status === 'error') return 'error';
  return undefined;
}

export function AgentWorkbenchPage() {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { token } = theme.useToken();
  // 新建会话页（2026-11-23 懒创建裁决）：/agent/new 只渲染居中输入框（项目上下文
  // 经 ?workspace= 携带），不建会话；首条消息发送时才 createSession
  const isCompose = location.pathname === '/agent/new';
  const composeWorkspace = isCompose ? searchParams.get('workspace') ?? '' : null;
  // 插件斜杠命令表（D22/L5：/ 渲染；失败降级空=功能关闭）
  const [pluginCommands, setPluginCommands] = useState<PluginCommand[]>([]);
  useEffect(() => {
    void fetchPluginCommands().then(setPluginCommands);
  }, []);
  /** 左栏会话列表整体折叠（2026-11-11：会话多时可让宽给中栏；项目内会话另有自身折叠） */
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  // 左栏拖拽调宽（未折叠且 L/XL 生效——M 档媒体查询收窄 56px 图标条，内联宽度会击穿须让位）
  const sessionsSplit = useSplitWidth('agent-sessions', 232, 180, 360);
  // 右栏内容坞拖拽调宽（2026-11-19：side='right' 向右拖=变窄；收起态由 store 持久化）
  const dockSplit = useSplitWidth('agent-dock', 400, 280, 760, 'right');
  const bp = useBreakpoint();
  const sessionsResizable = !sessionsCollapsed && (bp === 'L' || bp === 'XL');
  /** embedded 会话来源聊天（2026-11-11「回到聊天」：IndexedDB 映射反查 convId） */
  const [embeddedConvId, setEmbeddedConvId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!routeSessionId) {
      setEmbeddedConvId(null);
      return;
    }
    void convIdOfSession(routeSessionId).then((cid) => {
      if (!cancelled) setEmbeddedConvId(cid);
    });
    return () => {
      cancelled = true;
    };
  }, [routeSessionId]);

  // ---- store 接线 ----
  const init = useAgentStore((s) => s.init);
  const bridgeKind = useAgentStore((s) => s.bridgeKind);
  const sessions = useAgentStore((s) => s.sessions);
  const sessionsLoading = useAgentStore((s) => s.sessionsLoading);
  const sessionsError = useAgentStore((s) => s.sessionsError);
  const createError = useAgentStore((s) => s.createError);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const selectSession = useAgentStore((s) => s.selectSession);
  const modelBySession = useAgentStore((s) => s.modelBySession);
  const usageBySession = useAgentStore((s) => s.usageBySession);
  const runsBySession = useAgentStore((s) => s.runsBySession);
  const loadRuns = useAgentStore((s) => s.loadRuns);
  const dockTabsAll = useAgentStore((s) => s.dockTabs);
  const dockCollapsed = useAgentStore((s) => s.dockCollapsed);
  const setDockCollapsed = useAgentStore((s) => s.setDockCollapsed);
  const openRunTab = useAgentStore((s) => s.openRunTab);
  const workspaces = useAgentStore((s) => s.workspaces);
  const registerProject = useAgentStore((s) => s.registerProject);
  const sendText = useAgentStore((s) => s.sendText);
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const stopActive = useAgentStore((s) => s.stopActive);
  const setMode = useAgentStore((s) => s.setMode);
  const switchModel = useAgentStore((s) => s.switchModel);

  // ---- 模型选项（0023 多供应商：公司级 shared + 我的 BYOK；失败静默回落纯档位）----
  const [aiProviders, setAiProviders] = useState<{ shared: AIProvider[]; mine: AIProvider[] }>({ shared: [], mine: [] });
  useEffect(() => {
    let disposed = false;
    void Promise.all([fetchSharedProviders(), fetchMyProviders().catch(() => [])])
      .then(([shared, mine]) => {
        if (!disposed) setAiProviders({ shared, mine });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  // 路由 → store（/agent/s/:id 与列表点击双向同步；/agent/new 无选中——清残留高亮）
  useEffect(() => {
    if (routeSessionId) selectSession(routeSessionId);
    else if (isCompose) useAgentStore.setState({ activeSessionId: null });
    return () => undefined;
  }, [routeSessionId, isCompose, selectSession]);

  const activeSession = useAgentStore(selectActiveSession);
  // 只订当前会话的流数组（2026-11-11 卡顿修复）：此前订阅整个 streams record，
  // 任何会话（含后台 embedded）每个 delta 都整页重渲；selector 现仅取本会话数组
  // 引用（O(1)），其它会话的更新不再波及本页
  const items = useAgentStore((s) => (s.activeSessionId ? s.streams[s.activeSessionId] : undefined)) ?? EMPTY_ITEMS;
  // 历史是否已回填完（2026-11-23 懒创建）：无条目时据此区分「真空会话」（居中输入）
  // 与「历史还没加载完」（仍沉底，避免先居中再跳底的抖动）
  const historyLoaded = useAgentStore((s) => (activeSessionId ? s.historyLoadedBySession[activeSessionId] === true : true));
  // D33：右栏内容坞——只取当前会话的 tab（按主会话归属/隔离；切会话整条换）
  const dockTabs = useMemo(
    () => (activeSessionId ? dockTabsAll.filter((t) => t.sessionId === activeSessionId) : []),
    [dockTabsAll, activeSessionId],
  );
  const runs = activeSessionId ? (runsBySession[activeSessionId] ?? EMPTY_RUNS) : EMPTY_RUNS;

  // run 记录（D16 §3.1）：会话切换时拉取；生命周期事件触发的刷新在 store 内
  // （右栏 tab 的 kind/状态 + 历史子任务下拉数据源）
  useEffect(() => {
    if (activeSessionId) loadRuns(activeSessionId);
  }, [activeSessionId, loadRuns]);
  const composerState = composerDisabledFor(activeSession?.status);

  // ---- 六态推导（列表栏）----
  // 零会话不算 empty（2026-11-23 用户报修）：三分栏每区自带空态提示行，列表
  // 空也照常渲染分区——此前 sessions.length===0 判 empty 走 StateView 空态，
  // 其 empty 分支不渲染 children，左栏被「新建任务会话」居中空态整个顶掉
  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);
  const listState: ViewState | 'ok' = sessionsLoading
    ? 'loading'
    : sessionsError
      ? 'error'
      : degradedText
        ? 'degraded'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  // 中栏态：路由带 id 但会话不存在（未加载完 or 非法）→ loading；未选会话 → 空态引导；
  // 无条目：历史已回填完=真空会话 → empty（居中输入）；未回填完 → loading（沉底）
  const streamState: ViewState | 'ok' | 'none' = !activeSessionId
    ? 'none'
    : routeSessionId && !activeSession
      ? 'loading'
      : items.length === 0
        ? historyLoaded
          ? 'empty'
          : 'loading'
        : degradedText
          ? 'degraded'
          : connStatus === 'offline'
            ? 'offline'
            : 'ok';

  // ---- 模式切换（PAG-07：升档 full-auto 二次确认；降档即时生效）----
  const doSetMode = useCallback(
    (mode: PermissionMode) => {
      const current = useAgentStore.getState().sessions.find((x) => x.id === activeSessionId)?.mode;
      if (mode === current) return;
      const option = AGENT_MODE_OPTIONS.find((m) => m.value === mode);
      if (mode === 'full-auto') {
        Modal.confirm({
          title: '切换到完全控制模式？',
          content: `${option?.desc ?? ''}。本会话即时生效，不影响其它会话；"永不全自动清单"与高危命令仍保留审批。`,
          okText: '切换',
          cancelText: '取消',
          onOk: () => setMode(mode),
        });
        return;
      }
      setMode(mode);
    },
    [activeSessionId, setMode],
  );

  const modeMenu: MenuProps = {
    items: AGENT_MODE_OPTIONS.map((m) => ({
      key: m.value,
      label: (
        <div>
          <div>{m.label}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {m.desc}
          </Typography.Text>
        </div>
      ),
    })),
    onClick: ({ key }) => doSetMode(key as PermissionMode),
  };

  // ---- 滚动：智能跟随 + 回到底部浮标（对齐聊天页 INT-IM-13 口径）----
  // 贴底跟随新内容；用户上滚浏览历史时不抢滚动条；离底浮标常显（新输出计数/
  // 运行中红点/回到底部三态），点击回底恢复跟随。
  // 2026-11-18 二修：弃 streamTick 签名（条数+尾项文本长度——运行提示 TypingState/
  // 思考 ticker 的挂载不改变 items，签名不变即不吸底，回合启动窗口期的「思考中…」
  // 提示留在折叠线以下被裁掉）→ ResizeObserver 观察内容层实际高度：任何增高
  // （流式 delta/运行提示挂载/卡片展开）stick 时吸底
  const streamRef = useRef<HTMLDivElement>(null);
  const streamContentRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true); // ref 供 RO/计数读，state 供浮标渲染
  const [awayCount, setAwayCount] = useState(0); // 离底期间新增流条目数（浮标 Badge）
  /** 回合「发送到聊天」（2026-11-20 修订：固定发到本会话对应的来源私聊/群聊，
   *  不弹目标选择、不支持发到其他会话）——最终回答以 **bot 名义**消息发出（AI 头像+
   *  「{发起人}的BOT」+markdown 渲染，非本人样式）；非 embedded 会话无来源
   *  （embeddedConvId=null）→ 回调 undefined=按钮不渲染；返回是否成功（按钮翻已发态） */
  const shareTurnToConv = useCallback(
    async (_user: Extract<StreamItem, { kind: 'user' }>, items: StreamItem[]): Promise<boolean> => {
      if (!embeddedConvId) return false;
      let text = '';
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        if (it.kind === 'agentText') {
          text = it.text;
          break;
        }
      }
      if (!text.trim()) return false;
      const name = useImStore.getState().convs.find((c) => c.id === embeddedConvId)?.name;
      try {
        await sendBotText(embeddedConvId, text);
        message.success(`已发送到${name ? ` ${name}` : '对应聊天'}`);
        return true;
      } catch {
        message.error('发送失败，请重试');
        return false;
      }
    },
    [embeddedConvId],
  );
  const prevLenRef = useRef(items.length);
  // 容器挂载标记（loading/empty/none 分支不渲染 streamNode）：跨分支切换时
  // contentRef 指向新元素，RO 须随挂载重 observe——依赖 [] 的旧写法在「首载
  // loading→ok」路径空跑后再也不 observe，吸底整体失效
  const streamMounted = streamState === 'ok' || streamState === 'degraded' || streamState === 'offline';
  useEffect(() => {
    const el = streamRef.current;
    const content = streamContentRef.current;
    if (!el || !content) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!stickBottomRef.current) return;
      // 吸底写滚动经 rAF（2026-11-11 卡顿修复）：读 scrollHeight/写 scrollTop 同帧
      // 内直执=强制同步 layout，每 delta 一次在长 DOM 上主线程敏感；rAF 让读写
      // 落到帧边界，同帧多次触发合并为末次值
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [streamMounted]);
  // 切会话重置跟随态 + 首跳兜底：新会话历史全量在 DOM（无上翻分页），进入即
  // 底部；rAF 直跳兜「两会话内容等高、RO 无变化不触发」的极端情况
  useEffect(() => {
    stickBottomRef.current = true;
    setAtBottom(true);
    setAwayCount(0);
    prevLenRef.current = items.length; // 计数基线换会话重置（跨会话差值不计数）
    const raf = requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSessionId]);
  // 离底计数（声明序在重置之后：切会话时基线已重置、差值为零不误计）：仅计
  // items 净增（新块挂载计 1；流式 delta 原地长高不增条目——由 RO 吸底与
  // 运行中红点表达）
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = items.length;
    if (items.length > prev && !stickBottomRef.current) setAwayCount((n) => n + (items.length - prev));
  }, [items]);
  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickBottomRef.current = near;
    setAtBottom((v) => (v === near ? v : near)); // 同值不重渲染
    if (near) setAwayCount(0);
  }, []);

  // ---- 动作 ----
  // 回调 useCallback 化（2026-11-11 卡顿修复）：流式期间本页每 delta 重渲，
  // 稳定回调引用让左栏/消息卡 memo 生效
  const handleSelect = useCallback(
    (id: string) => {
      selectSession(id);
      stickBottomRef.current = true;
      navigate(`/agent/s/${id}`);
    },
    [selectSession, navigate],
  );
  /** 新建任务会话入口 → 新建会话页（2026-11-23 懒创建裁决：点击不建会话，首条
   *  消息发送时才 createSession；重复点击=同一路由幂等，不再堆积占位空会话） */
  const handleNewTask = useCallback(() => {
    navigate('/agent/new');
  }, [navigate]);

  /** D19 打开项目目录：系统目录选择 → workspace.register → 项目会话 */
  const handleOpenProject = useCallback(() => {
    void (async () => {
      let dir: string | null = null;
      try {
        dir = (await openDirectory({ directory: true, multiple: false, title: '选择项目目录（将作为该会话的工作目录与沙箱根）' })) as string | null;
      } catch {
        dir = null; // 浏览器演示（mock 桥）无系统对话框
      }
      if (!dir) {
        if (bridgeKind === 'mock') {
          useAgentStore.setState({ createError: '目录选择需要桌面端（当前为演示桥）：请在 Tauri 宿主中打开项目' });
        }
        return;
      }
      await openProjectSessionRef.current(dir);
    })();
  }, [bridgeKind]);

  /** 登记项目 + 进项目新建会话页（打开项目/项目行 + 共用；经 ref 解循环依赖）。
   *  2026-11-23 懒创建：登记即时进左栏项目区，会话待首条消息发送时才建 */
  const openProjectSessionRef = useRef<(path: string) => Promise<void>>(async () => undefined);
  openProjectSessionRef.current = async (path: string) => {
    try {
      // workspace 必须用登记行回传的 realpath（与 workspace.list 同串）：
      // 传对话框原始路径会让会话与登记表在左栏按路径分组时字符串不等，
      // 同项目裂成「目录名+绝对路径」两组（2026-11-23 用户报修）
      const item = await registerProject(path);
      navigate(`/agent/new?workspace=${encodeURIComponent(item.path)}`);
    } catch (err: unknown) {
      useAgentStore.setState({ createError: err instanceof Error ? err.message : String(err) });
    }
  };
  /** 稳定引用版（供左栏 memo props；内部经 ref 委派，随渲染刷新实现） */
  const openProjectSession = useCallback((path: string) => openProjectSessionRef.current(path), []);
  /** 移除项目登记（稳定引用，同上） */
  const forgetProjectById = useCallback((id: string) => void useAgentStore.getState().forgetProject(id), []);
  const handleRespond = useCallback(
    (d: PermissionDecision) => {
      respondPermission(d.requestId, d.decision, d.scope, d.editedArgs);
    },
    [respondPermission],
  );

  const status = activeSession?.status;
  // 停止=中断当前轮（2026-11-11）：有在跑的流/工具才显示（唯一入口=发送旁
  // Composer，2026-11-18 头部重复按钮退役）；paused=内部自动暂停
  // （OBO 到期/步数超限等），无流可断，只能「结束」；全局杀进程兜底=⌘⇧.
  const canStop = status === 'running' || status === 'waiting_permission' || status === 'waiting_clarify' || status === 'subagent_fanout';
  const modeOption = AGENT_MODE_OPTIONS.find((m) => m.value === activeSession?.mode);
  const modelChoice = (activeSessionId && modelBySession[activeSessionId]) || {
    policy: activeSession?.modelPolicy ?? 'auto',
    override: activeSession?.modelOverride,
  };
  const modelTier = modelChoice.policy;

  // ---- 右栏内容坞（D33 2026-11-19）：只按当前会话归属/隔离；无 tab 不渲染 ----
  const dockVisible = !!activeSession && dockTabs.length > 0;
  const showDock = dockVisible && !dockCollapsed;
  const dockRunning = dockTabs.some((t) => runs.some((r) => r.id === t.runId && r.status === 'running'));
  /** 历史子任务下拉（当前会话 run，最近 20；重启后子任务卡不在流里时的回看入口） */
  const historyRuns = useMemo(() => [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20), [runs]);
  const runStatusColor = (s: RunInfo['status']): string =>
    s === 'running' ? token.colorSuccess : s === 'failed' || s === 'interrupted' ? token.colorError : token.colorTextTertiary;
  const historyMenu: MenuProps = {
    items: historyRuns.map((r) => ({
      key: r.id,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 360 }} title={`${RUN_KIND_LABELS[r.kind]} · ${RUN_STATUS_LABELS[r.status]}${r.summary ? ` · ${r.summary}` : ''}`}>
          <Tag color={r.kind === 'expert' ? 'purple' : r.kind === 'terminal' ? 'green' : undefined} style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4, flexShrink: 0 }}>
            {RUN_KIND_LABELS[r.kind]}
          </Tag>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
            {r.summary || r.defRef.replace('builtin.', '') || r.id}
          </span>
          <span style={{ flexShrink: 0, fontSize: 11, color: runStatusColor(r.status) }}>{RUN_STATUS_LABELS[r.status]}</span>
        </div>
      ),
    })),
    onClick: ({ key }) => {
      const r = runs.find((x) => x.id === key);
      if (r && activeSession) openRunTab(activeSession.id, r.id, r.summary || r.defRef.replace('builtin.', '') || r.id);
    },
  };

  // ---- 模型选择（0023）：档位 + 公司供应商模型 + 我的供应商模型（ModelThinkPicker
  //      面板承载，与思考强度合体；key 口径沿用旧下拉菜单）----
  const onSelectModel = useCallback(
    (key: string) => {
      if (key.startsWith('tier:')) {
        switchModel(key.slice(5) as 'fast' | 'strong');
        return;
      }
      // p:<id>:<model> 直达引用（名义档位随当前；回执 modelSwitched 事件驱动 UI）
      switchModel(modelTier === 'fast' ? 'fast' : 'strong', key);
    },
    [switchModel, modelTier],
  );

  const sessionListNode = (
    <AgentSessionList
      sessions={sessions}
      workspaces={workspaces}
      activeId={activeSessionId}
      bridgeKind={bridgeKind}
      createError={createError}
      onSelect={handleSelect}
      onNewTask={handleNewTask}
      onOpenProject={handleOpenProject}
      onNewProjectSession={openProjectSession}
      onForgetProject={forgetProjectById}
      onCollapse={() => setSessionsCollapsed(true)}
    />
  );

  // ---- 会话流渲染（D33 平铺流：AgentStreamView 分组分发；active=末回合运行中）----
  const turnActive = status !== undefined && TURN_ACTIVE_STATUSES.has(status);
  // 回到底部浮标：离底即常显；三态=离底新增计数 Badge/回合运行中红点/回底。
  // 样式=水平居中吸输入框上缘 + 扁平方形（用户口径 2026-11-18，非聊天页右下圆钮）
  const scrollFab = !atBottom ? (
    <FloatButton
      shape="square"
      icon={<ArrowDown size={14} aria-hidden />}
      tooltip={
        awayCount > 0
          ? `${awayCount > 99 ? '99+' : awayCount} 条新输出`
          : turnActive
            ? 'Agent 运行中 · 回到底部'
            : '回到底部'
      }
      badge={
        awayCount > 0
          ? { count: awayCount > 99 ? '99+' : awayCount, size: 'small' }
          : turnActive
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
      style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 12, zIndex: 10 }}
    />
  ) : null;
  const streamNode = (
    // 相对定位包裹层（聊天页 messageStream-wrap 同构）：浮标以此为定位祖先，恒浮
    // 于输入框正上方；ok 与 degraded/offline 两分支共用（内联于 streamNode）
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} ref={streamRef} onScroll={onStreamScroll}>
        {/* 内容层：padding/gap 自滚动容器移入（RO 观察本层高度，运行提示挂载等
            非 items 驱动的高度变化也能触发吸底）；视觉口径不变（padding 16/gap 14） */}
        <div ref={streamContentRef} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <AgentStreamView items={items} onRespond={handleRespond} active={turnActive} onShareTurn={embeddedConvId ? shareTurnToConv : undefined} />
        </div>
      </div>
      {scrollFab}
    </div>
  );

  // 会话输入区共用 props（底部横条 / 空会话居中浮卡同套：会话已存在，发送走
  // sendText；空会话居中=2026-11-23 用户口径「无聊天历史不沉底」，zcode 同款）
  const composerProps = {
    disabled: composerState.disabled,
    disabledHint: composerState.hint,
    canStop,
    onSend: (text: string) => void sendText(text),
    onStop: stopActive,
    commands: pluginCommands,
    statusInfo: (
      <ContextUsageMeter
        usage={activeSessionId ? usageBySession[activeSessionId] : undefined}
        modelHint={modelChoice.override}
      />
    ),
    modePicker: (
      <Dropdown menu={modeMenu} trigger={['click']}>
        <Button
          variant="secondary"
          size="small"
          icon={<ShieldCheck size={13} aria-hidden />}
          title="切换权限模式（本会话即时生效）"
        >
          {modeOption?.label ?? activeSession?.mode}
        </Button>
      </Dropdown>
    ),
    modelPicker: (
      <ModelThinkPicker providers={aiProviders} policy={modelTier} override={modelChoice.override} onSelect={onSelectModel} />
    ),
  };
  // 空会话居中输入（头部保留：标题/状态/回到聊天等照常可用）
  const emptyComposeNode = (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        向 Agent 描述一个任务试试（支持文件定位、命令执行与审批）
      </Typography.Text>
      <div style={{ width: '100%', maxWidth: 760 }}>
        <Composer {...composerProps} centered autoFocus />
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <AgentSubNav />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* 左：会话列表（六态）；整体可折叠成细条（会话多时让宽给中栏） */}
        <section
          style={{
            width: sessionsCollapsed ? 44 : sessionsResizable ? sessionsSplit.width : bp === 'S' ? 180 : 232,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: sessionsCollapsed ? 'center' : undefined,
            gap: sessionsCollapsed ? 6 : undefined,
            padding: sessionsCollapsed ? '8px 0' : undefined,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            minHeight: 0,
            background: token.colorBgContainer,
          }}
        >
          {sessionsCollapsed ? (
            <>
              <Button variant="text" icon={<PanelLeftOpen size={16} aria-hidden />} onClick={() => setSessionsCollapsed(false)} title="展开会话列表" />
              <Button variant="text" icon={<Plus size={16} aria-hidden />} onClick={handleNewTask} title="新建任务会话" />
            </>
          ) : listState === 'ok' ? (
            sessionListNode
          ) : (
            <StateView
              state={listState}
              skeleton={<SkeletonList count={6} />}
              error={new Error(sessionsError ?? '会话列表加载失败')}
              onRetry={() => void init()}
              offlineText="离线中：Agent 会话为本地能力，不受影响"
              degradedText={degradedText ?? undefined}
            >
              {sessionListNode}
            </StateView>
          )}
        </section>
        {sessionsResizable ? <SplitHandle bind={sessionsSplit.bind} /> : null}

        {/* 中：会话视图 / 新建会话页（/agent/new 懒创建——居中输入，无会话头/右坞） */}
        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* key=workspace：任务⇄项目/换项目即重挂——草稿文本与模式/模型选择不跨上下文
              带入；同上下文重复点 + URL 不变，草稿保留 */}
          {isCompose && composeWorkspace !== null ? (
            <AgentComposeView key={composeWorkspace} workspace={composeWorkspace} aiProviders={aiProviders} pluginCommands={pluginCommands} />
          ) : activeSession ? (
            <>
              <header
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 16px',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  minHeight: 52,
                  background: token.colorBgContainer,
                }}
              >
                <div
                  style={{ minWidth: 0, marginRight: 8 }}
                  title={activeSession.workspace || (embeddedConvId ? '聊天会话（IM 来源）· 无工作目录' : '任务会话 · 无工作目录')}
                >
                  <Typography.Text strong ellipsis style={{ display: 'block', maxWidth: 220, fontSize: 14 }}>
                    {activeSession.title}
                  </Typography.Text>
                  <Typography.Text type="secondary" ellipsis style={{ display: 'block', maxWidth: 220, fontSize: 12 }}>
                    {activeSession.workspace
                      ? `${workspaces.find((w) => w.path === activeSession.workspace)?.name ?? activeSession.workspace.split('/').filter(Boolean).pop()} · ${activeSession.workspace}`
                      : embeddedConvId
                        ? '聊天会话 · 无工作目录'
                        : '任务会话 · 无工作目录'}
                  </Typography.Text>
                </div>
                {/* 模式/模型选择 2026-11-11 挪入输入框（Composer）；头部只留状态 */}
                {/* 状态徽标（D11 §3 枚举中文） */}
                <Tag color={statusTagColor(activeSession.status)} style={{ flexShrink: 0 }}>
                  {SESSION_STATUS_LABELS[activeSession.status]}
                </Tag>
                <Flex align="center" gap={8} style={{ marginLeft: 'auto' }}>
                  {embeddedConvId ? (
                    <Button variant="text" onClick={() => navigate(`/im/c/${embeddedConvId}`)} title="回到来源聊天会话">
                      <MessageCircle size={12} aria-hidden />
                      回到聊天
                    </Button>
                  ) : null}
                  {/* 历史子任务（当前会话 run）：重启后子任务卡不在流里时的回看入口——
                      点行在右栏内容坞打开该 run 过程 tab（不进左栏、不占固定 tab） */}
                  {runs.length > 0 ? (
                    <Dropdown menu={{ ...historyMenu, style: { maxHeight: 420, overflowY: 'auto' } }} trigger={['click']} placement="bottomRight">
                      <Button variant="text" size="small" icon={<History size={14} aria-hidden />} title="历史子任务（本会话）">
                        历史子任务
                      </Button>
                    </Dropdown>
                  ) : null}
                  {/* 右栏内容坞收起态 → 展开入口（右上角）；运行中圆点提示。
                      展开态时收起按钮在内容坞 tab 条最右（AgentRightDock） */}
                  {dockVisible && dockCollapsed ? (
                    <Badge dot={dockRunning} offset={[-2, 2]}>
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => setDockCollapsed(false)}
                        title={dockRunning ? '展开右栏（有子任务运行中）' : '展开右栏'}
                        icon={<PanelRightOpen size={16} aria-hidden />}
                      />
                    </Badge>
                  ) : null}
                  {/* 「结束」已移除（2026-11-11 会话不死裁决）；「停止」唯一入口在
                      发送旁（2026-11-18 走查：头部与 Composer 重复展示退役） */}
                </Flex>
              </header>

              {streamState === 'empty' ? (
                emptyComposeNode
              ) : (
                <>
                  {streamState === 'ok' ? (
                    streamNode
                  ) : (
                    <StateView
                      state={streamState === 'none' ? 'empty' : streamState}
                      skeleton={<SkeletonStream count={5} />}
                      emptyText="从左侧选择或新建一个会话"
                      offlineText="离线中：Agent 会话为本地能力，不受影响"
                      degradedText={degradedText ?? undefined}
                    >
                      {streamNode}
                    </StateView>
                  )}

                  <Composer {...composerProps} />
                </>
              )}
            </>
          ) : streamState === 'loading' ? (
            <StateView state="loading" skeleton={<SkeletonStream count={5} />} />
          ) : (
            <StateView state="empty" emptyText="从左侧选择或新建一个会话" emptyAction={<Button onClick={handleNewTask}>新建任务会话</Button>} />
          )}
        </section>

        {/* 右：内容坞（D33 2026-11-19：无固定 tab、按当前会话归属/隔离；
            可拖宽 + 右上角收起；无 tab 时整坞不渲染） */}
        {showDock && activeSession ? <SplitHandle bind={dockSplit.bind} /> : null}
        {showDock && activeSession ? (
          <aside
            ref={dockSplit.paneRef}
            style={{
              width: dockSplit.width,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              overflow: 'hidden',
              minHeight: 0,
            }}
          >
            <AgentRightDock session={activeSession} runs={runs} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
