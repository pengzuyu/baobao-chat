/**
 * 详情侧栏（D03 §3.5 PIM-05 入口）：
 * 骨架阶段展示会话元信息；群管理四 tab（信息/成员/设置/公告）后续阶段实现。
 * 形态：XL 常驻 304px；L/M 浮层化（滑出+遮罩）；S 全屏页（D01 §5.2）。
 */

import { Hash, ScrollText, Tag, Users, X } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import type { Conversation } from '../model/types';

interface ConvInfoSidebarProps {
  conv: Conversation;
  onClose?: () => void;
}

export function ConvInfoSidebar({ conv, onClose }: ConvInfoSidebarProps) {
  const typeLabel = conv.type === 1 ? '单聊' : conv.type === 2 ? '群聊' : '广播群';
  return (
    <aside className="detail-panel">
      <div className="detail-panel__head">
        <strong className="detail-panel__title">{conv.name}</strong>
        {onClose ? (
          <button className="icon-btn" onClick={onClose} title="收起">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <div className="detail-panel__profile">
        <Avatar name={conv.name} size={64} group={conv.type === 3 ? 'broadcast' : conv.type === 2 ? 'group' : null} />
        <span className="detail-panel__type-badge">{typeLabel}</span>
      </div>

      <div className="detail-panel__cards">
        <div className="detail-panel__card">
          <div className="detail-panel__kv">
            <span className="detail-panel__key">
              <Tag size={14} /> 类型
            </span>
            <span>{typeLabel}</span>
          </div>
          <div className="detail-panel__kv">
            <span className="detail-panel__key">
              <Users size={14} /> 成员数
            </span>
            <span>{conv.memberCount}</span>
          </div>
          <div className="detail-panel__kv">
            <span className="detail-panel__key">
              <Hash size={14} /> 最新 seq
            </span>
            <span>{conv.latestSeq}</span>
          </div>
          <div className="detail-panel__kv">
            <span className="detail-panel__key">
              <ScrollText size={14} /> 状态
            </span>
            <span className={`status-badge ${conv.status === 1 ? 'status-badge--ok' : 'status-badge--off'}`}>
              {conv.status === 1 ? '活跃' : '已解散（只读）'}
            </span>
          </div>
        </div>
        {/* TODO(PIM-05)：信息/成员/设置/公告 四 tab；退群/转让/解散（危险确认，D01 §8） */}
        <div className="detail-panel__todo">群管理（信息 / 成员 / 设置 / 公告）在后续阶段实现</div>
      </div>
    </aside>
  );
}
