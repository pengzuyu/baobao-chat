/**
 * 管理台壳（D10 阶段一务实版，路由 /admin/*）：
 * - 左侧二级导航：仪表盘/组织用户/角色/公告/Agent/知识库/策略/用量/审计
 *   （2026-11-18 批量导入收编组织用户页弹窗，「批量导入」独立菜单退役）
 * - 内容区 <Outlet/>；一级"管理"入口显隐由 MainLayout 按 me.perms admin:* 判定
 * - 阶段一无 perm.changed 实时显隐/二次验证票据条（取舍登记，见 D10 §3.0 裁剪）
 * D26-O2 补充：导航换 antd Menu（原 settings-nav 自研样式退役）；布局内联化。
 */

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu } from 'antd';
import type { MenuProps } from 'antd';
import {
  BookOpen,
  Bot,
  CalendarDays,
  Download,
  Gauge,
  KeyRound,
  Megaphone,
  Network,
  Puzzle,
  ScrollText,
  ShieldCheck,
  SmilePlus,
  Sparkles,
  UserCog,
  Zap,
} from 'lucide-react';
import { ErrorBoundary } from '../../../shared/ui/ErrorBoundary';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useBreakpoint } from '../../../shared/utils/useBreakpoint';

const TABS = [
  { to: '/admin', icon: Gauge, label: '仪表盘', end: true },
  // 2026-11-12 用户裁决：用户+组织合并为「组织用户」通讯录页（组织树上直接开人）
  { to: '/admin/org', icon: Network, label: '组织用户' },
  { to: '/admin/roles', icon: UserCog, label: '角色' },
  { to: '/admin/notices', icon: Megaphone, label: '公告' },
  { to: '/admin/calendar', icon: CalendarDays, label: '工作日日历' },
  { to: '/admin/agent', icon: Bot, label: 'Agent' },
  { to: '/admin/kb', icon: BookOpen, label: '知识库' },
  { to: '/admin/ai-providers', icon: Sparkles, label: 'AI 供应商' },
  { to: '/admin/policies', icon: ShieldCheck, label: '策略' },
  { to: '/admin/stickers', icon: SmilePlus, label: '表情集' },
  { to: '/admin/client-releases', icon: Download, label: '客户端发布' },
  { to: '/admin/oidc-clients', icon: KeyRound, label: '登录接入' },
  { to: '/admin/skills', icon: Sparkles, label: '技能包' },
  { to: '/admin/plugins', icon: Puzzle, label: '插件' },
  { to: '/admin/usage', icon: Zap, label: '用量' },
  { to: '/admin/audit', icon: ScrollText, label: '审计' },
] as const;

export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  // 左栏拖拽调宽（S 档导航转横条不参与——内联宽度会击穿 width:100% 媒体规则）
  const navSplit = useSplitWidth('admin-nav', 208, 170, 300);
  const bp = useBreakpoint();
  const navResizable = bp !== 'S';

  const items: MenuProps['items'] = TABS.map((tab) => ({
    key: tab.to,
    icon: <tab.icon size={15} strokeWidth={1.8} />,
    label: tab.label,
  }));
  const selectedKey =
    [...TABS]
      .filter((t) => (location.pathname + '/').startsWith(t.to + '/') || ('end' in t && t.end && location.pathname === t.to))
      .sort((a, b) => b.to.length - a.to.length)[0]?.to ?? '/admin';

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
      {navResizable ? (
        /* 二级导航自滚动（2026-11-23 真机）：管理项已有 16 个，一多就溢出到页面外
           （height:100% 的祖先不裁它，整页被撑高）；minHeight:0 让列高可被压到窗口内，
           overflowY:auto 让菜单在这列里滚 */
        <div ref={navSplit.paneRef} style={{ width: navSplit.width, flexShrink: 0, minHeight: 0, overflowY: 'auto' }}>
          <Menu
            mode="inline"
            style={{ width: '100%' }}
            items={items}
            selectedKeys={[selectedKey]}
            onClick={(e) => navigate(e.key)}
          />
        </div>
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
