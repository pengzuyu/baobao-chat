/**
 * 会话列表（D03 §3.1 B 区）：
 * 置顶区（≤30，last_msg_ts↓）→ 普通区（last_msg_ts↓）；
 * 列表项 60px：头像/名称/时间/类型化摘要/未读徽标（99+）/免打扰小圆点/草稿前缀。
 * 右键菜单：置顶/取消置顶、免打扰开关（INT-IM-07）。
 * D26 antd 换装：列表体→antd List（行内联 + token：active 主色浅底/置顶灰底/解散灰显/
 * 未读 Badge 99+），右键菜单本体→antd Menu 定点浮层（触发与关闭逻辑保真），
 * conv- 与 ctx-menu 系自研类退役。
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge, List, Menu, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { BellOff, Pin } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { PresenceBadge, toPresenceStatus } from '../../../shared/ui/PresenceDot';
import { formatListTime } from '../../../shared/utils/time';
import { useAuthStore } from '../../auth/store/auth';
import { useImStore } from '../store/im';
import type { Conversation } from '../model/types';

interface ConversationListProps {
  convs: Conversation[];
  activeId: string | null;
  onSelect: (convId: string) => void;
  onTogglePin: (convId: string) => void;
  onToggleMute: (convId: string) => void;
}

interface MenuState {
  convId: string;
  x: number;
  y: number;
}

function ConvItem({
  conv,
  active,
  onSelect,
  onContextMenu,
}: {
  conv: Conversation;
  active: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, convId: string) => void;
}) {
  const { token } = theme.useToken();
  const myUid = useAuthStore((s) => s.user?.uid);
  // 自聊会话（peerUid=自己，2026-11-26）：标题加「（我）」小标识区分备忘录
  const isSelf = conv.type === 1 && !!conv.peerUid && conv.peerUid === myUid;
  // 单聊对端在线状态（peerUid 后端 type=1 下发；群/广播群不挂点）
  const peerStatus = useImStore((s) => (conv.type === 1 && conv.peerUid ? s.presence[conv.peerUid] : undefined));
  const unread = conv.my?.unreadBadge ?? 0;
  const mute = conv.my?.mute ?? false;
  const draft = conv.my?.draft ?? '';
  const pinned = conv.my?.pinned ?? false;

  return (
    <List.Item
      onClick={() => onSelect(conv.id)}
      onContextMenu={(e) => onContextMenu(e, conv.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(conv.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 60,
        margin: '2px 8px',
        padding: '0 12px',
        borderRadius: token.borderRadiusLG,
        cursor: 'pointer',
        /* active 主色浅底 > 置顶灰底 > 无底（飞书式圆角内嵌块） */
        background: active ? token.colorPrimaryBg : pinned ? token.colorFillQuaternary : undefined,
        /* 已解散沉底灰显（INT-IM-09） */
        opacity: conv.status === 2 ? 0.55 : undefined,
      }}
    >
      {conv.type === 1 && conv.peerUid ? (
        <PresenceBadge status={toPresenceStatus(peerStatus)}>
          <Avatar name={conv.name} size={40} />
        </PresenceBadge>
      ) : (
        <Avatar name={conv.name} size={40} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Typography.Text ellipsis style={{ fontSize: 14, minWidth: 0 }}>
            {pinned ? (
              <Pin size={12} aria-label="置顶" style={{ marginRight: 4, verticalAlign: -1, color: token.colorTextQuaternary }} />
            ) : null}
            {mute ? (
              <BellOff size={12} aria-label="免打扰" style={{ marginRight: 2, verticalAlign: -1, color: token.colorTextQuaternary }} />
            ) : null}
            {conv.type === 1 ? (
              <>
                {conv.name}
                {isSelf ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    （我）
                  </Typography.Text>
                ) : null}
              </>
            ) : (
              `${conv.name} (${conv.memberCount})`
            )}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {conv.lastMsgTs ? formatListTime(conv.lastMsgTs) : ''}
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 13, minWidth: 0 }}>
            {/* 草稿优先显示，红色「草稿」前缀（INT-IM-10） */}
            {draft ? <span style={{ color: token.colorError, marginRight: 2 }}>[草稿]</span> : null}
            {draft || conv.lastMsgDigest || ''}
          </Typography.Text>
          {/* 免打扰降级小圆点，否则数字徽标 99+ 封顶 */}
          {unread > 0 ? (
            mute ? (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorError, flexShrink: 0 }} />
            ) : (
              <Badge count={unread} overflowCount={99} size="small" style={{ flexShrink: 0 }} />
            )
          ) : null}
        </div>
      </div>
    </List.Item>
  );
}

export function ConversationList({ convs, activeId, onSelect, onTogglePin, onToggleMute }: ConversationListProps) {
  const { token } = theme.useToken();
  const [menu, setMenu] = useState<MenuState | null>(null);

  // 全局点击/Esc 关闭右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 排序规则 INT-IM-09：置顶区(last_msg_ts↓) > 普通区(last_msg_ts↓)；已解散沉底灰显
  const sorted = useMemo(() => {
    const rank = (c: Conversation) => (c.status === 2 ? 2 : c.my?.pinned ? 0 : 1);
    return [...convs].sort((a, b) => rank(a) - rank(b) || (b.lastMsgTs ?? 0) - (a.lastMsgTs ?? 0));
  }, [convs]);

  const menuConv = menu ? convs.find((c) => c.id === menu.convId) : null;

  // 右键菜单项（INT-IM-07：置顶/免打扰；文案随当前态切换）
  const ctxMenuItems: MenuProps['items'] = [
    { key: 'pin', icon: <Pin size={14} />, label: menuConv?.my?.pinned ? '取消置顶' : '置顶' },
    { key: 'mute', icon: <BellOff size={14} />, label: menuConv?.my?.mute ? '开启提醒' : '免打扰' },
  ];

  const onCtxMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (!menu) return;
    if (key === 'pin') onTogglePin(menu.convId);
    else if (key === 'mute') onToggleMute(menu.convId);
    setMenu(null);
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 0' }}>
      <List
        dataSource={sorted}
        rowKey="id"
        split={false}
        renderItem={(conv) => (
          <ConvItem
            conv={conv}
            active={conv.id === activeId}
            onSelect={onSelect}
            onContextMenu={(e, convId) => {
              e.preventDefault();
              setMenu({ convId, x: e.clientX, y: e.clientY });
            }}
          />
        )}
      />
      {menu && menuConv ? (
        <div
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            zIndex: token.zIndexPopupBase,
            minWidth: 140,
            background: token.colorBgElevated,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
            padding: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Menu selectable={false} mode="vertical" style={{ border: 'none', boxShadow: 'none' }} items={ctxMenuItems} onClick={onCtxMenuClick} />
        </div>
      ) : null}
    </div>
  );
}
