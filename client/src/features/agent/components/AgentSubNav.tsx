/**
 * Agent 域二级导航（工作台 / 日报 / 插件）：三页共用顶栏。
 * 一级导航（侧边栏 Agent）已有；本栏承载域内路由。
 * D26-O4：换 antd Menu horizontal（原 agent-subnav 自研样式退役；写法对齐 SettingsLayout/AdminLayout）。
 * 记忆页已退役（记忆由平台后台组织，不做用户浏览面）。
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
import { Bot, Calendar, Puzzle } from 'lucide-react';

const TABS = [
  { to: '/agent', icon: Bot, label: '工作台' },
  { to: '/agent/reports', icon: Calendar, label: '日报' },
  { to: '/agent/plugins', icon: Puzzle, label: '插件' },
] as const;

export function AgentSubNav() {
  const location = useLocation();
  const navigate = useNavigate();

  const items: MenuProps['items'] = TABS.map((tab) => ({
    key: tab.to,
    icon: <tab.icon size={14} strokeWidth={1.8} aria-hidden />,
    label: tab.label,
  }));
  // /agent 精确匹配（end 语义）；其余前缀匹配（最长优先——工作台会话路由 /agent/s/* 仍属工作台）
  const selectedKey =
    [...TABS]
      .filter((t) => location.pathname === t.to || (location.pathname + '/').startsWith(t.to + '/'))
      .sort((a, b) => b.to.length - a.to.length)[0]?.to ?? '/agent';

  return (
    <Menu
      mode="horizontal"
      style={{ flexShrink: 0, paddingLeft: 12 }}
      items={items}
      selectedKeys={[selectedKey]}
      onClick={(e) => navigate(e.key)}
      aria-label="Agent 二级导航"
    />
  );
}
