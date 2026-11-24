/**
 * Agent Bridge 层类型（权威：D08 §5/§6.3、D11 §3/§4、D15 §2.4/§3.3）：
 * - UI 与宿主（Tauri Rust 核心 → stdio Runtime）之间的前端友好视图：
 *   协议字段 snake_case → camelCase，点号事件名 → camelCase 联合类型成员
 * - 事件 payload 字段名与 D11 §4 全消息表一一对应（stream.delta/tool.call/permission.request…）
 * - 实现两份：bridge/mock.ts（定时器剧本，dev/preview 可演示）、bridge/tauri.ts（真实 IPC）
 */

/** 权限模式三档（09 §3.3；中文名见 AGENT_MODE_OPTIONS，D13-A1 官方口径） */
export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto';

/** 会话状态机枚举（D11 §3 + D20 waiting_clarify；session.state 上报同款）。
 *  无 starting：建会话 REQ 同步等完 session.ready 回执（壳侧阻塞），回执到即就绪 */
export type SessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'waiting_clarify'
  | 'subagent_fanout'
  | 'paused'
  | 'error'
  | 'ended';

/** 工具风险级（09 §4.1 矩阵输入） */
export type RiskLevel = 'low' | 'mid' | 'high';

/** 会话场景来源（2026-11-23 场景提示词）：embedded=IM 私聊/群聊唤起
 *  （convId=im_history 参数、convType 区分单聊/群聊——runtime 在 SYSTEM_PROMPT
 *  末尾注入场景段，conv_id 常驻抗压缩）；任务/项目不传（workspace 判定） */
export interface SessionOriginInfo {
  kind: 'embedded';
  convId: string;
  convType: 'single' | 'group';
}

/** 会话历史条目（session.history 回执；WAL 摘要级投影——工作台打开会话加载
 *  聊天记录，IM embedded 与工作台同一会话跨端共用。ok/summary 旧 WAL 行可缺；
 *  args=脱敏 JSON 字符串（D33 §3.4 工具卡回放保真），旧行可缺；
 *  ts/turnDoneAt=turn 行 created_at 配对（折叠统计行冻结用时回放，旧行可缺）；
 *  reasoning=思考全文（assistant.thinking 行投影，重开还原过程区）；
 *  error=回合错误（turn.error 行投影，2026-11-23：错误卡重开保留——
 *  模型不可用/流中断/超限等重进会话可见，旧行无此类型） */
export type HistoryItem =
  | { kind: 'user'; text: string; ts?: number; turnDoneAt?: number }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'error'; code: number; message: string; fatal: boolean }
  | { kind: 'tool'; callId: string; tool: string; ok?: boolean; summary?: string; args?: string };

/**
 * 工具 args 归一（D33 §2 存量坑修复）：self 工具的 wire args 是 JSON **字符串**
 * （bridge.rs 包 Value::String 上行）——统一 parse 成
 * 对象；解析失败/非对象回落 {}。normalizeEvent 与 historyToStreamItem 共用。
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** 审批记忆粒度（09 §4.2 三级记忆） */
export type GrantScope = 'once' | 'session' | 'permanent';

/** 知识记忆类型（D15 §2.1 四类 + D37 status=项目进度台账） */
export type MemoryType = 'user' | 'project' | 'feedback' | 'reference' | 'status';

/** 会话元信息（agent_session 表投影，D08 §6.1） */
export interface AgentSessionMeta {
  id: string;
  title: string;
  workspace: string;
  mode: PermissionMode;
  modelPolicy: 'fast' | 'strong' | 'auto';
  /** 会话级模型直达引用（0023 多供应商；p:<providerId>:<model>；缺省=档位别名） */
  modelOverride?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  summary?: string;
  /** D35 定时任务：审批等待秒数（缺省=普通会话 120s；0=不超时） */
  approvalTimeoutSecs?: number;
}

