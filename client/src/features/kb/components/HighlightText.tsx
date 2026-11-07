/**
 * 高亮文本渲染（检索结果卡 <mark>）：
 * 服务端 highlight 为 snippet 内的「码点偏移」区间——按 code point 遍历对齐
 * （Go rune ↔ JS code point； astral 字符登记偏差可忽略）。
 */

interface HighlightTextProps {
  text: string;
  /** 码点偏移区间 [start,end)（升序；服务端封顶 5 段） */
  ranges?: Array<[number, number]>;
}

export function HighlightText({ text, ranges }: HighlightTextProps) {
  if (!ranges || ranges.length === 0) {
    return <span>{text}</span>;
  }
  const chars = Array.from(text); // code point 数组（与 rune 偏移对齐）
  const marks = [...ranges]
    .filter(([s, e]) => s >= 0 && e > s && s < chars.length)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<{ key: string; seg: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of marks) {
    const start = Math.max(s, cursor);
    const end = Math.min(e, chars.length);
    if (start >= end) continue;
    if (start > cursor) out.push({ key: `p${cursor}`, seg: chars.slice(cursor, start).join(''), hit: false });
    out.push({ key: `m${start}`, seg: chars.slice(start, end).join(''), hit: true });
    cursor = end;
  }
  if (cursor < chars.length) out.push({ key: `t${cursor}`, seg: chars.slice(cursor).join(''), hit: false });
  return (
    <span>
      {out.map((p) => (p.hit ? <mark key={p.key}>{p.seg}</mark> : <span key={p.key}>{p.seg}</span>))}
    </span>
  );
}
