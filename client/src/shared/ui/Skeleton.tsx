/**
 * 骨架屏基元（D01 §7 loading 态：列表=条形骨架×8；详情=块骨架；流式区域=shimmer 行）。
 * shimmer 动画见 global.css .bbw-skeleton；布局类 skl-* 同在 global.css。
 */

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
}

/** 单条骨架 */
export function Skeleton({ width = '100%', height = 14, className }: SkeletonProps) {
  return <div className={className ? `bbw-skeleton ${className}` : 'bbw-skeleton'} style={{ width, height }} />;
}

/** 列表骨架（条形×N，默认 8 条，对应会话列表 loading 态） */
export function SkeletonList({ count = 8 }: { count?: number }) {
  return (
    <div className="skl-list">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skl-list__row">
          <Skeleton width={40} height={40} className="skl-avatar" />
          <div className="skl-list__col">
            <Skeleton width="55%" height={14} />
            <Skeleton width="85%" height={12} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 详情/内容块骨架 */
export function SkeletonBlock({ height = 200 }: { height?: number }) {
  return (
    <div className="skl-block">
      <Skeleton width="40%" height={16} />
      <Skeleton height={height} />
      <Skeleton width="70%" height={14} />
    </div>
  );
}

/** 消息流 shimmer 行（×N，默认 6） */
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
