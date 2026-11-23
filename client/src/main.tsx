/**
 * 应用入口：装配 Provider、注册 token 桥（http 注入）、挂载路由壳。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { message } from 'antd';
import { AppProviders } from './app/providers';
import { App } from './app/App';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import { installHttpAuthBridge, restoreLogin } from './features/auth/store/auth';
import { ApiError, getErrorText, setApiErrorNotifier } from './shared/api/http';
import { pushLog } from './shared/log/devlog';
import './styles/tokens.css';
import './styles/global.css';

installHttpAuthBridge(); // http.ts ← auth store 的 token 提供者/401 处理
void restoreLogin(); // 启动静默恢复（D28 批0）：钥匙串 refresh → 免密直达主界面

// 未认领错误全局兜底（2026-11-12）：http 层抛出的 ApiError 一宏任务内无人认领
// （自展示 errText / 有意静默 claim）→ 全局 toast——静默吞错不再等于用户看不见
setApiErrorNotifier((e) => {
  void message.error({
    content: `${e.message || getErrorText(e.code)}${e.code ? `（${e.code}）` : ''}`,
    duration: 4,
  });
});

// 全局运行时捕获（2026-11-23 开发者模式）：渲染层之外无人 catch 的异常/拒绝此前
// 静默消失（生产包无 devtools）——统一进环形日志，DevPanel（Ctrl+Shift+D）可视可导出
window.addEventListener('error', (e) => {
  pushLog({
    level: 'error',
    source: 'js',
    message: e.message || '未捕获异常',
    stack: e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`,
    data: { filename: e.filename, line: e.lineno, col: e.colno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason;
  pushLog({
    level: 'error',
    source: 'promise',
    message:
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : typeof reason === 'string'
          ? reason
          : '未处理的 Promise 拒绝',
    stack: reason instanceof Error ? reason.stack : undefined,
    // ApiError 拒绝顺带码/trace_id（同错可能已触发兜底 toast，日志侧全量留痕不冲突）
    data: reason instanceof ApiError ? { code: reason.code, trace_id: reason.traceId } : undefined,
  });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('缺少 #root 挂载点');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary variant="page">
      <AppProviders>
        <App />
      </AppProviders>
    </ErrorBoundary>
  </StrictMode>,
);
