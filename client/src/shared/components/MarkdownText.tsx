/**
 * markdown 手写渲染器（GFM 子集；React 元素直出无 v-html，零 XSS 面）：
 * 围栏代码/表格（对齐）/标题/引用块/水平线/无序+有序列表（两级嵌套/任务项）/
 * 粗体/斜体/删除线/行内码/链接/图片（D24 补链接图片有序列表；富渲染增强补齐
 * 引用/hr/嵌套/任务/删除线/斜体/表格对齐，配色 token 化见 global.css .agent-md 段）。
 * 原实现于 features/agent/StreamMessage（PAG-03 §3.3 降级规范），
 * D18 内嵌 Agent 卡起移入 shared 供 im 落流卡/活动卡与 agent 工作台共用。
 * 已知边界（登记不修）：三级以上列表嵌套拍平、`\*` 转义、`_em_` 下划线斜体
 * （标识符误伤故只认 `*em*`）。
 */

import { memo, type ReactNode } from 'react';

/** 链接出站协议白名单（javascript:/data: 等拒绝——降级渲染的最小 XSS 防线） */
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|\/)/i.test(u)) return u;
  return null;
}

/** 行内标记渲染：`code` → <code>，**bold** → <strong>，*em* → <em>，
 * ~~del~~ → <del>，[text](url) → <a target=_blank>，![alt](url) → <img>（D24）。
 * em 的环视断言（lookbehind）拒绝 `2*3*4` 类运算式误判：开/闭星号紧邻单词字符不匹配。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])|!?\[[^\]]*\]\([^)\s]+\))/g;
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
    } else if (token.startsWith('~~')) {
      out.push(<del key={`${keyPrefix}-d${i}`}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*')) {
      out.push(<em key={`${keyPrefix}-i${i}`}>{token.slice(1, -1)}</em>);
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

/* ─────────────── 块级解析（GFM 子集） ─────────────── */

