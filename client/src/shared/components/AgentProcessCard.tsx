/**
 * Agent 过程折叠卡（2026-11-11 六改：外层消息卡片+头部恢复——用户反馈「原来最外层
 * 的消息卡片变没了，还有标题那些」；v5 的折叠结构保留为其内区块）：
 * - 最外层 = 消息卡片（🤖 Agent 标题 + 正在处理/已处理：本轮问题 + 状态 chip
 *   （运行中·实时走秒/已完成/失败/已中断）；运行中边框主色高亮）
 * - 卡内「过程折叠区块」：摘要条（思考中/已深度思考 + 用时·N次LLM调用·N次工具执行·
 *   N个子agent）= 整块折叠开关——思考小卡×N/工具/中间正文全收此块
 * - 最终结论在卡内、过程块下方常开（markdown+流式光标）；actions 卡尾
 * - 工作台（TurnBubble children=富交互明细）与 IM 落流卡（缺省 stages 投影）
 *   共用本组件，调整一处两端同步
 * D26 全量收口（2026-11-14）：agc-* 自研类退役——antd Collapse/Tag/Spin/Button +
 * theme.useToken() 内联；行为（折叠语义/流式光标/孤儿降级/统计口径）零改动。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Collapse, Spin, Tag, Typography, theme } from 'antd';
import { Bot, ChevronRight, ChevronUp, Code2, Lightbulb, Terminal } from 'lucide-react';
import { MarkdownText } from './MarkdownText';

/** 落流卡 stages 条目（D18 §4.1；服务端不透明透传，此为客户端投影类型） */
export interface AgentStage {
  t: 'thinking' | 'tool' | 'conclusion';
  ts?: number;
  /** thinking：摘要文本 */
  digest?: string;
  /** thinking：本段思考仍在流式（live 投影瞬态旗标——stagesFromStream 从 StreamItem
   *  透传；落流 PATCH 前剥除不落库，历史卡不带恒折叠） */
  streaming?: boolean;
  /** tool */
  name?: string;
  status?: 'ok' | 'fail' | 'blocked' | 'running';
  ms?: number;
  summary?: string;
  /** tool：行内命令/关键参数摘要（run_command=命令原文；2026-11-12 终端行口径，
   *  stagesFromStream 从 toolCall.args 提取，随卡落库——历史卡可见） */
  command?: string;
  /** tool：完整结果文本（展开查看用，≤2000 字截断；summary 是 120 字行内版） */
  result?: string;
  /** conclusion：markdown 正文 */
  md?: string;
}

/** 工具调用 → 行内命令/关键参数摘要（2026-11-12 终端行口径，落流卡 ToolRow 与
 * 工作台 ToolCard 共用）：run_command=命令原文；其他工具=首个字符串参数（path/query） */
export function toolCallCommand(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (tool === 'run_command') {
    const c = args.command;
    return typeof c === 'string' && c ? c : undefined;
  }
  const v = Object.values(args).find((x): x is string => typeof x === 'string' && !!x);
  return v || undefined;
}

export interface AgentCardBody {
  kind: 'embedded_agent';
  session_id?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  stages: AgentStage[];
  sources?: string[];
  rounds?: number;
  started_at?: number;
  ended_at?: number;
  /** 本轮用户问题（落流数据字段保留；当前布局不渲染） */
  question?: string;
}

/** 思考卡：流式强制展开；本段思考结束自动折叠（change-my-life ThinkingCard 模式）。
 *  折叠态随卸载重置：外层（IM 迷你卡/过程区摘要条）折叠即卸载本卡，再展开
 *  重挂回初始态——已完成=折叠（省空间，2026-11-11 用户口径），仍在流式=展开。
 *  2026-11-11 导出共享：工作台回合气泡过程区同款复用（每段思考一张折叠小卡） */
