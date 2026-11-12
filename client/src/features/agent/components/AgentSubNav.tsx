/**
 * Agent 域二级导航（工作台 / 记忆 / 日报 / 插件）：四页共用顶栏。
 * 一级导航（侧边栏 Agent）已有；本栏承载域内路由。
 */

import { NavLink } from 'react-router-dom';
import { Bot, Book, Calendar, Puzzle } from 'lucide-react';

const TABS = [
  { to: '/agent', icon: Bot, label: '工作台' },
  { to: '/agent/memory', icon: Book, label: '记忆' },
  { to: '/agent/reports', icon: Calendar, label: '日报' },
  { to: '/agent/plugins', icon: Puzzle, label: '插件' },
] as const;

export function AgentSubNav() {
  return (
    <nav className="agent-subnav" aria-label="Agent 二级导航">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/agent'}
          className={({ isActive }) => `agent-subnav__item${isActive ? ' agent-subnav__item--active' : ''}`}
        >
          <tab.icon size={14} strokeWidth={1.8} aria-hidden />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
