/**
 * 门控弹层（2026-11-25 用户口径：审批/提问不再内嵌输出流，浮于输入框上方弹出，
 * 流中只保留落定结果）：渲染当前会话全部未决 permission/clarify 条目。
 * - 悬浮卡：absolute 吸流区底部（=输入框正上方）+ 阴影浮起；多项纵向堆叠（常态 1 项）
 * - 底部保持（不遮挡）：宿主页 RO 测本层高度垫高流内容层 padding——吸底口径下
 *   最新输出顶到弹层上方可见，padding 变化经既有内容层 RO 自然触发跟底
 * - 控件复用：PermissionControls（审批）/ ClarifyForm（提问），与旧内嵌态同款
 * - IM 聊天页形态不同（antd Modal 居中，EmbeddedAgentSync），不经本组件
 */

import { type Ref } from 'react';
import { theme } from 'antd';
import type { StreamItem } from '../store/agent';
import { PermissionControls, type PermissionDecision } from './PermissionCard';
import { ClarifyForm, type ClarifySubmit } from './ClarifyCard';

type PermItem = Extract<StreamItem, { kind: 'permission' }>;
type ClarifyItem = Extract<StreamItem, { kind: 'clarify' }>;

export type GateItem = PermItem | ClarifyItem;

export interface GateDockProps {
  /** 未决门控条目（宿主页筛 outcome===null / answer===null 传入；顺序渲染） */
  items: GateItem[];
  onRespond: (d: PermissionDecision) => void;
  onClarify: (questionId: string, s: ClarifySubmit) => void;
  /** 宿主页 RO 测高挂点（垫流 padding 用）；条目空时本组件渲染 null（高度归零） */
  dockRef?: Ref<HTMLDivElement>;
}

export function GateDock({ items, onRespond, onClarify, dockRef }: GateDockProps) {
  const { token } = theme.useToken();
  if (items.length === 0) return null;
  return (
    <div
      ref={dockRef}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        zIndex: 20,
        pointerEvents: 'none',
      }}
    >
      {items.map((it) => (
        <div
          key={it.key}
          style={{
            pointerEvents: 'auto',
            width: 'min(680px, calc(100% - 16px))',
            borderRadius: 10,
            border: `1px solid ${it.kind === 'permission' ? token.colorWarningBorder : token.colorPrimaryBorder}`,
            background: token.colorBgContainer,
            boxShadow: token.boxShadowSecondary,
            overflow: 'hidden',
          }}
        >
          {it.kind === 'permission' ? (
            <div style={{ padding: 14 }}>
              <PermissionControls item={it} onRespond={onRespond} />
            </div>
          ) : (
            <div style={{ padding: 14 }}>
              <ClarifyForm
                question={it.request.question}
                header={it.request.header}
                options={it.request.options}
                multiSelect={it.request.multiSelect}
                onSubmit={(s) => onClarify(it.request.questionId, s)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
