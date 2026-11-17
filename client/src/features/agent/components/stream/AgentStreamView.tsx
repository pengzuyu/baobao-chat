/**
 * 平铺消息流渲染器（D33 §3.5）：条目分组（user 开回合）→ UserBlock 平铺块 +
 * TurnBlock 回合容器。工作台中栏与右栏「运行详情」共用（子 agent 过程流与
 * 主时间线同款渲染，拍板 #3「与主 agent 一样，但不在一个窗口」的落点）。
 * active=末回合运行中（中栏按会话状态传；侧栏 run 流按 run 状态传）。
 */

import { Fragment, useMemo } from 'react';
import type { StreamItem } from '../../store/agent';
import type { PermissionDecision } from '../PermissionCard';
import { UserBlock } from './UserBlock';
import { TurnBlock, renderStreamItems } from './TurnBlock';
import { TypingState } from '../TypingState';

type UserItem = Extract<StreamItem, { kind: 'user' }>;

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

export interface AgentStreamViewProps {
  items: StreamItem[];
  onRespond: (d: PermissionDecision) => void;
  /** 末回合运行中（收口折叠↔平铺全显示切换）；缺省 false（历史/侧栏终态） */
  active?: boolean;
}

export function AgentStreamView({ items, onRespond, active = false }: AgentStreamViewProps) {
  const { head, turns } = useMemo(() => groupTurns(items), [items]);
  return (
    <>
      {/* 首个 user 前的散条（历史残留事件流；正常为空） */}
      {head.length > 0 ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{renderStreamItems(head, onRespond)}</div> : null}
      {turns.map((t, i) => (
        <Fragment key={t.user.key}>
          <UserBlock text={t.user.text} />
          <TurnBlock user={t.user} items={t.items} active={i === turns.length - 1 && active} onRespond={onRespond} />
        </Fragment>
      ))}
      {/* 运行中但尚无回合可挂载（回合启动阶段）→ 独立打点 */}
      {active && turns.length === 0 ? <TypingState text="Agent 正在处理" /> : null}
    </>
  );
}
