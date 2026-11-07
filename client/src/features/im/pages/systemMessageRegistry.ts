/**
 * PIM-12 系统消息样式注册表（D03 §3.12）：
 * 服务端下发占位消息（type=system，body={kind, actor, target, group, extra, ...}），
 * 端内按 kind 套中文文案模板；统一样式居中弱化（MessageBubble）。
 */

import type { SystemBody } from '../model/types';

/** 时间格式化（禁言截止展示）：M 月 d 日 HH:mm / 今日 HH:mm */
export function formatMuteUntil(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

/** 按 kind 套模板（14 个 kind 全表；未知 kind 回退通用文案，前向兼容） */
export function systemMessageText(body: SystemBody): string {
  const actor = body.actor_name || body.actor || '有人';
  const target = body.target_name || body.target || '成员';
  switch (body.kind) {
    case 'group.created':
      return `${actor} 创建了群聊`;
    case 'member.joined':
      return body.join_by_apply ? `${target} 通过申请加入` : `${actor} 邀请 ${target} 加入群聊`;
    case 'member.quit':
      return `${actor} 退出了群聊`;
    case 'member.removed':
      return `${target} 被 ${actor} 移出群聊`;
    case 'member.role.changed':
      return body.extra === 'admin' ? `${target} 被 ${actor} 设为管理员` : `${target} 被 ${actor} 取消管理员`;
    case 'owner.transferred':
      return `${actor} 将群主转让给 ${target}`;
    case 'member.muted':
      return `${target} 被 ${actor} 禁言至 ${body.until ? formatMuteUntil(body.until) : '稍后'}`;
    case 'member.unmuted':
      return `${target} 被 ${actor} 解除禁言`;
    case 'mute.all.on':
      return `${actor} 开启了全员禁言${body.until ? `（至 ${formatMuteUntil(body.until)}）` : ''}`;
    case 'mute.all.off':
      return `${actor} 解除了全员禁言`;
    case 'announcement.changed':
      return `${actor} 修改了群公告`;
    case 'conv.dissolved':
      return `${actor} 解散了该群聊`;
    case 'msg.recalled':
      return `${actor} 撤回了一条消息`;
    case 'apply.submitted':
      return `${actor} 申请加入群聊${body.extra ? `：${body.extra}` : ''}`;
    case 'broadcast.published':
      return `${actor} 发布了新公告`;
    default:
      return '群通知';
  }
}
