/**
 * 设置页壳（D01 §4.2 /settings/*）：左侧二级导航 + 右侧内容区。
 * D26-O3：导航换 antd Menu（原 settings-nav 自研样式退役，写法对齐 AdminLayout）；
 * S 档导航转横条；拖宽仍用 useSplitWidth+SplitHandle；布局内联化。
 */

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
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
  const navigate = useNavigate();
  // 左栏拖拽调宽（S 档导航转横条不参与——内联宽度会击穿横条布局）
  const navSplit = useSplitWidth('settings-nav', 208, 170, 300);
  const bp = useBreakpoint();
  const navResizable = bp !== 'S';

  const items: MenuProps['items'] = tabs.map((tab) => ({
    key: tab.to,
    icon: <tab.icon size={15} strokeWidth={1.8} />,
    label: tab.label,
  }));
  const selectedKey =
    [...tabs]
      .filter((tab) => (location.pathname + '/').startsWith(tab.to + '/'))
      .sort((a, b) => b.to.length - a.to.length)[0]?.to ?? '/settings/general';

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
      {navResizable ? (
        <Menu
          mode="inline"
          style={{ width: navSplit.width, flexShrink: 0 }}
          items={items}
          selectedKeys={[selectedKey]}
          onClick={(e) => navigate(e.key)}
        />
      ) : (
        <Menu mode="horizontal" style={{ flexShrink: 0 }} items={items} selectedKeys={[selectedKey]} onClick={(e) => navigate(e.key)} />
      )}
      {navResizable ? <SplitHandle bind={navSplit.bind} /> : null}
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '16px 20px' }}>
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}
