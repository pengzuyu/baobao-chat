/**
 * Agent feature store（模块 UI 态，D01 §12.2-5 / D08 §8）：
 * - 会话列表 / 当前会话事件流（按序追加的端内投影）/ 状态机投影（session.state 驱动）
 * - 未决审批（requestId → 倒计时/结果；120s 到点置灰=拒绝）
 * - 知识记忆条目 / 日报列表（D15 双轨）
 * - handleEvent() 为唯一事件入口（reducer 式分发；数据源 = bridge.onEvent）
 */

import { create } from 'zustand';
import { getAgentBridge } from '../bridge';
import { notifyAgentDone, reportAgentTask, workbenchVisible } from '../bridge/notify';
import type {
  AgentEvent,
  AgentReport,
  AgentSessionMeta,
  AgentWorkspaceInfo,
  RunInfo,
  GrantScope,
  MemoryEntry,
  PermissionMode,
  SessionStatus,
} from '../bridge/types';

/** 会话流条目（UI 投影模型；stream.delta 增量拼进 agentText/reasoning 尾项） */
export type StreamItem =
  | { kind: 'user'; key: string; text: string; ts: number }
  | { kind: 'agentText'; key: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      call: Extract<AgentEvent, { type: 'toolCall' }>;
      result?: Extract<AgentEvent, { type: 'toolResult' }>;
    }
  | {
      kind: 'permission';
      key: string;
      request: Extract<AgentEvent, { type: 'permissionRequest' }>;
      /** null=等待中；'timeout'=120s 到点（灰显=拒绝）；对象=已决策 */
      outcome: null | 'timeout' | { decision: 'allow' | 'deny' | 'cancelled'; scope?: GrantScope; at: number };
    }
  /** 子 Agent 卡（D16 类型 1；runId=持久 r-{seq}，状态由 subagent.event 驱动） */
  | {
      kind: 'subagent';
      key: string;
      runId: string;
      taskDigest: string;
      status: 'running' | 'done' | 'failed';
      summary?: string;
    }
  /** 委派卡（D16 类型 3：brief 待确认 → running 后台 → review 审查 → resolved 终态） */
  | {
      kind: 'delegate';
      key: string;
      runId: string;
      backend: string;
      phase: 'brief' | 'running' | 'review' | 'resolved';
      /** 后端输出尾部行（output/delta；≤50 行滚动窗） */
      logs: string[];
      end?: Extract<AgentEvent, { type: 'delegateEnd' }>;
      decision?: 'accept' | 'reject';
    }
  | { kind: 'system'; key: string; text: string };

/** 检查点（checkpoint.created 投影，右栏时间线） */
export interface CheckpointItem {
  id: string;
  reason: string;
  filesChanged: string[];
  createdAt: number;
}

interface AgentState {
  /** 桥类型（mock=本地剧本 / tauri=真实宿主） */
  bridgeKind: 'mock' | 'tauri';
  /** init 已完成（事件订阅 + 首屏数据拉取） */
  ready: boolean;

