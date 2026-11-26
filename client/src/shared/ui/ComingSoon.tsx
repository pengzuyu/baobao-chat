/**
 * 敬请期待占位页（2026-11-26 全员试用收口）：
 * 知识库/管理后台等域暂不对试用开放——路由层整域落此占位（一级导航入口点击只弹 toast）。
 * 原页面组件原样包在 children 里（收口期间不渲染、零副作用、import 保持活跃），
 * 恢复开放 = App.tsx 中去掉 <ComingSoon> 包裹还原 element 即可。
 */

import type { ReactNode } from 'react';
import { Empty } from './Empty';

export function ComingSoon({ feature, children: _children }: { feature: string; children?: ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Empty text={`${feature} · 敬请期待`} />
    </div>
  );
}