/** 子 Agent run 行（D16 §3.1 agent_run 投影；runs.list 数据源） */
export interface RunInfo {
  id: string;
  sessionId: string;
  rootSessionId: string;
  parentRunId: string;
  parentCallId: string;
  kind: 'probe' | 'expert' | 'terminal';
  defRef: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  etaHintMs: number;
  etaActualMs: number;
  summary: string;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
}

/** D19 项目（agent_workspace 投影；workspace.list/register 数据形状） */
export interface AgentWorkspaceInfo {
  /** ws-<ms>-<n> */
  id: string;
  /** realpath（唯一身份锚点） */
  path: string;
  name: string;
  isRepo: boolean;
  trusted: boolean;
  lastOpenedAt: number;
  createdAt: number;
}

/** 审批卡参数预览（D08 §6.3 preview 联合；本轮 UI 只消费 command 形态） */
export type PermissionPreview =
  | { kind: 'command'; command: string; cwd: string; dangerFlags: string[] }
  | { kind: 'diff'; file: string; addLines: number; delLines: number }
  | { kind: 'obo'; target: string; scopes: string[] };

/** 工具结果被拦截信息（D11 §4 tool.result blocked；code=8020-8026） */
export interface ToolBlocked {
  rule: string;
  kind: 'path' | 'network' | 'resource' | 'rule' | 'danger-cmd' | 'permission';
  code: number;
}

/** D20 澄清选项（clarify.request.options 项） */
export interface ClarifyOptionDTO {
  label: string;
  description?: string;
}

/** 一轮 LLM 调用用量（D36）：in=prompt（当前上下文大小）、out=completion、
 *  cached=缓存命中 tokens（上游未上报则缺省）、model=上游实际模型名（快照名可含日期） */
export interface TurnUsage {
  in: number;
  out: number;
  cached?: number;
  model?: string;
}

/**
 * 会话历史查询结果（D36）：items=历史条目；usage=WAL 最后一条 assistant.done 的用量
 * （重启后输入框状态条恢复用；旧会话/无记录时缺省）
 */
export interface HistoryLoadResult {
  items: HistoryItem[];
  usage?: TurnUsage;
}

/**
 * UI 订阅的 Agent 事件联合（D08 §5.2 IPC 事件表的 camelCase 镜像）。
 * 命名 ↔ 协议：streamDelta=stream.delta / stateChanged=session.state /
 * toolCall=tool.call / toolResult=tool.result / permissionRequest=permission.request /
 * permissionResponse=permission.response / memorySaved=memory.saved（D15 §2.4）/
 * modelSwitched=model.switched / sessionEnded=session.ended
 */
