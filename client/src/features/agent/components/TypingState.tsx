/**
 * 运行中打点动画（D08 §3.2 shimmer 行的会话流版：running 时三个跳动圆点 + 文案）。
 * D19 增 300ms tick 已用时计时（对齐 change-my-life Elapsed；计时起点=本段运行指示
 * 出现时刻，暂停/等待审批等状态切换会重挂载自然重置）。
 */

import { memo, useEffect, useState } from 'react';

interface TypingStateProps {
  text?: string;
}

/** 毫秒 → 「12.3s」/「1分05秒」 */
function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

export const TypingState = memo(function TypingState({ text = 'Agent 正在处理' }: TypingStateProps) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="typing-state" role="status" aria-label={text}>
      <span className="typing-state__dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="typing-state__text">{text}…</span>
      <span className="typing-state__elapsed">{formatElapsed(now - startedAt)}</span>
    </div>
  );
});