  sessions: AgentSessionMeta[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  /** 新建会话失败提示（bbrt 缺失/超时/超限；下次成功即清） */
  createError: string | null;
  activeSessionId: string | null;

  /** sessionId → 事件流（按序追加） */
  streams: Record<string, StreamItem[]>;
  /** sessionId → 检查点栈（新→旧） */
  checkpoints: Record<string, CheckpointItem[]>;
  /** sessionId → 当前模型选择（model.switched 维护；override=直达引用 p:<id>:<model>） */
  modelBySession: Record<string, { policy: 'fast' | 'strong' | 'auto'; override?: string }>;
  /** sessionId → 最近一轮用量（stream.done usage） */
  usageBySession: Record<string, { in: number; out: number }>;
  /** sessionId → run 记录（D16 §3.1 runs.list；子任务生命周期事件触发刷新） */
  runsBySession: Record<string, RunInfo[]>;

  memories: MemoryEntry[];
  memoriesLoading: boolean;
  memoriesError: string | null;
  /** D19 当前记忆视图作用域（记忆页页签驱动；user=用户级 / project=项目级） */
  memoryScope: 'user' | 'project';
  /** D19 项目记忆视图的当前项目路径（scope=project 时有效） */
  memoryWorkspacePath: string | null;

  /** D19 项目登记表（workspace.list；last_opened_at 倒序） */
  workspaces: AgentWorkspaceInfo[];
  workspacesLoading: boolean;

  reports: AgentReport[];
  reportsLoading: boolean;
  reportsError: string | null;

  // ---- 动作 ----
  init: () => Promise<void>;
  selectSession: (sessionId: string | null) => void;
  startSession: (mode: PermissionMode, model?: string) => Promise<void>;
  /** 显式建会话并返回 meta（D18 内嵌卡：不切换 activeSessionId 之外还供 im 侧直接持有引用） */
  createSession: (opts?: { workspace?: string; mode?: PermissionMode; model?: string }) => Promise<import('../bridge/types').AgentSessionMeta>;
  /** 定向发送（D18：embedded 会话由 im 侧显式指定 sessionId，不依赖 activeSessionId） */
  sendTextTo: (sessionId: string, text: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope?: GrantScope, editedArgs?: Record<string, unknown>) => void;
  /** 确认委派启动（简报卡；乐观置 running，真实状态由 delegate.event 驱动） */
  confirmDelegate: (runId: string, backend: string) => void;
  /** 委派审查结论（审查卡；乐观置 resolved） */
  reviewDelegate: (runId: string, accept: boolean) => void;
  /** 取消委派（简报期/后台运行/审查期） */
  cancelDelegate: (runId: string) => void;
  /** 运行中子任务补充指令（D16 决策⑧：探查/专家/委派通用——delegate.input 通道） */
  sendRunInput: (runId: string, text: string) => void;
  /** 运行中子任务取消（探查/专家/委派通用） */
  cancelRun: (runId: string) => void;
  pauseActive: () => void;
  resumeActive: () => void;
  endActive: () => void;
  emergencyStop: () => void;
  setMode: (mode: PermissionMode) => void;
  /** 会话内切换模型（model=直达引用；缺省=档位；回执 modelSwitched 事件驱动 UI） */
  switchModel: (to: 'fast' | 'strong' | 'auto', model?: string) => void;
  deleteMemory: (name: string, scope?: 'user' | 'project', workspacePath?: string) => Promise<void>;
  /** D19 切换记忆视图作用域并拉取（记忆页页签；project 需项目路径） */
  loadMemories: (scope?: 'user' | 'project', workspacePath?: string | null) => Promise<void>;
  /** D19 拉取项目登记表 */
  loadWorkspaces: () => Promise<void>;
  /** D19 登记项目（workspace.register：realpath upsert；返回登记行） */
  registerProject: (path: string, name?: string) => Promise<AgentWorkspaceInfo>;
  /** D19 移除项目登记（只删登记，不动会话/记忆分区） */
  forgetProject: (id: string) => Promise<void>;
  /** 拉取会话 run 记录（D16 §3.1 run 面板） */
  loadRuns: (sessionId: string) => void;
  /** 事件唯一入口（reducer 式分发；包一层便于桥接入） */
  handleEvent: (event: AgentEvent) => void;
}

// ---- 模块级：桥实例 / 订阅守卫 / 审批超时计时器 / 流水 key 计数 ----
const bridge = getAgentBridge();
let subscribed = false;

/** requestId → 120s 到点计时器（到点置 timeout=拒绝语义，D08 §3.4） */
const permTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERMISSION_TIMEOUT_MS = 120_000;

let itemSeq = 0;
function nextKey(prefix: string): string {
  itemSeq += 1;
  return `${prefix}-${itemSeq}`;
}

/** 定位并修补当前会话流内的委派卡（动作乐观更新；真实状态由事件驱动覆盖） */
function patchDelegateCard(
  get: () => AgentState,
  set: (fn: (s: AgentState) => Partial<AgentState>) => void,
  runId: string,
  patch: (it: Extract<StreamItem, { kind: 'delegate' }>) => Extract<StreamItem, { kind: 'delegate' }>,
) {
  const sid = get().activeSessionId;
  if (!sid) return;
  set((s) => ({
    streams: {
      ...s.streams,
      [sid]: (s.streams[sid] ?? []).map((it) => (it.kind === 'delegate' && it.runId === runId ? patch(it) : it)),
    },
  }));
}


function touchSession(sessions: AgentSessionMeta[], sessionId: string, patch: Partial<AgentSessionMeta>): AgentSessionMeta[] {
  return sessions.map((s) => (s.id === sessionId ? { ...s, ...patch, updatedAt: Date.now() } : s));
}

/** 追加/合并流式增量：尾部同 channel 且未闭合 → 拼接；切换 channel 时闭合上一段（如 reasoning→正文） */
function appendDelta(items: StreamItem[], channel: 'text' | 'reasoning', delta: string, done: boolean): StreamItem[] {
  const kind = channel === 'reasoning' ? 'reasoning' : 'agentText';
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    const next = [...items];
    next[next.length - 1] = { ...last, text: last.text + delta, streaming: !done };
    return next;
  }
  // 正文开始 → 闭合仍在流式中的思考摘要（或反之）
  const closed = items.map((it) =>
    (it.kind === 'agentText' || it.kind === 'reasoning') && it.kind !== kind && it.streaming ? { ...it, streaming: false } : it,
  );
  return [...closed, { kind, key: nextKey(kind), text: delta, streaming: !done }];
}

