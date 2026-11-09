/**
 * Agent Bridge 层类型（权威：D08 §5/§6.3、D11 §3/§4、D15 §2.4/§3.3）：
 * - UI 与宿主（Tauri Rust 核心 → stdio Runtime）之间的前端友好视图：
 *   协议字段 snake_case → camelCase，点号事件名 → camelCase 联合类型成员
 * - 事件 payload 字段名与 D11 §4 全消息表一一对应（stream.delta/tool.call/permission.request…）
 * - 实现两份：bridge/mock.ts（定时器剧本，dev/preview 可演示）、bridge/tauri.ts（真实 IPC）
 */

/** 权限模式三档（09 §3.3；中文名见 AGENT_MODE_OPTIONS，D13-A1 官方口径） */
export type PermissionMode = 'ask' | 'auto-edit' | 'full-auto';

/** 会话状态机枚举（D11 §3，9+1 态；session.state 上报同款） */
export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'waiting_review'
  | 'subagent_fanout'
  | 'delegating'
  | 'paused'
  | 'error'
  | 'ended';

/** 工具风险级（09 §4.1 矩阵输入） */
export type RiskLevel = 'low' | 'mid' | 'high';

/** 审批记忆粒度（09 §4.2 三级记忆） */
export type GrantScope = 'once' | 'session' | 'permanent';

/** 知识记忆四类（D15 §2.1 frontmatter type） */
export type MemoryType = 'user' | 'project' | 'feedback' | 'reference';

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
}

/** 知识记忆条目（D15 §2.1：一文件一事实 + MEMORY.md 索引行） */
export interface MemoryEntry {
  /** slug（文件名），删除即 memory.delete(name) */
  name: string;
  /** 一句话标题 ≤40 字 */
  title: string;
  type: MemoryType;
  /** 钩子摘要（索引行 "- [标题](文件) — 钩子"的钩子部分） */
  hook: string;
  updatedAt: number;
  /** 产生该记忆的会话 */
  sessionId: string;
}

/** 日报统计概览（D15 §3.3 report.daily stats） */
export interface ReportStats {
  sessions: number;
  tools: number;
  blocked: number;
  files: number;
  memorySaved: number;
}

/** 单日日报（D15 §3.2：md 人读产物 + json UI 消费） */
export interface AgentReport {
  /** YYYY-MM-DD */
  date: string;
  stats: ReportStats;
  /** 日报 markdown 正文（会话数/工具排行/拦截/文件变更/记忆条目/会话明细表） */
  markdown: string;
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

/**
 * UI 订阅的 Agent 事件联合（D08 §5.2 IPC 事件表的 camelCase 镜像）。
 * 命名 ↔ 协议：streamDelta=stream.delta / stateChanged=session.state /
 * toolCall=tool.call / toolResult=tool.result / permissionRequest=permission.request /
 * permissionResponse=permission.response / memorySaved=memory.saved（D15 §2.4）/
 * reportDaily=report.daily（D15 §3.3）/ checkpointCreated=checkpoint.created（D11 §4）/
 * modelSwitched=model.switched / sessionEnded=session.ended
 */
export type AgentEvent =
  | { type: 'streamDelta'; sessionId: string; seq: number; delta: string; channel: 'text' | 'reasoning' }
  | { type: 'streamDone'; sessionId: string; finishReason: string; usage: { in: number; out: number } }
  | { type: 'stateChanged'; sessionId: string; state: SessionStatus; reason?: string }
  | {
      type: 'toolCall';
      sessionId: string;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      risk: RiskLevel;
      parallel?: boolean;
      source?: 'self' | 'backend';
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
      /** created_at + 120000（D08 §6.1；到点未决=拒绝） */
      expiresAt: number;
    }
  | {
      type: 'permissionResponse';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny' | 'cancelled';
      scope?: GrantScope;
    }
  | { type: 'memorySaved'; sessionId: string; name: string; title: string; memoryType: MemoryType; updated: boolean }
  | { type: 'reportDaily'; date: string; path: string; stats: ReportStats }
  | { type: 'sessionEnded'; sessionId: string; summary: string }
  | { type: 'checkpointCreated'; sessionId: string; checkpointId: string; filesChanged: string[]; reason: string }
  | { type: 'modelSwitched'; sessionId: string; from: 'fast' | 'strong' | 'auto'; to: 'fast' | 'strong' | 'auto'; modelOverride?: string; reason: string };

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
  /** 新建会话（agent_start_session：workspace + 模式 + 模型直达引用（0023 可选）；form 固定 workbench） */
  startSession(workspace: string, mode: PermissionMode, model?: string): Promise<AgentSessionMeta>;
  /** 发送用户消息（agent_input；UI 乐观上屏，回复经 streamDelta 事件回流） */
  sendMessage(sessionId: string, text: string): Promise<void>;
  /** 会话内切换模型（agent_switch_model：model 非空=直达引用；to 为名义档位；
   *  model 缺省=清引用回档位。回执 modelSwitched 事件） */
  switchModel(sessionId: string, to: 'fast' | 'strong' | 'auto', model?: string): Promise<void>;
  /** 暂停/恢复（agent_pause / agent_resume，D11 §3 迁移 16/17） */
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** 结束会话（agent_stop，reason=user） */
  endSession(sessionId: string): Promise<void>;
  /** 全局紧急停止（agent_emergency_stop：杀进程组 + 未决审批作废，INT-AG-12） */
  emergencyStop(): Promise<void>;
  /** 审批回应（agent_approve / agent_reject；editedArgs=命令卡改后回传，09 §6.1） */
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: GrantScope,
    editedArgs?: Record<string, unknown>,
  ): Promise<void>;
  /** 会话内切换权限模式（agent_set_mode） */
  setMode(sessionId: string, mode: PermissionMode): Promise<void>;

  /** 知识记忆列表（D15 §2.4 memory.list） */
  listMemories(): Promise<MemoryEntry[]>;
  /** 删除知识记忆（D15 §2.4 memory.delete；PAG-11 撤销） */
  deleteMemory(name: string): Promise<void>;

  /** 日报列表（D15 §3.3 report.list + 报告正文） */
  listReports(): Promise<AgentReport[]>;
}

// ---- 展示映射（纯数据，组件与 store 共用）----

/** D11 §3 状态枚举中文（状态徽标/列表状态点共用） */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  starting: '启动中',
  idle: '空闲',
  running: '运行中',
  waiting_permission: '等待审批',
  waiting_review: '等待审查',
  subagent_fanout: '子任务并行',
  delegating: '委派中',
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

/** 记忆类型中文（D15 §2.1 四类） */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  user: '用户偏好',
  project: '项目事实',
  feedback: '工作反馈',
  reference: '外部参考',
};

/** 模型档位显示（model_policy / model.switched） */
export const MODEL_TIER_LABELS: Record<'fast' | 'strong' | 'auto', string> = { fast: '快', strong: '强', auto: '自动' };
