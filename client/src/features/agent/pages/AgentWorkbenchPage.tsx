/**
 * PAG-01/02/03 Agent 工作台（/agent[/s/:sessionId]，D08 §3.1/§3.3）：
 * - 左：会话列表（窄栏 + 新建 + 二级导航入口）
 * - 中：会话视图（头部状态徽标 + 会话流 + 输入区；停止唯一入口=发送旁）
 * - 右：上下文栏（会话信息/检查点时间线/记忆侧写，可折叠）
 * - 会话流渲染（2026-11-17 D33 平铺流）：无气泡全宽消息流——用户消息平铺块 +
 *   类型化过程块（思考/工具族/技能/审批/子任务/中间正文），收口折叠一行统计，
 *   最终回答常开（AgentStreamView/TurnBlock；回合气泡/AgentProcessCard 归 IM 专用）
 * - 六态：列表与中栏各自 StateView（forbidden 不适用于本域：页面准入权限点由设置域登记）
 * - offline：Agent 不依赖 WSS（D08 §1.3），mock 桥本地照常，仅提示
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Dropdown, Flex, Modal, Tag, Typography, theme, type MenuProps } from 'antd';
import { MessageCircle, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, ShieldCheck, Square } from 'lucide-react';
import { open as openDirectory } from '@tauri-apps/plugin-dialog';
import { Button } from '../../../shared/ui/Button';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore, selectActiveSession, selectPendingPermissions, composerDisabledFor, type StreamItem } from '../store/agent';
import { AGENT_MODE_OPTIONS, SESSION_STATUS_LABELS } from '../bridge/types';
import type { PermissionMode } from '../bridge/types';
import { fetchMeSettings, fetchMyProviders, fetchSharedProviders, type AIDefaultSetting } from '../../settings/api/ai';
import type { AIProvider } from '../../admin/model/types';
import { AgentSubNav } from '../components/AgentSubNav';
import { AgentSessionList } from '../components/AgentSessionList';
import { AgentContextSidebar } from '../components/AgentContextSidebar';
import { AgentStreamView } from '../components/stream/AgentStreamView';
import type { PermissionDecision } from '../components/PermissionCard';
import { ModelThinkPicker } from '../components/ModelThinkPicker';
import { convIdOfSession } from '../../im/agent/embedded';
import { Composer } from '../components/Composer';
import { fetchPluginCommands, type PluginCommand } from '../../eco/api/plugins';

/** ai_default → 会话 model 直达引用（mode=org/解析失败 → undefined=档位别名） */
async function resolveDefaultModel(): Promise<string | undefined> {
  try {
    const settings = await fetchMeSettings();
    const ai = settings.ai_default as AIDefaultSetting | undefined;
    if (ai?.mode === 'provider' && ai.providerId && ai.model) return `p:${ai.providerId}:${ai.model}`;
  } catch {
    /* mock 桥/未登录：回落档位 */
  }
  return undefined;
}

/** 回合进行中的会话状态集（回合气泡 active 判定） */
const TURN_ACTIVE_STATUSES = new Set<string>(['running', 'waiting_permission', 'waiting_clarify', 'waiting_review', 'subagent_fanout', 'delegating']);

/** 空流常量（selector 稳定返回：无会话/无条目时不随渲染新建引用） */
const EMPTY_ITEMS: StreamItem[] = [];

/** 会话状态徽标色（原 agent-status-badge--* 口径：运行=绿/等待=橙/错误=红/其余灰） */
function statusTagColor(status: string): string | undefined {
  if (status === 'running' || status === 'subagent_fanout' || status === 'delegating') return 'success';
  if (status === 'waiting_permission' || status === 'waiting_review' || status === 'waiting_clarify' || status === 'starting') return 'warning';
  if (status === 'error') return 'error';
  return undefined;
}

