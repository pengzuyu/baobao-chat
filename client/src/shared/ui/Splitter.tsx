/**
 * 左侧栏拖拽分界线（2026-11-12 用户口径：每个页面的左侧栏都支持拖动调宽）：
 * - useSplitWidth(key, initial, min, max)：宽度状态 + localStorage 持久化（bbc:split:{key}，
 *   按页记忆；夹取 min~max）+ pointer 拖拽（pointermove 免独立 capture 分支）
 * - SplitHandle：5px 竖分界条（hover 态 2px 主色线，col-resize；默认隐形只留光标），
 *   拖拽期间 body 加 bbc-col-resizing（全局 col-resize 光标 + 禁文本选中）
 * - useCollapsibleSplit(key, initial, min, max)：可折叠变体（2026-11-18 组织树口径：
 *   拖过 min 再继续左拖松手=整栏折叠；宽度持久化同上，折叠态独立 key :c）；
 *   SplitCollapseTab=分界缝上的窄竖条把手（浅灰缝底+主色箭头+竖排文字，点击折叠/展开、
 *   拖动调宽——bind 接 useCollapsibleSplit；位移 <4px 的松手才算点击不误触拖拽）
 * D26-O6：bbc-split 类退役——视觉内联（token 主色 2px 线），拖拽交互逻辑不动。
 * 用法：const split = useSplitWidth('im', 264, 200, 420);
 *       <aside style={{ width: split.width }}>…</aside><SplitHandle {...split.bind} />
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { theme } from 'antd';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';

const STORAGE_PREFIX = 'bbc:split:';

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
  const liveElRef = useRef<HTMLElement | null>(null);

  /** 拖动中直写容器 style.width 绕过 setState（2026-11-18 卡顿修复：高频 pointermove ×
   * 整页重渲——AdminLayout 拖宽会连带 Outlet 页面全量重渲）；使用方把 paneRef 挂到
   * 宽度受控容器即生效，未挂退化回 setState 行为 */
  const paneRef = useCallback((el: HTMLElement | null) => {
    liveElRef.current = el;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      setDragging(true);
      document.body.classList.add('bbc-col-resizing');
      const onMove = (ev: PointerEvent) => {
        const w = Math.min(max, Math.max(min, startW + (ev.clientX - startX)));
        widthRef.current = w;
        if (liveElRef.current) liveElRef.current.style.width = `${w}px`; // 直写不重渲
        else setWidth(w);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('bbc-col-resizing');
        setDragging(false);
        setWidth(widthRef.current); // 一次性落盘（与直写值一致无跳变）
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

  return { width, dragging, paneRef, bind: { onPointerDown } satisfies SplitBind };
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
      {/* 2px 视觉线：hover/拖拽显主色（原 bbc-split::after） */}
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

/* ── 可折叠变体（2026-11-18 组织用户管理页）── */

/** 拖过 min 后继续左拖的松手折叠阈值（px）——拖动中显示仍 clamp 到 min，松手判折叠 */
const OVERSHRINK = 24;

const clampW = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * useCollapsibleSplit：useSplitWidth 的可折叠增强（现有 6 处使用零影响，独立实现）。
 * - 宽度持久化复用 bbc:split:{key}（纯数字，与 useSplitWidth 同格式可互换）；
 *   折叠态独立 key bbc:split:{key}:c（'1'/'0'）——不破坏既有纯数字解析
 * - 折叠：拖动 raw < min - OVERSHRINK 松手，或主动 collapse()；展开 expand() 恢复
 *   折叠前宽度（clamp min~max，width state 折叠期间不动=天然记忆）
 */
export function useCollapsibleSplit(storageKey: string, initialWidth: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      const n = raw === null ? NaN : Number(raw);
      if (Number.isFinite(n)) return clampW(n, min, max);
    } catch {
      /* localStorage 不可用走缺省 */
    }
    return initialWidth;
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${storageKey}:c`) === '1';
    } catch {
      return false;
    }
  });
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width); // pointerup 取最新值（闭包快照滞后）
  const liveElRef = useRef<HTMLElement | null>(null);

  /** 拖动中直写容器 style.width 绕过 setState（同 useSplitWidth 卡顿修复口径） */
  const paneRef = useCallback((el: HTMLElement | null) => {
    liveElRef.current = el;
  }, []);

  const persist = useCallback(
    (key: string, val: string) => {
      try {
        localStorage.setItem(key, val);
      } catch {
        /* 持久化失败静默——仅本次会话生效 */
      }
    },
    [],
  );

  const collapse = useCallback(() => {
    setCollapsed(true);
    persist(`${STORAGE_PREFIX}${storageKey}:c`, '1');
  }, [storageKey, persist]);

  const expand = useCallback(() => {
    setWidth(clampW(widthRef.current, min, max)); // 折叠前宽度（折叠期间 width state 未动）
    setCollapsed(false);
    persist(`${STORAGE_PREFIX}${storageKey}:c`, '0');
  }, [min, max, storageKey, persist]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      let raw = startW; // 原始指针宽度（不 clamp）：松手判拖过头折叠
      setDragging(true);
      document.body.classList.add('bbc-col-resizing');
      const onMove = (ev: PointerEvent) => {
        raw = startW + (ev.clientX - startX);
        const w = clampW(raw, min, max);
        widthRef.current = w;
        if (liveElRef.current) liveElRef.current.style.width = `${w}px`; // 直写不重渲
        else setWidth(w);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('bbc-col-resizing');
        setDragging(false);
        if (raw < min - OVERSHRINK) {
          collapse(); // 拖过最小宽度再继续左拖：整栏折叠（宽度值保留=展开回折叠前）
        } else {
          setWidth(widthRef.current); // 一次性落盘（与直写值一致无跳变）
          persist(`${STORAGE_PREFIX}${storageKey}`, String(Math.round(widthRef.current)));
        }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [storageKey, min, max, collapse, persist],
  );

  return { width, collapsed, dragging, paneRef, expand, collapse, bind: { onPointerDown } satisfies SplitBind };
}

/**
 * 分界缝上的窄竖条把手（图例口径：浅灰缝底 + 主色箭头 + 竖排文字，垂直居中于左右栏之间）。
 * 点击=折叠/展开（文案随态：收起×/展开×）；拖动=调宽（bind 接 useCollapsibleSplit——
 * 位移 <4px 的松手才算点击，拖拽后不误触折叠）。
 */
export function SplitCollapseTab({
  collapsed,
  label,
  bind,
  onToggle,
}: {
  collapsed: boolean;
  /** 竖排文案主体（如「组织树」→ 展开态「收起组织树」/折叠态「展开组织树」） */
  label: string;
  bind: SplitBind;
  onToggle: () => void;
}) {
  const { token } = theme.useToken();
  const [hover, setHover] = useState(false);
  const startX = useRef<number | null>(null);
  const text = `${collapsed ? '展开' : '收起'}${label}`;
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  const fg = hover ? token.colorPrimaryHover : token.colorPrimary;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={text}
      title={text}
      data-testid="split-collapse-tab"
      onPointerDown={(e) => {
        startX.current = e.clientX;
        bind.onPointerDown(e);
      }}
      onClick={(e) => {
        if (startX.current !== null && Math.abs(e.clientX - startX.current) < 4) onToggle();
        startX.current = null;
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none',
        width: 24,
        height: 128,
        alignSelf: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        background: hover ? token.colorFillTertiary : token.colorFillQuaternary,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        // 折叠态只剩点击展开（不可拖）→ 小手；展开态可拖可点 → 分隔线光标
        cursor: collapsed ? 'pointer' : 'col-resize',
        userSelect: 'none',
      }}
    >
      <Icon size={13} color={fg} />
      <span style={{ writingMode: 'vertical-rl', fontSize: 12, lineHeight: '16px', letterSpacing: 2, color: fg }}>{text}</span>
    </div>
  );
}
