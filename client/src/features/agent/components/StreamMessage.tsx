/**
 * 会话流消息行（PAG-03 §3.3 渲染规范的降级实现）：
 * - 用户消息：右侧主色浅底气泡
 * - Agent 消息：左侧 Bot 头像 + markdown 纯文本降级渲染（标题/列表/代码/表格/粗体/行内码）
 * - 流式期间（streaming）尾部渲染闪烁光标（INT-AG-01）
 * - 思考摘要：默认收起一行，点击展开（channel=reasoning 的 delta 不进正文）
 * MarkdownText 同时供日报页（PAG 新增）复用。
 */

import { useState, type ReactNode } from 'react';
import { Bot, ChevronRight } from 'lucide-react';

/** 行内标记降级渲染：`code` → <code>，**bold** → <strong> */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) out.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    else out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableCell = (c: string): boolean => c.length > 0 && /^:?-{2,}:?$/.test(c);

/** markdown 纯文本降级渲染（不引第三方渲染器；覆盖日报/结论用到的语法子集） */
export function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏
      blocks.push(
        <pre key={key++} className="agent-md__code">
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 表格（连续 | 行；分隔行跳过）
    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.every(isTableCell)) rows.push(cells);
        i += 1;
      }
      blocks.push(
        <table key={key++} className="agent-md__table">
          <tbody>
            {rows.map((cells, r) => (
              <tr key={r} className={r === 0 ? 'agent-md__tr--head' : undefined}>
                {cells.map((c, ci) => (
                  <td key={ci}>{renderInline(c, `t${key}-${r}-${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6') as 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={key++} className={`agent-md__h agent-md__h--${level}`}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i += 1;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={key++} className="agent-md__list">
          {items.map((it, li) => (
            <li key={li}>{renderInline(it, `l${key}-${li}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // 段落（收集到空行/新块为止）
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].trimStart().startsWith('|') &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={key++} className="agent-md__p">
        {renderInline(para.join('\n'), `p${key}`)}
      </p>,
    );
  }

  return <div className="agent-md">{blocks}</div>;
}

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
