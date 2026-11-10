/**
 * 会话流消息行（PAG-03 §3.3 渲染规范的降级实现）：
 * - 用户消息：右侧主色浅底气泡
 * - Agent 消息：左侧 Bot 头像 + markdown 纯文本降级渲染（标题/列表/代码/表格/粗体/行内码）
 * - 流式期间（streaming）尾部渲染闪烁光标（INT-AG-01）
 * - 思考摘要：默认收起一行，点击展开（channel=reasoning 的 delta 不进正文）
 * MarkdownText 已移 shared/components（D18 内嵌卡复用）；本文件 re-export 供日报页等既有消费方。
 */

import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { MarkdownText } from '../../../shared/components/MarkdownText';

export { MarkdownText };

/** 用户消息（右侧主色浅底气泡） */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="agent-row agent-row--user">
      <div className="agent-bubble agent-bubble--user">{text}</div>
    </div>
  );
}

/** Agent 消息（左侧头像 + markdown 降级渲染 + 流式光标） */
export function StreamMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="agent-row agent-row--bot">
      <div className="agent-row__avatar" aria-hidden>
        <Bot size={16} strokeWidth={1.8} />
      </div>
      <div className="agent-bubble agent-bubble--bot">
        <MarkdownText text={text} />
        {streaming ? <span className="agent-caret" aria-hidden /> : null}
      </div>
    </div>
  );
}

/**
 * 思考折叠卡（channel=reasoning；D19 对齐 change-my-life ThinkingCard 行为）：
 * - 流式强制展开（头部呼吸动画 + max-height 过渡 + 内部跟底滚动），结束自动收起为一行摘要
 * - 点击头部可手动切换；streaming 翻转时恢复自动态
 */
export function ReasoningCollapse({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);
  // 流式跟底（展开态下新增量自动滚到最新）
  useEffect(() => {
    if (streaming && open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, streaming, open]);
  const digest = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return (
    <div className={`agent-row agent-row--reasoning${open ? ' agent-row--reasoning--open' : ''}${streaming ? ' agent-row--reasoning--streaming' : ''}`}>
      <button type="button" className="agent-reasoning__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`agent-reasoning__chev${open ? ' agent-reasoning__chev--open' : ''}`} aria-hidden />
        <span className="agent-reasoning__label">{streaming ? '思考中' : '思考过程'}</span>
        <span className="agent-reasoning__digest">{digest}</span>
      </button>
      <div className="agent-reasoning__body" ref={bodyRef} style={{ maxHeight: open ? 300 : 0 }}>
        {text}
      </div>
    </div>
  );
}
