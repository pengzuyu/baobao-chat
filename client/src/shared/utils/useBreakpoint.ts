/**
 * 断点四档（D01 §5.2）：XL ≥1600 / L 1280-1599 / M 1024-1279 / S 720-1023。
 * 骨架阶段以窗口宽度近似；正式版应测量"主窗内容区"宽度（ResizeObserver）。
 */

import { useEffect, useState } from 'react';

export type Breakpoint = 'S' | 'M' | 'L' | 'XL';

function calcBreakpoint(width: number): Breakpoint {
  if (width >= 1600) return 'XL';
  if (width >= 1280) return 'L';
  if (width >= 1024) return 'M';
  return 'S'; // 最小窗口 960×600 落在 S 档上限附近，必须可用（D01 §5.2）
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => calcBreakpoint(window.innerWidth));

  useEffect(() => {
    const onResize = () => setBp(calcBreakpoint(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return bp;
}
