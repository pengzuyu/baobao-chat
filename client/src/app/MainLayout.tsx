/**
 * 主窗布局（D01 §4/§5.1）：
 * - 左侧一级导航（antd Layout.Sider + Menu）：**图标在上、文字在下**竖排形态
 *   （2026-11-14 用户拍板保留原 56px 图标栏观感——Menu items 不用 icon 槽，
 *   label 内自定义 Flex vertical；itemHeight 放宽、itemPaddingInline 归零经
 *   ConfigProvider components.Menu 覆写；未读 Badge 叠图标右上；选中态由 antdThemeFrom
 *   的 components.Menu 显式覆写（D27 修订2））
 * - 品牌 Logo + 消息/通知/知识库/邮件/Agent/管理 + 头像菜单；管理项按权限动态显隐；
 *   专家/应用入口 2026-11-12 起暂时隐藏
 * - 顶部连接状态横幅（antd Alert banner；六态 offline/degraded 全局落点，D01 §7）
 * - 内容区 <Outlet/>：路由切换不销毁 IM 的 WSS 连接与未读状态
 * D26-O6：app-shell/nav-rail 壳类退役——antd Layout + Menu + Badge + Alert（选中态随路由）。
 */

import { useEffect, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, ConfigProvider, Dropdown, Flex, Layout, Menu, message, theme, type MenuProps } from 'antd';
import { Bell, Bot, BookUser, BrainCircuit, Check, Gauge, Mail, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthStore } from '../features/auth/store/auth';
import { useImStore } from '../features/im/store/im';
import { wsClient } from '../shared/api/ws';
import { qk } from '../shared/api/keys';
import { PRESENCE_LABEL, PresenceBadge, PresenceDot, toPresenceStatus, usePresenceColors, type PresenceStatus } from '../shared/ui/PresenceDot';
import { APP_NAME } from '../shared/brand';
import { useImWsEvents } from '../features/im/store/wsEvents';
import { useUnreadNotificationCount } from '../features/im/api/hooks';
import { useConnectionStore } from '../shared/store/connection';
import { useThemeStore, type ThemeMode } from '../shared/store/theme';
import { t, useI18nStore } from '../shared/i18n';
import { Logo } from '../shared/ui/Logo';
import { Avatar } from '../shared/ui/Avatar';
import { AccentSwatches } from '../shared/ui/AccentSwatches';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary';

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
}

/** 一级导航（D01 §4.1；管理项按权限动态显隐） */
function useNavItems(): NavItem[] {
  useI18nStore((s) => s.locale); // E12
  return [
  { to: '/im', icon: MessageCircle, label: t('nav.im') },
  // 通讯录（M2，2026-11-12 用户裁决：全员可见——组织树+成员浏览/找人发消息）
  { to: '/contacts', icon: BookUser, label: t('nav.contacts') },
  { to: '/notifications', icon: Bell, label: t('nav.notification') },
  { to: '/kb', icon: BrainCircuit, label: t('nav.kb') },
  { to: '/mail', icon: Mail, label: t('nav.mail') },
  { to: '/agent', icon: Bot, label: t('nav.agent') },
  // 2026-11-12 用户指示先隐藏，恢复时取消注释即可（路由保留可直接深链访问）
  // { to: '/experts', icon: Sparkles, label: t('nav.experts') },
  // { to: '/apps', icon: Boxes, label: '应用' },
  ];
}

const THEME_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' };

/** 连接横幅：connecting 信息 / offline 红 / degraded 黄（antd Alert banner） */
function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);
  const attempt = useConnectionStore((s) => s.reconnectAttempt);
  const degradedText = useConnectionStore((s) => s.degradedText);

  if (degradedText) {
    return <Alert type="warning" banner message={degradedText} />;
  }
  if (status === 'connecting') {
    return <Alert type="info" banner message="连接中…" />;
  }
  if (status === 'offline') {
    return <Alert type="error" banner message={`已离线，正在重连…（第 ${attempt + 1} 次）`} />;
  }
  return null;
}