export function ThinkingCollapse({ text, streaming }: { text: string; streaming: boolean }) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setExpanded(streaming); // 思考结束自动收起；新一轮思考展开
  }, [streaming]);
  useEffect(() => {
    if (!expanded || !streaming) return;
    const el = bodyRef.current;
    if (!el) return;
    // 流式跟底经 rAF（2026-11-11 卡顿修复）：每 delta 直读 scrollHeight+写
    // scrollTop=强制同步 layout；rAF 落到帧边界，同帧多次 text 更新合并
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [text, expanded, streaming]);
  return (
    <Collapse
      ghost
      size="small"
      activeKey={expanded ? ['t'] : []}
      onChange={() => setExpanded((v) => !v)}
      style={{ background: token.colorFillQuaternary, borderRadius: token.borderRadius, margin: '4px 0' }}
      items={[
        {
          key: 't',
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: streaming ? token.colorPrimary : token.colorTextSecondary }}>
              <Lightbulb size={13} />
              {streaming ? '思考中...' : '思考过程'}
            </span>
          ),
          children: (
            <div ref={bodyRef} style={{ maxHeight: 300, overflowY: 'auto' }}>
              <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: token.colorTextSecondary }}>{text}</pre>
            </div>
          ),
        },
      ]}
    />
  );
}

/** 工具行（2026-11-12 终端行口径）：run_command 显示「终端」+ 命令（单行截断），
 *  其他工具=name+关键参数；有命令/结果可点开查看完整命令与执行结果（等宽块） */
