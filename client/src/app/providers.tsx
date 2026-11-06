/**
 * 全局 Provider 组合层（app/）：React Query + AntD 主题融合。
 * AntD token 融合（D01 §14 开放问题 2 已冻结）：色值引用 themeConstants 单源，
 * 亮/暗随 useThemeStore.resolved 动态切换 algorithm，与 --bbw-* 令牌双轨合一。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { useThemeStore } from '../shared/store/theme';
import { THEME } from '../shared/ui/themeConstants';

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

export function AppProviders({ children }: { children: ReactNode }) {
  const resolved = useThemeStore((s) => s.resolved);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            colorPrimary: THEME.primary, // = --bbw-primary（tokens.css 对齐，见 themeConstants）
            colorSuccess: THEME.success,
            colorWarning: THEME.warning,
            colorError: THEME.danger,
            borderRadius: 6, // = --bbw-radius-control
            fontFamily: THEME.fontFamily,
          },
        }}
      >
        {children}
      </ConfigProvider>
    </QueryClientProvider>
  );
}