export function MainLayout() {
  const { token } = theme.useToken();
  const navItems = useNavItems();
  const navigate = useNavigate();
  const location = useLocation();
  // IM WS 事件常驻绑定：任意页面实时入流 + 未读徽标（订阅随主布局，D01 §4.2）
  useImWsEvents();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  // 总未读徽标：来自 IM store（99+ 封顶，D01 §8 红点规则）
  const totalUnread = useImStore((s) => s.convs.reduce((sum, c) => sum + (c.my?.unreadBadge ?? 0), 0));
  // 通知中心未读红点（全局中心自身的数据源；IM 内铃铛同源）
  const notifUnread = useUnreadNotificationCount();
  const isAdmin = useMemo(() => (user?.perms ?? []).some((p) => p.startsWith('admin')), [user]);

  // ⌘,/Ctrl+, 打开设置（D01 §9 键位；输入框聚焦时忽略）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        navigate('/settings/general');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // ── 在线状态（pres.set 四档；用户拍板 2026-11-17：在线/离开/忙碌/离线=隐身）──
  const queryClient = useQueryClient();
  const myUid = useImStore((s) => s.myUid);
  const myPresence = toPresenceStatus(useImStore((s) => s.presence[s.myUid ?? '']) ?? 'online');
  const presenceColors = usePresenceColors();
  const setMyStatus = (status: 'online' | 'away' | 'dnd' | 'invisible') => {
    // 乐观投影（隐身对己也按离线显示，对齐服务端广播口径）；失败重拉快照回滚
    useImStore.getState().applyPresence(myUid ?? '', status === 'invisible' ? 'offline' : status);
    wsClient.request('pres.set', { status }).catch(() => {
      message.error('状态设置失败（连接不可用），已回退');
      void queryClient.invalidateQueries({ queryKey: qk.im.presence });
    });
  };
  const presItem = (key: PresenceStatus | 'invisible', label: string, dot: PresenceStatus) => ({
    key: `pres-${key}`,
    label: (
      <Flex align="center" gap={8} style={{ minWidth: 96 }}>
        <PresenceDot status={dot} />
        <span>{label}</span>
        {myPresence === dot ? <Check size={12} style={{ marginLeft: 'auto', opacity: 0.65 }} /> : null}
      </Flex>
    ),
  });

  const avatarMenu: MenuProps = {
    items: [
      {
        key: 'presence',
        label: `在线状态 · ${PRESENCE_LABEL[myPresence]}`,
        children: [
          presItem('online', '在线', 'online'),
          presItem('away', '离开', 'away'),
          presItem('dnd', '忙碌', 'dnd'),
          presItem('invisible', '离线（隐身）', 'offline'),
        ],
      },
      { type: 'divider' },
      {
        key: 'theme',
        label: `主题 · ${THEME_LABEL[themeMode]}`,
        children: [
          { key: 'theme-light', label: THEME_LABEL.light },
          { key: 'theme-dark', label: THEME_LABEL.dark },
          { key: 'theme-system', label: THEME_LABEL.system },
        ],
      },
      // D27 修订2：主题色快切（色块行内嵌 label；点击色块即生效并收起下拉，key 'accent' 本体无动作）
      {
        key: 'accent',
        label: (
          <Flex align="center" gap={8}>
            <span>主题色</span>
            <AccentSwatches size={16} />
          </Flex>
        ),
      },
      { key: 'settings', label: '设置' },
      { key: 'about', label: '关于' },
      { type: 'divider' },
      { key: 'logout', label: '退出登录', danger: true },
    ],
    onClick: ({ key }) => {
      if (key.startsWith('pres-')) {
        setMyStatus(key.slice(5) as 'online' | 'away' | 'dnd' | 'invisible');
        return;
      }
      if (key.startsWith('theme-')) {
        setThemeMode(key.slice(6) as ThemeMode);
        return;
      }
      if (key === 'settings') {
        navigate('/settings/general');
        return;
      }
      if (key === 'about') {
        navigate('/settings/about');
        return;
      }
      if (key === 'logout') {
        logout();
        navigate('/auth', { replace: true });
      }
    },
  };

  // 选中态随路由（/im/c/123 → /im 前缀命中）
  const menuKeys = useMemo(() => [...navItems.map((i) => i.to), ...(isAdmin ? ['/admin'] : [])], [navItems, isAdmin]);
  const selectedKey = useMemo(() => {
    const p = location.pathname;
    return menuKeys.find((k) => p === k || p.startsWith(`${k}/`)) ?? '';
  }, [location.pathname, menuKeys]);

  /** 项 → 竖排 label（图标在上文字在下；未读 Badge 叠图标右上，count=0 不渲染） */
  const railLabel = (item: { icon: LucideIcon; label: string; to: string }): React.ReactNode => {
    const unread = item.to === '/im' ? totalUnread : item.to === '/notifications' ? (notifUnread.data ?? 0) : 0;
    return (
      <Flex vertical align="center" gap={2} style={{ width: '100%', lineHeight: 1 }}>
        {/* offset 把数字收进 item 内容盒：antd inline 菜单的 .ant-menu-item/.ant-menu-title-content
            自带 overflow:hidden（文字省略号用），Badge 默认挂在图标右上且 translate(50%,-50%) 向右上
            各突出一半，两位数/99+ 右缘超出 47px 内容盒即被裁（2026-11-20 通知项数字显示不全根因）；
            x=-4 左收横向余量，y=7 抵消上突使数字顶与图标顶平齐，任何位数完整可见 */}
        <Badge count={unread} overflowCount={99} size="small" offset={[-4, 7]} style={{ boxShadow: 'none', background: token.colorError }}>
          <item.icon size={18} strokeWidth={1.8} />
        </Badge>
        <span style={{ fontSize: 12 }}>{item.label}</span>
      </Flex>
    );
  };

  const menuItems: MenuProps['items'] = [
    ...navItems.map((item) => ({ key: item.to, label: railLabel(item) })),
    // 管理入口：仅 admin:* 权限可见（perm.changed 动态显隐，D01 §4.1）
    ...(isAdmin ? [{ key: '/admin', label: railLabel({ icon: Gauge, label: '管理', to: '/admin' }) }] : []),
  ];

  return (
    <Layout style={{ height: '100%', background: 'transparent' }}>
      <Layout.Sider
        width={56} /* = --bbc-nav-width（D01 §5.1 一级导航栏基线；竖排化时曾放宽到 76 致两侧留白，2026-11-16 用户拍板收窄回归） */
        style={{ background: token.colorBgContainer, borderRight: `1px solid ${token.colorBorderSecondary}` }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '8px 0' }}>
          <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }} title={APP_NAME}>
            <Logo size={26} />
          </div>
          {/* 竖排图标栏：Menu 行高/内边距覆写（itemPaddingInline=0 让竖排内容居中） */}
          <ConfigProvider
            theme={{
              components: {
                Menu: {
                  itemHeight: 60,
                  itemPaddingInline: 0,
                  itemMarginInline: 4,
                  itemBorderRadius: token.borderRadius,
                  itemMarginBlock: 2,
                },
              },
            }}
          >
            <Menu
              mode="inline"
              inlineIndent={0} /* 根因修复：rc-menu 对 inline 根级项注入内联 paddingLeft=level×24px（盖过 itemPaddingInline 令牌），致内容右顶+左侧留白、56px 下挤压重叠 */
              selectedKeys={selectedKey ? [selectedKey] : []}
              onClick={({ key }) => navigate(key)}
              items={menuItems}
              style={{ flex: 1, minWidth: 0, borderInlineEnd: 'none', background: 'transparent' }}
            />
          </ConfigProvider>
          <Dropdown menu={avatarMenu} placement="topRight" trigger={['click']}>
            {/* 头像+常驻状态文字（2026-11-20 用户反馈：纯灰点在圆角方形头像角上错位、
                离线态不显眼；文字随状态着色，比单点更清晰饱满） */}
            <Flex vertical align="center" gap={3} title={user?.name ?? '未登录'} style={{ padding: '8px 8px 6px', cursor: 'pointer' }}>
              <PresenceBadge status={myPresence}>
                <Avatar name={user?.name ?? '?'} size={32} />
              </PresenceBadge>
              <span style={{ fontSize: 11, lineHeight: 1, userSelect: 'none', color: presenceColors[myPresence].dot }}>
                {PRESENCE_LABEL[myPresence]}
              </span>
            </Flex>
          </Dropdown>
        </div>
      </Layout.Sider>

      <Layout style={{ flex: 1, minWidth: 0, background: 'transparent' }}>
        <ConnectionBanner />
        <Layout.Content style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
