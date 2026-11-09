/**
 * 管理台壳（D10 阶段一务实版，路由 /admin/*）：
 * - 左侧二级导航（复用 settings-nav 样式骨架）：仪表盘/用户/批量导入/角色/组织/公告/Agent/知识库/策略/用量/审计
 * - 内容区 <Outlet/>；一级"管理"入口显隐由 MainLayout 按 me.perms admin:* 判定
 * - 阶段一无 perm.changed 实时显隐/二次验证票据条（取舍登记，见 D10 §3.0 裁剪）
 */

import { NavLink, Outlet } from 'react-router-dom';
import { BookOpen, Bot, FileUp, Gauge, Megaphone, Network, ScrollText, ShieldCheck, SmilePlus, UserCog, Users, Zap } from 'lucide-react';

const TABS = [
  { to: '/admin', icon: Gauge, label: '仪表盘', end: true },
  { to: '/admin/users', icon: Users, label: '用户' },
  { to: '/admin/users/import', icon: FileUp, label: '批量导入' },
  { to: '/admin/roles', icon: UserCog, label: '角色' },
  { to: '/admin/org', icon: Network, label: '组织' },
  { to: '/admin/notices', icon: Megaphone, label: '公告' },
  { to: '/admin/agent', icon: Bot, label: 'Agent' },
  { to: '/admin/kb', icon: BookOpen, label: '知识库' },
  { to: '/admin/policies', icon: ShieldCheck, label: '策略' },
  { to: '/admin/stickers', icon: SmilePlus, label: '表情集' },
  { to: '/admin/usage', icon: Zap, label: '用量' },
  { to: '/admin/audit', icon: ScrollText, label: '审计' },
] as const;

export function AdminLayout() {
  return (
    <div className="settings-page admin-page">
      <aside className="settings-nav">
        <div className="settings-nav__title">管理后台</div>
        <nav className="settings-nav__list">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={'end' in tab ? tab.end : false}
              className={({ isActive }) => `settings-nav__item${isActive ? ' settings-nav__item--active' : ''}`}
            >
              <tab.icon size={16} strokeWidth={1.8} />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="settings-body admin-body">
        <Outlet />
      </div>
    </div>
  );
}
