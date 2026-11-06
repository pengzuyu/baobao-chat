/** 运行中打点动画（D08 §3.2 shimmer 行的会话流版：running 时三个跳动圆点 + 文案） */

interface TypingStateProps {
  text?: string;
}

export function TypingState({ text = 'Agent 正在处理' }: TypingStateProps) {
  return (
    <div className="typing-state" role="status" aria-label={text}>
      <span className="typing-state__dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="typing-state__text">{text}…</span>
    </div>
  );
}
