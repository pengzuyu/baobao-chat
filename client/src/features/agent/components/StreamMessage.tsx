/**
 * 会话流消息行（PAG-03 §3.3 渲染规范的降级实现）：
 * - 用户消息：右侧主色浅底气泡
 * - Agent 消息：左侧 Bot 头像 + markdown 纯文本降级渲染（标题/列表/代码/表格/粗体/行内码）
 * - 流式期间（streaming）尾部渲染闪烁光标（INT-AG-01）
 * - 思考摘要：默认收起一行，点击展开（channel=reasoning 的 delta 不进正文）
 * MarkdownText 已移 shared/components（D18 内嵌卡复用）；本文件 re-export 供日报页等既有消费方。
 */

import { useState } from 'react';
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

/** 思考摘要折叠行（channel=reasoning；默认收起一行，D08 §3.3） */
export function ReasoningCollapse({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const digest = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  return (
    <div className={`agent-row agent-row--reasoning${open ? ' agent-row--reasoning--open' : ''}`}>
      <button type="button" className="agent-reasoning__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`agent-reasoning__chev${open ? ' agent-reasoning__chev--open' : ''}`} aria-hidden />
        <span className="agent-reasoning__label">思考摘要</span>
        <span className="agent-reasoning__digest">{streaming ? `${digest}（思考中…）` : digest}</span>
      </button>
      {open ? <div className="agent-reasoning__body">{text}</div> : null}
    </div>
  );
}