export function AgentWorkbenchPage() {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  /** 右栏上下文栏折叠态（PAG-01 E 区；L 档起可固定，M/S 浮层化的骨架阶段先做显隐） */
  const [sideOpen, setSideOpen] = useState(true);
  // 插件斜杠命令表（D22/L5：/ 渲染；失败降级空=功能关闭）
  const [pluginCommands, setPluginCommands] = useState<PluginCommand[]>([]);
  useEffect(() => {
    void fetchPluginCommands().then(setPluginCommands);
  }, []);
  /** 左栏会话列表整体折叠（2026-11-11：会话多时可让宽给中栏；项目内会话另有自身折叠） */
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  // 左栏拖拽调宽（未折叠且 L/XL 生效——M 档媒体查询收窄 56px 图标条，内联宽度会击穿须让位）
  const sessionsSplit = useSplitWidth('agent-sessions', 232, 180, 360);
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
  const checkpoints = useAgentStore((s) => s.checkpoints);
  const memories = useAgentStore((s) => s.memories);
  const modelBySession = useAgentStore((s) => s.modelBySession);
  const usageBySession = useAgentStore((s) => s.usageBySession);
  const runsBySession = useAgentStore((s) => s.runsBySession);
  const loadRuns = useAgentStore((s) => s.loadRuns);
  const taskRuns = useAgentStore((s) => s.taskRuns);
  const loadTaskRuns = useAgentStore((s) => s.loadTaskRuns);
  const startSession = useAgentStore((s) => s.startSession);
  const createSession = useAgentStore((s) => s.createSession);
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
    loadTaskRuns(); // 任务分区全量（后续随 run 生命周期事件增量刷新）
  }, [init, loadTaskRuns]);

  // 路由 → store（/agent/s/:id 与列表点击双向同步）
  useEffect(() => {
    if (routeSessionId) selectSession(routeSessionId);
    return () => undefined;
  }, [routeSessionId, selectSession]);

  const activeSession = useAgentStore(selectActiveSession);
  // 只订当前会话的流数组（2026-11-11 卡顿修复）：此前订阅整个 streams record，
  // 任何会话（含后台 embedded）每个 delta 都整页重渲；selector 现仅取本会话数组
  // 引用（O(1)），其它会话的更新不再波及本页
  const items = useAgentStore((s) => (s.activeSessionId ? s.streams[s.activeSessionId] : undefined)) ?? EMPTY_ITEMS;
  // D33：运行详情（右栏 aside 宽度随其激活加宽；侧栏自身订阅过程流数据）
  const activeRunView = useAgentStore((s) => s.activeRunView);
  const runs = activeSessionId ? (runsBySession[activeSessionId] ?? []) : [];

  // run 面板数据（D16 §3.1）：会话切换时拉取；生命周期事件触发的刷新在 store 内
  useEffect(() => {
    if (activeSessionId) loadRuns(activeSessionId);
  }, [activeSessionId, loadRuns]);
  const pendingPerms = useMemo(() => selectPendingPermissions(items), [items]);
  const composerState = composerDisabledFor(activeSession?.status);

  // ---- 六态推导（列表栏）----
  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);
  const listState: ViewState | 'ok' = sessionsLoading
    ? 'loading'
    : sessionsError
      ? 'error'
      : sessions.length === 0
        ? 'empty'
        : degradedText
          ? 'degraded'
          : connStatus === 'offline'
            ? 'offline'
            : 'ok';

  // 中栏态：路由带 id 但会话不存在（未加载完 or 非法）→ loading；未选会话 → 空态引导
  const streamState: ViewState | 'ok' | 'none' = !activeSessionId
    ? 'none'
    : routeSessionId && !activeSession
      ? 'loading'
      : items.length === 0
        ? 'empty'
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

  // ---- 滚动吸底（INT-AG-01 简版：距底 <40px 自动吸底；上滚即停随）----
  // 2026-11-18 二修：弃 streamTick 签名（条数+尾项文本长度——运行提示 TypingState/
  // 思考 ticker 的挂载不改变 items，签名不变即不吸底，回合启动窗口期的「思考中…」
  // 提示留在折叠线以下被裁掉）→ ResizeObserver 观察内容层实际高度：任何增高
  // （流式 delta/运行提示挂载/卡片展开）stick 时吸底
  const streamRef = useRef<HTMLDivElement>(null);
  const streamContentRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
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
  }, []);
  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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
  /** 新建任务会话（无工作目录；文件/命令类工具在该会话不可用）。workspace='' 且
   *  非 IM 来源——左栏落「任务」区（2026-11-17 分区口径，此前误落日常对话区） */
  const handleNewTask = useCallback(() => {
    const currentMode = activeSession?.mode ?? 'ask';
    void resolveDefaultModel()
      .then((model) => startSession(currentMode, model))
      .then(() => {
        const sid = useAgentStore.getState().activeSessionId;
        if (sid) navigate(`/agent/s/${sid}`);
      })
      .catch((err: unknown) => {
        // bbrt 缺失/握手超时/RT 错误回执（如 8001 活跃会话超限）——列表顶部提示
        useAgentStore.setState({ createError: err instanceof Error ? err.message : String(err) });
      });
  }, [activeSession?.mode, startSession, navigate]);

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

  /** 登记 + 在项目目录开会话（打开项目/项目行 + 共用；经 ref 解循环依赖） */
  const openProjectSessionRef = useRef<(path: string) => Promise<void>>(async () => undefined);
  openProjectSessionRef.current = async (path: string) => {
    const currentMode = useAgentStore.getState().sessions.find((s) => s.id === useAgentStore.getState().activeSessionId)?.mode ?? 'ask';
    try {
      await registerProject(path);
      const model = await resolveDefaultModel();
      const meta = await createSession({ workspace: path, mode: currentMode as PermissionMode, model });
      navigate(`/agent/s/${meta.id}`);
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
  const canStop = status === 'running' || status === 'waiting_permission' || status === 'waiting_clarify' || status === 'subagent_fanout' || status === 'delegating';
  const modeOption = AGENT_MODE_OPTIONS.find((m) => m.value === activeSession?.mode);
  const modelChoice = (activeSessionId && modelBySession[activeSessionId]) || {
    policy: activeSession?.modelPolicy ?? 'auto',
    override: activeSession?.modelOverride,
  };
  const modelTier = modelChoice.policy;

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
      runs={taskRuns}
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
  const streamNode = (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} ref={streamRef} onScroll={onStreamScroll}>
      {/* 内容层：padding/gap 自滚动容器移入（RO 观察本层高度，运行提示挂载等
          非 items 驱动的高度变化也能触发吸底）；视觉口径不变（padding 16/gap 14） */}
      <div ref={streamContentRef} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <AgentStreamView items={items} onRespond={handleRespond} active={turnActive} />
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
              emptyText="从任务区新建，或打开一个项目目录"
              emptyAction={
                <Button onClick={handleNewTask}>
                  <Square size={12} aria-hidden />
                  新建任务会话
                </Button>
              }
              offlineText="离线中：Agent 会话为本地能力，不受影响"
              degradedText={degradedText ?? undefined}
            >
              {sessionListNode}
            </StateView>
          )}
        </section>
        {sessionsResizable ? <SplitHandle bind={sessionsSplit.bind} /> : null}

        {/* 中：会话视图 */}
        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {activeSession ? (
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
                  {/* 「结束」已移除（2026-11-11 会话不死裁决）；「停止」唯一入口在
                      发送旁（2026-11-18 走查：头部与 Composer 重复展示退役） */}
                  <Button
                    variant="text"
                    size="small"
                    onClick={() => setSideOpen((v) => !v)}
                    title={sideOpen ? '收起上下文栏' : '展开上下文栏'}
                    icon={sideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                  />
                </Flex>
              </header>

              {streamState === 'ok' ? (
                streamNode
              ) : streamState === 'empty' ? (
                <StateView state="empty" emptyText="向 Agent 描述一个任务试试（支持文件定位、命令执行与审批）" />
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

              <Composer
                disabled={composerState.disabled}
                disabledHint={composerState.hint}
                canStop={canStop}
                onSend={(text) => void sendText(text)}
                onStop={stopActive}
                commands={pluginCommands}
                modePicker={
                  <Dropdown menu={modeMenu} trigger={['click']}>
                    <Button
                      variant="secondary"
                      size="small"
                      icon={<ShieldCheck size={13} aria-hidden />}
                      title="切换权限模式（本会话即时生效）"
                    >
                      {modeOption?.label ?? activeSession.mode}
                    </Button>
                  </Dropdown>
                }
                modelPicker={
                  <ModelThinkPicker providers={aiProviders} policy={modelTier} override={modelChoice.override} onSelect={onSelectModel} />
                }
              />
            </>
          ) : streamState === 'loading' ? (
            <StateView state="loading" skeleton={<SkeletonStream count={5} />} />
          ) : (
            <StateView state="empty" emptyText="从左侧选择或新建一个会话" emptyAction={<Button onClick={handleNewTask}>新建任务会话</Button>} />
          )}
        </section>

        {/* 右：上下文栏（可折叠；D33 运行详情激活时加宽至 480 承载过程流） */}
        {activeSession && sideOpen ? (
          <aside
            style={{
              width: activeRunView ? 480 : 304,
              flexShrink: 0,
              borderLeft: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              overflowY: 'auto',
              minHeight: 0,
            }}
          >
            <AgentContextSidebar
              session={activeSession}
              model={modelTier}
              checkpoints={activeSessionId ? (checkpoints[activeSessionId] ?? []) : []}
              memories={memories}
              usage={activeSessionId ? usageBySession[activeSessionId] : undefined}
              pendingCount={pendingPerms.length}
              runs={runs}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
