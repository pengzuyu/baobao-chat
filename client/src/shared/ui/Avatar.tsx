/**
 * 设计基元：多彩字母头像（哑组件）。
 * 名字 djb2 hash → 10 色企业系色板稳定取色；群聊/广播群显示图标底。
 * 形态遵循飞书式 8px 圆角方形（会话 40 / 消息 32 / 详情大号 64）。
 */

import { Megaphone, Users } from 'lucide-react';

/** 色板：饱和度对企业场景、白字对比可用（亮暗主题通用） */
const PALETTE = [
  '#2e6be6',
  '#0ea5e9',
  '#14b8a6',
  '#23a55b',
  '#8b5cf6',
  '#a855f7',
  '#ec4899',
  '#e5484d',
  '#f0872c',
  '#5e7ce0',
] as const;

/** djb2：同名稳定取色，异名尽量分散 */
function hashName(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h;
}

export type AvatarSize = 24 | 32 | 40 | 64;
export type AvatarGroup = 'group' | 'broadcast';

interface AvatarProps {
  name: string;
  size?: AvatarSize;
  /** group=群聊图标底；broadcast=广播群（橙底喇叭，飞书式警示感） */
  group?: AvatarGroup | null;
  className?: string;
}

export function Avatar({ name, size = 40, group = null, className }: AvatarProps) {
  const color = group === 'broadcast' ? '#f0872c' : PALETTE[hashName(name) % PALETTE.length];
  const iconSize = Math.round(size * 0.5);

  return (
    <div
      className={className ? `bbw-avatar ${className}` : 'bbw-avatar'}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.38), borderRadius: size >= 64 ? 12 : 8 }}
      aria-hidden
    >
      {group === 'group' ? (
        <Users size={iconSize} strokeWidth={2} />
      ) : group === 'broadcast' ? (
        <Megaphone size={iconSize} strokeWidth={2} />
      ) : (
        name.slice(0, 1)
      )}
    </div>
  );
}
