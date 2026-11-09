/**
 * MockAgentBridge：定时器驱动的完整剧本（无 Tauri/无后端时可真实演示）。
 * 剧本（对齐任务验收路径）：
 * - 发消息 → stateChanged(running) → 思考摘要 + streamDelta 分片输出（80ms/片）
 *   → toolCall(read_file foo.txt) → 3s 后 toolResult(ok) → 结论流 → streamDone → idle
 * - 再发一条 → modelSwitched(升档) → toolCall(run_command) → permission.request
 *   （cargo test，risk=high，命令预览可编辑，仅 once/session 两档）
 *   → 允许：checkpoint(pre-command) + toolResult(exit 0 通过)；拒绝/超时：toolResult(blocked 红条带)
 *   → memory.saved 事件 → report.daily 事件 → sessionEnded
 * 暂停会冻结剧本时钟；紧急停止作废未决审批并结束。
 */

import type {
  AgentBridge,
  AgentEvent,
  AgentReport,
  AgentSessionMeta,
  GrantScope,
  MemoryEntry,
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

const now = Date.now();

/** 演示用固定数据（与 IM mock 同思路：桩数据集中，不散落组件） */
function seedSessions(): AgentSessionMeta[] {
  return [
    {
      id: 'sess-mock-01',
      title: '修复登录超时',
      workspace: '~/code/bbw-server',
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
      workspace: '~/docs/notes',
      mode: 'ask',
      modelPolicy: 'auto',
      status: 'idle',
      createdAt: now - 5 * HOUR,
      updatedAt: now - 3 * HOUR,
    },
  ];
}

function seedMemories(): MemoryEntry[] {
  return [
    {
      name: 'dev-server-port',
      title: '开发服务器端口约定 8090',
      type: 'project',
      hook: '本地联调一律用 8090，避免与网关 8080 冲突',
      updatedAt: now - 2 * DAY,
      sessionId: 'sess-mock-02',
    },
    {
      name: 'pref-plan-first',
      title: '用户偏好：先方案后落笔',
      type: 'user',
      hook: '较大的改动先给方案要点，确认后再写代码',
      updatedAt: now - 5 * DAY,
      sessionId: 'sess-mock-01',
    },
    {
      name: 'gitee-remote',
      title: '公司仓库走 Gitee 远端',
      type: 'reference',
      hook: 'push 前确认 remote 指向 gitee.corp，勿用镜像源',
      updatedAt: now - 8 * DAY,
      sessionId: 'sess-mock-03',
    },
  ];
}

function dayStr(offsetDays: number): string {
  const d = new Date(now - offsetDays * DAY);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seedReports(): AgentReport[] {
  return [
    {
      date: dayStr(1),
      stats: { sessions: 3, tools: 47, blocked: 2, files: 12, memorySaved: 3 },
      markdown: [
        `# ${dayStr(1)} Agent 日报`,
        '- 会话 3 个（累计 2h14m）；工作区 baobao-work、docs-site',
        '- 工具调用 47 次：read_file×21 edit_file×9 run_command×8 search_files×9',
        '- 被拦截 2 次（8021 危险命令 / 8024 链接逃逸）',
        '- 文件变更 12：edit×9 create×3；检查点 4（pre-edit×3 manual×1）',
        '- 今日记忆 +3：「端口 8090 约定」「用户偏好先方案后落笔」「Gitee 远端」',
        '',
        '## 会话明细',
        '',
        '| 会话 | 工作区 | 时长 | 工具 | 结果 |',
        '| --- | --- | --- | --- | --- |',
        '| s-102 | bbw-server | 48m | 19 | 已完成 |',
        '| s-101 | docs-site | 26m | 15 | 已完成 |',
        '| s-099 | baobao-work | 60m | 13 | 已暂停 |',
      ].join('\n'),
    },
    {
      date: dayStr(2),
      stats: { sessions: 2, tools: 23, blocked: 0, files: 5, memorySaved: 1 },
      markdown: [
        `# ${dayStr(2)} Agent 日报`,
        '- 会话 2 个（累计 51m）；工作区 bbw-server',
        '- 工具调用 23 次：read_file×12 search_files×6 edit_file×5',
        '- 被拦截 0 次',
        '- 文件变更 5：edit×5；检查点 2（pre-edit×2）',
        '- 今日记忆 +1：「Gitee 远端」',
        '',
        '## 会话明细',
        '',
        '| 会话 | 工作区 | 时长 | 工具 | 结果 |',
        '| --- | --- | --- | --- | --- |',
        '| s-087 | bbw-server | 36m | 14 | 已完成 |',
        '| s-086 | bbw-server | 15m | 9 | 已完成 |',
      ].join('\n'),
    },
  ];
}

export class MockAgentBridge implements AgentBridge {
  readonly kind = 'mock' as const;

  private listeners = new Set<(event: AgentEvent) => void>();
  private sessions: AgentSessionMeta[] = seedSessions();
  private memories: MemoryEntry[] = seedMemories();
  private reports: AgentReport[] = seedReports();
  /** sessionId → 已发送轮次（第 2 轮触发审批剧本） */
  private rounds = new Map<string, number>();
  /** sessionId → 剧本上下文 */
  private contexts = new Map<string, ScriptContext>();
  /** requestId → 未决审批 */
  private pending = new Map<string, PendingPermission>();
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

  async startSession(workspace: string, mode: PermissionMode, model?: string): Promise<AgentSessionMeta> {
    await delay(200);
    this.sessionSeq += 1;
    const meta: AgentSessionMeta = {
      id: `sess-mock-n${this.sessionSeq}`,
      title: '新会话',
      workspace,
      mode,
      modelPolicy: 'auto',
      modelOverride: model,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.unshift(meta);
    this.emit({ type: 'stateChanged', sessionId: meta.id, state: 'starting', reason: 'session.start' });
    // starting → idle（工作区加载完成，D11 §3 迁移 2）
    setTimeout(() => {
      meta.status = 'idle';
      this.emit({ type: 'stateChanged', sessionId: meta.id, state: 'idle', reason: 'session.ready' });
    }, 400);
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

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s || s.status === 'ended' || s.status === 'paused') return;
    const round = (this.rounds.get(sessionId) ?? 0) + 1;
    this.rounds.set(sessionId, round);
    // 首条消息派生标题（会话列表可读性）
    if (s.title === '新会话') {
      s.title = text.length > 12 ? `${text.slice(0, 12)}…` : text;
    }
    this.touch(sessionId);
    const ctx = new ScriptContext();
    this.contexts.set(sessionId, ctx);
    if (round === 1) void this.scriptReadFile(s, ctx);
    else void this.scriptRunCommand(s, ctx);
  }

  async pause(sessionId: string): Promise<void> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) ctx.paused = true;
    this.setStatus(sessionId, 'paused', 'user.pause');
  }

  async resume(sessionId: string): Promise<void> {
    const ctx = this.contexts.get(sessionId);
    if (ctx) ctx.paused = false;
    this.setStatus(sessionId, 'running', 'session.resume');
  }

  async endSession(sessionId: string): Promise<void> {
    this.finishSession(sessionId, '会话已结束（用户主动结束）');
  }

  async emergencyStop(): Promise<void> {
    // 三入口一致语义（INT-AG-12）：杀剧本 + 未决审批作废 + 会话暂停展示
    for (const [requestId, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.emit({ type: 'permissionResponse', sessionId: p.sessionId, requestId, decision: 'cancelled' });
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

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.mode = mode;
    this.touch(sessionId);
  }

  // ---- 委派（D16：真实链路命令；mock 剧本不含委派场景——浏览器演示 no-op）----

  async launchDelegate(_sessionId: string, _runId: string, _backend: string): Promise<void> {}

  async delegateInput(_runId: string, _text: string): Promise<void> {}

  async cancelDelegate(_runId: string): Promise<void> {}

  async reviewDelegate(_runId: string, _accept: boolean): Promise<void> {}

  // ---- 记忆 / 日报（D15）----

  async listMemories(): Promise<MemoryEntry[]> {
    await delay(300);
    return [...this.memories].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteMemory(name: string): Promise<void> {
    await delay(150);
    this.memories = this.memories.filter((m) => m.name !== name);
  }

  async listReports(): Promise<AgentReport[]> {
    await delay(300);
    return [...this.reports].sort((a, b) => (a.date < b.date ? 1 : -1));
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
      const startedAt = Date.now();
      await ctx.wait(READ_FILE_RESULT_DELAY_MS);
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

  /** 第 2 轮：执行命令 → 审批 → 通过/阻止 两分支 → 记忆/日报/结束 */
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
      const preview: PermissionPreview = { kind: 'command', command: 'cargo test --lib', cwd: s.workspace, dangerFlags: [] };
      const requestId = `pr-${sid}-1`;
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
        // pre-command 检查点（D11 §6：修改/命令类首次执行前）
        await ctx.wait(400);
        this.emit({
          type: 'checkpointCreated',
          sessionId: sid,
          checkpointId: `cp-${sid}-1`,
          filesChanged: ['src/auth.rs'],
          reason: 'pre-command',
        });
        const startedAt = Date.now();
        await ctx.wait(RUN_COMMAND_RESULT_DELAY_MS);
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
        this.memories.unshift({
          name: 'login-timeout-drift',
          title: '登录超时根因：token 时钟偏移',
          type: 'project',
          hook: 'verify_token 需容忍 ±60s 时钟漂移；测试基线 cargo test --lib 12 例',
          updatedAt: Date.now(),
          sessionId: sid,
        });
      } else {
        // ---- 阻止分支（用户拒绝 / 120s 超时=拒绝）----
        this.setStatus(sid, 'running', 'permission.deny');
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
        this.memories.unshift({
          name: 'no-cargo-test-in-session',
          title: '本会话不执行 cargo test',
          type: 'feedback',
          hook: '用户倾向自行在本地跑全量测试；Why: 保持测试环境一致 How to apply: 会话内只做静态核验',
          updatedAt: Date.now(),
          sessionId: sid,
        });
      }
      // 收尾：日报产出（D15 §3.2：session.ended 落地后异步重算当日）+ 会话结束
      await ctx.wait(600);
      const stats = { sessions: 4, tools: 51, blocked: 2, files: 13, memorySaved: 4 };
      const today = dayStr(0);
      this.reports = [
        {
          date: today,
          stats,
          markdown: [
            `# ${today} Agent 日报`,
            `- 会话 ${stats.sessions} 个（累计 2h48m）；工作区 bbw-server`,
            `- 工具调用 ${stats.tools} 次：read_file×22 run_command×9 edit_file×9 search_files×11`,
            '- 被拦截 2 次（8020 审批拒绝 / 8024 链接逃逸）',
            `- 文件变更 ${stats.files}：edit×10 create×3；检查点 5（pre-edit×3 pre-command×1 manual×1）`,
            `- 今日记忆 +4：「登录超时根因」等`,
            '',
            '## 会话明细',
            '',
            '| 会话 | 工作区 | 时长 | 工具 | 结果 |',
            '| --- | --- | --- | --- | --- |',
            `| ${sid} | bbw-server | 18m | 9 | 已完成 |`,
            '| s-102 | bbw-server | 48m | 19 | 已完成 |',
            '| s-101 | docs-site | 26m | 15 | 已完成 |',
          ].join('\n'),
        },
        ...this.reports.filter((r) => r.date !== today),
      ];
      this.emit({ type: 'reportDaily', date: today, path: `~/Library/Application Support/baobao-work/agent/reports/${today}.md`, stats });
      await ctx.wait(400);
      await this.finishSession(sid, '修复登录超时：定位时钟偏移根因并验证（12/12 测试通过）');
    } catch (e) {
      if (!(e instanceof ScriptCancelled)) throw e;
    } finally {
      if (this.contexts.get(sid) === ctx) this.contexts.delete(sid);
    }
  }
}
