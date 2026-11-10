/**
 * Agent 过程卡（D18 §3.4，纯展示——活动卡与落流卡共用）：
 * - 运行中（live）：思考卡流式展开（呼吸动画）+ 工具组展开 + 结论流式 + 实时计时
 * - 终态：整体折叠为活动摘要条（▸ N 步 · M 个工具 · 耗时 Xs），点击展开逐项
 * 页面效果对齐 change-my-life agent-web（ThinkingCard/ToolCallGroup 模式，仅效果参考）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bot, ChevronDown, Code2, Lightbulb, Loader2 } from 'lucide-react';
import { MarkdownText } from './MarkdownText';

/** 落流卡 stages 条目（D18 §4.1；服务端不透明透传，此为客户端投影类型） */
export interface AgentStage {
  t: 'thinking' | 'tool' | 'conclusion';
  ts?: number;
  /** thinking：摘要文本 */
  digest?: string;
  /** tool */
  name?: string;
  status?: 'ok' | 'fail' | 'blocked' | 'running';
  ms?: number;
  summary?: string;
  /** conclusion：markdown 正文 */
  md?: string;
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
}

/** 思考卡：流式强制展开+呼吸动画；结束自动折叠（change-my-life ThinkingCard 模式） */
function ThinkingCollapse({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setExpanded(streaming); // 思考结束自动收起；新一轮思考展开
  }, [streaming]);
  useEffect(() => {
    if (!expanded || !streaming) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight; // 流式期间跟底
  }, [text, expanded, streaming]);
  return (
    <div className={`agc-thinking${streaming ? ' agc-thinking--streaming' : ''}`}>
      <button type="button" className="agc-thinking__head" onClick={() => setExpanded((v) => !v)}>
        <Lightbulb size={13} />
        <span className="agc-thinking__title">{streaming ? '思考中...' : '思考过程'}</span>
        <ChevronDown size={13} className={`agc-chev${expanded ? ' agc-chev--open' : ''}`} />
      </button>
      <div ref={bodyRef} className="agc-thinking__body" style={{ maxHeight: expanded ? 300 : 0 }}>
        <pre className="agc-thinking__text">{text}</pre>
      </div>
    </div>
  );
}

/** 工具行：name — 参数/结果摘要 · 耗时（code 样式单行） */
function ToolRow({ s }: { s: AgentStage }) {
  const running = s.status === 'running';
  return (
    <div className={`agc-tool${running ? ' agc-tool--running' : ''}${s.status === 'fail' ? ' agc-tool--fail' : ''}`}>
      {running ? <Loader2 size={12} className="agc-spin" /> : <Code2 size={12} />}
      <code>
        {s.name}
        {s.summary ? ` — ${s.summary}` : ''}
      </code>
      {s.ms != null && s.ms > 0 ? <span className="agc-tool__ms">{(s.ms / 1000).toFixed(1)}s</span> : null}
      {s.status === 'fail' ? <span className="agc-tool__fail">失败</span> : null}
    </div>
  );
}

/** 实时已用时计时（300ms tick；仅运行中渲染） */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 300);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return <span className="agc-elapsed">{sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`}</span>;
}

export interface AgentProcessCardProps {
  body: AgentCardBody;
  /** 运行中标记（活动卡=true；落流卡按 body.status 判定亦可） */
  live?: boolean;
  /** 会话存活但当前轮已结束（活动卡待追问态：折叠摘要条、无运行动画/计时） */
  idle?: boolean;
  startedAt?: number;
  /** 卡尾操作区（追问/转到工作台/重试/在我端继续——由壳组件注入） */
  actions?: ReactNode;
  testId?: string;
}

export function AgentProcessCard({ body, live, idle, startedAt, actions, testId }: AgentProcessCardProps) {
  const running = (live === true || body.status === 'running') && idle !== true;
  const [expanded, setExpanded] = useState(running); // 运行中默认展开；终态折叠为摘要条
  useEffect(() => {
    setExpanded(running);
  }, [running]);

  const tools = body.stages.filter((s) => s.t === 'tool');
  const conclusion = body.stages.filter((s) => s.t === 'conclusion');
  const totalSteps = body.stages.length;
  const durSec =
    body.started_at && body.ended_at ? Math.round((body.ended_at - body.started_at) / 1000) : null;
  const lastConclusion = conclusion.length ? conclusion[conclusion.length - 1] : null;
  const conclusionStreaming = running && !!lastConclusion;

  return (
    <div className={`agc-card${running ? ' agc-card--running' : ''}`} data-testid={testId}>
      <div className="agc-card__head">
        <Bot size={14} />
        <span className="agc-card__title">Agent</span>
        {running ? (
          <span className="agc-card__state">
            <Loader2 size={11} className="agc-spin" /> 运行中{startedAt ? <> · <Elapsed startedAt={startedAt} /></> : null}
          </span>
        ) : idle ? (
          <span className="agc-card__state agc-card__state--idle">已就绪 · 可追问</span>
        ) : (
          <span className={`agc-card__state agc-card__state--${body.status}`}>
            {body.status === 'done' ? '已完成' : body.status === 'failed' ? '失败' : '已取消'}
            {durSec != null ? ` · ${durSec >= 60 ? `${Math.floor(durSec / 60)}分${durSec % 60}秒` : `${durSec}秒`}` : ''}
          </span>
        )}
      </div>

      {/* 终态：折叠摘要条（点击展开） */}
      {!running && !expanded ? (
        <button type="button" className="agc-summary-bar" onClick={() => setExpanded(true)} data-testid="agc-summary-bar">
          <ChevronDown size={12} className="agc-chev" />
          <Code2 size={12} />
          <span>
            {totalSteps} 个过程步骤 · {tools.length} 次工具调用
            {body.rounds ? ` · ${body.rounds} 轮对话` : ''}
          </span>
        </button>
      ) : (
        <div className="agc-card__body">
          {body.stages.map((s, i) =>
            s.t === 'thinking' ? (
              <ThinkingCollapse key={i} text={s.digest ?? ''} streaming={running && i === body.stages.length - 1 && !tools.some((t) => t.status === 'running')} />
            ) : s.t === 'tool' ? (
              <ToolRow key={i} s={s} />
            ) : (
              <div key={i} className="agc-conclusion">
                <MarkdownText text={s.md ?? ''} />
                {conclusionStreaming ? <span className="agc-cursor" /> : null}
              </div>
            ),
          )}
          {body.sources && body.sources.length > 0 ? (
            <div className="agc-sources">
              来源：{body.sources.map((src, i) => (
                <span key={i} className="agc-sources__item">{src}</span>
              ))}
            </div>
          ) : null}
          {!running && expanded ? (
            <button type="button" className="agc-collapse-btn" onClick={() => setExpanded(false)}>
              收起 <ChevronDown size={11} className="agc-chev agc-chev--open" />
            </button>
          ) : null}
        </div>
      )}
      {actions ? <div className="agc-card__actions">{actions}</div> : null}
    </div>
  );
}
