/**
 * Markdown 简版渲染器（D05 阶段一登记项：任务书口径"现有 im MarkdownText 或简单
 * pre 渲染"——repo 无现成 MarkdownText，落简版自绘：标题/无序列表/有序列表/
 * 代码块/引用/粗体/行内代码；表格/图片/链接等阶段二换成熟渲染库）。
 * 安全口径：全部走 React 节点拼接，不 innerHTML/dangerouslySetInnerHTML（零注入面）。
 */

import type { ReactNode } from 'react';

/** 行内格式：`code` 与 **bold**（**未闭合回退原文） */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 按 `code` 与 **bold** 切分：交替匹配最先出现者
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const codeAt = rest.indexOf('`');
    const boldAt = rest.indexOf('**');
    if (codeAt < 0 && boldAt < 0) {
      nodes.push(<span key={`${keyPrefix}-t${i++}`}>{rest}</span>);
      break;
    }
    const useCode = codeAt >= 0 && (boldAt < 0 || codeAt < boldAt);
    if (useCode) {
      const close = rest.indexOf('`', codeAt + 1);
      if (close < 0) {
        nodes.push(<span key={`${keyPrefix}-t${i++}`}>{rest}</span>);
        break;
      }
      if (codeAt > 0) nodes.push(<span key={`${keyPrefix}-t${i++}`}>{rest.slice(0, codeAt)}</span>);
      nodes.push(
        <code className="md-lite__code" key={`${keyPrefix}-c${i++}`}>
          {rest.slice(codeAt + 1, close)}
        </code>,
      );
      rest = rest.slice(close + 1);
    } else {
      const close = rest.indexOf('**', boldAt + 2);
      if (close < 0) {
        nodes.push(<span key={`${keyPrefix}-t${i++}`}>{rest}</span>);
        break;
      }
      if (boldAt > 0) nodes.push(<span key={`${keyPrefix}-t${i++}`}>{rest.slice(0, boldAt)}</span>);
      nodes.push(
        <strong key={`${keyPrefix}-b${i++}`}>{renderInline(rest.slice(boldAt + 2, close), `${keyPrefix}-i${i}`)}</strong>,
      );
      rest = rest.slice(close + 2);
    }
  }
  return nodes;
}

interface Block {
  kind: 'h' | 'ul' | 'ol' | 'code' | 'quote' | 'p' | 'blank';
  level?: number;
  lang?: string;
  lines: string[];
}

/** 块级切分： fenced 代码块 → 标题/列表/引用/段落/空行 */
function parseBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 ```（文件尾未闭合则到末尾）
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, lines: [h[2]] });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', lines: items });
      continue;
    }
    if (/^\s*\d+[.、]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.、]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.、]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', lines: items });
      continue;
    }
    if (line.startsWith('> ')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        body.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }
    if (line.trim() === '') {
      blocks.push({ kind: 'blank', lines: [] });
      i++;
      continue;
    }
    // 段落：连续非空非格式行合并
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.、]\s+/.test(lines[i]) &&
      !lines[i].startsWith('> ') &&
      !lines[i].trim().startsWith('```')
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

/** markdown 正文渲染（编辑器预览态） */
export function MarkdownLite({ md }: { md: string }) {
  const blocks = parseBlocks(md ?? '');
  return (
    <div className="md-lite" data-testid="doc-md-preview">
      {blocks.map((b, idx) => {
        const key = `b${idx}`;
        switch (b.kind) {
          case 'h':
            return (
              <div key={key} className={`md-lite__h md-lite__h--${b.level}`}>
                {renderInline(b.lines[0], key)}
              </div>
            );
          case 'ul':
            return (
              <ul key={key} className="md-lite__ul">
                {b.lines.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="md-lite__ol">
                {b.lines.map((it, j) => (
                  <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={key} className="md-lite__pre" data-lang={b.lang || undefined}>
                <code>{b.lines.join('\n')}</code>
              </pre>
            );
          case 'quote':
            return (
              <blockquote key={key} className="md-lite__quote">
                {b.lines.map((it, j) => (
                  <div key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</div>
                ))}
              </blockquote>
            );
          case 'blank':
            return <div key={key} className="md-lite__blank" />;
          default:
            return (
              <p key={key} className="md-lite__p">
                {renderInline(b.lines.join(' '), key)}
              </p>
            );
        }
      })}
    </div>
  );
}
