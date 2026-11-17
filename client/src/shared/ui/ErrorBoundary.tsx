/**
 * 全局错误边界（2026-11-12 用户管理白屏教训立项：渲染期异常不再裸白屏——
 * 根因事件 scopes:null 炸 scopes.filter 时整个应用无任何 ErrorBoundary 直接整页空白）。
 * - panel（默认）：嵌在布局内容区（MainLayout/AdminLayout/SettingsLayout 包 <Outlet/>）——
 *   导航栏存活，重试=重挂子树；
 * - page：main.tsx 根部整页兜底——Provider 层也炸时仍有可读提示+整页刷新入口。
 * D26-O6：state-view/err-boundary 类退役——观感同 StateView error 态，内联（class 组件
 * 不便取 token，中性色走 var(--bbc-*) 令牌）；console.error 留现场。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** page=整页兜底（根装配）；panel=内容区内嵌（默认） */
  variant?: 'page' | 'panel';
  /** 复位键（路由 pathname）：切换页面时清除错误态——上一页的崩溃不拖累下一页 */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 真机无 devtools 时的唯一现场（bbrt.log 同思路：观测先行）
    console.error('[ErrorBoundary] 渲染异常', error, info.componentStack);
  }

  override componentDidUpdate(prev: Readonly<ErrorBoundaryProps>): void {
    if (this.state.error && this.props.resetKey !== undefined && this.props.resetKey !== prev.resetKey) {
      this.setState({ error: null });
    }
  }

  reset = (): void => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fullPage = this.props.variant === 'page';
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', ...(fullPage ? { minHeight: '100vh' } : null) }} role="alert">
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative' }}>
          <div style={{ textAlign: 'center', maxWidth: 360 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--bbc-warning)', marginBottom: 12 }} aria-hidden>
              <AlertTriangle size={40} strokeWidth={1.4} />
            </div>
            <div style={{ color: 'var(--bbc-gray-6)', fontSize: 14 }}>页面渲染出错了：{error.message || '未知错误'}</div>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={this.reset}>
                重试
              </Button>
              {fullPage ? (
                <Button variant="primary" onClick={() => window.location.reload()}>
                  刷新应用
                </Button>
              ) : null}
            </div>
            <div
              style={{ marginTop: 8, fontSize: 12, color: 'var(--bbc-gray-5)', fontFamily: 'var(--bbc-font-mono)', cursor: 'pointer', wordBreak: 'break-all' }}
              onClick={() => void navigator.clipboard?.writeText(`${error.name}: ${error.message}\n${error.stack ?? ''}`)}
              title="点击复制错误详情，供问题排查"
            >
              {error.name}: {error.message}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