export type AgentEvent =
  | { type: 'streamDelta'; sessionId: string; seq: number; delta: string; channel: 'text' | 'reasoning' }
  | { type: 'streamDone'; sessionId: string; finishReason: string; usage: TurnUsage }
  /** 协议级错误（error NTF：8011 模型不可用/流中断、8010 超限等；sessionId 可空=全局错误） */
  | { type: 'error'; sessionId: string; code: number; message: string; fatal: boolean }
  | { type: 'stateChanged'; sessionId: string; state: SessionStatus; reason?: string }
  | {
      type: 'toolCall';
      sessionId: string;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      risk: RiskLevel;
      parallel?: boolean;
      source?: 'self';
    }
  | {
      type: 'toolResult';
      sessionId: string;
      callId: string;
      ok: boolean;
      summary: string;
      truncated?: boolean;
      exitCode?: number;
      durationMs?: number;
      blocked?: ToolBlocked;
    }
  | {
      type: 'permissionRequest';
      sessionId: string;
      requestId: string;
      tool: string;
      risk: RiskLevel;
      reason: string;
      preview: PermissionPreview;
      options: GrantScope[];
      /** 到点未决=拒绝（D08 §6.1）；普通会话 created_at+120000；
       *  D35 定时会话按任务 approvalTimeoutSecs 计算，0=不超时 */
      expiresAt: number;
    }
  | {
      type: 'permissionResponse';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny' | 'cancelled';
      scope?: GrantScope;
    }
  /** D20 澄清提问（clarify.request；不超时——等用户或「停止」中断） */
  | {
      type: 'clarifyRequest';
      sessionId: string;
      questionId: string;
      question: string;
      header?: string;
      options: ClarifyOptionDTO[];
      multiSelect: boolean;
    }
  /** D20 澄清回执镜像（clarify.response 回显；answered=已答 / cancelled=中断） */
  | {
      type: 'clarifyResponse';
      sessionId: string;
      questionId: string;
      decision: 'answered' | 'cancelled';
      answers: string;
    }
  | { type: 'memorySaved'; sessionId: string; name: string; title: string; memoryType: MemoryType; updated: boolean; scope?: 'user' | 'project'; workspaceName?: string }
  | { type: 'sessionEnded'; sessionId: string; summary: string }
  | { type: 'modelSwitched'; sessionId: string; from: 'fast' | 'strong' | 'auto'; to: 'fast' | 'strong' | 'auto'; modelOverride?: string; reason: string }
  /**
   * 子 Agent（D16 类型 1：探查/通用子 agent）。sub_id 即持久任务 id（agent- 前缀+32hex）；
   * spawn 携 session 归属，event 按 runId 定位会话流内卡片
   */
  | { type: 'subagentSpawn'; sessionId: string; runId: string; taskDigest: string; toolSubset: string[] }
  | { type: 'subagentEvent'; sessionId: string; runId: string; phase: 'spawn' | 'delta' | 'done' | 'fail'; summary?: string }
  | { type: 'subagentJoin'; sessionId: string; results: Array<{ runId: string; ok: boolean; summary: string }> }
  /**
   * 子 Agent 过程明细（D33 §3.2：probe 每步文本/工具外发，按 runId 路由
   * sideStreams 侧栏 run 流，不进主时间线。text=每模型轮整段；argsMasked=
   * 脱敏 JSON 字符串）
   */
  | {
      type: 'subagentTrace';
      sessionId: string;
      runId: string;
      item:
        | { kind: 'text'; text: string }
        | { kind: 'tool_call'; callId: string; tool: string; argsMasked: string; risk: RiskLevel }
        | { kind: 'tool_result'; callId: string; ok: boolean; summary: string; durationMs: number };
    }

/**
 * Agent 桥接接口：UI 只面对该接口（D08 §5.1 Tauri 命令表的前端封装）。
 * mock/tauri 双实现，getAgentBridge() 运行时选择。
 */
export interface AgentBridge {
  readonly kind: 'mock' | 'tauri';

  /** 订阅事件流（宿主→WebView 镜像），返回取消订阅 */
  onEvent(cb: (event: AgentEvent) => void): () => void;

