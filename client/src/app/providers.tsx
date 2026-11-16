/**
 * 全局 Provider 组合层（app/）：React Query + AntD 主题融合 + i18n locale（E12）。
 * antd 内置文案随 bbw-locale 切换；应用文案经 shared/i18n t()。
 * AntD token 融合（D27 主题机制与色彩规范；修订2 增 accent 维度）：
 * - antd 组件：ConfigProvider theme=antdThemeFrom(mode, accent) 单源；
 * - 残余自研 CSS：cssVarsFrom(mode, accent) 注入 document root --bbw-*，与 antd 同源联动。
 */

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { useEffect, useRef, type ReactNode } from 'react';
import { useThemeStore } from '../shared/store/theme';
import { useI18nStore } from '../shared/i18n';
import { useAuthStore } from '../features/auth/store/auth';
import { useKbTabs } from '../features/kb/store/kbTabs';
import { antdThemeFrom, cssVarsFrom } from '../shared/ui/themeConstants';

// Query 全局默认：不自动重试（错误态由用户点重试，六态 error）；窗口聚焦不自动刷
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

/**
 * 账号切换缓存隔离（2026-11-13 真机修复）：登出不刷新页面时 react-query 缓存
 * （['kb','nodes',spaceId] 等）跨账号泄漏——新账号前端拿旧账号的空间 ID 发请求
 * → 服务端正确回 7002「无该空间的访问权限」。user 变 null（登出/令牌过期）即
 * 全清服务端数据缓存 + kb 本地残留（最近查看 localStorage/tab 页签），覆盖全部登出路径。
 */
function AuthCacheBoundary({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const hadUser = useRef(!!user);
  useEffect(() => {
    if (hadUser.current && !user) {
      qc.clear();
      try {
        localStorage.removeItem('bbw:kb:recent');
      } catch {
        /* 隐私模式写失败静默 */
      }
      useKbTabs.setState({ tabs: [{ key: 'home', title: '首页' }], activeKey: 'home' });
    }
    hadUser.current = !!user;
  }, [user, qc]);
  return <>{children}</>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const resolved = useThemeStore((s) => s.resolved);
  const accent = useThemeStore((s) => s.accent);
  const locale = useI18nStore((s) => s.locale);
  const mode = resolved === 'dark' ? 'dark' : 'light';

  // D27 机制核心：--bbw-* CSS 变量随 antd 主题单源注入（残余自研 CSS 与 antd 组件同源联动）
  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(cssVarsFrom(mode, accent))) root.style.setProperty(k, v);
  }, [mode, accent]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthCacheBoundary>
        <ConfigProvider locale={locale === 'en' ? enUS : zhCN} theme={antdThemeFrom(mode, accent)}>
          {children}
        </ConfigProvider>
      </AuthCacheBoundary>
    </QueryClientProvider>
  );
}
