/**
 * PAG-01/02/03 Agent 工作台（/agent[/s/:sessionId]，D08 §3.1/§3.3）：
 * - 左：会话列表（窄栏 + 新建 + 二级导航入口）
 * - 中：会话视图（头部模式胶囊/状态徽标/暂停继续/紧急停止 + 会话流 + 输入区）
 * - 右：上下文栏（会话信息/检查点时间线/记忆侧写，可折叠）
 * - 会话流渲染：用户气泡 / 思考摘要折叠 / markdown 降级 / 工具卡 / 审批卡 / 系统行 / running 打点
 * - 六态：列表与中栏各自 StateView（forbidden 不适用于本域：页面准入权限点由设置域登记）
 * - offline：Agent 不依赖 WSS（D08 §1.3），mock 桥本地照常，仅提示
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Dropdown, Modal, type MenuProps } from 'antd';
import { Pause, Play, PanelRightClose, PanelRightOpen, ShieldCheck, Sparkles, Square } from 'lucide-react';
import { open as openDirectory } from '@tauri-apps/plugin-dialog';
import { Button } from '../../../shared/ui/Button';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList, SkeletonStream } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore, selectActiveSession, selectPendingPermissions, composerDisabledFor } from '../store/agent';
import type { StreamItem } from '../store/agent';
import { AGENT_MODE_OPTIONS, MODEL_TIER_LABELS, SESSION_STATUS_LABELS } from '../bridge/types';
import type { PermissionMode } from '../bridge/types';
import { fetchMeSettings, fetchMyProviders, fetchSharedProviders, type AIDefaultSetting } from '../../settings/api/ai';
import type { AIProvider } from '../../admin/model/types';
import { AgentSubNav } from '../components/AgentSubNav';
import { AgentSessionList } from '../components/AgentSessionList';
import { AgentContextSidebar } from '../components/AgentContextSidebar';
import { StreamMessage, ReasoningCollapse, UserMessage } from '../components/StreamMessage';
import { ToolCard } from '../components/ToolCard';
import { ToolGroup } from '../components/ToolGroup';
import { PermissionCard, type PermissionDecision } from '../components/PermissionCard';
import { SubagentCard } from '../components/SubagentCard';
import { DelegateCard } from '../components/DelegateCard';
import { TypingState } from '../components/TypingState';
import { Composer } from '../components/Composer';

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

/**
 * 会话流渲染（D19：连续 tool 条目归组为 ToolGroup 汇总条，其余条目保序单渲）。
 * 单条工具不套组条（直接 ToolCard，避免一次点击变两次）。
 */
function renderStreamItems(items: StreamItem[], onRespond: (d: PermissionDecision) => void): ReactNode[] {
  type ToolItem = Extract<StreamItem, { kind: 'tool' }>;
  const nodes: ReactNode[] = [];
  let toolRun: ToolItem[] = [];
  const flushTools = () => {
    if (toolRun.length === 0) return;
    if (toolRun.length === 1) {
      nodes.push(<ToolCard key={toolRun[0].key} item={toolRun[0]} />);
    } else {
      nodes.push(<ToolGroup key={`tg-${toolRun[0].key}`} items={toolRun} />);
    }
    toolRun = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') {
      toolRun.push(item);
      continue;
    }
    flushTools();
    switch (item.kind) {
      case 'user':
        nodes.push(<UserMessage key={item.key} text={item.text} />);
        break;
      case 'agentText':
        nodes.push(<StreamMessage key={item.key} text={item.text} streaming={item.streaming} />);
        break;
      case 'reasoning':
        nodes.push(<ReasoningCollapse key={item.key} text={item.text} streaming={item.streaming} />);
        break;
      case 'permission':
        nodes.push(<PermissionCard key={item.key} item={item} onRespond={onRespond} />);
        break;
      case 'subagent':
        nodes.push(<SubagentCard key={item.key} item={item} />);
        break;
      case 'delegate':
        nodes.push(<DelegateCard key={item.key} item={item} />);
        break;
      case 'system':
        nodes.push(
          <div key={item.key} className="agent-system-row">
            {item.text}
          </div>,
        );
        break;
      default:
        break;
    }
  }
  flushTools();
  return nodes;
}

