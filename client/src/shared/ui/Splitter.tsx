/**
 * 左侧栏拖拽分界线（2026-11-12 用户口径：每个页面的左侧栏都支持拖动调宽）：
 * - useSplitWidth(key, initial, min, max)：宽度状态 + localStorage 持久化（bbw:split:{key}，
 *   按页记忆；夹取 min~max）+ pointer 拖拽（pointermove 免独立 capture 分支）
 * - SplitHandle：5px 竖分界条（hover 态 2px 主色线，col-resize；默认隐形只留光标），
 *   拖拽期间 body 加 bbw-col-resizing（全局 col-resize 光标 + 禁文本选中）
 * D26-O6：bbw-split 类退役——视觉内联（token 主色 2px 线），拖拽交互逻辑不动。
 * 用法：const split = useSplitWidth('im', 264, 200, 420);
 *       <aside style={{ width: split.width }}>…</aside><SplitHandle {...split.bind} />
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { theme } from 'antd';

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
  const { token } = theme.useToken();
  const [hover, setHover] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={bind.onPointerDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none',
        width: 5,
        marginLeft: -5, // 叠在左栏右边框上：不占布局额外宽度（grid 页面除外，见各页内联）
        position: 'relative',
        zIndex: 12,
        cursor: 'col-resize',
        ...style,
      }}
      data-testid="split-handle"
    >
      {/* 2px 视觉线：hover/拖拽显主色（原 bbw-split::after） */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '1.5px',
          width: 2,
          borderRadius: 1,
          background: hover ? token.colorPrimary : 'transparent',
          transition: 'background 0.12s ease',
        }}
      />
    </div>
  );
}
