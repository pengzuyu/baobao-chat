/**
 * 应用壳（D01 §4/§5）：
 * - 路由总表：/auth 认证 + 受保护主布局（/im 默认落点，其余一级导航占位）
 * - WS 生命周期：登录后连接、登出断开；重连成功触发增量同步（14 篇 §4.2）
 */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Phone } from 'lucide-react';
import { useAuthStore } from '../features/auth/store/auth';
import { LoginPage } from '../features/auth/pages/LoginPage';
import { ChatPage } from '../features/im/pages/ChatPage';
import { FavoritesPage } from '../features/im/pages/FavoritesPage';
import { NotificationCenterPage } from '../features/im/pages/NotificationCenterPage';
import { KbPage } from '../features/kb/pages/KbPage';
import { useImStore } from '../features/im/store/im';
import { AgentWorkbenchPage } from '../features/agent/pages/AgentWorkbenchPage';
import { AgentMemoryPage } from '../features/agent/pages/AgentMemoryPage';
import { AgentReportsPage } from '../features/agent/pages/AgentReportsPage';
import { AdminLayout } from '../features/admin/pages/AdminLayout';
import { DashboardPage } from '../features/admin/pages/DashboardPage';
import { UsersPage } from '../features/admin/pages/UsersPage';
import { PoliciesPage } from '../features/admin/pages/PoliciesPage';
import { UsagePage } from '../features/admin/pages/UsagePage';
import { AuditPage } from '../features/admin/pages/AuditPage';
import { wsClient } from '../shared/api/ws';
import { bindWsToConnectionStore, useConnectionStore } from '../shared/store/connection';
import { MainLayout } from './MainLayout';
import { PlaceholderPage } from './PlaceholderPage';
import { SettingsLayout } from '../features/settings/pages/SettingsLayout';
import { GeneralSettingsPage } from '../features/settings/pages/GeneralSettingsPage';
import { NotificationSettingsPage } from '../features/settings/pages/NotificationSettingsPage';
import { TransferSettingsPage } from '../features/settings/pages/TransferSettingsPage';
import { AgentSettingsPage } from '../features/settings/pages/AgentSettingsPage';
import { AboutPage } from '../features/settings/pages/AboutPage';

const WS_BASE: string = import.meta.env.VITE_WS_BASE ?? 'ws://localhost:8080/ws/connect';
/** mock 模式（无后端联调）默认开启：REST/WS 走 features 各模块 api 层内置桩数据 */
const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 认证门卫：无凭据强制跳 /auth（D01 §4.2） */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();
  if (!token) return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** WS 连接生命周期与全局绑定（装配副作用集中于此） */
function useWsLifecycle(): void {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setMyUid = useImStore((s) => s.setMyUid);
  const queryClient = useQueryClient();

  // 组合层注入：IM 判定"己方消息"用（features 间禁止横向 import，D01 §12.2）
  useEffect(() => {
    setMyUid(user?.uid ?? '');
  }, [user, setMyUid]);

  useEffect(() => {
    bindWsToConnectionStore();
    // 重连成功 → 精准失效 IM 缓存并触发重拉（正式版走 GET /sync 增量落库）
    wsClient.onResync = () => queryClient.invalidateQueries({ queryKey: ['im'] });
    wsClient.onAuthError = () => logout(); // WS 4001：强制下线（14 篇 §2.1）
    // 通知中心（D03 §3.9 PIM-09）：notification.new → 通知域失效（列表各分组 + 铃铛红点）。
    // 绑定在应用壳层：任何页面（含 /im/notifications 自身）收到推送都即时刷新
    const offNotification = wsClient.on('notification.new', () => {
      void queryClient.invalidateQueries({ queryKey: ['im', 'notifications'] });
    });
    return () => {
      wsClient.onResync = null;
      wsClient.onAuthError = null;
      offNotification();
    };
  }, [logout, queryClient]);

  useEffect(() => {
    if (token && !USE_MOCK) {
      // TODO(deviceId)：正式版由 Rust 层生成并持久化设备标识（禁止 localStorage 存业务数据，D01 §12.2-5）
      wsClient.connect(WS_BASE, token, 'dev-device');
    } else {
      wsClient.disconnect();
    }
    return () => wsClient.disconnect();
  }, [token]);

  // mock 模式下连接状态机视为在线（便于纯前端走查六态）
  const setStatus = useConnectionStore((s) => s.setStatus);
  useEffect(() => {
    if (USE_MOCK) setStatus('online');
  }, [USE_MOCK, setStatus]);
}

export function App() {
  useWsLifecycle();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <MainLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/im" replace />} />
        {/* IM：默认落点；子路由切换不销毁 WSS 连接与未读状态（D01 §4.2） */}
        <Route path="/im" element={<ChatPage />} />
        <Route path="/im/c/:convId" element={<ChatPage />} />
        {/* 我的收藏（PIM-08，D03 §3.8） */}
        <Route path="/im/favorites" element={<FavoritesPage />} />
        {/* 通知中心（PIM-09，D03 §3.9） */}
        <Route path="/im/notifications" element={<NotificationCenterPage />} />
        <Route path="/rtc" element={<PlaceholderPage title="通话" designDoc="D04" icon={Phone} blurb="音视频通话、来电接听与通话历史" />} />
        <Route path="/doc" element={<PlaceholderPage title="文档中心" designDoc="D05/D06" icon={FileText} blurb="在线文档协同、文件传输与分享" />} />
        {/* 知识库（D07 阶段一务实版）：空间/摄入/检索三合一最小可用页 */}
        <Route path="/kb" element={<KbPage />} />
        {/* Agent 工作台域（D08）：PAG-01/02/03 工作台 + PAG-11 记忆 + 日报 */}
        <Route path="/agent" element={<AgentWorkbenchPage />} />
        <Route path="/agent/s/:sessionId" element={<AgentWorkbenchPage />} />
        <Route path="/agent/memory" element={<AgentMemoryPage />} />
        <Route path="/agent/reports" element={<AgentReportsPage />} />
        {/* 管理后台（D10 阶段一务实版）：仪表盘/用户/策略/用量/审计五页；
            一级"管理"入口按 me.perms admin:* 显隐（MainLayout），服务端守卫 2003 兜底 */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        {/* 设置页族（D01 §4.2）：通用/通知/传输/Agent/关于；通用页主题切换真实生效 */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/general" replace />} />
          <Route path="general" element={<GeneralSettingsPage />} />
          <Route path="notification" element={<NotificationSettingsPage />} />
          <Route path="transfer" element={<TransferSettingsPage />} />
          <Route path="agent" element={<AgentSettingsPage />} />
          <Route path="about" element={<AboutPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