/** 关闭尾部未闭合的流式条目（stream.done） */
function closeStreaming(items: StreamItem[]): StreamItem[] {
  const last = items[items.length - 1];
  if (last && (last.kind === 'agentText' || last.kind === 'reasoning') && last.streaming) {
    const next = [...items];
    next[next.length - 1] = { ...last, streaming: false };
    return next;
  }
  return items;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  bridgeKind: bridge.kind,
  ready: false,

  sessions: [],
  sessionsLoading: false,
  sessionsError: null,
  createError: null,
  activeSessionId: null,

  streams: {},
  checkpoints: {},
  modelBySession: {},
  usageBySession: {},
  runsBySession: {},

  memories: [],
  memoriesLoading: false,
  memoryScope: 'user',
  memoryWorkspacePath: null,
  workspaces: [],
  workspacesLoading: false,
  memoriesError: null,

  reports: [],
  reportsLoading: false,
  reportsError: null,

  init: async () => {
    // 事件订阅只装一次（页面切换不重复）
    if (!subscribed) {
      subscribed = true;
      bridge.onEvent((event) => useAgentStore.getState().handleEvent(event));
    }
    if (get().ready || get().sessionsLoading) return;

    set({ sessionsLoading: true, sessionsError: null, memoriesLoading: true, reportsLoading: true });
    try {
      const sessions = await bridge.listSessions();
      set({ sessions, sessionsLoading: false, ready: true });
    } catch (err) {
      set({ sessionsLoading: false, sessionsError: err instanceof Error ? err.message : '会话列表加载失败', ready: true });
    }
    void bridge
      .listMemories()
      .then((memories) => set({ memories, memoriesLoading: false }))
      .catch((err: unknown) => set({ memoriesLoading: false, memoriesError: err instanceof Error ? err.message : '记忆加载失败' }));
    void bridge
      .listReports()
      .then((reports) => set({ reports, reportsLoading: false }))
      .catch((err: unknown) => set({ reportsLoading: false, reportsError: err instanceof Error ? err.message : '日报加载失败' }));
    // D19 项目登记表（左栏项目区数据源；失败静默——会话 workspace 路径兜底展示）
    void get().loadWorkspaces();
  },

  selectSession: (sessionId) => set({ activeSessionId: sessionId }),

  createSession: async (opts) => {
    // D19：workspace 缺省=日常对话（空串，无工作目录——文件/命令类工具不可用，
    // 记忆恒用户级）；项目会话由 openProject 传入目录。
    // model=用户默认模型的直达引用（settings.ai_default 解析，0023；缺省=档位别名）
    const meta = await bridge.startSession(opts?.workspace ?? '', opts?.mode ?? 'ask', opts?.model);
    set((s) => ({
      createError: null,
      sessions: [meta, ...s.sessions],
      activeSessionId: meta.id,
      modelBySession: { ...s.modelBySession, [meta.id]: { policy: meta.modelPolicy, override: meta.modelOverride } },
    }));
    return meta;
  },

  startSession: async (mode, model) => {
    await get().createSession({ mode, model });
  },

  sendTextTo: async (sid, text) => {
    if (!sid || !text.trim()) return;
    // 乐观上屏（与 sendText 同款；embedded 会话在 im 聊天卡消费，工作台打开时同样可见）
    set((s) => ({
      streams: { ...s.streams, [sid]: [...(s.streams[sid] ?? []), { kind: 'user', key: nextKey('u'), text, ts: Date.now() }] },
      sessions: touchSession(s.sessions, sid, {}),
    }));
    await bridge.sendMessage(sid, text);
  },

  sendText: async (text) => {
    const sid = get().activeSessionId;
    if (!sid || !text.trim()) return;
    // 乐观上屏（D08：agent_input 发送后 UI 乐观追加）
    set((s) => ({
      streams: { ...s.streams, [sid]: [...(s.streams[sid] ?? []), { kind: 'user', key: nextKey('u'), text, ts: Date.now() }] },
      sessions: touchSession(s.sessions, sid, {}),
    }));
    await bridge.sendMessage(sid, text);
  },

  respondPermission: (requestId, decision, scope, editedArgs) => {
    const timer = permTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      permTimers.delete(requestId);
    }
    // 卡片终态先落（权限响应镜像到达后幂等覆盖）；按 requestId 全流扫描——
    // D18 内嵌卡：embedded 会话往往不是 activeSessionId，不能只写当前会话
    set((s) => {
      const next: typeof s.streams = {};
      for (const [sid, list] of Object.entries(s.streams)) {
        next[sid] = list.map((it) =>
          it.kind === 'permission' && it.request.requestId === requestId && it.outcome === null
            ? { ...it, outcome: { decision, scope, at: Date.now() } }
            : it,
        );
      }
      return { streams: next };
    });
    void bridge.respondPermission(requestId, decision, scope, editedArgs).catch(() => undefined);
  },

  confirmDelegate: (runId, backend) => {
    // 乐观置 running（真实流转由 delegate.event/output 驱动；120s 未确认 RT 侧自弃）
    patchDelegateCard(get, set, runId, (it) => ({ ...it, phase: 'running' }));
    const sid = get().activeSessionId;
    if (sid) void bridge.launchDelegate(sid, runId, backend).catch(() => undefined);
  },

  reviewDelegate: (runId, accept) => {
    patchDelegateCard(get, set, runId, (it) => ({ ...it, phase: 'resolved', decision: accept ? 'accept' : 'reject' }));
    void bridge.reviewDelegate(runId, accept).catch(() => undefined);
  },

  cancelDelegate: (runId) => {
    // 乐观置 resolved（终态展示"已取消"；RT 侧 delegate.cancel → cancelled run）
    patchDelegateCard(get, set, runId, (it) => (it.phase === 'brief' ? { ...it, phase: 'resolved' } : it));
    void bridge.cancelDelegate(runId).catch(() => undefined);
  },

  sendRunInput: (runId, text) => {
    if (!text.trim()) return;
    void bridge.delegateInput(runId, text.trim()).catch(() => undefined);
  },

  cancelRun: (runId) => {
    void bridge.cancelDelegate(runId).catch(() => undefined);
  },

  pauseActive: () => {
    const sid = get().activeSessionId;
    if (sid) void bridge.pause(sid).catch(() => undefined);
  },
  resumeActive: () => {
    const sid = get().activeSessionId;
    if (sid) void bridge.resume(sid).catch(() => undefined);
  },
  endActive: () => {
    const sid = get().activeSessionId;
    if (sid) void bridge.endSession(sid).catch(() => undefined);
  },
  emergencyStop: () => {
    void bridge.emergencyStop().catch(() => undefined);
  },

  setMode: (mode) => {
    const sid = get().activeSessionId;
    if (!sid) return;
    set((s) => ({
      sessions: touchSession(s.sessions, sid, { mode }),
      // 时间线落一行系统提示（D08 PAG-07 切换即时生效 + 提示）
      streams: {
        ...s.streams,
        [sid]: [...(s.streams[sid] ?? []), { kind: 'system', key: nextKey('sys'), text: `权限模式已切换：${mode}` }],
      },
    }));
    void bridge.setMode(sid, mode).catch(() => undefined);
  },

  switchModel: (to, model) => {
    const sid = get().activeSessionId;
    if (!sid) return;
    // 状态更新与时间线提示以 modelSwitched 回执事件驱动（与 Runtime 口径一致）
    void bridge.switchModel(sid, to, model).catch(() => undefined);
  },

  deleteMemory: async (name, scope, workspacePath) => {
    // 乐观移除 + 桥删除（PAG-11 撤销，即时生效；D19 作用域参数随当前视图）
    const effScope = scope ?? get().memoryScope;
    const effPath = workspacePath ?? get().memoryWorkspacePath;
    set((s) => ({ memories: s.memories.filter((m) => m.name !== name) }));
    await bridge.deleteMemory(name, effScope, effPath ?? undefined).catch(() => undefined);
  },

  loadMemories: async (scope, workspacePath) => {
    const effScope = scope ?? get().memoryScope;
    const effPath = workspacePath === undefined ? get().memoryWorkspacePath : workspacePath;
    set({ memoriesLoading: true, memoriesError: null, memoryScope: effScope, memoryWorkspacePath: effPath ?? null });
    await bridge
      .listMemories(effScope, effPath ?? undefined)
      .then((memories) => set({ memories, memoriesLoading: false }))
      .catch((err: unknown) =>
        set({ memoriesLoading: false, memoriesError: err instanceof Error ? err.message : '记忆加载失败' }),
      );
  },

  loadWorkspaces: async () => {
    set({ workspacesLoading: true });
    await bridge
      .listWorkspaces()
      .then((workspaces) => set({ workspaces, workspacesLoading: false }))
      .catch(() => set({ workspacesLoading: false }));
  },

  registerProject: async (path, name) => {
    const item = await bridge.registerWorkspace(path, name);
    set((s) => ({
      workspaces: [item, ...s.workspaces.filter((w) => w.id !== item.id)].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    }));
    return item;
  },

  forgetProject: async (id) => {
    set((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== id) }));
    await bridge.forgetWorkspace(id).catch(() => undefined);
  },

  loadRuns: (sessionId) => {
    void bridge
      .listRuns(sessionId)
      .then((runs) => set((s) => ({ runsBySession: { ...s.runsBySession, [sessionId]: runs } })))
      .catch(() => undefined);
  },

  // ---- 事件分发（reducer 式；全部经此入口改 streams/sessions/…）----
  handleEvent: (event) => {
    set((s) => {
      switch (event.type) {
        case 'streamDelta': {
          const list = s.streams[event.sessionId] ?? [];
          return { streams: { ...s.streams, [event.sessionId]: appendDelta(list, event.channel, event.delta, false) } };
        }
        case 'streamDone': {
          const list = closeStreaming(s.streams[event.sessionId] ?? []);
          const usage = s.usageBySession[event.sessionId];
          const merged = usage && usage.in === event.usage.in && usage.out === event.usage.out ? usage : event.usage;
          return {
            streams: { ...s.streams, [event.sessionId]: list },
            usageBySession: { ...s.usageBySession, [event.sessionId]: merged },
          };
        }
        case 'stateChanged': {
          // 状态机投影：会话列表状态点/头部徽标/输入区禁用规则共用
          return { sessions: touchSession(s.sessions, event.sessionId, { status: event.state as SessionStatus }) };
        }
        case 'toolCall': {
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = { kind: 'tool', key: `t-${event.callId}`, call: event };
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'toolResult': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) => (it.kind === 'tool' && it.call.callId === event.callId ? { ...it, result: event } : it)),
            },
          };
        }
        case 'permissionRequest': {
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = { kind: 'permission', key: `p-${event.requestId}`, request: event, outcome: null };
          // 120s 到点 → timeout（=拒绝，UI 灰显）；桥侧（Runtime）同样按超时拒绝收口
          const timer = setTimeout(() => {
            permTimers.delete(event.requestId);
            useAgentStore.setState((st) => ({
              streams: {
                ...st.streams,
                [event.sessionId]: (st.streams[event.sessionId] ?? []).map((it) =>
                  it.kind === 'permission' && it.request.requestId === event.requestId && it.outcome === null
                    ? { ...it, outcome: 'timeout' }
                    : it,
                ),
              },
            }));
          }, PERMISSION_TIMEOUT_MS);
          permTimers.set(event.requestId, timer);
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'permissionResponse': {
          // 宿主回执镜像（多端/快捷键一致）；已 timeout 的保持 timeout 展示
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) =>
                it.kind === 'permission' && it.request.requestId === event.requestId && it.outcome === null
                  ? { ...it, outcome: { decision: event.decision, scope: event.scope, at: Date.now() } }
                  : it,
              ),
            },
          };
        }
        case 'checkpointCreated': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: [
                ...list,
                { kind: 'system', key: nextKey('sys'), text: `已创建检查点 ${event.checkpointId}（${event.reason}）` },
              ],
            },
            checkpoints: {
              ...s.checkpoints,
              [event.sessionId]: [
                { id: event.checkpointId, reason: event.reason, filesChanged: event.filesChanged, createdAt: Date.now() },
                ...(s.checkpoints[event.sessionId] ?? []),
              ],
            },
          };
        }
        case 'modelSwitched': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            modelBySession: { ...s.modelBySession, [event.sessionId]: { policy: event.to, override: event.modelOverride } },
            streams: {
              ...s.streams,
              [event.sessionId]: [
                ...list,
                {
                  kind: 'system',
                  key: nextKey('sys'),
                  text: event.modelOverride
                    ? `模型切换：${event.from} → ${event.modelOverride}（${event.reason}）`
                    : `模型档位切换：${event.from} → ${event.to}（${event.reason}）`,
                },
              ],
            },
          };
        }
        case 'memorySaved': {
          // D15 §2.4：知识记忆写入/更新（同题更新不重复）
          const entry: MemoryEntry = {
            name: event.name,
            title: event.title,
            type: event.memoryType,
            hook: '由本会话自动沉淀',
            updatedAt: Date.now(),
            sessionId: event.sessionId,
          };
          const exists = s.memories.some((m) => m.name === event.name);
          const memories = exists ? s.memories.map((m) => (m.name === event.name ? { ...m, ...entry } : m)) : [entry, ...s.memories];
          const list = s.streams[event.sessionId] ?? [];
          return {
            memories,
            streams: {
              ...s.streams,
              [event.sessionId]: [
                ...list,
                { kind: 'system', key: nextKey('sys'), text: `${event.updated ? '更新' : '沉淀'}记忆：${event.title}` },
              ],
            },
          };
        }
        case 'reportDaily': {
          // D15 §3.3：日报产出/更新（同日覆盖；markdown 已在列表缓存则沿用）
          const report: AgentReport = {
            date: event.date,
            stats: event.stats,
            markdown:
              s.reports.find((r) => r.date === event.date)?.markdown ??
              `# ${event.date} Agent 日报\n\n- 会话 ${event.stats.sessions} 个\n- 工具调用 ${event.stats.tools} 次\n- 被拦截 ${event.stats.blocked} 次\n- 文件变更 ${event.stats.files}\n- 今日记忆 +${event.stats.memorySaved}`,
          };
          const others = s.reports.filter((r) => r.date !== event.date);
          return { reports: [report, ...others] };
        }
        case 'sessionEnded': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            sessions: touchSession(s.sessions, event.sessionId, { status: 'ended', endedAt: Date.now(), summary: event.summary }),
            streams: {
              ...s.streams,
              [event.sessionId]: [...list, { kind: 'system', key: nextKey('sys'), text: `会话已结束：${event.summary}` }],
            },
          };
        }
        // ---- 子 Agent 卡（D16 类型 1）----
        case 'subagentSpawn': {
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = {
            kind: 'subagent',
            key: `sa-${event.runId}`,
            runId: event.runId,
            taskDigest: event.taskDigest,
            status: 'running',
          };
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'subagentEvent': {
          // delta=运行中反馈（补充指令注入等，D16 决策⑧）→ 刷新卡摘要；
          // 终态 done/fail 才刷卡（探查摘要以 done 一次性上报，D11 §7）
          if (event.phase === 'delta') {
            const list0 = s.streams[event.sessionId] ?? [];
            return {
              streams: {
                ...s.streams,
                [event.sessionId]: list0.map((it) =>
                  it.kind === 'subagent' && it.runId === event.runId && event.summary
                    ? { ...it, summary: event.summary }
                    : it,
                ),
              },
            };
          }
          if (event.phase !== 'done' && event.phase !== 'fail') return s;
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) =>
                it.kind === 'subagent' && it.runId === event.runId
                  ? { ...it, status: event.phase === 'done' ? 'done' : 'failed', summary: event.summary }
                  : it,
              ),
            },
          };
        }
        case 'subagentJoin': {
          const list = s.streams[event.sessionId] ?? [];
          const ok = event.results.filter((r) => r.ok).length;
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: [
                ...list,
                { kind: 'system', key: nextKey('sys'), text: `并行探查完成：${ok}/${event.results.length} 项成功，结论已回填主对话` },
              ],
            },
          };
        }
        // ---- 委派卡（D16 类型 3：launch 后 turn 立即返回，end 异步驱动审查）----
        case 'delegateBrief': {
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = {
            kind: 'delegate',
            key: `dg-${event.runId}`,
            runId: event.runId,
            backend: event.backendSuggestion,
            phase: 'brief',
            logs: [],
          };
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'delegateEvt': {
          const list = s.streams[event.sessionId] ?? [];
          const line = typeof event.payload.text === 'string' ? event.payload.text : '';
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) => {
                if (it.kind !== 'delegate' || it.runId !== event.runId) return it;
                const logs = line ? [...it.logs, line].slice(-50) : it.logs;
                return { ...it, phase: it.phase === 'brief' ? 'running' : it.phase, logs };
              }),
            },
          };
        }
        case 'delegateEnd': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) =>
                it.kind === 'delegate' && it.runId === event.runId
                  ? { ...it, phase: event.exitCode === 0 ? 'review' : 'resolved', end: event }
                  : it,
              ),
            },
          };
        }
        case 'delegateReviewResolved': {
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) =>
                it.kind === 'delegate' && it.runId === event.runId ? { ...it, phase: 'resolved', decision: event.decision } : it,
              ),
            },
          };
        }
        default:
          return s;
      }
    });
    // 日报产出 → 重拉全量列表（含当日 markdown 正文，D15 §3.2 幂等重算）
    if (event.type === 'reportDaily') {
      void bridge
        .listReports()
        .then((reports) => set({ reports }))
        .catch(() => undefined);
    }
    // 跨端终态上报（14 篇 §3.3 OQ-C32）：run 终态 → notify 域落卡 + agent.task.completed
    // 推其它在线设备（本端经 markReportedRun 自滤防双响；尽力而为不阻塞事件泵）
    if (event.type === 'delegateEnd') {
      const card = (useAgentStore.getState().streams[event.sessionId] ?? []).find(
        (it) => it.kind === 'delegate' && it.runId === event.runId,
      );
      void reportAgentTask({
        run_id: event.runId,
        kind: 'delegate',
        status: event.exitCode === 0 ? 'done' : 'failed',
        session_id: event.sessionId,
        title: card?.kind === 'delegate' ? `委派（${card.backend}）` : '委派任务',
        summary: event.summary.slice(0, 80),
        changed_files_count: event.changedFiles.length,
      });
    } else if (event.type === 'subagentEvent' && (event.phase === 'done' || event.phase === 'fail')) {
      const card = (useAgentStore.getState().streams[event.sessionId] ?? []).find(
        (it) => it.kind === 'subagent' && it.runId === event.runId,
      );
      void reportAgentTask({
        run_id: event.runId,
        kind: 'probe',
        status: event.phase === 'done' ? 'done' : 'failed',
        session_id: event.sessionId,
        title: card?.kind === 'subagent' ? card.taskDigest : undefined,
        summary: event.summary?.slice(0, 80),
      });
    }
    // 本地完成通知（D16 本地环：工作台不可见时弹系统通知；跨端待服务端）
    if (!workbenchVisible()) {
      if (event.type === 'delegateEnd') {
        void notifyAgentDone(
          `委派完成（${event.exitCode === 0 ? '待审查' : '退出 ' + event.exitCode}）`,
          event.summary.slice(0, 80) || `run ${event.runId}`,
        );
      } else if (event.type === 'subagentJoin') {
        const ok = event.results.filter((r) => r.ok).length;
        void notifyAgentDone('并行子任务完成', `${ok}/${event.results.length} 项成功，结论已回填`);
      }
    }
    // run 生命周期事件 → 刷新该会话 run 面板（D16 §3.1；后台完成也可见）
    if (
      (event.type === 'subagentSpawn' ||
        event.type === 'subagentJoin' ||
        (event.type === 'subagentEvent' && (event.phase === 'done' || event.phase === 'fail')) ||
        event.type === 'delegateBrief' ||
        event.type === 'delegateEnd' ||
        event.type === 'delegateReviewResolved') &&
      event.sessionId
    ) {
      useAgentStore.getState().loadRuns(event.sessionId);
    }
  },
}));

