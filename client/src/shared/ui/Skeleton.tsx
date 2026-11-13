/**
 * 骨架屏基元（D26-O1 包装化）：SkeletonList/SkeletonBlock 内部换 antd Skeleton（原生观感，API 不动）。
 * 单条 Skeleton 保留自研条 + SkeletonStream 整体保留——IM 消息流骨架属 D26 §4 保留域。
 */

import { Skeleton as AntdSkeleton } from 'antd';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
}

/** 单条骨架（保留自研：IM 流式气泡等保留域专用） */
export function Skeleton({ width = '100%', height = 14, className }: SkeletonProps) {
  return <div className={className ? `bbw-skeleton ${className}` : 'bbw-skeleton'} style={{ width, height }} />;
}

/** 列表骨架（条形×N，默认 8 条；antd 段落骨架驱动） */
export function SkeletonList({ count = 8 }: { count?: number }) {
  return (
    <div className="skl-list">
      <AntdSkeleton active title={false} paragraph={{ rows: count }} />
    </div>
  );
}

/** 详情/内容块骨架（antd 标题+段落骨架，行数按高度折算） */
export function SkeletonBlock({ height = 200 }: { height?: number }) {
  return (
    <div className="skl-list">
      <AntdSkeleton active title paragraph={{ rows: Math.max(2, Math.round(height / 24)) }} />
    </div>
  );
}

/** 消息流 shimmer 行（×N，默认 6；IM 保留域，自研不动） */
export function SkeletonStream({ count = 6 }: { count?: number }) {
  return (
    <div className="skl-stream">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skl-stream__row${i % 2 === 0 ? '' : ' skl-stream__row--end'}`}>
          <Skeleton width={32} height={32} className="skl-avatar-sm" />
          <Skeleton width={i % 2 === 0 ? '45%' : '35%'} height={44} className="skl-bubble" />
        </div>
      ))}
    </div>
  );
}