  /** 会话列表（session_list，按 updated_at 倒序） */
  listSessions(): Promise<AgentSessionMeta[]>;
  /** 新建会话（agent_start_session：workspace + 模式 + 模型直达引用（0023 可选）；
   *  title 可选初始标题（IM embedded 来源名「与xxx的对话」），缺省占位由首条消息 rename 派生；
   *  origin 场景来源（2026-11-23，embedded 专用），任务/项目不传 */
  startSession(workspace: string, mode: PermissionMode, model?: string, title?: string, origin?: SessionOriginInfo): Promise<AgentSessionMeta>;
  /** 发送用户消息（agent_input；UI 乐观上屏，回复经 streamDelta 事件回流）；
   *  thinking 思考三档（2026-11-11 轮级生效）缺省=medium */
  sendMessage(sessionId: string, text: string, thinking?: 'low' | 'medium' | 'high'): Promise<void>;
  /** 会话内切换模型（agent_switch_model：model 非空=直达引用；to 为名义档位；
   *  model 缺省=清引用回档位。回执 modelSwitched 事件） */
  switchModel(sessionId: string, to: 'fast' | 'strong' | 'auto', model?: string): Promise<void>;
  /** 中断当前轮（agent_interrupt：LLM 流内/工具间检查点断，收口 idle 可继续追问；
   *  2026-11-11 取代旧 pause/resume 用户通道——暂停按钮已移除） */
  interrupt(sessionId: string): Promise<void>;
  /** 会话重命名（agent_rename：RT 落库 + 宿主缓存同步；返回截断后的最终标题） */
  renameSession(sessionId: string, title: string): Promise<string>;
  /** 结束会话（agent_stop，reason=user） */
  endSession(sessionId: string): Promise<void>;
  /** 会话历史（session.history 直读 WAL：打开会话加载聊天记录；空=无历史；
   *  D36：附最后一条 assistant.done 用量（重启后状态条恢复）） */
  loadHistory(sessionId: string): Promise<HistoryLoadResult>;
  /** run 历史（D33 run.history：子 agent 侧栏过程回放——spawn→User/trace→Assistant·Tool；空=无过程行） */
  loadRunHistory(runId: string): Promise<HistoryItem[]>;
  /** 全局紧急停止（agent_emergency_stop：杀进程组 + 未决审批作废，INT-AG-12） */
  emergencyStop(): Promise<void>;
  /** 审批回应（agent_approve / agent_reject；editedArgs=命令卡改后回传，09 §6.1） */
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: GrantScope,
    editedArgs?: Record<string, unknown>,
  ): Promise<void>;
  /** 澄清回答（D20 agent_clarify_respond；answers=所选 label，freeText=「其他」补充） */
  respondClarify(questionId: string, answers: string[], freeText?: string): Promise<void>;
  /** 会话内切换权限模式（agent_set_mode） */
  setMode(sessionId: string, mode: PermissionMode): Promise<void>;

  /** 取消后台 run（agent_run_cancel → run.cancel：terminal 后台命令/探查/专家通用） */
  cancelRun(runId: string): Promise<void>;

  /** D19 项目登记（workspace.register：realpath upsert，同目录重复打开不换身份） */
  registerWorkspace(path: string, name?: string): Promise<AgentWorkspaceInfo>;
  /** D19 项目列表（workspace.list；last_opened_at 倒序） */
  listWorkspaces(): Promise<AgentWorkspaceInfo[]>;
  /** D19 项目移除登记（workspace.forget；只删登记，不动会话/记忆分区） */
  forgetWorkspace(id: string): Promise<void>;

  /** run 清单（D16 §3.1 runs.list；sessionId 缺省=全部） */
  listRuns(sessionId?: string): Promise<RunInfo[]>;
}

// ---- 展示映射（纯数据，组件与 store 共用）----

/** D11 §3 状态枚举中文（状态徽标/列表状态点共用） */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  waiting_permission: '等待审批',
  waiting_clarify: '等你回答',
  subagent_fanout: '子任务并行',
  paused: '已暂停',
  error: '错误',
  ended: '已结束',
};

/** 权限模式官方中文名与一句话说明（D13-A1 §2；full-auto 升档需二次确认） */
export const AGENT_MODE_OPTIONS: Array<{ value: PermissionMode; label: string; desc: string }> = [
  { value: 'ask', label: '变更前确认', desc: '任何变更（写文件/执行命令）前都先问你' },
  { value: 'auto-edit', label: '自主', desc: '文件修改自动执行；危险命令仍需审批' },
  { value: 'full-auto', label: '完全控制', desc: '文件+白名单命令全自动，仅"永不全自动清单"保留审批' },
];

/** 风险级中文（工具卡/审批卡徽标） */
export const RISK_LABELS: Record<RiskLevel, string> = { low: '低危', mid: '中危', high: '高危' };

/** 模型档位显示（model_policy / model.switched） */
export const MODEL_TIER_LABELS: Record<'fast' | 'strong' | 'auto', string> = { fast: '快', strong: '强', auto: '自动' };

/** run 类型中文（右栏内容坞 tab/历史子任务下拉共用） */
export const RUN_KIND_LABELS: Record<RunInfo['kind'], string> = { probe: '探查', expert: '专家', terminal: '终端' };

/** run 状态中文（同上） */
export const RUN_STATUS_LABELS: Record<RunInfo['status'], string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
