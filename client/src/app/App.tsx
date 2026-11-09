/**
 * 应用壳（D01 §4/§5）：
 * - 路由总表：/auth 认证 + 受保护主布局（/im 默认落点，其余一级导航占位）
 * - WS 生命周期：登录后连接、登出断开；重连成功触发增量同步（14 篇 §4.2）
 */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../features/auth/store/auth';
import { LoginPage } from '../features/auth/pages/LoginPage';
import { SetupPage } from '../features/auth/pages/SetupPage';
import { ChatPage } from '../features/im/pages/ChatPage';
import { FavoritesPage } from '../features/im/pages/FavoritesPage';
import { NotificationCenterPage } from '../features/im/pages/NotificationCenterPage';
import { ShareResolvePage } from '../features/im/pages/ShareResolvePage';
import { KbPage } from '../features/kb/pages/KbPage';
import { MailPage } from '../features/mail/pages/MailPage';
import { MeetingPage } from '../features/meeting/pages/MeetingPage';
import { ExpertLibraryPage } from '../features/expert/pages/ExpertLibraryPage';
import { AppStorePage } from '../features/eco/pages/AppStorePage';
import { useImStore } from '../features/im/store/im';
import { useRtcStore } from '../features/rtc/store/rtcStore';
import { RtcOverlay } from '../features/rtc/components/RtcOverlay';
import { RecentCallsPage } from '../features/rtc/pages/RecentCallsPage';
import { AgentWorkbenchPage } from '../features/agent/pages/AgentWorkbenchPage';
import { AgentMemoryPage } from '../features/agent/pages/AgentMemoryPage';
import { AgentReportsPage } from '../features/agent/pages/AgentReportsPage';
import { useAgentStore } from '../features/agent/store/agent';
import { isLocallyReported, notifyAgentDone } from '../features/agent/bridge/notify';
import { AdminLayout } from '../features/admin/pages/AdminLayout';
import { DashboardPage } from '../features/admin/pages/DashboardPage';
import { EcoAppsPage } from '../features/admin/pages/EcoAppsPage';
import { SkillsPage } from '../features/admin/pages/SkillsPage';
import { UsersPage } from '../features/admin/pages/UsersPage';
import { RolesPage } from '../features/admin/pages/RolesPage';
import { NoticesPage } from '../features/admin/pages/NoticesPage';
import { ImportPage } from '../features/admin/pages/ImportPage';
import { AgentGovernancePage } from '../features/admin/pages/AgentGovernancePage';
import { OrgTreePage } from '../features/admin/pages/OrgTreePage';
import { KbGovernancePage } from '../features/admin/pages/KbGovernancePage';
import { PoliciesPage } from '../features/admin/pages/PoliciesPage';
import { AiProvidersPage } from '../features/admin/pages/AiProvidersPage';
import { StickersPage } from '../features/admin/pages/StickersPage';
import { UsagePage } from '../features/admin/pages/UsagePage';
import { AuditPage } from '../features/admin/pages/AuditPage';
import { resolveWsBase, wsClient } from '../shared/api/ws';
import { bindWsToConnectionStore, useConnectionStore } from '../shared/store/connection';
import { MainLayout } from './MainLayout';
import { SettingsLayout } from '../features/settings/pages/SettingsLayout';
import { ShortcutSettingsPage } from '../features/settings/pages/ShortcutSettingsPage';
import { GeneralSettingsPage } from '../features/settings/pages/GeneralSettingsPage';
import { NotificationSettingsPage } from '../features/settings/pages/NotificationSettingsPage';
import { TransferSettingsPage } from '../features/settings/pages/TransferSettingsPage';
import { AgentSettingsPage } from '../features/settings/pages/AgentSettingsPage';
import { AboutPage } from '../features/settings/pages/AboutPage';
import { sendSystemNotification } from '../features/agent/bridge/notify';
import { message as antdMessage } from 'antd';

