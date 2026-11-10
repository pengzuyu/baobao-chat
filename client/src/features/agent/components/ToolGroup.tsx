/**
 * 工具调用组（D19 对齐 change-my-life ToolCallGroup）：
 * - 灰底汇总条：运行中「正在执行 (N 个工具)」图标呼吸；全部完成「N 个工具调用 · 全部完成」
 * - 组内任一工具运行中=默认展开、全部落定=自动折叠为一行条（手动点击可翻转）
 * - 组内行复用 ToolCard（自带运行中展开/落定折叠）
 */

import { useEffect, useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import type { StreamItem } from '../store/agent';
import { ToolCard } from './ToolCard';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

export function ToolGroup({ items }: { items: ToolItem[] }) {
  const running = items.some((it) => !it.result);
  const [open, setOpen] = useState(running);
  useEffect(() => {
    setOpen(running);
  }, [running]);
  if (items.length === 0) return null;
  return (
    <div className={`tool-group${running ? ' tool-group--running' : ''}`}>
      <button type="button" className="tool-group__head" onClick={() => setOpen((v) => !v)}>
        <Wrench size={13} className="tool-group__icon" aria-hidden />
        <span className="tool-group__title">
          {running ? `正在执行 (${items.length} 个工具)` : `${items.length} 个工具调用 · 全部完成`}
        </span>
        <ChevronDown size={13} className={`tool-group__chev${open ? ' tool-group__chev--open' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="tool-group__body">
          {items.map((it) => (
            <ToolCard key={it.key} item={it} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
