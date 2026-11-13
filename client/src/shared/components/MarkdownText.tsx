/**
 * markdown 纯文本降级渲染（不引第三方渲染器；覆盖结论/日报用到的语法子集：
 * 围栏代码/表格/标题/列表/粗体/行内码；D24 补链接/图片/有序列表——博客阅读页需要，
 * agent 消费方只增不改）。
 * 原实现于 features/agent/StreamMessage（PAG-03 §3.3 降级规范），
 * D18 内嵌 Agent 卡起移入 shared 供 im 落流卡/活动卡与 agent 工作台共用。
 */

import { memo, type ReactNode } from 'react';

/** 链接出站协议白名单（javascript:/data: 等拒绝——降级渲染的最小 XSS 防线） */
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|\/)/i.test(u)) return u;
  return null;
}

/** 行内标记降级渲染：`code` → <code>，**bold** → <strong>，
 * [text](url) → <a target=_blank>，![alt](url) → <img>（D24） */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|!?\[[^\]]*\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      out.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('![')) {
      // 图片 ![alt](url)
      const im = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (im) {
        const href = safeHref(im[2]);
        out.push(href
          ? <img key={`${keyPrefix}-img${i}`} className="agent-md__img" src={href} alt={im[1]} loading="lazy" />
          : token);
      } else {
        out.push(token);
      }
    } else {
      // 链接 [text](url)
      const lm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      if (lm) {
        const href = safeHref(lm[2]);
        out.push(href
          ? <a key={`${keyPrefix}-a${i}`} className="agent-md__a" href={href} target="_blank" rel="noreferrer noopener">{lm[1] || href}</a>
          : token);
      } else {
        out.push(token);
      }
    }
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableCell = (c: string): boolean => c.length > 0 && /^:?-{2,}:?$/.test(c);

/** memo（2026-11-11 卡顿修复）：流式期间只有正在生长的那条消息 text 变化，
 * 历史消息 text 引用稳定 → 跳过全量 markdown 重解析（O(全列表×每token) 主线程杀手） */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
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
      i += 1; // 根因修复（2026-11-13 真机「打开文章整页卡死」）：漏此行则 # 开头行 continue 后 i 永不推进 → 无限 push 主线程死循环
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

    // 有序列表（D24：`1. item`——序号任意，渲染统一 <ol>）
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={key++} className="agent-md__list agent-md__list--ordered">
          {items.map((it, li) => (
            <li key={li}>{renderInline(it, `ol${key}-${li}`)}</li>
          ))}
        </ol>,
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
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i])
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
});
