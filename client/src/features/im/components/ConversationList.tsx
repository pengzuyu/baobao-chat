/**
 * 会话列表（D03 §3.1 B 区）：
 * 置顶区（≤30，last_msg_ts↓）→ 普通区（last_msg_ts↓）；
 * 列表项 64px：头像/名称/时间/类型化摘要/未读徽标（99+）/免打扰小圆点/草稿前缀。
 */

import { useMemo } from 'react';
import { Pin } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { formatListTime } from '../../../shared/utils/time';
import type { Conversation } from '../model/types';

interface ConversationListProps {
  convs: Conversation[];
  activeId: string | null;
  onSelect: (convId: string) => void;
}

function ConvItem({ conv, active, onSelect }: { conv: Conversation; active: boolean; onSelect: (id: string) => void }) {
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
    <div className={cls} onClick={() => onSelect(conv.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(conv.id)}>
      <Avatar name={conv.name} size={40} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
      <div className="conv-item__main">
        <div className="conv-item__row">
          <span className="conv-item__name">
            {pinned ? (
              <Pin size={12} className="conv-item__pin" aria-label="置顶" />
            ) : null}
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

export function ConversationList({ convs, activeId, onSelect }: ConversationListProps) {
  // 排序规则 INT-IM-09：置顶区(last_msg_ts↓) > 普通区(last_msg_ts↓)；已解散沉底灰显
  const sorted = useMemo(() => {
    const rank = (c: Conversation) => (c.status === 2 ? 2 : c.my?.pinned ? 0 : 1);
    return [...convs].sort((a, b) => rank(a) - rank(b) || (b.lastMsgTs ?? 0) - (a.lastMsgTs ?? 0));
  }, [convs]);

  return (
    <div className="im-list-col__body">
      {sorted.map((conv) => (
        <ConvItem key={conv.id} conv={conv} active={conv.id === activeId} onSelect={onSelect} />
      ))}
    </div>
  );
}
