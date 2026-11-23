/**
 * MockAgentBridge：定时器驱动的完整剧本（无 Tauri/无后端时可真实演示）。
 * 剧本（对齐任务验收路径）：
 * - 发消息 → stateChanged(running) → 思考摘要 + streamDelta 分片输出（80ms/片）
 *   → toolCall(read_file foo.txt) → 3s 后 toolResult(ok) → 结论流 → streamDone → idle
 * - 再发一条 → modelSwitched(升档) → toolCall(run_command) → permission.request
 *   （cargo test，risk=high，命令预览可编辑，仅 once/session 两档）
 *   → 允许：toolResult(exit 0 通过)；拒绝/超时：toolResult(blocked 红条带)
 *   → memory.saved 事件 → sessionEnded
 * 暂停会冻结剧本时钟；紧急停止作废未决审批并结束。
 */

import type {
  AgentBridge,
  AgentEvent,
  AgentSessionMeta,
  AgentWorkspaceInfo,
  GrantScope,
  HistoryItem,
  HistoryLoadResult,
  RunInfo,
  PermissionMode,
  PermissionPreview,
} from './types';

const STREAM_INTERVAL_MS = 80; // 分片节奏（任务约定）
const READ_FILE_RESULT_DELAY_MS = 3000; // read_file 运行时长
const RUN_COMMAND_RESULT_DELAY_MS = 2600; // run_command 运行时长
const PERMISSION_TIMEOUT_MS = 120_000; // 审批 120s 倒计时（D08 §3.4）
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把文本切成 N 字符的小片，模拟 token 级流式（CJK 友好） */
function chunks(text: string, size = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 剧本被取消（endSession/紧急停止） */
class ScriptCancelled extends Error {}

/** 单会话剧本运行上下文：wait() 在暂停期间冻结时钟，取消时抛出 */
class ScriptContext {
  paused = false;
  /** 在飞工具调用（callId 集合）：toolCall 发出后登记、toolResult 到达移除；
   *  interrupt 时统一补失败结果收口（对齐 bbrt 中断收口语义，工具卡不留「运行中」） */
  inFlightCalls = new Set<string>();
  private cancelledFlag = false;

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  cancel(): void {
    this.cancelledFlag = true;
  }

  async wait(ms: number): Promise<void> {
    let remain = ms;
    while (remain > 0) {
      if (this.cancelledFlag) throw new ScriptCancelled();
      if (this.paused) {
        await delay(120);
        continue; // 暂停期间时钟停走（D08 暂停语义）
      }
      const step = Math.min(80, remain);
      await delay(step);
      remain -= step;
    }
    if (this.cancelledFlag) throw new ScriptCancelled();
  }
}

/** 审批回应结果（mock 侧收口：用户回应或 120s 超时=拒绝） */
interface PermissionAnswer {
  decision: 'allow' | 'deny';
  scope: GrantScope;
  editedArgs?: Record<string, unknown>;
  timedOut: boolean;
}

interface PendingPermission {
  sessionId: string;
  requestId: string;
  resolve: (v: PermissionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 澄清回答（D20；null=被中断，剧本协程随之弃置） */
interface ClarifyAnswerMsg {
  answers: string[];
  freeText?: string;
}

interface PendingClarify {
  sessionId: string;
  questionId: string;
  resolve: (v: ClarifyAnswerMsg | null) => void;
}

const now = Date.now();

/** 演示用固定数据（与 IM mock 同思路：桩数据集中，不散落组件） */
function seedSessions(): AgentSessionMeta[] {
  return [
    {
      id: 'sess-mock-01',
      title: '修复登录超时',
      workspace: '~/code/bbc-server',
      mode: 'auto-edit',
      modelPolicy: 'auto',
      status: 'paused',
      createdAt: now - 3 * HOUR,
      updatedAt: now - 40 * MIN,
    },
    {
      id: 'sess-mock-02',
      title: '退款接口调研',
      workspace: '~/code/order-svc',
      mode: 'ask',
      modelPolicy: 'fast',
      status: 'ended',
      createdAt: now - 2 * DAY,
      updatedAt: now - DAY - 2 * HOUR,
      endedAt: now - DAY - 2 * HOUR,
      summary: '产出 POST /refunds 接口方案与错误码约定，已同步给 PM',
    },
    {
      id: 'sess-mock-03',
      title: '周报草稿',
      // D19：日常对话（无工作目录——文件/命令类工具不可用）
      workspace: '',
      mode: 'ask',
      modelPolicy: 'auto',
      status: 'idle',
      createdAt: now - 5 * HOUR,
      updatedAt: now - 3 * HOUR,
    },
  ];
}

/** D19 演示项目登记（workspace.list 口径；path 即身份） */
function seedWorkspaces(): AgentWorkspaceInfo[] {
  return [
    {
      id: 'ws-mock-01',
      path: '/Users/demo/code/bbc-server',
      name: 'bbc-server',
      isRepo: true,
      trusted: true,
      lastOpenedAt: now - 40 * MIN,
      createdAt: now - 6 * DAY,
    },
    {
      id: 'ws-mock-02',
      path: '/Users/demo/code/order-svc',
      name: 'order-svc',
      isRepo: true,
      trusted: true,
      lastOpenedAt: now - DAY - 2 * HOUR,
      createdAt: now - 20 * DAY,
    },
  ];
}


export class MockAgentBridge implements AgentBridge {
  readonly kind = 'mock' as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private sessions: AgentSessionMeta[] = seedSessions();
  /** D19 项目登记（workspace.list/register/forget 演示数据） */
  private workspaces: AgentWorkspaceInfo[] = seedWorkspaces();
  /** sessionId → 已发送轮次（第 2 轮触发审批剧本） */
  private rounds = new Map<string, number>();
  /** sessionId → 剧本上下文 */
  private contexts = new Map<string, ScriptContext>();
  /** requestId → 未决审批 */
  private pending = new Map<string, PendingPermission>();
  /** D20 待决提问（无超时；中断/紧急停止时镜像 cancelled 收口） */
  private pendingClarifies = new Map<string, PendingClarify>();
  private seqCounters = new Map<string, number>();
  private sessionSeq = 0;

  // ---- 事件通道 ----

  onEvent(cb: (event: AgentEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: AgentEvent): void {
    this.listeners.forEach((cb) => cb(event));
  }

  private nextSeq(sessionId: string): number {
    const n = (this.seqCounters.get(sessionId) ?? 0) + 1;
    this.seqCounters.set(sessionId, n);
    return n;
  }

  private touch(sessionId: string): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.updatedAt = Date.now();
  }

  // ---- 会话管理 ----

  async listSessions(): Promise<AgentSessionMeta[]> {
    await delay(250);
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async startSession(workspace: string, mode: PermissionMode, model?: string, title?: string, _origin?: import('./types').SessionOriginInfo): Promise<AgentSessionMeta> {
    await delay(200);
    this.sessionSeq += 1;
    // D19：项目会话自动登记（对齐 bbrt manager.start 的 realpath upsert 行为）
    if (workspace) {
      const name = workspace.split('/').filter(Boolean).pop() ?? '项目';
      const existing = this.workspaces.find((w) => w.path === workspace);
      if (existing) {
        existing.lastOpenedAt = Date.now();
      } else {
        this.workspaces.unshift({
          id: `ws-mock-n${Date.now()}`,
          path: workspace,
          name,
          isRepo: true,
          trusted: true,
          lastOpenedAt: Date.now(),
          createdAt: Date.now(),
        });
      }
    }
    // 建会话即 idle（对齐真实桥：session.start 同步等完 session.ready 回执才返回）
    const meta: AgentSessionMeta = {
      id: `sess-mock-n${this.sessionSeq}`,
      title: title?.trim() || '新会话',
      workspace,
      mode,
      modelPolicy: 'auto',
      modelOverride: model,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.unshift(meta);
    return { ...meta };
  }

  async switchModel(sessionId: string, to: 'fast' | 'strong' | 'auto', model?: string): Promise<void> {
    await delay(120);
    const meta = this.sessions.find((s) => s.id === sessionId);
    const from = meta?.modelPolicy ?? 'auto';
    if (meta) {
      meta.modelPolicy = to;
      meta.modelOverride = model;
      meta.updatedAt = Date.now();
    }
    this.emit({ type: 'modelSwitched', sessionId, from, to, modelOverride: model, reason: 'user' });
  }

  async sendMessage(sessionId: string, _text: string, _thinking?: 'low' | 'medium' | 'high'): Promise<void> {
    let s = this.sessions.find((x) => x.id === sessionId);
    if (!s) {
      // 会话不死（revive 兜底）：embedded 映射跨页面重载持久（IndexedDB），而 mock
      // 内存态随重载重置——模拟 bbrt 从 SQLite 还原库行：合成会话行继续跑
      // （真实链路会话在库内持久，此处对齐语义，避免演示流「发消息无反应」）
      s = {
        id: sessionId,
        title: 'Agent 会话',
        workspace: '',
        mode: 'ask',
        modelPolicy: 'auto',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.unshift(s);
    }
    // 会话不死（2026-11-11）：ended/paused 会话 input 即复活（对齐 bbrt revive 语义）
    if (s.status === 'ended' || s.status === 'paused') {
      s.status = 'idle';
      this.emit({ type: 'stateChanged', sessionId, state: 'idle', reason: 'revived' });
    }
    const round = (this.rounds.get(sessionId) ?? 0) + 1;
    this.rounds.set(sessionId, round);
    // 标题派生上移 store 层（统一 20 字首行规则 + renameSession 通道），桥不再自派生
    this.touch(sessionId);
    const ctx = new ScriptContext();
    this.contexts.set(sessionId, ctx);
    if (round === 1) void this.scriptReadFile(s, ctx);
    else if (round === 2) void this.scriptRunCommand(s, ctx);
    else if (round === 3) void this.scriptAskUser(s, ctx);
    else if (round === 4) void this.scriptSkillAndSubagent(s, ctx);
    else void this.scriptRunCommand(s, ctx);
  }

  /** 中断当前轮（2026-11-11：取代旧 pause/resume——收口 idle 可继续追问） */
  async interrupt(sessionId: string): Promise<void> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) {
      ctx.cancel();
      // 在飞工具统一补「已中断」失败结果（剧本取消后不再发 result，
      // 不补则工具卡永远停在「运行中」）
      for (const callId of ctx.inFlightCalls) {
        this.emit({ type: 'toolResult', sessionId, callId, ok: false, summary: '已被中断' });
      }
      ctx.inFlightCalls.clear();
    }
    // 未决审批作废（同 emergencyStop 口径：cancelled 镜像收口，审批卡不再倒计时；
    // 脚本协程随 ctx.cancel 弃置，承诺不 resolve）
    for (const [requestId, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.emit({ type: 'permissionResponse', sessionId, requestId, decision: 'cancelled' });
    }
    // D20 未决提问作废（cancelled 镜像；协程 resolve(null) 弃置）
    for (const [questionId, q] of this.pendingClarifies) {
      if (q.sessionId !== sessionId) continue;
      this.pendingClarifies.delete(questionId);
      this.emit({ type: 'clarifyResponse', sessionId, questionId, decision: 'cancelled', answers: '' });
      q.resolve(null);
    }
    this.contexts.delete(sessionId);
    this.setStatus(sessionId, 'idle', 'user-interrupt');
  }

  async renameSession(sessionId: string, title: string): Promise<string> {
    await delay(60);
    const t = title.trim().slice(0, 20);
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s && t) {
      s.title = t;
      s.updatedAt = Date.now();
    }
    return t;
  }

  async endSession(sessionId: string): Promise<void> {
    this.finishSession(sessionId, '会话已结束（用户主动结束）');
  }

  async loadHistory(_sessionId: string): Promise<HistoryLoadResult> {
    // mock 剧本是内存态不落 WAL——历史加载返回空（真实链路 session.history 读库）
    return { items: [] };
  }

  async loadRunHistory(_runId: string): Promise<HistoryItem[]> {
    // D33：mock 剧本 trace 不落 WAL——回放返回空（侧栏直播期可见）
    return [];
  }

  async emergencyStop(): Promise<void> {
    // 三入口一致语义（INT-AG-12）：杀剧本 + 未决审批/提问作废 + 会话暂停展示
    for (const [requestId, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.emit({ type: 'permissionResponse', sessionId: p.sessionId, requestId, decision: 'cancelled' });
    }
    for (const [questionId, q] of this.pendingClarifies) {
      this.pendingClarifies.delete(questionId);
      this.emit({ type: 'clarifyResponse', sessionId: q.sessionId, questionId, decision: 'cancelled', answers: '' });
      q.resolve(null);
    }
    for (const [sessionId, ctx] of this.contexts) {
      ctx.cancel();
      this.contexts.delete(sessionId);
      this.setStatus(sessionId, 'paused', 'emergency_stop');
    }
  }

  async respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    scope?: GrantScope,
    editedArgs?: Record<string, unknown>,
  ): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.emit({ type: 'permissionResponse', sessionId: p.sessionId, requestId, decision, scope });
    p.resolve({ decision, scope: scope ?? 'once', editedArgs, timedOut: false });
  }

  /** 澄清回答（D20）：resolve 挂起剧本 + 回执镜像（多端一致） */
  async respondClarify(questionId: string, answers: string[], freeText?: string): Promise<void> {
    const q = this.pendingClarifies.get(questionId);
    if (!q) return;
    this.pendingClarifies.delete(questionId);
    const answersText = answers.join('、') + (freeText?.trim() ? `；补充：${freeText.trim()}` : '');
    this.emit({ type: 'clarifyResponse', sessionId: q.sessionId, questionId, decision: 'answered', answers: answersText });
    q.resolve({ answers, freeText });
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.mode = mode;
    this.touch(sessionId);
  }

  async cancelRun(_runId: string): Promise<void> {}

  async listRuns(_sessionId?: string): Promise<RunInfo[]> {
    return []; // 剧本无 run 记录（真实链路经 agent_runs_list）
  }


  async registerWorkspace(path: string, name?: string): Promise<AgentWorkspaceInfo> {
    await delay(180);
    const existing = this.workspaces.find((w) => w.path === path);
    if (existing) {
      existing.lastOpenedAt = Date.now();
      if (name) existing.name = name;
      return { ...existing };
    }
    const item: AgentWorkspaceInfo = {
      id: `ws-mock-n${Date.now()}`,
      path,
      name: name ?? path.split('/').filter(Boolean).pop() ?? '项目',
      isRepo: true,
      trusted: true,
      lastOpenedAt: Date.now(),
      createdAt: Date.now(),
    };
    this.workspaces.unshift(item);
    return { ...item };
  }

  async listWorkspaces(): Promise<AgentWorkspaceInfo[]> {
    await delay(250);
    return [...this.workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  async forgetWorkspace(id: string): Promise<void> {
    await delay(150);
    this.workspaces = this.workspaces.filter((w) => w.id !== id);
  }

  // ---- 剧本 ----

  private setStatus(sessionId: string, state: AgentSessionMeta['status'], reason: string): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) s.status = state;
    this.touch(sessionId);
    this.emit({ type: 'stateChanged', sessionId, state, reason });
  }

  private async streamOut(ctx: ScriptContext, sessionId: string, text: string, channel: 'text' | 'reasoning' = 'text'): Promise<void> {
    for (const piece of chunks(text)) {
      await ctx.wait(STREAM_INTERVAL_MS);
      this.emit({ type: 'streamDelta', sessionId, seq: this.nextSeq(sessionId), delta: piece, channel });
    }
  }

  private async finishSession(sessionId: string, summary: string): Promise<void> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) {
      ctx.cancel();
      this.contexts.delete(sessionId);
    }
    const s = this.sessions.find((x) => x.id === sessionId);
    if (s) {
      s.status = 'ended';
      s.endedAt = Date.now();
      s.summary = summary;
    }
    this.touch(sessionId);
    this.emit({ type: 'stateChanged', sessionId, state: 'ended', reason: 'session.end' });
    this.emit({ type: 'sessionEnded', sessionId, summary });
  }

  /** 等待审批回应（120s 超时=拒绝，D08 §3.4；取消时抛 ScriptCancelled） */
  private awaitPermission(ctx: ScriptContext, sessionId: string, requestId: string): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve, reject) => {
      const entry: PendingPermission = {
        sessionId,
        requestId,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          this.emit({ type: 'permissionResponse', sessionId, requestId, decision: 'deny' });
          entry.resolve({ decision: 'deny', scope: 'once', timedOut: true });
        }, PERMISSION_TIMEOUT_MS),
        resolve: (v) => resolve(v),
      };
      this.pending.set(requestId, entry);
      // 剧本被取消 → 拒绝挂起的 promise（避免泄漏）；正常回应/超时也会停掉监视
      const watch = setInterval(() => {
        if (ctx.cancelled) {
          clearInterval(watch);
          clearTimeout(entry.timer);
          this.pending.delete(requestId);
          reject(new ScriptCancelled());
        }
      }, 200);
      const origResolve = entry.resolve;
      entry.resolve = (v) => {
        clearInterval(watch);
        origResolve(v);
      };
    });
  }

  /** 第 1 轮：读取文件 → 结论 */
  private async scriptReadFile(s: AgentSessionMeta, ctx: ScriptContext): Promise<void> {
    const sid = s.id;
    try {
      this.setStatus(sid, 'running', 'user.message');
      await this.streamOut(ctx, sid, '用户反馈登录偶发超时，我先定位相关代码与配置。', 'reasoning');
      await this.streamOut(ctx, sid, '好的，我先读取 `foo.txt`，确认登录相关配置：');
      // 工具调用：read_file（低危只读，无需审批）
      this.emit({
        type: 'toolCall',
        sessionId: sid,
        callId: `call-${sid}-r1`,
        tool: 'read_file',
        args: { path: 'foo.txt' },
        risk: 'low',
        parallel: false,
        source: 'self',
      });
      ctx.inFlightCalls.add(`call-${sid}-r1`);
      const startedAt = Date.now();
      await ctx.wait(READ_FILE_RESULT_DELAY_MS);
      ctx.inFlightCalls.delete(`call-${sid}-r1`);
      this.emit({
        type: 'toolResult',
        sessionId: sid,
        callId: `call-${sid}-r1`,
        ok: true,
        summary: '读取成功：128 行。发现 session.timeout=30s，且 verify_token 未校验时钟偏移',
        truncated: false,
        durationMs: Date.now() - startedAt,
      });
      await this.streamOut(
        ctx,
        sid,
        [
          '## 结论',
          '',
          '- **根因**：`verify_token` 用严格相等比较过期时间，令牌签发方与本机存在时钟偏移时会被误判为过期',
          '- **建议**：在 claims 校验处加入 ±60s 漂移窗口，并保持 30s 超时配置不变',
          '',
          '还需要我跑一次 `cargo test` 验证修复吗？',
        ].join('\n'),
        'text',
      );
      this.emit({ type: 'streamDone', sessionId: sid, finishReason: 'stop', usage: { in: 1834, out: 402 } });
      this.setStatus(sid, 'idle', 'finish');
    } catch (e) {
      if (!(e instanceof ScriptCancelled)) throw e;
    } finally {
      if (this.contexts.get(sid) === ctx) this.contexts.delete(sid);
    }
  }

  /** 第 2 轮：执行命令 → 审批 → 通过/阻止 两分支 → 记忆/结束 */
  private async scriptRunCommand(s: AgentSessionMeta, ctx: ScriptContext): Promise<void> {
    const sid = s.id;
    try {
      this.setStatus(sid, 'running', 'user.message');
      // 复杂任务自动升档（D11 §4 model.switched）
      await ctx.wait(300);
      this.emit({ type: 'modelSwitched', sessionId: sid, from: 'fast', to: 'strong', reason: 'auto:任务复杂度升档' });
      await this.streamOut(ctx, sid, '需要执行测试命令验证修复。该命令不在白名单内，按当前模式需要你确认：');
      // 管线第 0 步先展示 tool.call，再走门控确认（D11 §6）
      this.emit({
        type: 'toolCall',
        sessionId: sid,
        callId: `call-${sid}-r2`,
        tool: 'run_command',
        args: { command: 'cargo test --lib', cwd: s.workspace },
        risk: 'high',
        parallel: false,
        source: 'self',
      });
      ctx.inFlightCalls.add(`call-${sid}-r2`);
      const preview: PermissionPreview = { kind: 'command', command: 'cargo test --lib', cwd: s.workspace, dangerFlags: [] };
      // 真机约定 requestId="pr-{callId}"（loop_runner）——前端按此前缀配对内嵌工具卡
      const requestId = `pr-call-${sid}-r2`;
      this.emit({
        type: 'permissionRequest',
        sessionId: sid,
        requestId,
        tool: 'run_command',
        risk: 'high',
        reason: '规则未命中 · 快模型分类：中危（构建类）· 高危工具不提供永久记忆',
        preview,
        // 高危 → options 不含 permanent（D08 §3.4）
        options: ['once', 'session'],
        expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
      });
      this.setStatus(sid, 'waiting_permission', 'gate.confirm');
      const answer = await this.awaitPermission(ctx, sid, requestId);
      if (answer.decision === 'allow') {
        // ---- 通过分支 ----
        const effectiveCommand = (answer.editedArgs?.command as string | undefined) ?? 'cargo test --lib';
        this.setStatus(sid, 'running', 'permission.allow');
        await ctx.wait(400);
        const startedAt = Date.now();
        await ctx.wait(RUN_COMMAND_RESULT_DELAY_MS);
        ctx.inFlightCalls.delete(`call-${sid}-r2`);
        this.emit({
          type: 'toolResult',
          sessionId: sid,
          callId: `call-${sid}-r2`,
          ok: true,
          summary: `$ ${effectiveCommand}\nrunning 12 tests … 12 passed\nfinished in 2.4s`,
          truncated: false,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        });
        await this.streamOut(ctx, sid, '测试全部通过（12/12）。修复已验证，我把这次的结论沉淀进记忆。', 'text');
        this.emit({ type: 'streamDone', sessionId: sid, finishReason: 'stop', usage: { in: 2510, out: 518 } });
        this.setStatus(sid, 'idle', 'finish');
        await ctx.wait(500);
        this.emit({
          type: 'memorySaved',
          sessionId: sid,
          name: 'login-timeout-drift',
          title: '登录超时根因：token 时钟偏移',
          memoryType: 'project',
          updated: false,
        });
      } else {
        // ---- 阻止分支（用户拒绝 / 120s 超时=拒绝）----
        this.setStatus(sid, 'running', 'permission.deny');
        ctx.inFlightCalls.delete(`call-${sid}-r2`);
        this.emit({
          type: 'toolResult',
          sessionId: sid,
          callId: `call-${sid}-r2`,
          ok: false,
          summary: answer.timedOut ? '审批超时（120s），按拒绝处理' : '用户拒绝执行，理由已回填给模型',
          truncated: false,
          blocked: { rule: 'permission.denied', kind: 'permission', code: 8020 },
          durationMs: 0,
        });
        await this.streamOut(ctx, sid, '好的，已取消执行该命令。你可以稍后在本地自行运行全量测试。', 'text');
        this.emit({ type: 'streamDone', sessionId: sid, finishReason: 'stop', usage: { in: 2210, out: 296 } });
        this.setStatus(sid, 'idle', 'finish');
        await ctx.wait(500);
        this.emit({
          type: 'memorySaved',
          sessionId: sid,
          name: 'no-cargo-test-in-session',
          title: '本会话不执行 cargo test',
          memoryType: 'feedback',
          updated: false,
        });
      }
      // 收尾：会话结束
      await ctx.wait(400);
      await this.finishSession(sid, '修复登录超时：定位时钟偏移根因并验证（12/12 测试通过）');
    } catch (e) {
      if (!(e instanceof ScriptCancelled)) throw e;
    } finally {
      if (this.contexts.get(sid) === ctx) this.contexts.delete(sid);
    }
  }

  /** 第 3 轮（D20）：ask_user 提问卡 → 等用户选项作答 → 按答案收尾（不超时） */
  private async scriptAskUser(s: AgentSessionMeta, ctx: ScriptContext): Promise<void> {
    const sid = s.id;
    try {
      this.setStatus(sid, 'running', 'user.message');
      await this.streamOut(ctx, sid, '修复前有个方向问题需要你拍板：', 'text');
      // 真机时序（loop_runner run_ask_user）：先落 toolCall（ask_user 工具卡）
      // 再发 clarify.request，questionId="q-{callId}"——前端按此前缀配对内嵌工具卡
      const callId = `call-${sid}-r3`;
      this.emit({
        type: 'toolCall',
        sessionId: sid,
        callId,
        tool: 'ask_user',
        args: {
          question: '登录超时的修复方式选哪种？',
          header: '修复方式',
          options: [
            { label: '加漂移窗口', description: 'claims 校验 ±60s 容忍时钟偏移（改动小）' },
            { label: '对齐 NTP', description: '统一各机器时钟源（治本但要运维配合）' },
            { label: '两者都做', description: '先加窗口止血，再排期 NTP' },
          ],
          multi_select: false,
        },
        risk: 'low',
        parallel: false,
        source: 'self',
      });
      ctx.inFlightCalls.add(callId);
      const questionId = `q-${callId}`;
      this.emit({
        type: 'clarifyRequest',
        sessionId: sid,
        questionId,
        question: '登录超时的修复方式选哪种？',
        header: '修复方式',
        options: [
          { label: '加漂移窗口', description: 'claims 校验 ±60s 容忍时钟偏移（改动小）' },
          { label: '对齐 NTP', description: '统一各机器时钟源（治本但要运维配合）' },
          { label: '两者都做', description: '先加窗口止血，再排期 NTP' },
        ],
        multiSelect: false,
      });
      this.setStatus(sid, 'waiting_clarify', 'gate.clarify');
      const answer = await this.awaitClarify(ctx, sid, questionId);
      this.setStatus(sid, 'running', 'clarify.answered');
      const label = answer ? answer.answers.join('、') + (answer.freeText ? `（补充：${answer.freeText}）` : '') : '';
      // 回答以工具结果回给模型（真机 run_ask_user ToolOutcome 语义）
      ctx.inFlightCalls.delete(callId);
      this.emit({
        type: 'toolResult',
        sessionId: sid,
        callId,
        ok: !!answer,
        summary: answer ? (answer.freeText?.trim() ? `${label}；补充：${answer.freeText.trim()}` : label) : '已被中断',
        truncated: false,
      });
      await this.streamOut(
        ctx,
        sid,
        answer
          ? `收到，按「${label}」执行。我先按这个方向改，完成后再同步验证结果。`
          : '本轮已中断，需要时随时继续。',
        'text',
      );
      this.emit({ type: 'streamDone', sessionId: sid, finishReason: 'stop', usage: { in: 1980, out: 240 } });
      this.setStatus(sid, 'idle', 'finish');
    } catch (e) {
      if (!(e instanceof ScriptCancelled)) throw e;
    } finally {
      if (this.contexts.get(sid) === ctx) this.contexts.delete(sid);
    }
  }

  /** 第 4 轮（D33）：skill 显式加载 → 并行探查子 agent（spawn/trace/done/join，
   *  trace 按状态机走 sideStreams 侧栏——主流只见子任务卡）→ 结论收尾 */
  private async scriptSkillAndSubagent(s: AgentSessionMeta, ctx: ScriptContext): Promise<void> {
    const sid = s.id;
    try {
      this.setStatus(sid, 'running', 'user.message');
      await this.streamOut(ctx, sid, '这个任务匹配技能目录里的「报销助手」，先加载技能规范：', 'text');
      // ① skill 工具调用（D33：结果=技能正文注入上下文）
      this.emit({
        type: 'toolCall',
        sessionId: sid,
        callId: `call-${sid}-r4a`,
        tool: 'skill',
        args: { name: '报销助手' },
        risk: 'low',
        parallel: false,
        source: 'self',
      });
      ctx.inFlightCalls.add(`call-${sid}-r4a`);
      await ctx.wait(600);
      ctx.inFlightCalls.delete(`call-${sid}-r4a`);
      this.emit({
        type: 'toolResult',
        sessionId: sid,
        callId: `call-${sid}-r4a`,
        ok: true,
        summary: '# 技能: 报销助手（risk: low）\n报销三步：填单、贴票、提交审批。',
        truncated: false,
        durationMs: 580,
      });
      await this.streamOut(ctx, sid, '按技能规范拆成两项并行探查，派子 agent 调查：', 'text');
      // ② 子 agent fan-out：spawn ×2 → trace（侧栏流）→ done → join
      this.setStatus(sid, 'subagent_fanout', 'fanout');
      const subs: Array<{ runId: string; task: string }> = [
        { runId: 'r-41', task: '查近 30 天差旅票据与金额汇总' },
        { runId: 'r-42', task: '核对报销制度里的票据要求与审批链' },
      ];
      for (const sub of subs) {
        this.emit({ type: 'subagentSpawn', sessionId: sid, runId: sub.runId, taskDigest: sub.task, toolSubset: ['read_file', 'search_files'] });
      }
      for (const sub of subs) {
        this.emit({
          type: 'subagentTrace',
          sessionId: sid,
          runId: sub.runId,
          item: {
            kind: 'tool_call',
            callId: `${sub.runId}-c1`,
            tool: 'search_files',
            argsMasked: '{"query":"差旅 票据"}',
            risk: 'low',
          },
        });
        await ctx.wait(900);
        this.emit({
          type: 'subagentTrace',
          sessionId: sid,
          runId: sub.runId,
          item: { kind: 'tool_result', callId: `${sub.runId}-c1`, ok: true, summary: '命中 6 处（发票/行程单/审批单）', durationMs: 860 },
        });
        this.emit({
          type: 'subagentTrace',
          sessionId: sid,
          runId: sub.runId,
          item: { kind: 'text', text: `已完成调查：${sub.task}——材料齐全，含 2 张待补行程单。` },
        });
        this.emit({
          type: 'subagentEvent',
          sessionId: sid,
          runId: sub.runId,
          phase: 'done',
          summary: `已完成调查：${sub.task}——材料齐全，含 2 张待补行程单。`,
        });
      }
      this.emit({
        type: 'subagentJoin',
        sessionId: sid,
        results: subs.map((sub) => ({ runId: sub.runId, ok: true, summary: `${sub.task}——材料齐全` })),
      });
      // 收尾走富渲染样例（D34：表格排序/筛选、带语言代码块、引用、diff、任务列表——
      // 真机验收一眼看全；流式期间未闭合围栏/半张表格走 MdCode/MdTable 渐进渲染）
      await this.streamOut(
        ctx,
        sid,
        [
          '## 汇总',
          '',
          '两项探查完成，票据核对结果如下（**点击表头可三态排序**，行数 ≥4 自动出现筛选框）：',
          '',
          '| 票据类型 | 张数 | 金额（元） | 状态 |',
          '| --- | ---: | ---: | :--- |',
          '| 增值税发票 | 4 | 3260.00 | 已核对 |',
          '| 行程单 | 3 | 1180.00 | 2 张待补 |',
          '| 出租车票 | 6 | 486.50 | 已核对 |',
          '| 餐饮发票 | 5 | 692.00 | 已核对 |',
          '| 住宿发票 | 2 | 1588.00 | 已核对 |',
          '',
          '> **制度要点**（来自探查 2）：单张 ≥1000 元须附审批单；电子发票二维码需可扫描。',
          '',
          '待办按技能三步流程推进：',
          '',
          '- [x] 填写报销单（草稿已生成）',
          '- [ ] 补 2 张行程单',
          '- [ ] 提交审批链（直属 → 财务）',
          '',
          '修正后的提交命令：',
          '',
          '```bash',
          'bbc expense submit --form draft.yaml --dry-run',
          '```',
          '',
          '其中 `--dry-run` 仅校验不落库；~~bbc expense push~~ 已在新版本移除。金额修正摘录：',
          '',
          '```diff',
          '- amount: 4468.50',
          '+ amount: 4726.50',
          '```',
          '',
          '点击上方子任务卡「查看过程」可看探查明细。',
        ].join('\n'),
        'text',
      );
      this.emit({ type: 'streamDone', sessionId: sid, finishReason: 'stop', usage: { in: 2210, out: 310 } });
      this.setStatus(sid, 'idle', 'finish');
    } catch (e) {
      if (!(e instanceof ScriptCancelled)) throw e;
    } finally {
      if (this.contexts.get(sid) === ctx) this.contexts.delete(sid);
    }
  }

  /** 等待澄清回答（D20：不超时；剧本被取消 → reject ScriptCancelled 防泄漏） */
  private awaitClarify(ctx: ScriptContext, sessionId: string, questionId: string): Promise<ClarifyAnswerMsg | null> {
    return new Promise<ClarifyAnswerMsg | null>((resolve, reject) => {
      const entry: PendingClarify = {
        sessionId,
        questionId,
        resolve: (v) => resolve(v),
      };
      this.pendingClarifies.set(questionId, entry);
      const watch = setInterval(() => {
        if (ctx.cancelled) {
          clearInterval(watch);
          this.pendingClarifies.delete(questionId);
          reject(new ScriptCancelled());
        }
      }, 200);
      const orig = entry.resolve;
      entry.resolve = (v) => {
        clearInterval(watch);
        orig(v);
      };
    });
  }
}
