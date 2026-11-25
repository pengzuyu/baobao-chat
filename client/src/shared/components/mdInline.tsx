/**
 * markdown 行内标记渲染（MarkdownText/MdTable 共用；自 MarkdownText 抽出避免
 * MdTable ↔ MarkdownText 循环依赖）。
 * 链接出站协议白名单（javascript:/data: 等拒绝）是降级渲染的最小 XSS 防线。
 */

import type { ReactNode } from 'react';

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|\/)/i.test(u)) return u;
  return null;
}

/** 行内标记渲染：`code` → <code>，**bold** → <strong>，*em* → <em>，
 * ~~del~~ → <del>，[text](url) → <a target=_blank>，![alt](url) → <img>（D24）。
 * em 的环视断言（lookbehind）拒绝 `2*3*4` 类运算式误判：开/闭星号紧邻单词字符不匹配。
 * blockImages=true 时图片渲染为占位块不加载（D39：插件 readme 防 beacon——
 * 不可信内容的远程图片一拉即回拨第三方，安装意愿/IP 泄露）。 */
export function renderInline(text: string, keyPrefix: string, blockImages = false): ReactNode[] {
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
        out.push(blockImages && href
          ? <span key={`${keyPrefix}-imgb${i}`} className="agent-md__img-blocked" title={href}>图片已屏蔽</span>
          : href
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
