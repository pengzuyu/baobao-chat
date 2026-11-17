/**
 * 思考块（D33 §3.5；2026-11-17 三改定稿口径，与共享 ThinkingCollapse 分叉——
 * IM 卡继续用共享件，工作台平铺流独有行为不回写 shared）：
 * - **流式输出中=默认单行 ticker**：只显示「当前行」（最后一个非空行）——
 *   不折行、超宽横向滚动、自动跟尾（终端 tail 式），换行即切新行；
 *   点击可临时展开看全文（流式跟底），段末仍自动收回
 * - **输出完毕=自动折叠**：只留「思考过程」标题行，不展示内容；
 *   点开才展开全部正文查看（≤300px 纵向滚动）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from 'antd';
import { ChevronRight, Lightbulb } from 'lucide-react';

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const { token } = theme.useToken();
  // 恒折叠为默认态：流式段开始/结束（streaming 翻转）都自动收拢；
  // 展开只来自手动点击（流式中临时看全文 / 完成后查看全部）
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
  }, [streaming]);

  // ticker 当前行=最后一个非空行（换行即切下一行）
  const lastLine = useMemo(() => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
  }, [text]);

  // 单行 ticker：新内容到达即滚到最右（跟尾）
  useEffect(() => {
    const el = lineRef.current;
    if (!el || expanded || !streaming) return;
    el.scrollLeft = el.scrollWidth;
  }, [lastLine, expanded, streaming]);

  // 展开体流式跟底（rAF 落帧边界，同帧多次 text 更新合并）
  useEffect(() => {
    if (!expanded || !streaming) return;
    const el = bodyRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [text, expanded, streaming]);

  return (
    <div
      style={{
        background: token.colorFillQuaternary,
        borderRadius: token.borderRadius,
        padding: '2px 10px 2px 6px',
        margin: '2px 0',
        minWidth: 0,
        alignSelf: 'stretch',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '收起思考' : '展开思考'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '4px 0',
            fontSize: 12,
            color: streaming ? token.colorPrimary : token.colorTextSecondary,
            textAlign: 'left',
            height: 'auto',
          }}
        >
          <ChevronRight
            size={12}
            aria-hidden
            style={{ transition: 'transform 0.15s ease', transform: expanded ? 'rotate(90deg)' : undefined }}
          />
          <Lightbulb size={13} aria-hidden />
          {streaming ? '思考中...' : '思考过程'}
        </button>
        {/* 流式输出中（未手动展开）：单行 ticker=当前行，超宽横向滚动自动跟尾；
            输出完毕不再展示内容（点标题展开查看） */}
        {streaming && !expanded ? (
          <div
            ref={lineRef}
            style={{
              flex: 1,
              minWidth: 0,
              overflowX: 'auto',
              overflowY: 'hidden',
              whiteSpace: 'nowrap',
              fontSize: 12,
              lineHeight: '26px',
              color: token.colorTextTertiary,
              scrollbarWidth: 'thin',
            }}
          >
            {lastLine || '…'}
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div ref={bodyRef} style={{ maxHeight: 300, overflowY: 'auto', padding: '4px 0' }}>
          <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: token.colorTextSecondary }}>{text}</pre>
        </div>
      ) : null}
    </div>
  );
}
