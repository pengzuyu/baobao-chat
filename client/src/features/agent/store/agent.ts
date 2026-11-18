/**
 * Agent feature store（模块 UI 态，D01 §12.2-5 / D08 §8）：
 * - 会话列表 / 当前会话事件流（按序追加的端内投影）/ 状态机投影（session.state 驱动）
 * - 未决审批（requestId → 倒计时/结果；120s 到点置灰=拒绝）
 * - 记忆回执（memorySaved → 会话流系统消息；记忆/日报浏览面均已退役）
 * - handleEvent() 为唯一事件入口（reducer 式分发；数据源 = bridge.onEvent）
 */

import { create } from 'zustand';
import { getAgentBridge } from '../bridge';
import { notifyAgentDone, reportAgentTask, sendSystemNotification, workbenchVisible } from '../bridge/notify';
import type {
  AgentEvent,
  AgentSessionMeta,
  AgentWorkspaceInfo,
  HistoryItem,
  RunInfo,
  GrantScope,
  PermissionMode,
  SessionStatus,
} from '../bridge/types';
import { parseToolArgs } from '../bridge/types';

/** 会话流条目（UI 投影模型；stream.delta 增量拼进 agentText/reasoning 尾项） */
export type StreamItem =
    | {
      kind: 'user';
      key: string;
      text: string;
      ts: number;
      /** 本回合收口时刻（2026-11-11 回合气泡用时/IM 落流卡收口判定）：仅终态
       *  stateChanged 打点（idle/error/ended/paused，含 interrupt）——回合结束
       *  必有终态收口；新 user 条目天然重置 */
      turnDoneAt?: number;
    }
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
  /** 澄清提问卡（D20 ask_user；不超时——等回答或「停止」中断收口） */
  | {
      kind: 'clarify';
      key: string;
      request: Extract<AgentEvent, { type: 'clarifyRequest' }>;
      /** null=等待回答；对象=已回答/中断（answers=所选 label 串） */
      answer: null | { decision: 'answered' | 'cancelled'; answers: string; at: number };
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
  | { kind: 'system'; key: string; text: string }
  /** 错误卡（error NTF 投影：8011 模型不可用/流中断、8010 超限等；不进 WAL——
   *  刷新/重开后消失，仅当轮提示重发/换模型可重试） */
  | { kind: 'error'; key: string; code: number; message: string; fatal: boolean };

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
  /** sessionId → 当前模型选择（model.switched 维护；override=直达引用 p:<id>:<model>） */
  modelBySession: Record<string, { policy: 'fast' | 'strong' | 'auto'; override?: string }>;
  /** sessionId → 最近一轮用量（stream.done usage） */
  usageBySession: Record<string, { in: number; out: number }>;
  /** sessionId → run 记录（D16 §3.1 runs.list；子任务生命周期事件触发刷新） */
  runsBySession: Record<string, RunInfo[]>;
  /** 全量 run 清单（2026-11-11 左栏任务分区：runs.list 无 sessionId=跨会话全量） */
  taskRuns: RunInfo[];
  /** D33 §3.2/§3.3：runId → 子 agent 过程流（subagentSpawn 播种 user 条目 +
   *  subagentTrace 直播投影 + run.history 回放回填；右栏运行详情数据源。
   *  不进主时间线——probe 过程只在侧栏可见） */
  sideStreams: Record<string, StreamItem[]>;
  /** D33：右栏运行详情当前展示的 runId（null=未打开/回落默认 tab） */
  activeRunView: string | null;

  /** 思考强度档位（2026-11-11 zcode 同款三档；全局用户选择，随每条消息下发） */
  thinkLevel: 'low' | 'medium' | 'high';
  setThinkLevel: (level: 'low' | 'medium' | 'high') => void;

  /** D19 项目登记表（workspace.list；last_opened_at 倒序） */
  workspaces: AgentWorkspaceInfo[];
  workspacesLoading: boolean;


  // ---- 动作 ----
  init: () => Promise<void>;
  selectSession: (sessionId: string | null) => void;
  /** 打开会话加载历史（session.history 直读 WAL）：本进程尚无流时拉取回填
   *  （重启后/列表切回；IM embedded 会话在工作台打开即见全程聊天记录） */
  loadHistoryIfEmpty: (sessionId: string) => Promise<void>;
  startSession: (mode: PermissionMode, model?: string) => Promise<void>;
  /** 显式建会话并返回 meta（D18 内嵌卡：不切换 activeSessionId 之外还供 im 侧直接持有引用；
   *  title 可选初始标题——IM embedded 来源名「与xxx的对话」/「xxx · 群聊」） */
  createSession: (opts?: { workspace?: string; mode?: PermissionMode; model?: string; title?: string }) => Promise<import('../bridge/types').AgentSessionMeta>;
  /** 定向发送（D18：embedded 会话由 im 侧显式指定 sessionId，不依赖 activeSessionId；
   *  首条用户消息自动派生标题（占位判定 + renameSession 落库）） */
  sendTextTo: (sessionId: string, text: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  respondPermission: (requestId: string, decision: 'allow' | 'deny', scope?: GrantScope, editedArgs?: Record<string, unknown>) => void;
  /** D20 澄清回答（全流按 questionId 扫描置终态 + bridge 下发） */
  respondClarify: (questionId: string, answers: string[], freeText?: string) => void;
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
  /** 中断当前轮（2026-11-11：取代旧暂停/恢复——收口 idle，会话保留可继续追问） */
  stopActive: () => void;
  /** 首条消息派生标题（占位判定 + renameSession 落库；embedded 显式标题不覆盖） */
  deriveTitleIfPlaceholder: (sessionId: string, text: string) => Promise<void>;
  endActive: () => void;
  emergencyStop: () => void;
  setMode: (mode: PermissionMode) => void;
  /** 会话内切换模型（model=直达引用；缺省=档位；回执 modelSwitched 事件驱动 UI） */
  switchModel: (to: 'fast' | 'strong' | 'auto', model?: string) => void;
  /** D19 拉取项目登记表 */
  loadWorkspaces: () => Promise<void>;
  /** D19 登记项目（workspace.register：realpath upsert；返回登记行） */
  registerProject: (path: string, name?: string) => Promise<AgentWorkspaceInfo>;
  /** D19 移除项目登记（只删登记，不动会话/记忆分区） */
  forgetProject: (id: string) => Promise<void>;
  /** 拉取会话 run 记录（D16 §3.1 run 面板） */
  loadRuns: (sessionId: string) => void;
  /** 拉全量 run（左栏任务分区；sessionId 缺省=跨会话全量） */
  loadTaskRuns: () => void;
  /** D33：打开运行详情（右栏切该 run 的过程流；本进程无流时拉 run.history 回放） */
  openRunView: (runId: string) => void;
  /** D33：关闭运行详情（回落默认 tab；sideStreams 保留——重开不重拉） */
  closeRunView: () => void;
  /** D33：run 历史回放（subagentTrace 未直播到的场景：重启/切回后打开） */
  loadRunHistory: (runId: string) => Promise<void>;
  /** 事件唯一入口（reducer 式分发；包一层便于桥接入） */
  handleEvent: (event: AgentEvent) => void;
}

// ---- 模块级：桥实例 / 订阅守卫 / 审批超时计时器 / 流水 key 计数 ----
const bridge = getAgentBridge();
let subscribed = false;

/**
 * agent://event 订阅装配（幂等）。2026-11-11 真机根因修复：此前只在 init()（懒——
 * 发 agent 消息/进工作台才触发）里注册监听；HMR/整页重载会洗掉旧监听，重载后
 * 若无人再调 init，壳泵照发但 webview 无人听——表现为审批弹框永不出现/流式中途
 * 静默断流（8/8 timeout 与 19:53 卡流同根）。App 挂载即调本函数，任何重载后恒有宿主。
 */
export function ensureAgentEventSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  bridge.onEvent((event) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[agent-evt]', event.type);
    }
    useAgentStore.getState().handleEvent(event);
  });
}

