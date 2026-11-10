/**
 * 会话头（D03 §3.2，吸顶 z-100）：
 * 名称+成员数 / 在线状态点（presence.changed 接入点）/ S 档返回 / 详情侧栏开关 / ⋮ 菜单占位。
 * （通话入口随 rtc 域 2026-11 产品瘦身移除）
 */

import { ArrowLeft, Info, MoreHorizontal } from 'lucide-react';
import type { Conversation } from '../model/types';

interface ChatHeaderProps {
  conv: Conversation;
  /** 对端在线状态（单聊在线点；D03 §5.3——away/dnd 黄点、其余灰/无） */
  peerStatus?: string;
  /** 副标题：正在输入…（INT-IM-11 TTL 5s，超时回退空） */
  typing?: string;
  /** S 档两级导航：返回列表 */
  onBack?: () => void;
  onToggleDetail: () => void;
}

export function ChatHeader({ conv, typing, peerStatus, onBack, onToggleDetail }: ChatHeaderProps) {
  const typeName = conv.type === 1 ? '' : conv.type === 2 ? ` (${conv.memberCount})` : ' · 广播群';

  return (
    <header className="chat-header">
      {onBack ? (
        <button className="icon-btn back-btn" onClick={onBack} title="返回会话列表">
          <ArrowLeft size={18} />
        </button>
      ) : null}
      {/* 在线状态点（D03 §3.2：online 绿/away·dnd 黄/offline 不亮） */}
      {conv.type === 1 && peerStatus === 'online' ? (
        <span className="chat-header__presence" title="在线" />
      ) : conv.type === 1 && (peerStatus === 'away' || peerStatus === 'dnd') ? (
        <span className="chat-header__presence chat-header__presence--busy" title={peerStatus === 'dnd' ? '请勿打扰' : '离开'} />
      ) : null}
      <span className="chat-header__title">
        {conv.name}
        {typeName}
        {typing ? <span className="chat-header__typing">{typing}</span> : null}
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