// ---- 选择器 ----

/** 当前激活会话（工作台中栏数据源） */
export function selectActiveSession(s: AgentState): AgentSessionMeta | null {
  return s.sessions.find((x) => x.id === s.activeSessionId) ?? null;
}

/** 指定会话的未决审批（右栏队列/倒计时徽标） */
export function selectPendingPermissions(items: StreamItem[]): Array<Extract<StreamItem, { kind: 'permission' }>> {
  return items.filter((it): it is Extract<StreamItem, { kind: 'permission' }> => it.kind === 'permission' && it.outcome === null);
}

/** 输入区禁用规则（D08 §3.3：暂停/等待审批/运行中均不可发；ended 终态） */
export function composerDisabledFor(status: SessionStatus | undefined): { disabled: boolean; hint?: string } {
  switch (status) {
    case undefined:
      return { disabled: true };
    case 'starting':
      return { disabled: true, hint: '会话启动中…' };
    case 'running':
      return { disabled: true, hint: 'Agent 处理中，可先暂停' };
    case 'waiting_permission':
    case 'waiting_review':
      return { disabled: true, hint: '等待你的审批…' };
    case 'subagent_fanout':
    case 'delegating':
      return { disabled: true, hint: '子任务执行中…' };
    case 'paused':
      return { disabled: true, hint: '会话已暂停，点击"继续"恢复' };
    case 'ended':
      return { disabled: true, hint: '会话已结束，请新建会话继续' };
    case 'error':
      return { disabled: true, hint: '会话异常，请重试或新建会话' };
    default:
      return { disabled: false };
  }
}