/** requestId → 120s 到点计时器（到点置 timeout=拒绝语义，D08 §3.4） */
const permTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERMISSION_TIMEOUT_MS = 120_000;

let itemSeq = 0;

// ---- stream.delta 前端合帧（2026-11-11 页面卡顿修复）----
// Rust 壳 80ms 合批只合并同 (session, channel)，flush 时跨会话/跨 channel 仍每条
// 一次 set（每 set 同步通知全部订阅 selector）；mock 桥更是每 token 直发。此处
// 50ms 窗口缓冲 delta、合并成一次 set，把流式期间 store 更新压到 ≤20 次/s；
// 任何非 delta 事件先同步 flush 保序（stream.done 必后于该会话全部 delta，
// tool.call 前的正文段不换位）。
const DELTA_FLUSH_MS = 50;
const deltaBuffer = new Map<string, Array<{ channel: 'text' | 'reasoning'; delta: string }>>();
let deltaTimer: ReturnType<typeof setTimeout> | null = null;

/** 冲刷缓冲的 delta（一次 set；相邻同 channel 段先合并，减少 appendDelta 数组复制） */
function flushDeltaBuffer(): void {
  if (deltaTimer) {
    clearTimeout(deltaTimer);
    deltaTimer = null;
  }
  if (deltaBuffer.size === 0) return;
  const buffered = [...deltaBuffer.entries()];
  deltaBuffer.clear();
  useAgentStore.setState((s) => {
    let streams = s.streams;
    for (const [sid, chunks] of buffered) {
      let list = streams[sid] ?? [];
      let i = 0;
      while (i < chunks.length) {
        const ch = chunks[i].channel;
        let text = '';
        while (i < chunks.length && chunks[i].channel === ch) {
          text += chunks[i].delta;
          i += 1;
        }
        if (text) list = appendDelta(list, ch, text, false);
      }
      streams = { ...streams, [sid]: list };
    }
    return { streams };
  });
}

