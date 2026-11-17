/**
 * markdown 围栏代码块（MarkdownText 围栏分支专用）：语言标签 + 一键复制 +
 * highlight.js 按需子集高亮。渲染器仍为自研（路线 A），hljs 只做代码上色——
 * PAG-03「不引第三方渲染器」的旧规自此限定为「不引 markdown 解析器」。
 * lib/core + 12 门常用语言（bundle 克制；vite manualChunks 独立分包），未注册
 * 语言/解析失败回退纯文本；流式中未闭合围栏照常渲染，每 token 重高亮单块
 * （几 KB 字符串 sub-ms 级，memo 隔离其余块不重算）。
 * 安全说明：hljs 高亮输出对源码做 HTML 转义、仅追加库自身的 token span，
 * dangerouslySetInnerHTML 消费其产物是官方支持的安全用法（非用户裸 HTML）。
 */

import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('json', json);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

/** 常用别名（hljs 内建别名之外补短的） */
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['golang'], { languageName: 'go' });
hljs.registerAliases(['js'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

/** 围栏语言标识归一：```bash、```  TOML 这类杂写一律小写去空白 */
function normLang(lang: string): string {
  return lang.trim().toLowerCase();
}

export function MdCode({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    const l = normLang(lang);
    if (!l || !hljs.getLanguage(l)) return null;
    try {
      return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
    } catch {
      return null; // 未注册语言/解析异常 → 纯文本回退
    }
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板被拒（焦点策略）：用户手动选择复制 */
    }
  };

  return (
    <div className="agent-md__code-wrap">
      <div className="agent-md__code-head">
        <span className="agent-md__code-lang">{normLang(lang) || 'text'}</span>
        <button
          type="button"
          className={`agent-md__copy${copied ? ' agent-md__copy--done' : ''}`}
          onClick={copy}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="agent-md__code">
        {html !== null
          ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          : <code>{code}</code>}
      </pre>
    </div>
  );
}
