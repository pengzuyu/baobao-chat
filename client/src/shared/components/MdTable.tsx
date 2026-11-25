/**
 * markdown 表格组件（MarkdownText 表格分支专用）：表头点击三态排序（升→降→还原
 * 原序；语义参考 change-my-life enhance.js，localeCompare numeric 数字感知）+
 * 行数 ≥4 附搜索筛选框。排序/筛选为组件局部状态——流式表格生长时状态自然保持；
 * ES2019 起 Array.sort 稳定，等值行保持原相对顺序（等价其「原始序回退」口径）。
 * React 组件化替代 change-my-life 的 v-html 后 DOM 增强（无需幂等标记）。
 */

import { useMemo, useState } from 'react';
import { Input } from 'antd';
import { renderInline } from './mdInline';

export type MdAlign = 'left' | 'center' | 'right';

export function MdTable({ head, rows, aligns, blockImages }: {
  head: string[];
  rows: string[][];
  aligns?: MdAlign[] | null;
  /** D39：透传 renderInline——插件 readme 场景表格内图片同样占位不加载 */
  blockImages?: boolean;
}) {
  const [sortCol, setSortCol] = useState(-1);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filter, setFilter] = useState('');

  const onSort = (col: number) => {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc');
      else setSortCol(-1); // 第三态：还原原序
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const visibleRows = useMemo(() => {
    let out = rows;
    const q = filter.trim().toLowerCase();
    if (q) out = out.filter((cells) => cells.some((c) => c.toLowerCase().includes(q)));
    if (sortCol >= 0) {
      out = [...out].sort((a, b) => {
        const cmp = (a[sortCol] ?? '').localeCompare(b[sortCol] ?? '', undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, filter, sortCol, sortDir]);

  return (
    <div className="agent-md__table-wrap">
      {rows.length >= 4 && (
        <Input
          className="agent-md__table-filter"
          size="small"
          allowClear
          placeholder="筛选表格内容…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <table className="agent-md__table">
        <thead>
          <tr>
            {head.map((c, ci) => (
              <th
                key={ci}
                className="agent-md__th"
                style={{ textAlign: aligns?.[ci] }}
                aria-sort={ci === sortCol ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <button type="button" className="agent-md__th-btn" onClick={() => onSort(ci)}>
                  <span className="agent-md__th-label">{renderInline(c, `th${ci}`, blockImages)}</span>
                  <span className="agent-md__th-ind">{ci === sortCol ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((cells, r) => (
            <tr key={r}>
              {cells.map((c, ci) => (
                <td key={ci} style={{ textAlign: aligns?.[ci] }}>{renderInline(c, `td${r}-${ci}`, blockImages)}</td>
              ))}
            </tr>
          ))}
          {visibleRows.length === 0 && (
            <tr>
              <td colSpan={Math.max(head.length, 1)} className="agent-md__table-empty">无匹配行</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
