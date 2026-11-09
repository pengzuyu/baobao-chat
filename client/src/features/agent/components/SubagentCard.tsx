/**
 * 子 Agent 卡（D16 类型 1 / P0-4）：并行探查任务行——
 * spawn → running（spinner）→ done/fail（摘要可展开）。
 * runId=持久 r-{seq}（agent_run 审计行关联；展开体标注 run 号）。
 */

import { useState } from 'react';
import { ChevronRight, Loader2, Radar } from 'lucide-react';
import type { StreamItem } from '../store/agent';

type SubagentItem = Extract<StreamItem, { kind: 'subagent' }>;

export function SubagentCard({ item }: { item: SubagentItem }) {
  const [open, setOpen] = useState(false);

  const statusNode =
    item.status === 'running' ? (
      <span className="tool-card__status tool-card__status--running">
        <Loader2 size={12} className="bbw-spin" aria-hidden />
        探查中
      </span>
    ) : item.status === 'done' ? (
      <span className="tool-card__status tool-card__status--ok">完成</span>
    ) : (
      <span className="tool-card__status tool-card__status--failed">失败</span>
    );

  return (
    <div className={`subagent-card${item.status === 'failed' ? ' subagent-card--failed' : ''}`}>
      <button type="button" className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`tool-card__chev${open ? ' tool-card__chev--open' : ''}`} aria-hidden />
        <Radar size={13} className="tool-card__icon" aria-hidden />
        <span className="subagent-card__label">子任务</span>
        <span className="subagent-card__digest">{item.taskDigest}</span>
        <span className="tool-card__status-wrap">{statusNode}</span>
      </button>
      {open ? (
        <div className="tool-card__body">
          <div className="tool-card__section">
            <div className="tool-card__section-label">run {item.runId}</div>
            <div className="tool-card__mono">{item.summary ?? '（执行中…）'}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
