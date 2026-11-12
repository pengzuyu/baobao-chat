/**
 * 应用入口：装配 Provider、注册 token 桥（http 注入）、挂载路由壳。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/providers';
import { App } from './app/App';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import { installHttpAuthBridge } from './features/auth/store/auth';
import './styles/tokens.css';
import './styles/global.css';

installHttpAuthBridge(); // http.ts ← auth store 的 token 提供者/401 处理

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
