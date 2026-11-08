/**
 * 主窗布局（D01 §4/§5.1）：
 * - 左侧 56px 图标导航栏（品牌 Logo + 消息/通话/文档/知识库/Agent/管理 + 头像菜单）
 * - 顶部连接状态横幅（六态 offline/degraded 全局落点，D01 §7）
 * - 内容区 <Outlet/>：路由切换不销毁 IM 的 WSS 连接与未读状态
 */

import { useMemo } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Dropdown, type MenuProps } from 'antd';
import { Bot, BrainCircuit, FileText, Gauge, MessageCircle, Phone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuthStore } from '../features/auth/store/auth';
import { useImStore } from '../features/im/store/im';
import { useImWsEvents } from '../features/im/store/wsEvents';
import { useConnectionStore } from '../shared/store/connection';
import { useThemeStore, type ThemeMode } from '../shared/store/theme';
import { Logo } from '../shared/ui/Logo';

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
}

/** 一级导航（D01 §4.1；管理项按权限动态显隐） */
const NAV_ITEMS: NavItem[] = [
  { to: '/im', icon: MessageCircle, label: '消息' },
  { to: '/rtc', icon: Phone, label: '通话' },
  { to: '/doc', icon: FileText, label: '文档' },
  { to: '/kb', icon: BrainCircuit, label: '知识库' },
  { to: '/agent', icon: Bot, label: 'Agent' },
];

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
  const navigate = useNavigate();
  // IM WS 事件常驻绑定：任意页面实时入流 + 未读徽标（订阅随主布局，D01 §4.2）
  useImWsEvents();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  // 总未读徽标：来自 IM store（99+ 封顶，D01 §8 红点规则）
  const totalUnread = useImStore((s) => s.convs.reduce((sum, c) => sum + (c.my?.unreadBadge ?? 0), 0));
  const isAdmin = useMemo(() => (user?.perms ?? []).some((p) => p.startsWith('admin')), [user]);

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
      { key: 'lock', label: '锁屏' },
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
      // TODO：锁屏（cred_lock_screen 等经 Tauri IPC）
    },
  };

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <div className="nav-rail__logo" title="BaobaoWork">
          <Logo size={30} />
        </div>
        <div className="nav-rail__divider" />
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-rail__item${isActive ? ' nav-rail__item--active' : ''}`} title={item.label}>
            <item.icon size={20} strokeWidth={1.8} />
            {/* 消息项未读总数徽标 */}
            {item.to === '/im' && totalUnread > 0 ? <span className="nav-rail__badge">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
          </NavLink>
        ))}
        {/* 管理入口：仅 admin:* 权限可见（perm.changed 动态显隐，D01 §4.1） */}
        {isAdmin ? (
          <NavLink to="/admin" className={({ isActive }) => `nav-rail__item${isActive ? ' nav-rail__item--active' : ''}`} title="管理">
            <Gauge size={20} strokeWidth={1.8} />
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
          <Outlet />
        </div>
      </div>
    </div>
  );
}
