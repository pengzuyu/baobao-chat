/**
 * 设计基元：在线状态点（presence 域 UI 统一出口）。
 * 四态：online 绿 / away 黄 / dnd 红 / offline 灰（用户拍板 2026-11-17：离线也亮灰点）；
 * 颜色取 antd token（随 D27 主题明暗切换）；数据源 im store presence（快照种子 + 推送增量）。
 */

import type { ReactNode } from 'react';
import { Tag, theme } from 'antd';

export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline';

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: '在线',
  away: '离开',
  dnd: '忙碌',
  offline: '离线',
};

/** 协议态 → 展示态（invisible 服务端已按 offline 广播，端上不会再收到） */
export function toPresenceStatus(s: string | undefined): PresenceStatus {
  return s === 'online' || s === 'away' || s === 'dnd' ? s : 'offline';
}

/** 状态点颜色（dot 本体 + 2px 光环隔离底图，沿 ChatHeader 既有范式） */
export function usePresenceColors(): Record<PresenceStatus, { dot: string; ring: string }> {
  const { token } = theme.useToken();
  return {
    online: { dot: token.colorSuccess, ring: token.colorSuccessBg },
    away: { dot: token.colorWarning, ring: token.colorWarningBg },
    dnd: { dot: token.colorError, ring: token.colorErrorBg },
    offline: { dot: token.colorTextQuaternary, ring: token.colorBgContainer },
  };
}

/** 裸状态点（会话头/菜单项等行内场景） */
export function PresenceDot({ status, size = 8, title }: { status: PresenceStatus; size?: number; title?: string }) {
  const colors = usePresenceColors()[status];
  return (
    <span
      title={title ?? PRESENCE_LABEL[status]}
      style={{ width: size, height: size, borderRadius: '50%', background: colors.dot, boxShadow: `0 0 0 2px ${colors.ring}`, flexShrink: 0 }}
    />
  );
}

/** 头像角标：dot 绝对定位右下角（会话列表/成员行/通讯录叶子共用） */
export function PresenceBadge({ status, dotSize = 10, children }: { status: PresenceStatus; dotSize?: number; children: ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      {children}
      <span style={{ position: 'absolute', right: -2, bottom: -2, display: 'inline-flex', lineHeight: 0 }}>
        <PresenceDot status={status} size={dotSize} />
      </span>
    </span>
  );
}

/** 状态文字 Tag（档案页等明示场景；antd 预设色） */
export function PresenceTag({ status }: { status: PresenceStatus }) {
  const color = status === 'online' ? 'success' : status === 'away' ? 'gold' : status === 'dnd' ? 'error' : 'default';
  return (
    <Tag color={color} style={{ marginInlineEnd: 0 }}>
      {PRESENCE_LABEL[status]}
    </Tag>
  );
}