function ToolRow({ s }: { s: AgentStage }) {
  const { token } = theme.useToken();
  const running = s.status === 'running';
  const failed = s.status === 'fail';
  const isTerm = s.name === 'run_command';
  const inline = s.command ?? (isTerm ? undefined : s.summary);
  const expandable = !!(s.command || s.result || (!isTerm && s.summary));
  const mono = { fontFamily: 'var(--bbc-font-mono)', fontSize: 12 } as const;
  return (
    <Collapse
      ghost
      size="small"
      style={{
        margin: '2px 0',
        borderRadius: token.borderRadius,
        border: `1px solid ${failed ? token.colorErrorBorder : running ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
      }}
      items={[
        {
          key: 'tool',
          collapsible: expandable ? 'header' : 'disabled',
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12 }}>
              {running ? <Spin size="small" /> : isTerm ? <Terminal size={12} /> : <Code2 size={12} />}
              <span style={{ fontWeight: 500 }}>{isTerm ? '终端' : s.name}</span>
              {inline ? (
                <Typography.Text code style={{ ...mono, maxInlineSize: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} ellipsis>
                  {inline}
                </Typography.Text>
              ) : null}
              {s.ms != null && s.ms > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto', paddingLeft: 8 }}>
                  {(s.ms / 1000).toFixed(1)}s
                </Typography.Text>
              ) : null}
              {failed ? <Tag color="error" style={{ marginInlineEnd: 0 }}>失败</Tag> : null}
            </span>
          ),
          children: expandable ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {s.command ? (
                <pre style={{ ...mono, margin: 0, whiteSpace: 'pre-wrap', color: token.colorText }}>{isTerm ? `$ ${s.command}` : s.command}</pre>
              ) : null}
              {s.result ? (
                <pre style={{ ...mono, margin: 0, whiteSpace: 'pre-wrap', color: token.colorTextSecondary }}>{s.result}</pre>
              ) : null}
              {!s.command && !s.result && !isTerm && s.summary ? (
                <pre style={{ ...mono, margin: 0, whiteSpace: 'pre-wrap', color: token.colorTextSecondary }}>{s.summary}</pre>
              ) : null}
            </div>
          ) : null,
        },
      ]}
    />
  );
}

/** 时长格式（2026-11-11 用户口径）：<1分 纯秒；≥1分 01分23秒；≥1时 01时01分01秒 */
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${pad(Math.floor(s / 60))}分${pad(s % 60)}秒`;
  return `${pad(Math.floor(s / 3600))}时${pad(Math.floor((s % 3600) / 60))}分${pad(s % 60)}秒`;
}

/** 实时已用时计时（300ms tick；仅运行中渲染）。
 *  2026-11-24 导出共享：工作台回合左下角运行总时长同款复用（锚点外传，
 *  重挂载从锚点重算不归零） */
export function Elapsed({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 300);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(sec)}</span>;
}

/**
 * 回合统计摘要（2026-11-11 两端口径单一来源——工作台/IM 摘要条同文案）：
 * 「用时 X · N 次LLM调用 · N 次工具执行 · N 个子agent」——
 * - LLM 调用数 = thinking/conclusion 文本段与工具段交替的合并段数（文本后紧跟
 *   工具=同一次调用，工具后新文本=下一次）
 * - 工具执行数 = 工具行（子任务行不计入，另计子 agent 数——stages 投影中
 *   其 name 前缀为「子任务」）
 * - durMs 缺省（未收口）省略用时段；仅基于 stages（landed 卡/其他端查看者可算）
 */
export function agentStatsText(stages: AgentStage[], durMs?: number | null): string {
  let llmCalls = 0;
  let tools = 0;
  let subs = 0;
  let prev: 'text' | 'tool' | null = null;
  for (const s of stages) {
    if (s.t === 'thinking' || s.t === 'conclusion') {
      if (prev !== 'text') llmCalls += 1;
      prev = 'text';
    } else if (s.t === 'tool') {
      const name = s.name ?? '';
      if (name.startsWith('子任务')) {
        subs += 1;
        // 透明：不打断文本段（对齐 items 级口径——子任务卡不属 LLM 调用段）
      } else {
        tools += 1;
        if (prev !== 'text') llmCalls += 1; // 无前置文本的工具批次=独立一次调用
        prev = 'tool';
      }
    }
  }
  return [
    durMs != null ? `用时 ${formatDuration(Math.round(durMs / 1000))}` : null,
    `${llmCalls} 次LLM调用`,
    `${tools} 次工具执行`,
    `${subs} 个子agent`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface AgentProcessCardProps {
  body: AgentCardBody;
  /** 运行中标记（工作台回合=active；IM 落流卡按 body.status 判定亦可） */
  live?: boolean;
  startedAt?: number;
  /** 落流卡孤儿自降级阈值（ms）：body.status=running 且 started_at 超过此值 →
   *  按中断终态渲染（卡死轮次被杀后消息体永远烙 running，2026-11-10 真机） */
  staleAfterMs?: number;
  /** 结论/卡尾操作区（追问/打开工作台/审批条——由壳组件注入，结论下方） */
  actions?: ReactNode;
  testId?: string;
  /** 强制展开过程区（工作台未决审批不可折叠藏起） */
  forceExpand?: boolean;
  /** 卡头收起钮回调（2026-11-11 IM 落流卡一行折叠态的展开/收起；工作台不传
   *  则不渲染该钮，展示与行为零变化） */
  onCollapse?: () => void;
  /** 过程区内容覆盖（工作台富交互明细：审批卡/子任务卡/可展开工具卡/中间正文；
   *  结论仍取 body.stages 最后一段——工作台经 stagesFromStream 投影喂入） */
  children?: ReactNode;
}

export function AgentProcessCard({ body, live, startedAt, staleAfterMs, actions, testId, forceExpand, onCollapse, children }: AgentProcessCardProps) {
  const { token } = theme.useToken();
  // 孤儿降级：非 live 视图的 running 卡超龄 → 视作中断终态
  const stale =
    live !== true && staleAfterMs != null && body.status === 'running' &&
    typeof body.started_at === 'number' && Date.now() - body.started_at > staleAfterMs;
  const running = (live === true || body.status === 'running') && !stale;
  // 收口后过程默认折叠；运行中恒展开
  const [expanded, setExpanded] = useState(false);
  const showProcess = running || expanded || forceExpand === true;

  const lastConclusionIdx = body.stages.map((x) => x.t).lastIndexOf('conclusion');
  const processStages = body.stages.filter((_, i) => i !== lastConclusionIdx);
  const lastConclusion = lastConclusionIdx >= 0 ? body.stages[lastConclusionIdx] : null;
  const durMs = body.started_at && body.ended_at ? body.ended_at - body.started_at : null;
  // 统计：运行中不冻结用时（头部状态 chip 由 Elapsed 实时走秒）；收口后带冻结用时
  const statsText = agentStatsText(body.stages, running ? null : durMs);
  const hasChildren = Array.isArray(children) ? children.length > 0 : children != null;
  const hasProcess = processStages.length > 0 || hasChildren;
  // 空终态（无过程无结论且非运行）不渲染——历史残留空卡不占位
  if (!hasProcess && !lastConclusion && !running) return null;

  const stateTag = running ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: token.colorPrimary }}>
      <Spin size="small" /> 运行中{startedAt != null ? <> · <Elapsed startedAt={startedAt} /></> : null}
    </span>
  ) : (
    <Tag
      color={stale || body.status === 'cancelled' ? 'default' : body.status === 'done' ? 'success' : 'error'}
      style={{ marginInlineEnd: 0 }}
    >
      {stale ? '已中断' : body.status === 'done' ? '已完成' : body.status === 'failed' ? '失败' : '已取消'}
    </Tag>
  );

  return (
    <div
      data-testid={testId}
      style={{
        borderRadius: 12,
        border: `1px solid ${running ? token.colorPrimary : token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        overflow: 'hidden',
        maxWidth: 680,
      }}
    >
      {/* 头部：标题 + 本轮问题 + 状态。onCollapse 在时整条头部行=收起触发区
          （2026-11-11 用户口径：title 区域都可点，箭头仅指示） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
          cursor: onCollapse ? 'pointer' : undefined,
        }}
        {...(onCollapse
          ? {
              role: 'button',
              tabIndex: 0,
              title: '收起',
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation();
                onCollapse();
              },
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onCollapse();
                }
              },
            }
          : undefined)}
      >
        <Bot size={14} />
        <span style={{ fontWeight: 600 }}>Agent</span>
        {body.question ? (
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: token.colorTextSecondary }} title={onCollapse ? undefined : body.question}>
            {running ? '正在处理：' : '已处理：'}{body.question}
          </span>
        ) : <span style={{ flex: 1 }} />}
        {stateTag}
        {onCollapse ? <ChevronUp size={13} aria-hidden /> : null}
      </div>

      <div style={{ padding: '8px 12px' }}>
        {/* 0 阶段占位（新回合落卡即渲染：消息一发出就见「处理中」气泡，不等模型） */}
        {running && !hasProcess && !lastConclusion ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: token.colorTextSecondary }}>
            <Spin size="small" /> 正在等待 AI 响应…
          </span>
        ) : null}
        {/* 过程折叠区块：摘要条=整块折叠开关（思考小卡/工具/中间正文全收此块） */}
        {hasProcess ? (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={showProcess ? '收起过程' : '展开过程'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '4px 0',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 13,
                color: token.colorText,
              }}
            >
              <ChevronRight
                size={12}
                style={{ transform: showProcess ? 'rotate(90deg)' : 'none', transition: 'transform .2s', color: token.colorTextTertiary }}
                aria-hidden
              />
              <span style={{ fontWeight: 500, color: running ? token.colorPrimary : undefined }}>
                {running ? '思考中' : stale ? '已中断' : '已深度思考'}
              </span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {statsText}
              </Typography.Text>
            </button>
            {showProcess ? (
              <div style={{ padding: '4px 0' }}>
                {children ??
                  processStages.map((s, j) =>
                    s.t === 'thinking' ? (
                      // streaming 用投影透传的精确旗标（本轮思考已收尾即折叠，不再
                      // 启发式撑到下一阶段——2026-11-11 用户口径：一轮思考完就收）
                      <ThinkingCollapse key={j} text={s.digest ?? ''} streaming={running && s.streaming === true} />
                    ) : s.t === 'tool' ? (
                      <ToolRow key={j} s={s} />
                    ) : (
                      <div key={j} style={{ margin: '6px 0' }}>
                        <MarkdownText text={s.md ?? ''} />
                      </div>
                    ),
                  )}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 最终结论：卡内过程块下方常开（流式光标只挂末段结论） */}
        {lastConclusion ? (
          <div style={{ position: 'relative' }}>
            <MarkdownText text={lastConclusion.md ?? ''} />
            {running && lastConclusionIdx === body.stages.length - 1 ? (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 15,
                  marginLeft: 2,
                  verticalAlign: 'text-bottom',
                  background: token.colorPrimary,
                  animation: 'agc-pulse 0.9s steps(2) infinite',
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {actions ? <div style={{ padding: '6px 12px', borderTop: `1px solid ${token.colorBorderSecondary}` }}>{actions}</div> : null}
    </div>
  );
}
