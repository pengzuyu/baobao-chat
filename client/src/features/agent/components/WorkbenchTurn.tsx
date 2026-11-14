/**
 * ZCode 式全页过程流回合（2026-11-14 用户裁决：工作台弃聊天气泡/共用过程卡形态）：
 * 一轮 = 全宽用户消息块 + 过程流一行一项（思考卡/工具行[每个工具一行，不归组]/
 * 审批/提问/子任务/委派/中间正文/系统行）+ 结论 markdown 常开（流式光标）；
 * 运行中过程全展开 + 状态行实时走秒；回合收口（turnDoneAt 打点）过程整块折为
 * 一行统计摘要（agentStatsText 两端口径），点击回看；未决审批/提问强制展开不折。
 * 替代 TurnBubble（气泡壳/Bot 头像列/AgentProcessCard 外壳全弃——共享卡留 IM 用，
 * 其导出 ThinkingCollapse/agentStatsText/toolCallCommand 只读复用）。
 */

import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Spin, Typography, theme } from 'antd';
import { ChevronRight } from 'lucide-react';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { ThinkingCollapse, agentStatsText } from '../../../shared/components/AgentProcessCard';
import { stagesFromStream } from '../../im/agent/embedded';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';
import { ToolCard } from './ToolCard';
import { PermissionCard, type PermissionDecision } from './PermissionCard';
import { ClarifyCard, type ClarifySubmit } from './ClarifyCard';
import { SubagentCard } from './SubagentCard';
import { DelegateCard } from './DelegateCard';
import { TypingState } from './TypingState';

type UserItem = Extract<StreamItem, { kind: 'user' }>;

/** 全宽用户消息块（ZCode 式：浅底信息块，替代旧右侧主色气泡） */
const UserBlock = memo(function UserBlock({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        border: `1px solid ${token.colorBorderSecondary}`,
        fontSize: token.fontSize,
        lineHeight: 1.6,
        color: token.colorText,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  );
});

/** 系统提示行（检查点/模式切换/记忆沉淀） */
function SystemRow({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        fontSize: 12,
        color: token.colorTextTertiary,
        background: token.colorFillQuaternary,
        borderRadius: 999,
        padding: '2px 12px',
      }}
    >
      {text}
    </div>
  );
}

/** 中间轮正文（非最终回答，弱化展示） */
function MidBody({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div style={{ fontSize: 13, color: token.colorTextSecondary, borderLeft: `2px solid ${token.colorBorderSecondary}`, paddingLeft: 8 }}>
      {children}
    </div>
  );
}

/** 过程区条目渲染（一行一项：思考卡/工具行/审批/提问/子任务/委派/中间正文/系统行）。
 *  2026-11-14 全页过程流口径：每个工具独立一行 ToolCard，不再连续归组（ToolGroup 退役） */
export function renderProcessItems(
  items: StreamItem[],
  onRespond: (d: PermissionDecision) => void,
  onRespondClarify: (questionId: string, s: ClarifySubmit) => void = (qid, s) => {
    void useAgentStore.getState().respondClarify(qid, s.answers, s.freeText || undefined);
  },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'tool':
        nodes.push(<ToolCard key={item.key} item={item} />);
        break;
      case 'reasoning':
        // 每段思考一张折叠小卡（共享卡同款 ThinkingCollapse：流式展开+段毕自动折）
        nodes.push(<ThinkingCollapse key={item.key} text={item.text} streaming={item.streaming} />);
        break;
      case 'agentText':
        // 中间轮正文（非最终回答）弱化展示
        nodes.push(
          <MidBody key={item.key}>
            <MarkdownText text={item.text} />
          </MidBody>,
        );
        break;
      case 'permission':
        nodes.push(<PermissionCard key={item.key} item={item} onRespond={onRespond} />);
        break;
      case 'clarify':
        nodes.push(
          <ClarifyCard
            key={item.key}
            item={item}
            onRespond={(qid, s) => onRespondClarify(qid, s)}
          />,
        );
        break;
      case 'subagent':
        nodes.push(<SubagentCard key={item.key} item={item} />);
        break;
      case 'delegate':
        nodes.push(<DelegateCard key={item.key} item={item} />);
        break;
      case 'system':
        nodes.push(<SystemRow key={item.key} text={item.text} />);
        break;
      default:
        break;
    }
  }
  return nodes;
}

/** 流条目 → 回合分组：user 条目开回合，其后条目全部归入；首个 user 前的散条进 head */
export function groupTurns(items: StreamItem[]): { head: StreamItem[]; turns: Array<{ user: UserItem; items: StreamItem[] }> } {
  const head: StreamItem[] = [];
  const turns: Array<{ user: UserItem; items: StreamItem[] }> = [];
  let cur: { user: UserItem; items: StreamItem[] } | null = null;
  for (const it of items) {
    if (it.kind === 'user') {
      cur = { user: it, items: [] };
      turns.push(cur);
      continue;
    }
    if (cur) cur.items.push(it);
    else head.push(it);
  }
  return { head, turns };
}

