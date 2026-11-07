/**
 * 会话头（D03 §3.2，吸顶 z-100）：
 * 名称+成员数 / 在线状态点（presence.changed 接入点）/ S 档返回 / [通话▾]（D04 INT-RTC-01，
 * 单聊 only：语音/视频入口经 bus im:invoke-call 转发 rtc 域）/ 详情侧栏开关 / ⋮ 菜单占位。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Info, MoreHorizontal, Phone, Video } from 'lucide-react';
import { emit } from '../../../shared/bus';
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
  // [通话▾] 菜单开合（点击外部收起）
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!callMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCallMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [callMenuOpen]);

  /** 发起通话（单聊 only；群通话入口待阶段二，D04 INT-RTC-02 登记） */
  const startCall = (video: boolean) => {
    setCallMenuOpen(false);
    emit('im:invoke-call', { convId: conv.id, video });
  };

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
        {/* 通话入口（D04 INT-RTC-01：单聊 only；403 rtc:call:start 权限点 v0.1 缺省放行，登记） */}
        {conv.type === 1 && conv.status === 1 ? (
          <div className="chat-header__call" ref={menuRef}>
            <button
              className="icon-btn"
              data-testid="call-entry"
              title="通话"
              onClick={() => setCallMenuOpen((v) => !v)}
            >
              <Phone size={17} />
            </button>
            {callMenuOpen ? (
              <div className="chat-header__call-menu" data-testid="call-menu">
                <button type="button" onClick={() => startCall(false)} data-testid="call-menu-audio">
                  <Phone size={15} /> 语音通话
                </button>
                <button type="button" onClick={() => startCall(true)} data-testid="call-menu-video">
                  <Video size={15} /> 视频通话
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
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
