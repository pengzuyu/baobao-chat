/**
 * 六态统一视图组件（D01 §7：每个数据视图强制）：
 * - loading：骨架屏（调用方传入骨架形态），>300ms 才显示（防闪烁）
 * - empty：说明 + CTA
 * - error：错误码映射文案 + 重试 + trace_id 点击复制
 * - offline：渲染 children（本地缓存）+ 半透明遮罩提示
 * - forbidden：锁图标 + 无权限说明 + 申请权限入口
 * - degraded：顶部黄条 + children（只读操作可用）
 * D26-O6：state-view 族类退役——容器/文案/按钮排版内联 + theme token（API 与六态语义不动）。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Typography, theme } from 'antd';
import { AlertTriangle, Lock } from 'lucide-react';
import { ApiError, getErrorText } from '../api/http';
import { Button } from './Button';
import { Empty } from './Empty';

export type ViewState = 'loading' | 'empty' | 'error' | 'offline' | 'forbidden' | 'degraded';

/** 六态 + 'ok'（正常内容态：直接渲染 children，不经 state-view 包裹层） */
export type ViewStateOrOk = ViewState | 'ok';

interface StateViewProps {
  state: ViewStateOrOk;
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

/** 居中容器（原 state-view：loading/empty/error/forbidden 共用） */
function CenterShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative' }}>
      {children}
    </div>
  );
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
  const { token } = theme.useToken();
  const showSkeleton = useDelayed(state === 'loading', loadingDelayMs);

  // ok：正常内容态——直接透传 children（不套居中容器，表格/卡片网格按自身布局渲染）
  if (state === 'ok') return <>{children}</>;

  if (state === 'loading') {
    return <CenterShell>{showSkeleton ? skeleton : null}</CenterShell>;
  }

  if (state === 'empty') {
    return (
      <CenterShell>
        <Empty text={emptyText} action={emptyAction} />
      </CenterShell>
    );
  }

  if (state === 'error') {
    const apiError = error instanceof ApiError ? error : null;
    const text = apiError ? getErrorText(apiError.code) : error instanceof Error ? error.message : getErrorText(9004);
    return (
      <CenterShell>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorWarning, marginBottom: 12 }} aria-hidden>
            <AlertTriangle size={40} strokeWidth={1.4} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSize }}>
            {text}
          </Typography.Text>
          {onRetry ? (
            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" onClick={onRetry}>
                重试
              </Button>
            </div>
          ) : null}
          {/* trace_id 折叠可复制（D01 §7 error 态） */}
          {apiError?.traceId ? (
            <Typography.Text
              code
              copyable={false}
              onClick={() => void navigator.clipboard?.writeText(apiError.traceId as string)}
              title="点击复制 trace_id，供问题排查"
              style={{ display: 'block', marginTop: 8, cursor: 'pointer' }}
            >
              trace_id: {apiError.traceId}
            </Typography.Text>
          ) : null}
        </div>
      </CenterShell>
    );
  }

  if (state === 'forbidden') {
    return (
      <CenterShell>
        <div style={{ textAlign: 'center', maxWidth: 360 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextQuaternary, marginBottom: 12 }} aria-hidden>
            <Lock size={40} strokeWidth={1.4} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSize }}>
            {forbiddenText}
          </Typography.Text>
          {onApplyPermission ? (
            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" onClick={onApplyPermission}>
                申请权限
              </Button>
            </div>
          ) : null}
        </div>
      </CenterShell>
    );
  }

  // offline / degraded：保留 children（缓存浏览 / 只读），叠加提示层
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
      {state === 'degraded' ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            background: token.colorWarningBg,
            color: token.colorWarning,
            fontSize: token.fontSizeSM,
            textAlign: 'center',
            padding: '4px 0',
            zIndex: 2,
          }}
        >
          {degradedText}
        </div>
      ) : null}
      {children}
      {state === 'offline' ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--bbc-veil)',
            backdropFilter: 'blur(1px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1,
            color: token.colorTextSecondary,
            fontSize: token.fontSizeSM,
          }}
        >
          {offlineText}
        </div>
      ) : null}
    </div>
  );
}