/** 时长格式（对齐 shared/AgentProcessCard 口径；彼处未导出——共享文件 IM 冻结不改，本地副本） */
function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${pad(Math.floor(s / 60))}分${pad(s % 60)}秒`;
  return `${pad(Math.floor(s / 3600))}时${pad(Math.floor((s % 3600) / 60))}分${pad(s % 60)}秒`;
}

/** 实时已用时计时（300ms tick；仅运行中渲染） */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 300);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(sec)}</span>;
}

/** 收口态折叠开关行样式（统计摘要条） */
const summaryToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '4px 0',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  height: 'auto',
};

interface WorkbenchTurnProps {
  /** 本轮用户消息（ts=回合起点；turnDoneAt=收口时刻，store 终态打点） */
  user: UserItem;
  /** 用户消息之后的全过程条目（含最终回答 agentText） */
  items: StreamItem[];
  /** 回合进行中（末轮 + 会话运行态）：过程恒展开 + 实时走秒 */
  active: boolean;
  onRespond: (d: PermissionDecision) => void;
}

/** memo（2026-11-11 卡顿口径延续）：流式每 delta 重建数组，历史回合须比条目引用
 * （appendDelta 保旧条目引用稳定）而非数组引用，才能跳过重渲 */
export const WorkbenchTurn = memo(
  function WorkbenchTurn({ user, items, active, onRespond }: WorkbenchTurnProps) {
    const { token } = theme.useToken();
    // 最终回答 = 最后一段 agentText；其余（思考/工具/审批/子任务/中间正文/系统行）进过程区
    let lastAnswerIdx = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].kind === 'agentText') {
        lastAnswerIdx = i;
        break;
      }
    }
    const lastAnswer = lastAnswerIdx >= 0 ? (items[lastAnswerIdx] as Extract<StreamItem, { kind: 'agentText' }>) : null;
    const processItems = lastAnswerIdx >= 0 ? items.filter((_, i) => i !== lastAnswerIdx) : items;
    const hasProcess = processItems.length > 0;
    // 统计口径单一来源（agentStatsText，与 IM 落流卡同文案）；stages 投影仅算数用
    const { stages } = useMemo(() => stagesFromStream(items), [items]);
    const durMs = user.turnDoneAt != null ? user.turnDoneAt - user.ts : null;
    const statsText = agentStatsText(stages, active ? null : durMs);
    // 未决审批/提问强制展开（交互卡不能被折叠藏起）
    const hasPending = processItems.some(
      (it) => (it.kind === 'permission' && it.outcome === null) || (it.kind === 'clarify' && it.answer === null),
    );
    // 收口后过程默认折叠（点击摘要行回看）；运行中恒展开（对齐旧 AgentProcessCard 折叠语义）
    const [expanded, setExpanded] = useState(false);
    const showProcess = active || expanded || hasPending;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <UserBlock text={user.text} />
        {hasProcess ? (
          active ? (
            // 运行态状态行：实时走秒 + 实时统计（过程恒展开，非折叠开关）
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: token.colorPrimary }}>
              <Spin size="small" aria-hidden />
              <span style={{ fontWeight: 500 }}>正在处理</span>
              <Elapsed startedAt={user.ts} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {statsText}
              </Typography.Text>
            </div>
          ) : (
            // 收口态：一行统计摘要 = 过程折叠开关（点击回看全明细）
            <button type="button" style={summaryToggleStyle} onClick={() => setExpanded((v) => !v)} title={showProcess ? '收起过程' : '展开过程'}>
              <ChevronRight
                size={12}
                aria-hidden
                style={{ color: token.colorTextTertiary, flexShrink: 0, transition: 'transform 0.15s ease', transform: showProcess ? 'rotate(90deg)' : undefined }}
              />
              <span style={{ fontWeight: 500 }}>已深度思考</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {statsText}
              </Typography.Text>
            </button>
          )
        ) : null}
        {showProcess && hasProcess ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {renderProcessItems(processItems, onRespond)}
          </div>
        ) : null}
        {/* 结论：常开 markdown + 流式光标（仅末段流式中；hairline 与过程区隔开） */}
        {lastAnswer ? (
          <div
            style={{
              position: 'relative',
              borderTop: hasProcess ? `1px solid ${token.colorBorderSecondary}` : undefined,
              paddingTop: hasProcess ? 10 : 2,
            }}
          >
            <MarkdownText text={lastAnswer.text} />
            {active && lastAnswer.streaming ? (
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
        {/* 0 阶段占位：回合已发出但模型未产出任何条目 */}
        {active && !hasProcess && !lastAnswer ? <TypingState text="Agent 正在处理" /> : null}
      </div>
    );
  },
  (a, b) =>
    a.active === b.active &&
    a.onRespond === b.onRespond &&
    a.user === b.user &&
    a.items.length === b.items.length &&
    a.items.every((it, i) => it === b.items[i]),
);
