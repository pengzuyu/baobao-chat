/**
 * TauriAgentBridge：真实宿主桥接（@tauri-apps/api invoke + listen）。
 *
 * ## Rust 侧待接命令清单（client/src-tauri 内实现；本文件只做前端封装，不改 Rust）
 * 事件名统一 `agent://event`，payload = D08 §5.2 表（stdio 协议镜像）的 snake_case JSON，
 * 由本类的 normalizeEvent() 转 camelCase AgentEvent。
 *
 * | 前端调用 | Tauri 命令 | 参数 → 返回（D08 §5.1） |
 * |---|---|---|
 * | listSessions() | `session_list` | `{ cursor?: string }` → `{ items: SessionRow[], next_cursor }`（agent_session 表读，updated_at 倒序） |
 * | startSession() | `agent_start_session` | `{ workspace_id?: string, form: 'workbench', mode: PermissionMode, model_policy: 'auto' }` → `{ session_id }` |
 * | sendMessage() | `agent_input` | `{ session_id, text, attachments?: [] }` → `{ ok: true }` |
 * | pause() | `agent_pause` | `{ session_id }` → `{ ok }` |
 * | resume() | `agent_resume` | `{ session_id }` → `{ ok }` |
 * | endSession() | `agent_stop` | `{ session_id, reason: 'user' }` → `{ ok }` |
 * | emergencyStop() | `agent_emergency_stop` | `{}` → `{ killed_pids: number[], cancelled_requests: string[] }` |
 * | respondPermission(allow) | `agent_approve` | `{ request_id, scope: 'once'\|'session'\|'permanent', edited_args? }` → `{ ok }` |
 * | respondPermission(deny) | `agent_reject` | `{ request_id, reason? }` → `{ ok }` |
 * | setMode() | `agent_set_mode` | `{ session_id, mode }` → `{ ok, effective }` |
 * | listMemories() | `memory_list` | `{}` → `{ items: [{ name, title, type, updated_at, hook, session }] }`（D15 §2.4） |
 * | deleteMemory() | `memory_delete` | `{ name }` → `{ ok }`（D15 §2.4） |
 * | listReports() | `report_list` + `report_get` | `{ limit?: number }` → `{ items: [{ date, stats }] }`；正文需扩展 `report_get { date } → { markdown }`（D15 §3.3 只登记了 list，正文为前端消费扩展） |
 *
 * 事件 payload 字段（宿主透传 stdio 协议镜像 + 宿主补充）：
 * - `stream.delta` { session_id, delta, seq, channel } / `stream.done` { session_id, finish_reason, usage }
 * - `session.state` { session_id, state, reason } / `session.ended` { session_id, summary }
 * - `tool.call` { session_id, call_id, tool, args, risk, parallel, source }
 * - `tool.result` { session_id, call_id, ok, summary, truncated, exit_code, duration_ms, blocked }
 * - `permission.request` { session_id, request_id, tool, risk, reason, preview, options, expires_at }
 * - `permission.response` { session_id, request_id, decision, scope }
 * - `checkpoint.created` { session_id, checkpoint_id, files_changed, reason }
 * - `model.switched` { session_id, from, to, reason }
 * - `memory.saved` { session_id, name, title, type, updated }（D15 §2.4）
 * - `report.daily` { date, path, stats }（D15 §3.3）
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AgentBridge,
  AgentEvent,
  AgentReport,
  AgentSessionMeta,
  GrantScope,
  MemoryEntry,
  MemoryType,
  PermissionMode,
  PermissionPreview,
  ReportStats,
  RiskLevel,
  RunInfo,
  SessionStatus,
} from './types';

/** Tauri WebView 注入标记：存在才启用真实桥（否则 getAgentBridge() 回落 mock） */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---- 宿主返回的 snake_case 行类型（局部映射，不外泄）----

interface SessionRow {
  id: string;
  title: string;
  workspace: string;
  mode: PermissionMode;
  model_policy: 'fast' | 'strong' | 'auto';
  /** 0023 模型直达引用（agent_session.model_override） */
  model_override?: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  ended_at?: number;
  summary?: string;
}

