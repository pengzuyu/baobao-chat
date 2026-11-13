/**
 * 主窗布局（D01 §4/§5.1）：
 * - 左侧 56px 图标导航栏（品牌 Logo + 消息/通知/知识库/邮件/Agent/管理 + 头像菜单；专家/应用入口 2026-11-12 起暂时隐藏）
 * - 顶部连接状态横幅（六态 offline/degraded 全局落点，D01 §7）
 * - 内容区 <Outlet/>：路由切换不销毁 IM 的 WSS 连接与未读状态
 */

import { useEffect, useMemo } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Dropdown, type MenuProps } from 'antd';
import { Bell, Bot, BookUser, BrainCircuit, Gauge, Mail, MessageCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthStore } from '../features/auth/store/auth';
import { useImStore } from '../features/im/store/im';
import { useImWsEvents } from '../features/im/store/wsEvents';
import { useUnreadNotificationCount } from '../features/im/api/hooks';
import { useConnectionStore } from '../shared/store/connection';
import { useThemeStore, type ThemeMode } from '../shared/store/theme';
import { t, useI18nStore } from '../shared/i18n';
import { Logo } from '../shared/ui/Logo';
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

/** 连接横幅：connecting 蓝 / offline 红 / degraded 黄 */
function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);
  const attempt = useConnectionStore((s) => s.reconnectAttempt);
  const degradedText = useConnectionStore((s) => s.degradedText);

  if (degradedText) {
    return <div className="conn-banner conn-banner--degraded">{degradedText}</div>;
  }
  if (status === 'connecting') {
    return <div className="conn-banner conn-banner--connecting">连接中…</div>;
  }
  if (status === 'offline') {
    return <div className="conn-banner conn-banner--offline">已离线，正在重连…（第 {attempt + 1} 次）</div>;
  }
  return null;
}

export function MainLayout() {
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

  const avatarMenu: MenuProps = {
    items: [
      { key: 'profile', label: `在线状态：在线（${user?.name ?? '-'}）`, disabled: true },
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
      { key: 'settings', label: '设置' },
      { key: 'about', label: '关于' },
      { type: 'divider' },
      { key: 'logout', label: '退出登录', danger: true },
    ],
    onClick: ({ key }) => {
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

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <div className="nav-rail__logo" title="BaobaoWork">
          <Logo size={26} />
        </div>
        <div className="nav-rail__divider" />
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-rail__item${isActive ? ' nav-rail__item--active' : ''}`} title={item.label}>
            <item.icon size={19} strokeWidth={1.8} />
            {/* 图标下文字（2026-11-13 用户反馈：纯图标不可辨识） */}
            <span className="nav-rail__label">{item.label}</span>
            {/* 消息项未读总数徽标 */}
            {item.to === '/im' && totalUnread > 0 ? <span className="nav-rail__badge">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
            {/* 通知中心未读徽标（99+ 封顶同规则） */}
            {item.to === '/notifications' && (notifUnread.data ?? 0) > 0 ? (
              <span className="nav-rail__badge">{(notifUnread.data ?? 0) > 99 ? '99+' : notifUnread.data}</span>
            ) : null}
          </NavLink>
        ))}
        {/* 管理入口：仅 admin:* 权限可见（perm.changed 动态显隐，D01 §4.1） */}
        {isAdmin ? (
          <NavLink to="/admin" className={({ isActive }) => `nav-rail__item${isActive ? ' nav-rail__item--active' : ''}`} title="管理">
            <Gauge size={19} strokeWidth={1.8} />
            <span className="nav-rail__label">管理</span>
          </NavLink>
        ) : null}
        <div className="nav-rail__spacer" />
        <Dropdown menu={avatarMenu} placement="topRight" trigger={['click']}>
          <button className="nav-rail__avatar" title={user?.name ?? '未登录'}>
            {(user?.name ?? '?').slice(0, 1)}
          </button>
        </Dropdown>
      </nav>

      <div className="main-area">
        <ConnectionBanner />
        <div className="route-content">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
