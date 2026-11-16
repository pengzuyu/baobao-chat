/**
 * 回合气泡（2026-11-11 三改：与 IM 落流卡共用 AgentProcessCard 单一实现——用户裁决
 * 「两处同一实现，未来一起调整」）：
 * 一轮问答 = 用户气泡 + 本组件；整轮（过程+最终回答）包在共享折叠卡最外层——
 * body 由 stagesFromStream 投影喂入（结论=stages 最后一段，常开+流式光标），
 * 富交互过程明细（审批卡/子任务卡/可展开工具卡/中间正文）经 children 注入折叠区。
 * 摘要条=工作台统计口径（用时 · N 次LLM调用 · N 次工具执行 · N 个子agent）；
 * 运行中卡片自动展开+边框高亮+实时计时；回合收口自动折叠；未决审批强制展开。
 * D26-O6：agent-row/agent-turn 类退役——内联 token（Bot 头像/系统行/中间正文弱化）。
 */

import { memo, useMemo, type ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { theme } from 'antd';
import { AgentProcessCard, ThinkingCollapse } from '../../../shared/components/AgentProcessCard';
import { MarkdownText } from '../../../shared/components/MarkdownText';
import { stagesFromStream } from '../../im/agent/embedded';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';
import { ToolCard } from './ToolCard';
import { ToolGroup } from './ToolGroup';
import { PermissionCard, type PermissionDecision } from './PermissionCard';
import { ClarifyCard, type ClarifySubmit } from './ClarifyCard';
import { SubagentCard } from './SubagentCard';
import { DelegateCard } from './DelegateCard';
import { TypingState } from './TypingState';

type UserItem = Extract<StreamItem, { kind: 'user' }>;
type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

/** 系统提示行（检查点/模式切换/记忆沉淀；原 agent-system-row，内联 token） */
function SystemRow({ text }: { text: string }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignSelf: 'center',
        fontSize: 12,
        color: token.colorTextTertiary,
        background: token.colorFillQuaternary,
        borderRadius: 999,
        padding: '2px 12px',
        maxWidth: '92%',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}

/** 错误行（error NTF：8011 模型不可用/流中断、8010 超限——不可静默，红字行内卡） */
function ErrorRow({ code, message, fatal }: { code: number; message: string; fatal: boolean }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignSelf: 'stretch',
        fontSize: 12,
        lineHeight: 1.6,
        color: token.colorError,
        background: token.colorErrorBg,
        border: `1px solid ${token.colorErrorBorder}`,
        borderRadius: token.borderRadius,
        padding: '6px 10px',
      }}
    >
      {fatal ? '严重错误' : '出错了'}（{code}）：{message}
    </div>
  );
}

/** 中间轮正文（非最终回答，弱化展示；原 agent-turn__mid，内联 token） */
function MidBody({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div style={{ fontSize: 13, color: token.colorTextSecondary, borderLeft: `2px solid ${token.colorBorderSecondary}`, paddingLeft: 8 }}>
      {children}
    </div>
  );
}

/** 过程区条目渲染（思考折叠卡/工具组/审批/提问/子任务/委派/中间正文/系统行；连续工具归组）。
 *  作为 AgentProcessCard children 注入折叠区（2026-11-11 共用卡实现） */
export function renderProcessItems(
  items: StreamItem[],
  onRespond: (d: PermissionDecision) => void,
  onRespondClarify: (questionId: string, s: ClarifySubmit) => void = (qid, s) => {
    void useAgentStore.getState().respondClarify(qid, s.answers, s.freeText || undefined);
  },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let toolRun: ToolItem[] = [];
  const flushTools = () => {
    if (toolRun.length === 0) return;
    if (toolRun.length === 1) {
      nodes.push(<ToolCard key={toolRun[0].key} item={toolRun[0]} />);
    } else {
      nodes.push(<ToolGroup key={`tg-${toolRun[0].key}`} items={toolRun} />);
    }
    toolRun = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') {
      toolRun.push(item);
      continue;
    }
    flushTools();
    switch (item.kind) {
      case 'reasoning':
        // 每段思考一张折叠小卡（agent card 同款 ThinkingCollapse：流式展开+渐变标题）
        nodes.push(<ThinkingCollapse key={item.key} text={item.text} streaming={item.streaming} />);
        break;
      case 'agentText':
        // 中间轮正文（非最终回答）进折叠区，弱化展示
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
      case 'error':
        nodes.push(<ErrorRow key={item.key} code={item.code} message={item.message} fatal={item.fatal} />);
        break;
      default:
        break;
    }
  }
  flushTools();
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

interface TurnBubbleProps {
  /** 本轮用户消息（ts=回合起点；turnDoneAt=收口时刻，store 终态打点） */
  user: UserItem;
  /** 用户消息之后的全过程条目（含最终回答 agentText） */
  items: StreamItem[];
  /** 回合进行中（末轮 + 会话运行态）：过程区自动展开 + 实时计时 */
  active: boolean;
  onRespond: (d: PermissionDecision) => void;
}

/** memo（2026-11-11 卡顿口径延续）：流式每 delta 重建数组，历史回合须比条目引用
 * （appendDelta 保旧条目引用稳定）而非数组引用，才能跳过重渲 */
export const TurnBubble = memo(
  function TurnBubble({ user, items, active, onRespond }: TurnBubbleProps) {
    const { token } = theme.useToken();
    // 最终回答 = 最后一段 agentText；其余（思考/工具/审批/子任务/中间正文/系统行）进折叠区
    let lastAnswerIdx = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i].kind === 'agentText') {
        lastAnswerIdx = i;
        break;
      }
    }
    const processItems = lastAnswerIdx >= 0 ? items.filter((_, i) => i !== lastAnswerIdx) : items;
    // stages 投影（共用卡数据源）：结论=stages 最后一段（含最终回答），卡下常开
    const { stages, sources, rounds } = useMemo(() => stagesFromStream(items), [items]);

    // 未决审批/提问强制展开（交互卡不能被折叠藏起）；错误行同样不可折叠藏起
    //（回合收口自动折叠——否则 8011/8010 等错误卡被收进折叠区=静默）
    const hasPendingPerm = processItems.some(
      (it) => (it.kind === 'permission' && it.outcome === null) || (it.kind === 'clarify' && it.answer === null),
    );
    const hasError = processItems.some((it) => it.kind === 'error');
    // 卡头问题标识（≤30 字截断，对齐 IM 卡口径）
    const q = [...user.text.trim()];
    const question = q.length > 30 ? `${q.slice(0, 30).join('')}…` : user.text.trim();

    return (
      <div style={{ display: 'flex', gap: 8, maxWidth: '88%' }}>
        <div
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: token.colorPrimaryBg,
            color: token.colorPrimary,
            marginTop: 2,
          }}
        >
          <Bot size={16} strokeWidth={1.8} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <AgentProcessCard
            body={{
              kind: 'embedded_agent',
              status: active ? 'running' : 'done',
              stages,
              sources,
              rounds,
              started_at: user.ts,
              ended_at: user.turnDoneAt,
              question,
            }}
            live={active}
            startedAt={user.ts}
            forceExpand={hasPendingPerm || hasError}
          >
            {processItems.length > 0 ? renderProcessItems(processItems, onRespond) : undefined}
          </AgentProcessCard>
          {active && stages.length === 0 && processItems.length === 0 ? <TypingState text="Agent 正在处理" /> : null}
        </div>
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
