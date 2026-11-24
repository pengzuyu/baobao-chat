/**
 * 运行中打点动画（D08 §3.2 shimmer 行的会话流版：running 时加载指示 + 文案）。
 * D19 增 300ms tick 已用时计时（对齐 change-my-life Elapsed）。
 * 2026-11-24 修计时重置：起点改外传锚点 startedAt（回合起点=user.ts，store 持久）——
 * 原实现起点=挂载时刻，切会话/切页面回来重挂载即归零；无锚点时回落挂载时刻（瞬态兜底）。
 * D26-O6：自研 typing-state 类退役——内联 token 容器 + antd Spin（动画由 antd 承载）。
 */

import { memo, useEffect, useState } from 'react';
import { Spin, Typography } from 'antd';

interface TypingStateProps {
  text?: string;
  /** 计时锚点（ms 纪元）：传回合起点 user.ts——重挂载从锚点重算，不归零 */
  startedAt?: number;
}

/** 毫秒 → 「12.3s」/「1分05秒」 */
function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export const TypingState = memo(function TypingState({ text = 'Agent 正在处理', startedAt }: TypingStateProps) {
  const [startedAtMs] = useState(() => (startedAt && startedAt > 0 ? startedAt : Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label={text}
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        borderRadius: 999,
        background: 'var(--bbc-primary-light)',
      }}
    >
      <Spin size="small" aria-hidden />
      <Typography.Text style={{ fontSize: 12, flexShrink: 0 }}>
        {text}…
      </Typography.Text>
      <Typography.Text code style={{ fontSize: 11, flexShrink: 0 }}>
        {formatElapsed(now - startedAtMs)}
      </Typography.Text>
    </div>
  );
});
