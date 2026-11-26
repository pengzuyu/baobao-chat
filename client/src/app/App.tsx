/**
 * 应用壳（D01 §4/§5）：
 * - 路由总表：/auth 认证 + 受保护主布局（/im 默认落点，其余一级导航占位）
 * - WS 生命周期：登录后连接、登出断开；重连成功触发增量同步（14 篇 §4.2）
 */

import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../features/auth/store/auth';
import { ensureDeviceId } from '../shared/deviceId';
import { OidcConfirmCard } from '../features/auth/components/OidcConfirmCard';
import { LoginPage } from '../features/auth/pages/LoginPage';
import { SetupPage } from '../features/auth/pages/SetupPage';
import { ChatPage } from '../features/im/pages/ChatPage';
import { FavoritesPage } from '../features/im/pages/FavoritesPage';
import { NotificationCenterPage } from '../features/im/pages/NotificationCenterPage';
import { ContactsPage } from '../features/contacts/pages/ContactsPage';
import { KbShellPage } from '../features/kb/pages/KbShellPage';
import { MyArticlesPage } from '../features/kb/pages/MyArticlesPage';
import { APP_NAME } from '../shared/brand';
import { SearchPage } from '../features/kb/pages/SearchPage';
import { SpaceBrowsePage } from '../features/kb/pages/SpaceBrowsePage';
import { MailPage } from '../features/mail/pages/MailPage';
import { ExpertLibraryPage } from '../features/expert/pages/ExpertLibraryPage';
import { useImStore } from '../features/im/store/im';
import { AgentWorkbenchPage } from '../features/agent/pages/AgentWorkbenchPage';
import { SchedulesPage } from '../features/agent/pages/SchedulesPage';
import { AgentSettingsPage } from '../features/agent/pages/AgentSettingsPage';
import { McpSettingsPage } from '../features/agent/pages/McpSettingsPage';
import { PluginPage } from '../features/eco/pages/PluginPage';
import { ensureAgentEventSubscribed, useAgentStore } from '../features/agent/store/agent';
import { isLocallyReported, notifyAgentDone, notifyScheduleApproval } from '../features/agent/bridge/notify';
import { scheduleSyncCalendar } from '../features/agent/bridge/schedule';
import { isTauriAvailable } from '../features/agent/bridge/tauri';
import { AdminLayout } from '../features/admin/pages/AdminLayout';
import { DashboardPage } from '../features/admin/pages/DashboardPage';
import { OidcClientsPage } from '../features/admin/pages/OidcClientsPage';
import { ClientReleasePage } from '../features/admin/pages/ClientReleasePage';
import { SkillsPage } from '../features/admin/pages/SkillsPage';
import { OrgDirectoryPage } from '../features/admin/pages/OrgDirectoryPage';
import { RolesPage } from '../features/admin/pages/RolesPage';
import { NoticesPage } from '../features/admin/pages/NoticesPage';
import { CalendarPage } from '../features/admin/pages/CalendarPage';
import { AgentGovernancePage } from '../features/admin/pages/AgentGovernancePage';
import { PluginGovernancePage } from '../features/admin/pages/PluginGovernancePage';
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
import { ProfileSettingsPage } from '../features/settings/pages/ProfileSettingsPage';
import { ShortcutSettingsPage } from '../features/settings/pages/ShortcutSettingsPage';
import { GeneralSettingsPage } from '../features/settings/pages/GeneralSettingsPage';
import { NotificationSettingsPage } from '../features/settings/pages/NotificationSettingsPage';
import { TransferSettingsPage } from '../features/settings/pages/TransferSettingsPage';
import { AuthorizedAppsPage } from '../features/settings/pages/AuthorizedAppsPage';
import { AboutPage } from '../features/settings/pages/AboutPage';
import { sendSystemNotification } from '../features/agent/bridge/notify';
import { startUpdaterAutoCheck } from '../features/settings/updater';
import { message as antdMessage } from 'antd';
import { DevPanel } from '../shared/ui/DevPanel';
import { toggleDevPanel } from '../shared/log/devlog';

/** WS 基址：显式 VITE_WS_BASE > 同源推导自 VITE_API_BASE（统一入口路径分流，见 ws.ts） */
const WS_BASE: string = resolveWsBase();
/** mock 模式（无后端纯演示）：显式 VITE_USE_MOCK=1 才启用桩数据，默认连真实后端（D18 翻转） */
const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === '1';

/** 认证门卫：无凭据强制跳 /auth（D01 §4.2） */
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const mustChangePwd = useAuthStore((s) => !!s.user?.must_change_pwd);
  const location = useLocation();
  if (!token) return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  // 首登强制改密（D11）：token 已发但未改密——全部业务路由拦回 /auth 二步表单
  if (mustChangePwd) return <Navigate to="/auth" replace />;
  return <>{children}</>;
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
        window.dispatchEvent(new CustomEvent('bbc:toast', { detail: '已触发紧急停止：Agent 进程终止、未决审批作废' }));
        void sendSystemNotification(`${APP_NAME} · 紧急停止`, 'Agent 进程已终止，未决审批已作废');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** dev 刷新键（2026-11-11 真机排查补）：Tauri webview 无原生 ⌘R——卡流/旧模块
 *  时手动整页重载（生产构建不挂）。⌘R / ⌘⇧R / Ctrl 系同构 */
