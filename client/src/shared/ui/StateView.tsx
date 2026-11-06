/**
 * 六态统一视图组件（D01 §7：每个数据视图强制）：
 * - loading：骨架屏（调用方传入骨架形态），>300ms 才显示（防闪烁）
 * - empty：说明 + CTA
 * - error：错误码映射文案 + 重试 + trace_id 点击复制
 * - offline：渲染 children（本地缓存）+ 半透明遮罩提示
 * - forbidden：锁图标 + 无权限说明 + 申请权限入口
 * - degraded：顶部黄条 + children（只读操作可用）
 */

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { ApiError, getErrorText } from '../api/http';
import { Button } from './Button';
import { Empty } from './Empty';

export type ViewState = 'loading' | 'empty' | 'error' | 'offline' | 'forbidden' | 'degraded';

interface StateViewProps {
  state: ViewState;
  /** loading 骨架形态（SkeletonList / SkeletonStream / SkeletonBlock…） */
  skeleton?: ReactNode;
  /** loading 防闪烁延迟，默认 300ms */
  loadingDelayMs?: number;
  /** empty 态文案 */
  emptyText?: string;
  /** empty 态主 CTA */
  emptyAction?: ReactNode;
  /** error 态错误对象（ApiError 优先取错误码文案） */
  error?: unknown;
  onRetry?: () => void;
  /** offline 遮罩文案 */
  offlineText?: string;
  /** forbidden 说明文案 */
  forbiddenText?: string;
  /** 申请权限入口回调（doc/kb 场景） */
  onApplyPermission?: () => void;
  /** degraded 黄条文案（如"编辑暂不可用，已切换只读预览"） */
  degradedText?: string;
  /** offline / degraded 态下继续渲染的内容（本地缓存/只读视图） */
  children?: ReactNode;
}

/** loading 防闪烁：300ms 内保持占位不闪骨架 */
function useDelayed(show: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [show, delayMs]);
  return visible;
}

export function StateView({
  state,
  skeleton,
  loadingDelayMs = 300,
  emptyText = '暂无数据',
  emptyAction,
  error,
  onRetry,
  offlineText = '离线中，正在展示本地缓存',
  forbiddenText = '无权限访问该内容',
  onApplyPermission,
  degradedText = '当前为降级模式，部分功能暂不可用',
  children,
}: StateViewProps) {
  const showSkeleton = useDelayed(state === 'loading', loadingDelayMs);

  if (state === 'loading') {
    return <div className="state-view">{showSkeleton ? skeleton : null}</div>;
  }

  if (state === 'empty') {
    return (
      <div className="state-view">
        <Empty text={emptyText} action={emptyAction} />
      </div>
    );
  }

  if (state === 'error') {
    const apiError = error instanceof ApiError ? error : null;
    const text = apiError ? getErrorText(apiError.code) : error instanceof Error ? error.message : getErrorText(9004);
    return (
      <div className="state-view">
        <div className="state-view__inner">
          <div className="state-view__icon state-view__icon--warn" aria-hidden>
            <AlertTriangle size={40} strokeWidth={1.4} />
          </div>
          <div className="state-view__text">{text}</div>
          {onRetry ? (
            <div className="state-view__action">
              <Button variant="secondary" onClick={onRetry}>
                重试
              </Button>
            </div>
          ) : null}
          {/* trace_id 折叠可复制（D01 §7 error 态） */}
          {apiError?.traceId ? (
            <div
              className="state-view__trace"
              onClick={() => void navigator.clipboard?.writeText(apiError.traceId as string)}
              title="点击复制 trace_id，供问题排查"
            >
              trace_id: {apiError.traceId}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (state === 'forbidden') {
    return (
      <div className="state-view">
        <div className="state-view__inner">
          <div className="state-view__icon" aria-hidden>
            <Lock size={40} strokeWidth={1.4} />
          </div>
          <div className="state-view__text">{forbiddenText}</div>
          {onApplyPermission ? (
            <div className="state-view__action">
              <Button variant="secondary" onClick={onApplyPermission}>
                申请权限
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // offline / degraded：保留 children（缓存浏览 / 只读），叠加提示层
  return (
    <div className="state-view state-view--overlayed">
      {state === 'degraded' ? <div className="state-view__degraded-bar">{degradedText}</div> : null}
      {children}
      {state === 'offline' ? <div className="state-view__overlay">{offlineText}</div> : null}
    </div>
  );
}