const FENCE_RE = /^```/;
const TABLE_RE = /^\s*\|/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
/** 表格分隔行单元格（:--- / :--: / ---:）→ 对齐方式 */
const ALIGN_RE = /^(:?)(-{2,})(:?)$/;

function cellAlign(c: string): 'left' | 'center' | 'right' | null {
  const m = ALIGN_RE.exec(c);
  if (!m) return null;
  if (m[1] && m[3]) return 'center';
  if (m[3]) return 'right';
  return 'left';
}

/** 列表项（两级嵌套拍平为父子；task = GFM 任务项 `- [ ]` / `- [x]`） */
type ListItem = { text: string; task: boolean; done: boolean };

function parseTaskItem(text: string): ListItem {
  const tm = /^\[([ xX])\]\s*(.*)$/.exec(text);
  if (!tm) return { text, task: false, done: false };
  return { text: tm[2], task: true, done: tm[1].toLowerCase() === 'x' };
}

/** 列表项渲染（任务项 checkbox + 文本；flex 容器内文本须独立 span，防匿名 flex item
 * 拆散行内流；children 供嵌套子列表挂载） */
function TaskLi({ item, keyPrefix, children }: { item: ListItem; keyPrefix: string; children?: ReactNode }) {
  const cls = item.task
    ? `agent-md__task${item.done ? ' agent-md__task--done' : ''}`
    : undefined;
  return (
    <li className={cls}>
      {item.task && (
        <span className={`agent-md__checkbox${item.done ? ' agent-md__checkbox--on' : ''}`}>
          {item.done ? '✓' : ''}
        </span>
      )}
      <span className="agent-md__task-text">{renderInline(item.text, keyPrefix)}</span>
      {children}
    </li>
  );
}

function renderBlocks(lines: string[], keyPrefix: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (FENCE_RE.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏（流式中未闭合则吃到行尾）
      blocks.push(
        <pre key={key++} className="agent-md__code">
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 表格（连续 | 行；首行=表头，第二行为分隔行时取对齐，GFM 之外的分隔行按数据行）
    if (TABLE_RE.test(line)) {
      const raw: string[][] = [];
      let aligns: ('left' | 'center' | 'right')[] | null = null;
      while (i < lines.length && TABLE_RE.test(lines[i])) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        if (raw.length <= 1 && cells.length > 0 && cells.every((c) => ALIGN_RE.test(c))) {
          aligns = cells.map((c) => cellAlign(c) ?? 'left');
        } else {
          raw.push(cells);
        }
        i += 1;
      }
      const [head, ...body] = raw;
      blocks.push(
        <table key={key++} className="agent-md__table">
          <thead>
            <tr>
              {(head ?? []).map((c, ci) => (
                <th key={ci} className="agent-md__th" style={{ textAlign: aligns?.[ci] }}>
                  {renderInline(c, `${keyPrefix}-th${key}-${ci}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((cells, r) => (
              <tr key={r}>
                {cells.map((c, ci) => (
                  <td key={ci} style={{ textAlign: aligns?.[ci] }}>
                    {renderInline(c, `${keyPrefix}-td${key}-${r}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (level === 1 ? 'h4' : level === 2 ? 'h5' : 'h6') as 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={key++} className={`agent-md__h agent-md__h--${level}`}>{renderInline(heading[2], `${keyPrefix}-h${key}`)}</Tag>);
      i += 1; // 根因修复（2026-11-13 真机「打开文章整页卡死」）：漏此行则 # 开头行 continue 后 i 永不推进 → 无限 push 主线程死循环
      continue;
    }

    // 引用块（剥一层 `>` 前缀后递归，`>> 嵌套` 自然多轮递归）
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote key={key++} className="agent-md__quote">
          <div className="agent-md agent-md--inner">{renderBlocks(buf, `${keyPrefix}-q${key}`)}</div>
        </blockquote>,
      );
      continue;
    }

    // 水平线（须在列表前判定：`---`/`***` 独行）
    if (HR_RE.test(line)) {
      blocks.push(<hr key={key++} className="agent-md__hr" />);
      i += 1;
      continue;
    }

    // 列表（无序/有序统一收集；顶层标记类型切换即分家保持 ul/ol 旧口径；
    // 缩进 ≥2 空格为二级，挂到上一顶层项）
    if (LIST_RE.test(line)) {
      const firstOrdered = /^\s*\d/.test(line);
      const items: (ListItem & { children: ListItem[] })[] = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (!lm) break;
        const level = lm[1].length >= 2 ? 1 : 0;
        const ordered = /\d/.test(lm[2][0]);
        if (level === 0 && ordered !== firstOrdered) break;
        const item = parseTaskItem(lm[3]);
        if (level === 1 && items.length > 0) {
          items[items.length - 1].children.push(item);
        } else {
          items.push({ ...item, children: [] });
        }
        i += 1;
      }
      const Tag = firstOrdered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key++} className={`agent-md__list${firstOrdered ? ' agent-md__list--ordered' : ''}`}>
          {items.map((it, li) => (
            <TaskLi key={li} item={it} keyPrefix={`${keyPrefix}-l${key}-${li}`}>
              {it.children.length > 0 && (
                <ul className="agent-md__list agent-md__list--nested">
                  {it.children.map((ch, ci) => (
                    <TaskLi key={ci} item={ch} keyPrefix={`${keyPrefix}-ln${key}-${li}-${ci}`} />
                  ))}
                </ul>
              )}
            </TaskLi>
          ))}
        </Tag>,
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
      !FENCE_RE.test(lines[i]) &&
      !TABLE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={key++} className="agent-md__p">
        {renderInline(para.join('\n'), `${keyPrefix}-p${key}`)}
      </p>,
    );
  }
  return blocks;
}

/** memo（2026-11-11 卡顿修复）：流式期间只有正在生长的那条消息 text 变化，
 * 历史消息 text 引用稳定 → 跳过全量 markdown 重解析（O(全列表×每token) 主线程杀手） */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <div className="agent-md">{renderBlocks(text.split('\n'), 'md')}</div>;
});
