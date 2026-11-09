/**
 * 设置页壳（D01 §4.2 /settings/*）：左侧 tab 栏 + 右侧内容区。
 * S 档 tab 转横向滚动条（global.css 断点处理）；内容页由子路由渲染。
 */

import { NavLink, Outlet } from 'react-router-dom';
import { t, useI18nStore } from '../../../shared/i18n';
import { ArrowDownUp, Bell, Bot, Info, Keyboard, Settings } from 'lucide-react';

function useTabs() {
  useI18nStore((s) => s.locale); // 响应语言切换（E12）
  return [
  { to: '/settings/general', icon: Settings, label: t('settings.tab.general') },
  { to: '/settings/notification', icon: Bell, label: t('settings.tab.notification') },
  { to: '/settings/transfer', icon: ArrowDownUp, label: t('settings.tab.transfer') },
  { to: '/settings/shortcuts', icon: Keyboard, label: t('settings.tab.shortcuts') },
  { to: '/settings/agent', icon: Bot, label: t('settings.tab.agent') },
  { to: '/settings/about', icon: Info, label: t('settings.tab.about') },
  ] as const;
}

export function SettingsLayout() {
  const tabs = useTabs();
  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <div className="settings-nav__title">设置</div>
        <nav className="settings-nav__list">
          {tabs.map((tab) => (
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