export function AgentWorkbenchPage() {
  const { sessionId: routeSessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  /** 右栏上下文栏折叠态（PAG-01 E 区；L 档起可固定，M/S 浮层化的骨架阶段先做显隐） */
  const [sideOpen, setSideOpen] = useState(true);

  // ---- store 接线 ----
  const init = useAgentStore((s) => s.init);
  const bridgeKind = useAgentStore((s) => s.bridgeKind);
  const sessions = useAgentStore((s) => s.sessions);
  const sessionsLoading = useAgentStore((s) => s.sessionsLoading);
  const sessionsError = useAgentStore((s) => s.sessionsError);
  const createError = useAgentStore((s) => s.createError);
  const activeSessionId = useAgentStore((s) => s.activeSessionId);
  const selectSession = useAgentStore((s) => s.selectSession);
  const streams = useAgentStore((s) => s.streams);
  const checkpoints = useAgentStore((s) => s.checkpoints);
  const memories = useAgentStore((s) => s.memories);
  const modelBySession = useAgentStore((s) => s.modelBySession);
  const usageBySession = useAgentStore((s) => s.usageBySession);
  const runsBySession = useAgentStore((s) => s.runsBySession);
  const loadRuns = useAgentStore((s) => s.loadRuns);
  const startSession = useAgentStore((s) => s.startSession);
  const createSession = useAgentStore((s) => s.createSession);
  const workspaces = useAgentStore((s) => s.workspaces);
  const registerProject = useAgentStore((s) => s.registerProject);
  const sendText = useAgentStore((s) => s.sendText);
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const pauseActive = useAgentStore((s) => s.pauseActive);
  const resumeActive = useAgentStore((s) => s.resumeActive);
  const endActive = useAgentStore((s) => s.endActive);
  const emergencyStop = useAgentStore((s) => s.emergencyStop);
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

  // 路由 → store（/agent/s/:id 与列表点击双向同步）
  useEffect(() => {
    if (routeSessionId) selectSession(routeSessionId);
    return () => undefined;
  }, [routeSessionId, selectSession]);

  const activeSession = useAgentStore(selectActiveSession);
  const items = activeSessionId ? (streams[activeSessionId] ?? []) : [];
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
        <span className="agent-mode-menu__item">
          <span className="agent-mode-menu__name">{m.label}</span>
          <span className="agent-mode-menu__desc">{m.desc}</span>
        </span>
      ),
    })),
    onClick: ({ key }) => doSetMode(key as PermissionMode),
  };

  // ---- 滚动吸底（INT-AG-01 简版：距底 <40px 自动吸底；上滚即停随）----
  const streamRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const lastTickRef = useRef('');
  // 流内容签名：条数 + 尾项文本长度（流式增量驱动）
  const streamTick = `${items.length}:${items[items.length - 1]?.kind === 'agentText' || items[items.length - 1]?.kind === 'reasoning' ? (items[items.length - 1] as { text: string }).text.length : 0}`;
  useEffect(() => {
    if (streamTick === lastTickRef.current) return;
    lastTickRef.current = streamTick;
    const el = streamRef.current;
    if (!el) return;
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [streamTick]);
  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // ---- 动作 ----
  const handleSelect = (id: string) => {
    selectSession(id);
    stickBottomRef.current = true;
    navigate(`/agent/s/${id}`);
  };
  /** D19 新建日常对话（无工作目录；文件/命令类工具在该会话不可用） */
  const handleNewDaily = () => {
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
  };

  /** D19 打开项目目录：系统目录选择 → workspace.register → 项目会话 */
  const handleOpenProject = () => {
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
      await openProjectSession(dir);
    })();
  };

  /** 登记 + 在项目目录开会话（打开项目/项目行 + 共用） */
  const openProjectSession = async (path: string) => {
    const currentMode = activeSession?.mode ?? 'ask';
    try {
      await registerProject(path);
      const model = await resolveDefaultModel();
      const meta = await createSession({ workspace: path, mode: currentMode as PermissionMode, model });
      navigate(`/agent/s/${meta.id}`);
    } catch (err: unknown) {
      useAgentStore.setState({ createError: err instanceof Error ? err.message : String(err) });
    }
  };
  const handleRespond = (d: PermissionDecision) => {
    respondPermission(d.requestId, d.decision, d.scope, d.editedArgs);
  };

  const status = activeSession?.status;
  const canPause = status === 'running' || status === 'waiting_permission' || status === 'subagent_fanout' || status === 'delegating';
  const canResume = status === 'paused';
  const canStop = canPause || canResume;
  const modeOption = AGENT_MODE_OPTIONS.find((m) => m.value === activeSession?.mode);
  const modelChoice = (activeSessionId && modelBySession[activeSessionId]) || {
    policy: activeSession?.modelPolicy ?? 'auto',
    override: activeSession?.modelOverride,
  };
  const modelTier = modelChoice.policy;
  /** override 展示名：p:<id>:<model> → 模型尾段（供应商名由下拉菜单承载） */
  const overrideModel = modelChoice.override?.split(':')[2];

  // ---- 模型切换菜单（0023）：档位 + 公司供应商模型 + 我的供应商模型 ----
  const providerItems: MenuProps['items'] = useMemo(() => {
    const ofProvider = (label: string, p: AIProvider): NonNullable<MenuProps['items']> =>
      p.models.map((m) => ({
        key: `p:${p.id}:${m.id}`,
        label: `${label}${p.name} · ${m.label ? `${m.label}（${m.id}）` : m.id}`,
      }));
    const shared = aiProviders.shared.flatMap((p) => ofProvider('', p));
    const mine = aiProviders.mine.flatMap((p) => ofProvider('我的 · ', p));
    return [
      { key: 'tier:fast', label: '快 · bbw-fast（公司默认快档）' },
      { key: 'tier:strong', label: '强 · bbw-strong（公司默认强档）' },
      ...(shared.length > 0 ? [{ type: 'divider' as const }, { key: 'grp-shared', label: '公司供应商', disabled: true }, ...shared] : []),
      ...(mine.length > 0 ? [{ type: 'divider' as const }, { key: 'grp-mine', label: '我的供应商', disabled: true }, ...mine] : []),
    ];
  }, [aiProviders]);

  const onModelMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('tier:')) {
      switchModel(key.slice(5) as 'fast' | 'strong');
      return;
    }
    // p:<id>:<model> 直达引用（名义档位随当前；回执 modelSwitched 事件驱动 UI）
    switchModel(modelTier === 'fast' ? 'fast' : 'strong', key);
  };

  const modelMenu: MenuProps = { items: providerItems, onClick: onModelMenuClick };

  const sessionListNode = (
    <AgentSessionList
      sessions={sessions}
      workspaces={workspaces}
      activeId={activeSessionId}
      bridgeKind={bridgeKind}
      createError={createError}
      onSelect={handleSelect}
      onNewDaily={handleNewDaily}
      onOpenProject={handleOpenProject}
      onNewProjectSession={(path) => void openProjectSession(path)}
      onForgetProject={(id) => void useAgentStore.getState().forgetProject(id)}
    />
  );

  const streamNode = (
    <div className="agent-stream" ref={streamRef} onScroll={onStreamScroll}>
      {renderStreamItems(items, handleRespond)}
      {status === 'running' || status === 'starting' || status === 'subagent_fanout' || status === 'delegating' ? (
        <TypingState text={status === 'starting' ? '会话启动中' : 'Agent 正在处理'} />
      ) : null}
    </div>
  );

  return (
    <div className="agent-page">
      <AgentSubNav />
      <div className="agent-workbench">
        {/* 左：会话列表（六态） */}
        <section className="agent-sessions">
          {listState === 'ok' ? (
            sessionListNode
          ) : (
            <StateView
              state={listState}
              skeleton={<SkeletonList count={6} />}
              error={new Error(sessionsError ?? '会话列表加载失败')}
              onRetry={() => void init()}
              emptyText="从一个任务开始，或打开一个项目目录"
              emptyAction={
                <Button onClick={handleNewDaily}>
                  <Square size={12} aria-hidden />
                  新建日常对话
                </Button>
              }
              offlineText="离线中：Agent 会话为本地能力，不受影响"
              degradedText={degradedText ?? undefined}
            >
              {sessionListNode}
            </StateView>
          )}
        </section>

        {/* 中：会话视图 */}
        <section className="agent-main">
          {activeSession ? (
            <>
              <header className="agent-header">
                <div className="agent-header__title-wrap" title={activeSession.workspace || '日常对话（无工作目录）'}>
                  <div className="agent-header__title">{activeSession.title}</div>
                  <div className="agent-header__sub">
                    {activeSession.workspace
                      ? `${workspaces.find((w) => w.path === activeSession.workspace)?.name ?? activeSession.workspace.split('/').filter(Boolean).pop()} · ${activeSession.workspace}`
                      : '日常对话 · 无工作目录'}
                  </div>
                </div>
                {/* 模式切换胶囊（PAG-07） */}
                <Dropdown menu={modeMenu} trigger={['click']}>
                  <button type="button" className="agent-mode-capsule" title="切换权限模式（本会话即时生效）">
                    <ShieldCheck size={13} aria-hidden />
                    {modeOption?.label ?? activeSession.mode}
                  </button>
                </Dropdown>
                {/* 模型选择（0023：档位别名或供应商模型直达引用；会话内即时切换） */}
                <Dropdown menu={modelMenu} trigger={['click']}>
                  <button type="button" className="agent-model-chip" title="切换模型（档位=公司默认路由；供应商模型=直达引用）">
                    <Sparkles size={13} aria-hidden /> {overrideModel ? `模型 ${overrideModel}` : `模型 ${MODEL_TIER_LABELS[modelTier]}`}
                  </button>
                </Dropdown>
                {/* 状态徽标（D11 §3 枚举中文） */}
                <span className={`agent-status-badge agent-status-badge--${activeSession.status}`}>
                  <i className="agent-status-badge__dot" aria-hidden />
                  {SESSION_STATUS_LABELS[activeSession.status]}
                </span>
                <div className="agent-header__actions">
                  {canPause ? (
                    <Button variant="secondary" onClick={pauseActive} title="暂停当前会话">
                      <Pause size={12} aria-hidden />
                      暂停
                    </Button>
                  ) : null}
                  {canResume ? (
                    <Button variant="secondary" onClick={resumeActive} title="继续当前会话">
                      <Play size={12} aria-hidden />
                      继续
                    </Button>
                  ) : null}
                  {activeSession.status !== 'ended' ? (
                    <Button variant="text" onClick={endActive} title="结束会话（保留事件镜像）">
                      结束
                    </Button>
                  ) : null}
                  {canStop ? (
                    <Button variant="danger" onClick={emergencyStop} title="紧急停止：杀进程组并作废未决审批（⌘⇧.）">
                      <Square size={12} aria-hidden />
                      紧急停止
                    </Button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setSideOpen((v) => !v)}
                    title={sideOpen ? '收起上下文栏' : '展开上下文栏'}
                  >
                    {sideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                  </button>
                </div>
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
                onEmergencyStop={emergencyStop}
              />
            </>
          ) : streamState === 'loading' ? (
            <StateView state="loading" skeleton={<SkeletonStream count={5} />} />
          ) : (
            <StateView state="empty" emptyText="从左侧选择或新建一个会话" emptyAction={<Button onClick={handleNewDaily}>新建日常对话</Button>} />
          )}
        </section>

        {/* 右：上下文栏（可折叠） */}
        {activeSession && sideOpen ? (
          <aside className="agent-side-col">
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
