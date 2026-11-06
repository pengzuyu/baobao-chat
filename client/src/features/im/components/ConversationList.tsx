/**
 * 会话列表（D03 §3.1 B 区）：
 * 置顶区（≤30，last_msg_ts↓）→ 普通区（last_msg_ts↓）；
 * 列表项 64px：头像/名称/时间/类型化摘要/未读徽标（99+）/免打扰小圆点/草稿前缀。
 * 右键菜单：置顶/取消置顶、免打扰开关（INT-IM-07）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BellOff, Pin } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { formatListTime } from '../../../shared/utils/time';
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
  const unread = conv.my?.unreadBadge ?? 0;
  const mute = conv.my?.mute ?? false;
  const draft = conv.my?.draft ?? '';
  const pinned = conv.my?.pinned ?? false;

  const cls = [
    'conv-item',
    active ? 'conv-item--active' : '',
    pinned && !active ? 'conv-item--pinned' : '',
    conv.status === 2 ? 'conv-item--dissolved' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onClick={() => onSelect(conv.id)}
      onContextMenu={(e) => onContextMenu(e, conv.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(conv.id)}
    >
      <Avatar name={conv.name} size={40} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
      <div className="conv-item__main">
        <div className="conv-item__row">
          <span className="conv-item__name">
            {pinned ? (
              <Pin size={12} className="conv-item__pin" aria-label="置顶" />
            ) : null}
            {mute ? <BellOff size={12} className="conv-item__mute-icon" aria-label="免打扰" /> : null}
            {conv.type === 1 ? conv.name : `${conv.name} (${conv.memberCount})`}
          </span>
          <span className="conv-item__time">{conv.lastMsgTs ? formatListTime(conv.lastMsgTs) : ''}</span>
        </div>
        <div className="conv-item__row">
          <span className="conv-item__digest">
            {/* 草稿优先显示，红色"草稿"前缀（INT-IM-10） */}
            {draft ? <span className="conv-item__draft-tag">[草稿]</span> : null}
            {draft || conv.lastMsgDigest || ''}
          </span>
          {/* 免打扰降级小圆点，否则数字徽标 99+ 封顶 */}
          {unread > 0 ? mute ? <span className="conv-item__dot" /> : <span className="conv-item__badge">{unread > 99 ? '99+' : unread}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ConversationList({ convs, activeId, onSelect, onTogglePin, onToggleMute }: ConversationListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="im-list-col__body">
      {sorted.map((conv) => (
        <ConvItem
          key={conv.id}
          conv={conv}
          active={conv.id === activeId}
          onSelect={onSelect}
          onContextMenu={(e, convId) => {
            e.preventDefault();
            setMenu({ convId, x: e.clientX, y: e.clientY });
          }}
        />
      ))}
      {menu && menuConv ? (
        <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="ctx-menu__item"
            onClick={() => {
              onTogglePin(menu.convId);
              setMenu(null);
            }}
          >
            <Pin size={14} />
            {menuConv.my?.pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            onClick={() => {
              onToggleMute(menu.convId);
              setMenu(null);
            }}
          >
            <BellOff size={14} />
            {menuConv.my?.mute ? '开启提醒' : '免打扰'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
