/**
 * 会话头（D03 §3.2，吸顶 z-100）：
 * 名称+成员数 / 在线状态点（presence.changed 接入点）/ S 档返回 / 详情侧栏开关 / ⋮ 菜单占位。
 * （通话入口随 rtc 域 2026-11 产品瘦身移除）
 * D26 antd 换装：Flex+Typography+shared Button（icon-btn/chat-header-* 自研类退役）。
 */

import { ArrowLeft, Bot, Info, MoreHorizontal } from 'lucide-react';
import { Flex, Typography, theme } from 'antd';
import { Button } from '../../../shared/ui/Button';
import type { Conversation } from '../model/types';

interface ChatHeaderProps {
  conv: Conversation;
  /** 对端在线状态（单聊在线点；D03 §5.3——away/dnd 黄点、其余灰/无） */
  peerStatus?: string;
  /** 副标题：正在输入…（INT-IM-11 TTL 5s，超时回退空） */
  typing?: string;
  /** S 档两级导航：返回列表 */
  onBack?: () => void;
  /** 打开本会话的 Agent 工作台会话（2026-11-11：无 embedded 会话则新建后跳转） */
  onOpenAgent?: () => void;
  onToggleDetail: () => void;
}

export function ChatHeader({ conv, typing, peerStatus, onBack, onOpenAgent, onToggleDetail }: ChatHeaderProps) {
  const { token } = theme.useToken();
  const typeName = conv.type === 1 ? '' : conv.type === 2 ? ` (${conv.memberCount})` : ' · 广播群';

  return (
    <Flex
      component="header"
      align="center"
      gap={8}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 'var(--bbc-z-sticky)',
        flexShrink: 0,
        height: 52,
        padding: '0 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
      }}
    >
      {onBack ? (
        <Button variant="text" size="small" icon={<ArrowLeft size={18} />} onClick={onBack} title="返回会话列表" aria-label="返回会话列表" />
      ) : null}
      {/* 在线状态点（D03 §3.2：online 绿/away·dnd 黄/offline 不亮） */}
      {conv.type === 1 && peerStatus === 'online' ? (
        <span
          title="在线"
          style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorSuccess, boxShadow: `0 0 0 2px ${token.colorSuccessBg}`, flexShrink: 0 }}
        />
      ) : conv.type === 1 && (peerStatus === 'away' || peerStatus === 'dnd') ? (
        <span
          title={peerStatus === 'dnd' ? '请勿打扰' : '离开'}
          style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorWarning, boxShadow: `0 0 0 2px ${token.colorWarningBg}`, flexShrink: 0 }}
        />
      ) : null}
      <Flex align="baseline" gap={8} style={{ minWidth: 0 }}>
        <Typography.Text strong ellipsis style={{ fontSize: 16, minWidth: 0 }} title={conv.name}>
          {conv.name}
          {typeName}
        </Typography.Text>
        {typing ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {typing}
          </Typography.Text>
        ) : null}
      </Flex>
      <Flex align="center" gap={4} style={{ marginLeft: 'auto' }}>
        {onOpenAgent ? (
          <Button variant="text" size="small" icon={<Bot size={17} />} onClick={onOpenAgent} title="打开本会话的 Agent 工作台会话" />
        ) : null}
        <Button variant="text" size="small" icon={<Info size={17} />} onClick={onToggleDetail} title="会话信息" />
        {/* TODO：搜索（Cmd+F）/置顶/免打扰/举报（D03 §3.2 ⋮ 菜单） */}
        <Button variant="text" size="small" icon={<MoreHorizontal size={17} />} title="更多操作" />
      </Flex>
    </Flex>
  );
}
