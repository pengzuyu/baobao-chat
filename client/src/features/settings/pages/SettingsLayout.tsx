/**
 * 设置页壳（D01 §4.2 /settings/*）：左侧 tab 栏 + 右侧内容区。
 * S 档 tab 转横向滚动条（global.css 断点处理）；内容页由子路由渲染。
 */

import { NavLink, Outlet } from 'react-router-dom';
import { ArrowDownUp, Bell, Bot, Info, Settings } from 'lucide-react';

const TABS = [
  { to: '/settings/general', icon: Settings, label: '通用' },
  { to: '/settings/notification', icon: Bell, label: '通知' },
  { to: '/settings/transfer', icon: ArrowDownUp, label: '传输' },
  { to: '/settings/agent', icon: Bot, label: 'Agent' },
  { to: '/settings/about', icon: Info, label: '关于' },
] as const;

export function SettingsLayout() {
  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <div className="settings-nav__title">设置</div>
        <nav className="settings-nav__list">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) => `settings-nav__item${isActive ? ' settings-nav__item--active' : ''}`}
            >
              <tab.icon size={16} strokeWidth={1.8} />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="settings-body">
        <Outlet />
      </div>
    </div>
  );
}
