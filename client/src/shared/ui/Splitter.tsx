/**
 * 左侧栏拖拽分界线（2026-11-12 用户口径：每个页面的左侧栏都支持拖动调宽）：
 * - useSplitWidth(key, initial, min, max)：宽度状态 + localStorage 持久化（bbw:split:{key}，
 *   按页记忆；夹取 min~max）+ pointer 拖拽（pointermove 免独立 capture 分支）
 * - SplitHandle：5px 竖分界条（hover/拖拽态 2px 主色线，col-resize），拖拽期间
 *   body 加 bbw-col-resizing（全局 col-resize 光标 + 禁文本选中）
 * 用法：const split = useSplitWidth('im', 264, 200, 420);
 *       <aside style={{ width: split.width }}>…</aside><SplitHandle {...split.bind} />
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react';

const STORAGE_PREFIX = 'bbw:split:';

export interface SplitBind {
  onPointerDown: (e: React.PointerEvent) => void;
}

export function useSplitWidth(storageKey: string, initialWidth: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      const n = raw === null ? NaN : Number(raw);
      if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
    } catch {
      /* localStorage 不可用走缺省 */
    }
    return initialWidth;
  });
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width); // pointerup 落盘取最新值（闭包快照会滞后）

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      setDragging(true);
      document.body.classList.add('bbw-col-resizing');
      const onMove = (ev: PointerEvent) => {
        const w = Math.min(max, Math.max(min, startW + (ev.clientX - startX)));
        widthRef.current = w;
        setWidth(w);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('bbw-col-resizing');
        setDragging(false);
        try {
          localStorage.setItem(STORAGE_PREFIX + storageKey, String(Math.round(widthRef.current)));
        } catch {
          /* 持久化失败静默——仅本次会话生效 */
        }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [storageKey, min, max],
  );

  return { width, dragging, bind: { onPointerDown } satisfies SplitBind };
}

export function SplitHandle({ bind, style }: { bind: SplitBind; style?: CSSProperties }) {
  return (
    <div
      className="bbw-split"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={bind.onPointerDown}
      style={style}
      data-testid="split-handle"
    />
  );
}