interface MemoryRow {
  name: string;
  title: string;
  type: MemoryType;
  hook: string;
  updated_at: number;
  session?: string;
}

interface ReportRow {
  date: string;
  stats: ReportStats;
}

/** 宿主推送的原始事件（snake_case；type 为点号协议名） */
interface RawAgentEvent {
  type: string;
  [k: string]: unknown;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function mapSession(row: SessionRow): AgentSessionMeta {
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace,
    mode: row.mode,
    modelPolicy: row.model_policy,
    modelOverride: row.model_override,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    summary: row.summary,
  };
}

export class TauriAgentBridge implements AgentBridge {
  readonly kind = 'tauri' as const;

  constructor() {
    // 运行时探测：非 Tauri WebView（纯浏览器 dev/preview）直接抛错，由 getAgentBridge() 回落 mock
    if (!isTauriAvailable()) {
      throw new Error('TauriAgentBridge 仅能在 Tauri WebView 中使用（window.__TAURI_INTERNALS__ 缺失）');
    }
  }

  onEvent(cb: (event: AgentEvent) => void): () => void {
    // listen 返回 UnlistenFn（Promise）；包装成同步取消函数
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<RawAgentEvent>('agent://event', (e) => {
      const mapped = normalizeEvent(e.payload);
      if (mapped) cb(mapped);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }

  async listSessions(): Promise<AgentSessionMeta[]> {
    const data = await invoke<{ items: SessionRow[] }>('session_list', {});
    return data.items.map(mapSession).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async startSession(workspace: string, mode: PermissionMode, model?: string): Promise<AgentSessionMeta> {
    const ack = await invoke<{ session_id: string }>('agent_start_session', {
      workspaceId: workspace,
      form: 'workbench',
      mode,
      modelPolicy: 'auto',
      // 0023 模型直达引用（p:<id>:<model>）；缺省=档位别名（宿主命令透传 Runtime session.start）
      model: model ?? null,
    });
    // 起始元信息由 session.state 事件补全；先给最小可用投影
    return {
      id: ack.session_id,
      title: '新会话',
      workspace,
      mode,
      modelPolicy: 'auto',
      modelOverride: model,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await invoke('agent_input', { sessionId, text });
  }

  async switchModel(sessionId: string, to: 'fast' | 'strong' | 'auto', model?: string): Promise<void> {
    // 回执经 agent://event 的 model.switched 镜像事件
    await invoke('agent_switch_model', { sessionId, to, model: model ?? null });
  }

  async pause(sessionId: string): Promise<void> {
    await invoke('agent_pause', { sessionId });
  }

  async resume(sessionId: string): Promise<void> {
    await invoke('agent_resume', { sessionId });
  }

  async endSession(sessionId: string): Promise<void> {
    await invoke('agent_stop', { sessionId, reason: 'user' });
  }

  async emergencyStop(): Promise<void> {
    await invoke('agent_emergency_stop');
  }

  async respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: GrantScope,
    editedArgs?: Record<string, unknown>,
  ): Promise<void> {
    if (decision === 'allow') {
      await invoke('agent_approve', { requestId, scope: scope ?? 'once', editedArgs });
      return;
    }
    await invoke('agent_reject', { requestId });
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await invoke('agent_set_mode', { sessionId, mode });
  }

  async launchDelegate(sessionId: string, runId: string, backend: string): Promise<void> {
    // taskBrief=null=沿用模型简报原稿（D16 主路径：确认不改稿）
    await invoke('agent_delegate_launch', { sessionId, delegateTaskId: runId, backend, taskBrief: null });
  }

  async delegateInput(runId: string, text: string): Promise<void> {
    await invoke('agent_delegate_input', { delegateTaskId: runId, text });
  }

  async cancelDelegate(runId: string): Promise<void> {
    await invoke('agent_delegate_cancel', { delegateTaskId: runId });
  }

  async reviewDelegate(runId: string, accept: boolean): Promise<void> {
    await invoke('agent_delegate_review', { delegateTaskId: runId, accept });
  }

  async listMemories(): Promise<MemoryEntry[]> {
    const data = await invoke<{ items: MemoryRow[] }>('memory_list', {});
    return data.items.map((m) => ({
      name: m.name,
      title: m.title,
      type: m.type,
      hook: m.hook,
      updatedAt: m.updated_at,
      sessionId: m.session ?? '',
    }));
  }

  async deleteMemory(name: string): Promise<void> {
    await invoke('memory_delete', { name });
  }

  async listRuns(sessionId?: string): Promise<RunInfo[]> {
    const data = await invoke<{ items: RunInfo[] }>('agent_runs_list', { sessionId: sessionId ?? null });
    return data.items;
  }

  async listReports(): Promise<AgentReport[]> {
    const data = await invoke<{ items: ReportRow[] }>('report_list', { limit: 30 });
    // 正文按日拉取（宿主扩展命令；缺省实现可先返回空串，UI 优雅降级）
    const reports = await Promise.all(
      data.items.map(async (row) => {
        let markdown = '';
        try {
          const full = await invoke<{ markdown: string }>('report_get', { date: row.date });
          markdown = full.markdown;
        } catch {
          markdown = `# ${row.date} Agent 日报\n\n（正文暂不可用：宿主未实现 report_get）`;
        }
        return { date: row.date, stats: row.stats, markdown } satisfies AgentReport;
      }),
    );
    return reports.sort((a, b) => (a.date < b.date ? 1 : -1));
  }
}

/** snake_case 原始事件 → camelCase AgentEvent（未知 type 忽略，前向兼容 D11 编解码规则） */
export function normalizeEvent(raw: RawAgentEvent): AgentEvent | null {
  const sid = str(raw.session_id);
  switch (raw.type) {
    case 'stream.delta':
      return {
        type: 'streamDelta',
        sessionId: sid,
        seq: num(raw.seq),
        delta: str(raw.delta),
        channel: raw.channel === 'reasoning' ? 'reasoning' : 'text',
      };
    case 'stream.done':
      return {
        type: 'streamDone',
        sessionId: sid,
        finishReason: str(raw.finish_reason, 'stop'),
        usage: {
          in: num((raw.usage as { in?: number } | undefined)?.in),
          out: num((raw.usage as { out?: number } | undefined)?.out),
        },
      };
    case 'session.state':
      return {
        type: 'stateChanged',
        sessionId: sid,
        state: str(raw.state) as SessionStatus,
        reason: str(raw.reason) || undefined,
      };
    case 'session.ended':
      return { type: 'sessionEnded', sessionId: sid, summary: str(raw.summary) };
    case 'tool.call':
      return {
        type: 'toolCall',
        sessionId: sid,
        callId: str(raw.call_id),
        tool: str(raw.tool),
        args: (raw.args as Record<string, unknown> | undefined) ?? {},
        risk: (str(raw.risk) as RiskLevel) || 'low',
        parallel: raw.parallel === true,
        source: raw.source === 'backend' ? 'backend' : 'self',
      };
    case 'tool.result': {
      const blocked = raw.blocked as { rule?: string; kind?: string; code?: number } | undefined;
      return {
        type: 'toolResult',
        sessionId: sid,
        callId: str(raw.call_id),
        ok: raw.ok === true,
        summary: str(raw.summary),
        truncated: raw.truncated === true,
        exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : undefined,
        durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
        blocked:
          blocked && typeof blocked.code === 'number'
            ? {
                rule: str(blocked.rule),
                kind: (str(blocked.kind) as 'rule') || 'rule',
                code: blocked.code,
              }
            : undefined,
      };
    }
    case 'permission.request':
      return {
        type: 'permissionRequest',
        sessionId: sid,
        requestId: str(raw.request_id),
        tool: str(raw.tool),
        risk: (str(raw.risk) as RiskLevel) || 'mid',
        reason: str(raw.reason),
        preview: (raw.preview as PermissionPreview | undefined) ?? { kind: 'command', command: '', cwd: '', dangerFlags: [] },
        options: (raw.options as GrantScope[] | undefined) ?? ['once'],
        expiresAt: num(raw.expires_at, Date.now() + 120_000),
      };
    case 'permission.response':
      return {
        type: 'permissionResponse',
        sessionId: sid,
        requestId: str(raw.request_id),
        decision: raw.decision === 'allow' ? 'allow' : raw.decision === 'cancelled' ? 'cancelled' : 'deny',
        scope: raw.scope as GrantScope | undefined,
      };
    case 'checkpoint.created':
      return {
        type: 'checkpointCreated',
        sessionId: sid,
        checkpointId: str(raw.checkpoint_id),
        filesChanged: (raw.files_changed as string[] | undefined) ?? [],
        reason: str(raw.reason),
      };
    case 'model.switched':
      return {
        type: 'modelSwitched',
        sessionId: sid,
        from: (str(raw.from) || 'auto') as 'fast' | 'strong' | 'auto',
        to: (str(raw.to) || 'auto') as 'fast' | 'strong' | 'auto',
        modelOverride: raw.model ? str(raw.model) : undefined,
        reason: str(raw.reason),
      };
    case 'memory.saved':
      return {
        type: 'memorySaved',
        sessionId: sid,
        name: str(raw.name),
        title: str(raw.title),
        memoryType: (str(raw.type) as MemoryType) || 'project',
        updated: raw.updated === true,
      };
    case 'report.daily':
      return {
        type: 'reportDaily',
        date: str(raw.date),
        path: str(raw.path),
        stats: (raw.stats as ReportStats | undefined) ?? { sessions: 0, tools: 0, blocked: 0, files: 0, memorySaved: 0 },
      };
    case 'subagent.spawn':
      return {
        type: 'subagentSpawn',
        sessionId: sid,
        runId: str(raw.sub_id),
        taskDigest: str(raw.task_digest),
        toolSubset: (raw.tool_subset as string[] | undefined) ?? [],
      };
    case 'subagent.event':
      return {
        type: 'subagentEvent',
        sessionId: sid,
        runId: str(raw.sub_id),
        phase: (['spawn', 'delta', 'done', 'fail'].includes(str(raw.phase)) ? str(raw.phase) : 'delta') as 'spawn' | 'delta' | 'done' | 'fail',
        summary: raw.summary ? str(raw.summary) : undefined,
      };
    case 'subagent.join':
      return {
        type: 'subagentJoin',
        sessionId: sid,
        results: ((raw.results as Array<{ sub_id?: string; ok?: boolean; summary?: string }> | undefined) ?? []).map((r) => ({
          runId: str(r.sub_id),
          ok: r.ok === true,
          summary: str(r.summary),
        })),
      };
    case 'delegate.event': {
      const runId = str(raw.delegate_task_id);
      const kind = str(raw.kind);
      const payload = (raw.payload as Record<string, unknown> | undefined) ?? {};
      // meta 复合：简报待确认信号 / 审查结论镜像（bbrt bridge 映射口径）
      if (kind === 'meta' && payload.brief_pending === true) {
        return { type: 'delegateBrief', sessionId: sid, runId, backendSuggestion: str(payload.backend_suggestion) };
      }
      if (kind === 'meta' && typeof payload.review === 'string') {
        return { type: 'delegateReviewResolved', sessionId: sid, runId, decision: payload.review === 'accept' ? 'accept' : 'reject' };
      }
      return { type: 'delegateEvt', sessionId: sid, runId, kind, payload };
    }
    case 'delegate.end':
      return {
        type: 'delegateEnd',
        sessionId: sid,
        runId: str(raw.delegate_task_id),
        exitCode: num(raw.exit_code, -1),
        summary: str(raw.summary),
        changedFiles: (raw.changed_files as string[] | undefined) ?? [],
        checkpointId: raw.checkpoint_id ? str(raw.checkpoint_id) : undefined,
        childSessionRef: raw.child_session_ref ? str(raw.child_session_ref) : undefined,
      };
    default:
      return null; // 未知事件忽略 + 上层计数（前向兼容）
  }
}
