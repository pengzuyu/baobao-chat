/**
 * 应用入口：装配 Provider、注册 token 桥（http 注入）、挂载路由壳。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { message } from 'antd';
import { AppProviders } from './app/providers';
import { App } from './app/App';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import { installHttpAuthBridge } from './features/auth/store/auth';
import { getErrorText, setApiErrorNotifier } from './shared/api/http';
import './styles/tokens.css';
import './styles/global.css';

installHttpAuthBridge(); // http.ts ← auth store 的 token 提供者/401 处理

// 未认领错误全局兜底（2026-11-12）：http 层抛出的 ApiError 一宏任务内无人认领
// （自展示 errText / 有意静默 claim）→ 全局 toast——静默吞错不再等于用户看不见
setApiErrorNotifier((e) => {
  void message.error({
    content: `${e.message || getErrorText(e.code)}${e.code ? `（${e.code}）` : ''}`,
    duration: 4,
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