function useDevReloadHotkey(): void {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 开发者面板键（2026-11-23 开发者模式）：⌘⇧D / Ctrl+Shift+D 全局开关——生产包无
 * devtools 时现场排查第一入口（错误/网络/WS 事件环形日志，见 shared/log/devlog.ts） */
function useDevPanelHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        toggleDevPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 全局轻提示（bbc:toast CustomEvent → antd message；E7 紧急停止等主窗提示） */
function useGlobalToast(): void {
  const [api, contextHolder] = antdMessage.useMessage();
  useEffect(() => {
    const onToast = (e: Event) => {
      api.warning((e as CustomEvent<string>).detail);
    };
    window.addEventListener('bbc:toast', onToast);
    return () => window.removeEventListener('bbc:toast', onToast);
  }, [api]);
  // 挂到路由树外层（render 里消费 contextHolder）
  (window as unknown as { __bbcToastHolder?: unknown }).__bbcToastHolder = contextHolder;
}

function useWsLifecycle(): void {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const refreshPerms = useAuthStore((s) => s.refreshPerms);
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

  // D35 定时任务（纯本地）：壳事件 → 本地系统通知（完成/等待审批）
  useEffect(() => {
    if (!isTauriAvailable()) return;
    let un: (() => void) | null = null;
    let disposed = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{
        kind: string;
        run?: { status: string; error?: string | null; summary?: string | null };
      }>('schedule://event', (e) => {
        const p = e.payload;
        if (p.kind === 'run_finished' && p.run) {
          const ok = p.run.status === 'success';
          void notifyAgentDone(
            ok ? '定时任务完成' : '定时任务失败',
            (p.run.error || p.run.summary || '').slice(0, 100) || '打开 Agent → 定时任务查看详情',
          );
        } else if (p.kind === 'run_changed' && p.run?.status === 'waiting_approval') {
          void notifyScheduleApproval(
            '定时任务等待审批',
            '打开 Agent → 定时任务 → 历史 → 去审批',
          );
        }
      }),
    ).then((off) => {
      if (disposed) off();
      else un = off;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // D35：登录后同步工作日日历（今年+明年，失败静默；用户可在任务页手动同步）
  useEffect(() => {
    if (!token || USE_MOCK || !isTauriAvailable()) return;
    const y = new Date().getFullYear();
    void scheduleSyncCalendar(y).catch(() => {});
    void scheduleSyncCalendar(y + 1).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (token && !USE_MOCK) {
      // 稳定设备号（D28 批0）：Rust 持久化 uuid 单源——替换 dev-device 硬编码
      void ensureDeviceId().then((did) => wsClient.connect(WS_BASE, token, did));
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
  // OIDC 深链确认请求（D28 批2/Q2b）：bbc://auth?req= 唤起 → Rust emit → 确认卡
  const [oidcConfirmReq, setOidcConfirmReq] = useState<string | null>(null);
  useEffect(() => {
    if (USE_MOCK || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ req?: string }>('oidc://confirm-req', (e) => {
        if (e.payload?.req) setOidcConfirmReq(e.payload.req);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, []);
  useEmergencyStopHotkey();
  useDevReloadHotkey();
  useDevPanelHotkey();
  useGlobalToast();
  // agent 事件监听宿主化（2026-11-11 根因修复）：App 挂载即注册——不再依赖
  // 懒 init，任何整页重载/HMR 后恒有监听（否则壳泵照发、webview 无人听）
  useEffect(() => {
    ensureAgentEventSubscribed();
  }, []);

  // 应用更新静默检查（D21，16 篇 §4.2：启动延迟 3s + 每 6h 复查；发现新版发
  // 系统通知引导到「设置 · 关于」——通知回调在 App 层注入避免 settings→agent 横向 import）
  useEffect(() => {
    startUpdaterAutoCheck((info) => {
      void sendSystemNotification(
        `${APP_NAME} · 发现新版本`,
        `v${info.version} 已发布，可到「设置 · 关于」下载更新`,
      );
    });
  }, []);

  // 启动静默恢复门（D28 批0）：钥匙串 refresh 换新 access 期间显示占位——
  // 防 RequireAuth 先跳登录页再跳主界的闪跳；非 Tauri/mock 恒 false 不触发
  const restoring = useAuthStore((s) => s.restoring);
  if (restoring) {
    return (
      <>
        <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
          正在恢复登录…
        </div>
        <DevPanel />
      </>
    );
  }

  return (
    <BrowserRouter>
      {(window as unknown as { __bbcToastHolder?: React.ReactNode }).__bbcToastHolder}
      <Routes>
        <Route path="/auth" element={<LoginPage />} />
        {/* 初始化向导（16 篇 §2.2 Web 化）：空系统引导首个管理员；已初始化自动回 /auth */}
        <Route path="/setup" element={<SetupPage />} />
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
        {/* 通讯录（M2，2026-11-12 全员可见）：组织树+成员浏览/找人发消息；管理动作在 /admin/org */}
        <Route path="/contacts" element={<ContactsPage />} />
        {/* 我的收藏（PIM-08，D03 §3.8） */}
        <Route path="/im/favorites" element={<FavoritesPage />} />
        {/* 全局通知中心（OQ-B07 上移：/notifications——IM/kb/agent 审批复用同一中心， */}
        {/* kind 分组随域接入扩展；旧 /im/notifications 兼容跳转） */}
        <Route path="/notifications" element={<NotificationCenterPage />} />
        <Route path="/im/notifications" element={<Navigate to="/notifications" replace />} />
        {/* 知识库（D07 阶段一务实版）：空间/摄入/检索三合一最小可用页 */}
        {/* kb/* 单条 splat：/kb 与 /kb/d/:id 同组件零重挂（tab 切换不销毁壳/树/首页，
            双路由版本切 tab 整壳重挂——真机「打开文章整页卡死」根因）；search/my/s 静态段优先匹配 */}
        <Route path="/kb/*" element={<KbShellPage />} />
        <Route path="/kb/search" element={<SearchPage />} />
        <Route path="/kb/s/:spaceId" element={<SpaceBrowsePage />} />
        <Route path="/kb/my" element={<MyArticlesPage />} />
        {/* 邮箱（22 篇 MAI-01~04：三栏/写信/设置/搜索） */}
        <Route path="/mail" element={<MailPage />} />
        {/* 专家库（D14 PAG-13~15：公司/个人库/编辑器） */}
        <Route path="/experts" element={<ExpertLibraryPage />} />
        {/* Agent 工作台域（D08）：PAG-01/02/03 工作台（记忆/日报页已退役——平台后台组织，不做用户浏览面） */}
        <Route path="/agent" element={<AgentWorkbenchPage />} />
        {/* 新建会话页（2026-11-23 懒创建）：?workspace=项目路径=项目新建，缺省=任务新建 */}
        <Route path="/agent/new" element={<AgentWorkbenchPage />} />
        <Route path="/agent/s/:sessionId" element={<AgentWorkbenchPage />} />
        <Route path="/agent/schedules" element={<SchedulesPage />} />
        <Route path="/agent/plugins" element={<PluginPage />} />
        {/* Agent 设置/MCP 服务（2026-11-25 自设置域迁入：与定时任务/插件同属 agent 域二级导航） */}
        <Route path="/agent/settings" element={<AgentSettingsPage />} />
        <Route path="/agent/mcp" element={<McpSettingsPage />} />
        {/* 旧设置域路由兼容跳转 */}
        <Route path="/settings/agent" element={<Navigate to="/agent/settings" replace />} />
        <Route path="/settings/mcp" element={<Navigate to="/agent/mcp" replace />} />
        {/* 管理后台（D10 阶段一务实版）：仪表盘/用户/策略/用量/审计五页；
            一级"管理"入口按 me.perms admin:* 显隐（MainLayout），服务端守卫 2003 兜底 */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<DashboardPage />} />
          {/* 2026-11-12 用户裁决：用户+组织合并为通讯录页；旧 /admin/users 重定向 */}
          <Route path="users" element={<Navigate to="/admin/org" replace />} />
          {/* 2026-11-18 批量导入收编组织用户页（弹窗）；旧独立页重定向 */}
          <Route path="users/import" element={<Navigate to="/admin/org" replace />} />
          <Route path="roles" element={<RolesPage />} />
          <Route path="notices" element={<NoticesPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="agent" element={<AgentGovernancePage />} />
          <Route path="plugins" element={<PluginGovernancePage />} />
          <Route path="org" element={<OrgDirectoryPage />} />
          <Route path="kb" element={<KbGovernancePage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="ai-providers" element={<AiProvidersPage />} />
          <Route path="stickers" element={<StickersPage />} />
          <Route path="oidc-clients" element={<OidcClientsPage />} />
          <Route path="client-releases" element={<ClientReleasePage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        {/* 设置页族（D01 §4.2）：通用/通知/传输/关于；通用页主题切换真实生效。
            Agent/MCP 服务两 tab 已迁 agent 工作台域（/agent/settings、/agent/mcp） */}
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/profile" replace />} />
          <Route path="profile" element={<ProfileSettingsPage />} />
          <Route path="general" element={<GeneralSettingsPage />} />
          <Route path="notification" element={<NotificationSettingsPage />} />
          <Route path="transfer" element={<TransferSettingsPage />} />
          <Route path="shortcuts" element={<ShortcutSettingsPage />} />
          <Route path="authorized" element={<AuthorizedAppsPage />} />
          <Route path="about" element={<AboutPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {oidcConfirmReq && (
        <OidcConfirmCard reqId={oidcConfirmReq} onClose={() => setOidcConfirmReq(null)} />
      )}
      <DevPanel />
    </BrowserRouter>
  );
}
