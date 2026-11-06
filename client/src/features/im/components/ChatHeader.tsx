/**
 * 会话头（D03 §3.2，吸顶 z-100）：
 * 名称+成员数 / 在线状态点（presence.changed 接入点）/ S 档返回 / 详情侧栏开关 / ⋮ 菜单占位。
 */

import { ArrowLeft, Info, MoreHorizontal } from 'lucide-react';
import type { Conversation } from '../model/types';

interface ChatHeaderProps {
  conv: Conversation;
  /** S 档两级导航：返回列表 */
  onBack?: () => void;
  onToggleDetail: () => void;
}

export function ChatHeader({ conv, onBack, onToggleDetail }: ChatHeaderProps) {
  const typeName = conv.type === 1 ? '' : conv.type === 2 ? ` (${conv.memberCount})` : ' · 广播群';

  return (
    <header className="chat-header">
      {onBack ? (
        <button className="icon-btn back-btn" onClick={onBack} title="返回会话列表">
          <ArrowLeft size={18} />
        </button>
      ) : null}
      {/* 在线状态点：presence.changed 订阅接入点（D03 §3.2） */}
      {conv.type === 1 ? <span className="chat-header__presence" title="在线" /> : null}
      <span className="chat-header__title">
        {conv.name}
        {typeName}
      </span>
      <div className="chat-header__actions">
        <button className="icon-btn" onClick={onToggleDetail} title="会话信息">
          <Info size={17} />
        </button>
        {/* TODO：搜索（Cmd+F）/置顶/免打扰/举报（D03 §3.2 ⋮ 菜单） */}
        <button className="icon-btn" title="更多操作">
          <MoreHorizontal size={17} />
        </button>
      </div>
    </header>
  );
}
