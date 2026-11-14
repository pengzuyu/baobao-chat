/**
 * 工具调用组（D19 对齐 change-my-life ToolCallGroup）：
 * - 灰底汇总条：运行中「正在执行 (N 个工具)」；全部完成「N 个工具调用 · 全部完成」
 * - 组内任一工具运行中=默认展开、全部落定=自动折叠为一行条（手动点击可翻转）
 * - 组内行复用 ToolCard（自带运行中展开/落定折叠）
 * - D26-O6：tool-group 类退役——内联 token 容器（折叠行为原样保留）。
 */

import { memo, useEffect, useState } from 'react';
import { Typography, theme } from 'antd';
import { ChevronDown, Wrench } from 'lucide-react';
import type { StreamItem } from '../store/agent';
import { ToolCard } from './ToolCard';

type ToolItem = Extract<StreamItem, { kind: 'tool' }>;

/** memo + 逐项比较（2026-11-11 卡顿修复）：renderStreamItems 每次渲染重建
 * toolRun 数组（引用必变），须比内容而非引用才能跳过重渲 */
export const ToolGroup = memo(function ToolGroup({ items }: { items: ToolItem[] }) {
  const { token } = theme.useToken();
  const running = items.some((it) => !it.result);
  const [open, setOpen] = useState(running);
  useEffect(() => {
    setOpen(running);
  }, [running]);
  if (items.length === 0) return null;
  return (
    <div style={{ background: token.colorFillQuaternary, borderRadius: token.borderRadiusLG, margin: '4px 0', overflow: 'hidden' }}>
      <button
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '6px 10px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 12,
          textAlign: 'left',
          height: 'auto',
          color: token.colorTextSecondary,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <Wrench size={13} aria-hidden style={{ flexShrink: 0 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, textAlign: 'left' }}>
          {running ? `正在执行 (${items.length} 个工具)` : `${items.length} 个工具调用 · 全部完成`}
        </Typography.Text>
        <ChevronDown
          size={13}
          aria-hidden
          style={{ color: token.colorTextQuaternary, flexShrink: 0, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4 }}>
          {items.map((it) => (
            <ToolCard key={it.key} item={it} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
