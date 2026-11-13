/**
 * 设置页壳（D01 §4.2 /settings/*）：左侧 tab 栏 + 右侧内容区。
 * S 档 tab 转横向滚动条（global.css 断点处理）；内容页由子路由渲染。
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { t, useI18nStore } from '../../../shared/i18n';
import { ArrowDownUp, Bell, Bot, Info, Keyboard, Plug, Settings } from 'lucide-react';
import { ErrorBoundary } from '../../../shared/ui/ErrorBoundary';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';

function useTabs() {
  useI18nStore((s) => s.locale); // 响应语言切换（E12）
  return [
  { to: '/settings/general', icon: Settings, label: t('settings.tab.general') },
  { to: '/settings/notification', icon: Bell, label: t('settings.tab.notification') },
  { to: '/settings/transfer', icon: ArrowDownUp, label: t('settings.tab.transfer') },
  { to: '/settings/shortcuts', icon: Keyboard, label: t('settings.tab.shortcuts') },
  { to: '/settings/agent', icon: Bot, label: t('settings.tab.agent') },
  { to: '/settings/mcp', icon: Plug, label: t('settings.tab.mcp') },
  { to: '/settings/about', icon: Info, label: t('settings.tab.about') },
  ] as const;
}

export function SettingsLayout() {
  const tabs = useTabs();
  const location = useLocation();
  // 左栏拖拽调宽（S 档导航转横条不参与——内联宽度会击穿 width:100% 媒体规则）
  const navSplit = useSplitWidth('settings-nav', 208, 170, 300);
  const bp = useBreakpoint();
  const navResizable = bp !== 'S';
  return (
    <div className="settings-page">
      <aside className="settings-nav" style={navResizable ? { width: navSplit.width } : undefined}>
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
      {navResizable ? <SplitHandle bind={navSplit.bind} /> : null}
      <div className="settings-body">
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}
