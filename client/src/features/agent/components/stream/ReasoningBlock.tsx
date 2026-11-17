/**
 * 思考块（D33 §3.5；2026-11-17 二改与共享 ThinkingCollapse 分叉——IM 卡继续用
 * 共享件，工作台平铺流独有行为不回写 shared）：
 * - 流式默认展开；段末自动折叠；手动点击随时翻转
 * - **未展开=单行「当前行」预览**：显示思考文本最后一个非空行——不折行，
 *   超宽横向滚动（流式中自动跟尾，终端 tail 式），文本换行即切到新行
 * - 展开=完整思考正文（≤300px 纵向滚动，流式跟底经 rAF 合帧）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from 'antd';
import { ChevronRight, Lightbulb } from 'lucide-react';

export function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(streaming); // 思考结束自动收起；新一轮思考展开
  }, [streaming]);

  // 预览行=最后一个非空行（换行即切下一行）
  const lastLine = useMemo(() => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
  }, [text]);

  // 未展开单行预览：流式中横向跟尾（新内容到达即滚到最右）
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
        {/* 未展开：单行当前行预览（不折行/超宽横向滚动/流式跟尾） */}
        {!expanded ? (
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