/** WS 基址：显式 VITE_WS_BASE > 同源推导自 VITE_API_BASE（统一入口路径分流，见 ws.ts） */
const WS_BASE: string = resolveWsBase();
/** mock 模式（无后端联调）默认开启：REST/WS 走 features 各模块 api 层内置桩数据 */
const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 认证门卫：无凭据强制跳 /auth（D01 §4.2）；通过后挂全局通话浮层（D04） */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const mustChangePwd = useAuthStore((s) => !!s.user?.must_change_pwd);
  const location = useLocation();
  if (!token) return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  // 首登强制改密（D11）：token 已发但未改密——全部业务路由拦回 /auth 二步表单
  if (mustChangePwd) return <Navigate to="/auth" replace />;
  return (
    <>
      {children}
      {/* D17 §4：auth 源经组合层下发（Tauri 宿主下拉起独立会议窗口的 handoff 载荷用） */}
      <RtcOverlay
        auth={{
          getToken: () => useAuthStore.getState().token,
          getRefreshToken: () => useAuthStore.getState().refreshToken,
          getExpiresAt: () => useAuthStore.getState().expiresAt ?? 0,
          getUid: () => useAuthStore.getState().user?.uid ?? '',
          getDisplayName: () => useAuthStore.getState().user?.name ?? '',
        }}
      />
    </>
  );
}

/** WS 连接生命周期与全局绑定（装配副作用集中于此） */
/**
 * 紧急停止全局键（E7/OQ-C30：⌘⇧. 主窗任意路由可触发；主窗 toast+系统通知
 * 双通道多屏提示——系统通知覆盖主窗不在前台/最小化场景）。
 */
function useEmergencyStopHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘⇧. / Ctrl+Shift+.（09 篇 INT-AG-12；period 在 mac 中文输入法下 key 值兼容 '。'）
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '.' || e.key === '。')) {
        e.preventDefault();
        const { emergencyStop } = useAgentStore.getState();
        emergencyStop();
        // 多屏提示（OQ-C30）：主窗 toast + 系统通知（免打扰不拦——紧急语义优先于偏好闸门）
        window.dispatchEvent(new CustomEvent('bbw:toast', { detail: '已触发紧急停止：Agent 进程终止、未决审批作废' }));
        void sendSystemNotification('BaobaoWork · 紧急停止', 'Agent 进程已终止，未决审批已作废');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 全局轻提示（bbw:toast CustomEvent → antd message；E7 紧急停止等主窗提示） */
function useGlobalToast(): void {
  const [api, contextHolder] = antdMessage.useMessage();
  useEffect(() => {
    const onToast = (e: Event) => {
      api.warning((e as CustomEvent<string>).detail);
    };
    window.addEventListener('bbw:toast', onToast);
    return () => window.removeEventListener('bbw:toast', onToast);
  }, [api]);
  // 挂到路由树外层（render 里消费 contextHolder）
  (window as unknown as { __bbwToastHolder?: unknown }).__bbwToastHolder = contextHolder;
}

function useWsLifecycle(): void {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const refreshPerms = useAuthStore((s) => s.refreshPerms);
  const setMyUid = useImStore((s) => s.setMyUid);
  const setRtcUid = useRtcStore((s) => s.setMyUid);
  const queryClient = useQueryClient();

  // 组合层注入：IM 判定"己方消息"用（features 间禁止横向 import，D01 §12.2）
  // rtc 同口径注入（对端解析/bus 回拨发起判定方向，D04）
  useEffect(() => {
    setMyUid(user?.uid ?? '');
    setRtcUid(user?.uid ?? '');
  }, [user, setMyUid, setRtcUid]);

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
    // Agent 任务终态跨端通知（14 篇 §3.3 OQ-C32）：其它端上报的 run 完成 →
    // 系统通知触达；本端刚上报过的 run 自滤（本地通知已负责，防双响）。
    // 工作台在 /agent 时顺带刷新 run 面板（后台完成的 run 跨端也实时可见）
    const offAgentTask = wsClient.on('agent.task.completed', (raw) => {
      const t = raw as {
        run_id: string; kind: string; status: string; session_id: string;
        title?: string; summary?: string;
      };
      if (isLocallyReported(t.run_id)) return;
      const outcome = t.status === 'failed' ? '失败' : '完成';
      void notifyAgentDone(
        `任务${outcome}${t.title ? `：${t.title}` : ''}`,
        (t.summary ?? t.run_id).slice(0, 80),
      );
      if (window.location.pathname.startsWith('/agent')) {
        useAgentStore.getState().loadRuns(t.session_id);
      }
    });
    // 权限实时生效（03 篇 §4）：授权/收回/角色变更 → perm.changed → 重拉 /me/permissions
    // 更新 auth store（管理入口与模块树显隐即时收窄；进行中操作由服务端守卫 2001 拒绝）
    const offPermChanged = wsClient.on('perm.changed', () => {
      void refreshPerms();
    });
    return () => {
      wsClient.onResync = null;
      wsClient.onAuthError = null;
      offNotification();
      offAgentTask();
      offPermChanged();
    };
  }, [logout, queryClient, refreshPerms]);

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
  useEmergencyStopHotkey();
  useGlobalToast();

  return (
    <BrowserRouter>
      {(window as unknown as { __bbwToastHolder?: React.ReactNode }).__bbwToastHolder}
      <Routes>
        <Route path="/auth" element={<LoginPage />} />
        {/* 初始化向导（16 篇 §2.2 Web 化）：空系统引导首个管理员；已初始化自动回 /auth */}
        <Route path="/setup" element={<SetupPage />} />
        {/* 分享外链解析（D06 §4.4：登录态访问——企业内不匿名；独立轻页面不走主布局） */}
        <Route
          path="/s/:code"
          element={
            <RequireAuth>
              <ShareResolvePage />
            </RequireAuth>
          }
        />
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
        {/* 全局通知中心（OQ-B07 上移：/notifications——IM/kb/agent 审批复用同一中心， */}
        {/* kind 分组随域接入扩展；旧 /im/notifications 兼容跳转） */}
        <Route path="/notifications" element={<NotificationCenterPage />} />
        <Route path="/im/notifications" element={<Navigate to="/notifications" replace />} />
        {/* 通话域（D04 阶段一务实版）：最近通话（call_card 消息流派生）+ 全局通话浮层在 RequireAuth 挂载 */}
        <Route path="/rtc" element={<RecentCallsPage />} />
        {/* 知识库（D07 阶段一务实版）：空间/摄入/检索三合一最小可用页 */}
        <Route path="/kb" element={<KbPage />} />
        {/* 邮箱（22 篇 MAI-01~04：三栏/写信/设置/搜索） */}
        <Route path="/mail" element={<MailPage />} />
        {/* 会议（21 篇 PMT-01~03：周日历/预约/详情；会中侧栏与纪要随 ASR） */}
        <Route path="/meetings" element={<MeetingPage />} />
        {/* 专家库（D14 PAG-13~15：公司/个人库/编辑器；协作图视图随 agent_* 接线） */}
        <Route path="/experts" element={<ExpertLibraryPage />} />
        {/* 应用商店（E1/D09 PEC-07：catalog 差异+安装） */}
        <Route path="/apps" element={<AppStorePage />} />
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
          <Route path="users/import" element={<ImportPage />} />
          <Route path="roles" element={<RolesPage />} />
          <Route path="notices" element={<NoticesPage />} />
          <Route path="agent" element={<AgentGovernancePage />} />
          <Route path="org" element={<OrgTreePage />} />
          <Route path="kb" element={<KbGovernancePage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="ai-providers" element={<AiProvidersPage />} />
          <Route path="stickers" element={<StickersPage />} />
          <Route path="eco-apps" element={<EcoAppsPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        {/* 设置页族（D01 §4.2）：通用/通知/传输/Agent/关于；通用页主题切换真实生效 */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/general" replace />} />
          <Route path="general" element={<GeneralSettingsPage />} />
          <Route path="notification" element={<NotificationSettingsPage />} />
          <Route path="transfer" element={<TransferSettingsPage />} />
          <Route path="shortcuts" element={<ShortcutSettingsPage />} />
          <Route path="agent" element={<AgentSettingsPage />} />
          <Route path="about" element={<AboutPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