/** 标题派生（2026-11-11）：首行 trim、≤20 字截断加省略号；空白返回 null 不派生 */
export function deriveSessionTitle(text: string): string | null {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const chars = [...firstLine];
  return chars.length > 20 ? `${chars.slice(0, 20).join('')}…` : firstLine;
}

/** 占位标题判定：'新会话'（DDL/前端缺省）/「会话 n」（宿主缓存）/title===id
 * （bbrt 老数据落库口径）——三者均视为未命名，首条消息派生可覆盖 */
export function isPlaceholderTitle(title: string, sessionId: string): boolean {
  return !title.trim() || title === '新会话' || /^会话 \d+$/.test(title) || title === sessionId;
}

function nextKey(prefix: string): string {
  itemSeq += 1;
  return `${prefix}-${itemSeq}`;
}

/** 历史条目 → 流条目（回合气泡同构渲染；key 前缀 h- 区分直播条目。
 *  工具行合成 call/result 事件（args=脱敏 JSON 串 parse——D33 §3.4 WAL 补记后
 *  重启回放工具卡保真；旧行无 args → {} 降级）；reasoning 行→思考条目、
 *  user 行 ts/turnDoneAt 透传（折叠统计行冻结用时回放，旧行缺省 0/undefined） */
function historyToStreamItem(sid: string, it: HistoryItem, i: number): StreamItem {
  switch (it.kind) {
    case 'user':
      return { kind: 'user', key: `h-u${i}`, text: it.text, ts: it.ts ?? 0, turnDoneAt: it.turnDoneAt };
    case 'assistant':
      return { kind: 'agentText', key: `h-a${i}`, text: it.text, streaming: false };
    case 'reasoning':
      return { kind: 'reasoning', key: `h-r${i}`, text: it.text, streaming: false };
    case 'tool':
      return {
        kind: 'tool',
        key: `t-${it.callId}`,
        call: {
          type: 'toolCall',
          sessionId: sid,
          callId: it.callId,
          tool: it.tool,
          args: parseToolArgs(it.args),
          risk: 'low',
          parallel: false,
          source: 'self',
        },
        result:
          it.ok === undefined
            ? undefined
            : { type: 'toolResult', sessionId: sid, callId: it.callId, ok: it.ok, summary: it.summary ?? '', truncated: false },
      };
  }
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

/** 回合收口打点（2026-11-11）：终态 stateChanged 时给最后一个 user 条目盖
 *  turnDoneAt（覆盖式，终值=最后收口时刻）。无 user 条目（纯事件流）不动 */
function stampTurnDone(streams: Record<string, StreamItem[]>, sessionId: string): Record<string, StreamItem[]> {
  const list = streams[sessionId];
  if (!list) return streams;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const it = list[i];
    if (it.kind === 'user') {
      const next = [...list];
      next[i] = { ...it, turnDoneAt: Date.now() };
      return { ...streams, [sessionId]: next };
    }
  }
  return streams;
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
  modelBySession: {},
  usageBySession: {},
  runsBySession: {},
  thinkLevel: 'medium',
  taskRuns: [],
  sideStreams: {},
  activeRunView: null,

  workspaces: [],
  workspacesLoading: false,


  init: async () => {
    // 事件订阅只装一次（App 挂载已兜底注册；此处幂等）
    ensureAgentEventSubscribed();
    if (get().ready || get().sessionsLoading) return;

    set({ sessionsLoading: true, sessionsError: null });
    try {
      const sessions = await bridge.listSessions();
      set({ sessions, sessionsLoading: false, ready: true });
    } catch (err) {
      set({ sessionsLoading: false, sessionsError: err instanceof Error ? err.message : '会话列表加载失败', ready: true });
    }
    // D19 项目登记表（左栏项目区数据源；失败静默——会话 workspace 路径兜底展示）
    void get().loadWorkspaces();
  },

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId });
    // 打开会话即加载历史（本进程无流时；含 IM embedded 同一会话的跨端记录）
    if (sessionId) void get().loadHistoryIfEmpty(sessionId);
  },

  loadHistoryIfEmpty: async (sid) => {
    if (!sid || (get().streams[sid] ?? []).length > 0) return;
    let items: HistoryItem[];
    try {
      items = await bridge.loadHistory(sid);
    } catch {
      return; // 历史加载失败不阻断（直播照常；空态=无历史）
    }
    // 拉取期间可能已有新事件（乐观上屏/直播）→ 仅在仍为空时回填
    set((s) =>
      (s.streams[sid] ?? []).length > 0
        ? s
        : { streams: { ...s.streams, [sid]: items.map((it, i) => historyToStreamItem(sid, it, i)) } },
    );
  },

  setThinkLevel: (level) => set({ thinkLevel: level }),

  createSession: async (opts) => {
    // D19：workspace 缺省=日常对话（空串，无工作目录——文件/命令类工具不可用，
    // 记忆恒用户级）；项目会话由 openProject 传入目录。
    // model=用户默认模型的直达引用（settings.ai_default 解析，0023；缺省=档位别名）
    // title 可选初始标题（IM embedded 来源名）；缺省=占位，首条消息后自动派生
    const meta = await bridge.startSession(opts?.workspace ?? '', opts?.mode ?? 'ask', opts?.model, opts?.title);
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
    const wasFirst = !(get().streams[sid] ?? []).some((it) => it.kind === 'user');
    // 乐观上屏（与 sendText 同款；embedded 会话在 im 聊天卡消费，工作台打开时同样可见）
    set((s) => ({
      streams: { ...s.streams, [sid]: [...(s.streams[sid] ?? []), { kind: 'user', key: nextKey('u'), text, ts: Date.now() }] },
      sessions: touchSession(s.sessions, sid, {}),
    }));
    await bridge.sendMessage(sid, text, get().thinkLevel);
    // 首条用户消息自动命名（2026-11-11：标题以用户所问为准，对齐 zcode 感觉）。
    // 仅占位标题会话（'新会话'/'会话 n'/老数据 title=session_id）——embedded
    // 来源名等显式标题不被覆盖。失败静默（标题为辅链路，不阻断消息）
    if (wasFirst) void get().deriveTitleIfPlaceholder(sid, text);
  },

  sendText: async (text) => {
    const sid = get().activeSessionId;
    if (!sid || !text.trim()) return;
    const wasFirst = !(get().streams[sid] ?? []).some((it) => it.kind === 'user');
    // 乐观上屏（D08：agent_input 发送后 UI 乐观追加）
    set((s) => ({
      streams: { ...s.streams, [sid]: [...(s.streams[sid] ?? []), { kind: 'user', key: nextKey('u'), text, ts: Date.now() }] },
      sessions: touchSession(s.sessions, sid, {}),
    }));
    await bridge.sendMessage(sid, text, get().thinkLevel);
    if (wasFirst) void get().deriveTitleIfPlaceholder(sid, text);
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

  respondClarify: (questionId, answers, freeText) => {
    // D20：卡片终态先落（回执镜像到达后幂等覆盖）；按 questionId 全流扫描
    // （embedded 会话非 active 同口径）
    const answersText = answers.join('、') + (freeText?.trim() ? `；补充：${freeText.trim()}` : '');
    set((s) => {
      const next: typeof s.streams = {};
      for (const [sid, list] of Object.entries(s.streams)) {
        next[sid] = list.map((it) =>
          it.kind === 'clarify' && it.request.questionId === questionId && it.answer === null
            ? { ...it, answer: { decision: 'answered', answers: answersText, at: Date.now() } }
            : it,
        );
      }
      return { streams: next };
    });
    void bridge.respondClarify(questionId, answers, freeText).catch(() => undefined);
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

  stopActive: () => {
    const sid = get().activeSessionId;
    if (sid) void bridge.interrupt(sid).catch(() => undefined);
  },
  /** 首条消息派生标题（占位判定见 isPlaceholderTitle；rename 落库 + 本地同步） */
  deriveTitleIfPlaceholder: async (sid, text) => {
    const meta = get().sessions.find((m) => m.id === sid);
    if (!meta || !isPlaceholderTitle(meta.title, meta.id)) return;
    const derived = deriveSessionTitle(text);
    if (!derived) return;
    try {
      const finalTitle = await bridge.renameSession(sid, derived);
      set((s) => ({ sessions: touchSession(s.sessions, sid, { title: finalTitle || derived }) }));
    } catch {
      // 桥失败不阻断；本地仍用派生标题（下次 listSessions 由库内真值校正）
      set((s) => ({ sessions: touchSession(s.sessions, sid, { title: derived }) }));
    }
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

  loadTaskRuns: () => {
    void bridge
      .listRuns()
      .then((runs) => set({ taskRuns: runs }))
      .catch(() => undefined);
  },

  // ---- D33：运行详情（右栏子 agent 过程流）----

  openRunView: (runId) => {
    set({ activeRunView: runId });
    void get().loadRunHistory(runId);
  },

  closeRunView: () => set({ activeRunView: null }),

  loadRunHistory: async (runId) => {
    // 本进程已有直播流（或已回放过）不重拉；拉取期间来了直播也不覆盖
    if (!runId || (get().sideStreams[runId] ?? []).length > 0) return;
    let items: HistoryItem[];
    try {
      items = await bridge.loadRunHistory(runId);
    } catch {
      return; // 回放失败不阻断（直播照常；空态=子任务卡摘要兜底）
    }
    set((s) =>
      (s.sideStreams[runId] ?? []).length > 0
        ? s
        : { sideStreams: { ...s.sideStreams, [runId]: items.map((it, i) => historyToStreamItem(runId, it, i)) } },
    );
  },

  // ---- 事件分发（reducer 式；全部经此入口改 streams/sessions/…）----
  handleEvent: (event) => {
    // stream.delta 走合帧缓冲（50ms 窗口一次 set；见 flushDeltaBuffer 注释）；
    // 其余事件先同步冲刷缓冲保序，再进 reducer
    if (event.type === 'streamDelta') {
      const arr = deltaBuffer.get(event.sessionId);
      if (arr) arr.push({ channel: event.channel, delta: event.delta });
      else deltaBuffer.set(event.sessionId, [{ channel: event.channel, delta: event.delta }]);
      if (!deltaTimer) deltaTimer = setTimeout(() => flushDeltaBuffer(), DELTA_FLUSH_MS);
      return;
    }
    flushDeltaBuffer();
    set((s) => {
      switch (event.type) {
        case 'streamDone': {
          const list = closeStreaming(s.streams[event.sessionId] ?? []);
          const usage = s.usageBySession[event.sessionId];
          const merged = usage && usage.in === event.usage.in && usage.out === event.usage.out ? usage : event.usage;
          return {
            streams: { ...s.streams, [event.sessionId]: list },
            usageBySession: { ...s.usageBySession, [event.sessionId]: merged },
          };
        }
        case 'error': {
          // 全局错误（无会话归属，如 fatal 协议错）不落卡——控制台可观测即可
          if (!event.sessionId) {
            console.warn(`[agent] 全局错误 ${event.code}: ${event.message}`);
            return {};
          }
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = {
            kind: 'error',
            key: `e-${list.length}-${event.code}`,
            code: event.code,
            message: event.message,
            fatal: event.fatal,
          };
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'stateChanged': {
          // 状态机投影：会话列表状态点/头部徽标/输入区禁用规则共用
          const sessions = touchSession(s.sessions, event.sessionId, { status: event.state as SessionStatus });
          // 回合收口打点：仅终态 stateChanged（回合结束必有 idle/error/ended/paused 收口，
          // 含 interrupt）——streamDone 不打（多段回合每次 LLM 调用都触发会中途冻结）；
          // 流尾是裸 user 条目不打（revive：ended 会话发消息先镜像 idle 再 running，
          // 此时回合尚未开始）。覆盖式打最后一个 user（终值=最后收口时刻）
          const terminal = event.state === 'idle' || event.state === 'error' || event.state === 'ended' || event.state === 'paused';
          if (!terminal) return { sessions };
          const list = s.streams[event.sessionId] ?? [];
          const last = list.length > 0 ? list[list.length - 1] : undefined;
          return last && last.kind !== 'user' ? { sessions, streams: stampTurnDone(s.streams, event.sessionId) } : { sessions };
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
          // 系统通知（2026-11-11 真机事故：审批弹框挂在活动卡/工作台页，用户不在场
          // → 120s 无人应答自动拒绝，表现为"很久没响应"）——跨页面可见
          void sendSystemNotification('Agent 请求审批', `${event.tool}（120 秒内未响应将自动拒绝）`);
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
        case 'clarifyRequest': {
          // D20：提问卡入流 + 系统通知（不超时——无 permTimers 同款倒计时）
          const list = s.streams[event.sessionId] ?? [];
          const item: StreamItem = { kind: 'clarify', key: `q-${event.questionId}`, request: event, answer: null };
          void sendSystemNotification('Agent 有问题问你', event.question.slice(0, 80));
          return { streams: { ...s.streams, [event.sessionId]: [...list, item] } };
        }
        case 'clarifyResponse': {
          // 宿主回执镜像（多端一致）；answered=答案串 / cancelled=用户中断
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: list.map((it) =>
                it.kind === 'clarify' && it.request.questionId === event.questionId && it.answer === null
                  ? { ...it, answer: { decision: event.decision, answers: event.answers, at: Date.now() } }
                  : it,
              ),
            },
          };
        }
        case 'modelSwitched': {
          // 2026-11-12 用户口径：切换提示不进回复气泡（chip 即时反映档位/直达引用，
          // 时间线插话打扰阅读）；仅更新会话模型状态
          return {
            modelBySession: { ...s.modelBySession, [event.sessionId]: { policy: event.to, override: event.modelOverride } },
          };
        }
        case 'memorySaved': {
          // D15 §2.4：知识记忆写入/更新——仅会话流回执（记忆浏览面已退役，列表不再维护）
          const list = s.streams[event.sessionId] ?? [];
          return {
            streams: {
              ...s.streams,
              [event.sessionId]: [
                ...list,
                { kind: 'system', key: nextKey('sys'), text: `${event.updated ? '更新' : '沉淀'}记忆：${event.title}` },
              ],
            },
          };
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
          // D33：侧栏过程流播种（user 条目=任务摘要；trace 在其上追加）
          const side = s.sideStreams[event.runId] ?? [
            { kind: 'user' as const, key: `su-${event.runId}`, text: event.taskDigest, ts: Date.now() },
          ];
          return {
            streams: { ...s.streams, [event.sessionId]: [...list, item] },
            sideStreams: { ...s.sideStreams, [event.runId]: side },
          };
        }
        // D33 §3.2：probe 过程明细 → 侧栏 run 流（不进主时间线）。
        // text=每模型轮整段 agentText；tool_call/tool_result 按 callId 配对成
        // 标准 tool 条目（与主流 handleEvent 同构，渲染器零特判）
        case 'subagentTrace': {
          const runId = event.runId;
          let list = s.sideStreams[runId] ?? [
            { kind: 'user' as const, key: `su-${runId}`, text: '（子任务过程）', ts: Date.now() },
          ];
          if (event.item.kind === 'text') {
            if (event.item.text) {
              list = [...list, { kind: 'agentText' as const, key: nextKey('sat'), text: event.item.text, streaming: false }];
            }
          } else if (event.item.kind === 'tool_call') {
            list = [
              ...list,
              {
                kind: 'tool' as const,
                key: `t-${event.item.callId}`,
                call: {
                  type: 'toolCall' as const,
                  sessionId: event.sessionId,
                  callId: event.item.callId,
                  tool: event.item.tool,
                  args: parseToolArgs(event.item.argsMasked),
                  risk: event.item.risk,
                  parallel: false,
                  source: 'self' as const,
                },
              },
            ];
          } else {
            // tool_result：按 callId 回填；孤儿（错过 call，如中途订阅）合成带结果的完整条目
            // （先解构——闭包内联合窄化失效）
            const { callId, ok, summary, durationMs } = event.item;
            let patched = false;
            list = list.map((it) => {
              if (it.kind === 'tool' && it.call.callId === callId && !it.result) {
                patched = true;
                return {
                  ...it,
                  result: {
                    type: 'toolResult' as const,
                    sessionId: event.sessionId,
                    callId,
                    ok,
                    summary,
                    truncated: false,
                    durationMs,
                  },
                };
              }
              return it;
            });
            if (!patched) {
              list = [
                ...list,
                {
                  kind: 'tool' as const,
                  key: `t-${callId}`,
                  call: {
                    type: 'toolCall' as const,
                    sessionId: event.sessionId,
                    callId,
                    tool: '(unknown)',
                    args: {},
                    risk: 'low' as const,
                    parallel: false,
                    source: 'self' as const,
                  },
                  result: {
                    type: 'toolResult' as const,
                    sessionId: event.sessionId,
                    callId,
                    ok,
                    summary,
                    truncated: false,
                    durationMs,
                  },
                },
              ];
            }
          }
          return { sideStreams: { ...s.sideStreams, [runId]: list } };
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
      // 任务分区（全量）随 run 生命周期同步刷新（2026-11-11）
      useAgentStore.getState().loadTaskRuns();
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

/** 指定会话的未决提问（D20；同审批口径，供三端提问卡） */
export function selectPendingClarifies(items: StreamItem[]): Array<Extract<StreamItem, { kind: 'clarify' }>> {
  return items.filter((it): it is Extract<StreamItem, { kind: 'clarify' }> => it.kind === 'clarify' && it.answer === null);
}

/** 输入区禁用规则（D08 §3.3：暂停/等待审批/运行中均不可发；ended 终态） */
export function composerDisabledFor(status: SessionStatus | undefined): { disabled: boolean; hint?: string } {
  switch (status) {
    case undefined:
      return { disabled: true };
    case 'running':
      return { disabled: true, hint: 'Agent 处理中，可点停止中断' };
    case 'waiting_permission':
    case 'waiting_review':
      return { disabled: true, hint: '等待你的审批…' };
    case 'waiting_clarify':
      return { disabled: true, hint: 'Agent 在等你回答提问…' };
    case 'subagent_fanout':
    case 'delegating':
      return { disabled: true, hint: '子任务执行中…' };
    case 'paused':
      // 暂停入口已移除（2026-11-11）：paused 只剩步数上限等罕见内部触发，不可恢复
      return { disabled: true, hint: '会话已自动暂停（内部限制），请新建会话继续' };
    // ended/error 不再禁输入（2026-11-11「会话不死」）：发消息即复活，
    // RT 重放事件镜像续上下文——落 default 可输入分支
    default:
      return { disabled: false };
  }
}
