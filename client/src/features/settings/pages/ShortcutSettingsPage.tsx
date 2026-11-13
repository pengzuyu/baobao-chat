/**
 * 设置 · 快捷键（D01 §9 总表渲染 / EXECUTION-PLAN D14）：
 * v0.1 =权威速查表（只读，仅列已生效键位）——键位为 D01 §9 全局冻结约定，
 * 自定义键位映射随全局快捷键框架阶段二（当前各组件 onKeyDown 硬编码消费；
 * 框架化后本页开放改键+冲突检测，登记）。
 * D26-O3：速查表→antd Table（键位→Typography.Text keyboard；settings-* 退役）。
 */

import type React from 'react';
import { Card, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

/** D01 §9 权威总表（已生效子集；⌥↑↓ 切会话未实现暂不列） */
const SHORTCUTS: Array<{ keys: string; label: string; scope: string }> = [
  { keys: `${MOD} + K`, label: '全局搜索（跨消息/知识库/联系人）', scope: '全局' },
  { keys: `${MOD} + F`, label: '当前会话内搜索', scope: '会话' },
  { keys: `${MOD} + ,`, label: '打开设置', scope: '全局' },
  { keys: `Esc`, label: '逐层关闭浮层（弹窗→抽屉→搜索）', scope: '全局' },
  { keys: `${MOD} + ⇧ + .`, label: 'Agent 紧急停止（全局生效）', scope: '全局' },
  { keys: `Enter / ⇧+Enter`, label: '发送 / 换行（会话输入框）', scope: '输入框' },
];

const columns: ColumnsType<(typeof SHORTCUTS)[number]> = [
  { title: '键位', dataIndex: 'keys', width: 170, render: (v: string) => <Typography.Text keyboard>{v}</Typography.Text> },
  { title: '作用', dataIndex: 'label' },
  { title: '作用域', dataIndex: 'scope', width: 90 },
];

export function ShortcutSettingsPage() {
  return (
    <div data-testid="settings-shortcuts">
      <Typography.Title level={5} style={{ margin: 0, marginBottom: 16 }}>
        快捷键
      </Typography.Title>

      <Card size="small">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
          以下为 D01 §9 全局冻结键位；自定义改键随全局快捷键框架开放（各组件散落
          onKeyDown 收敛为统一注册表后本页开放改键+冲突检测）。
        </Typography.Paragraph>
        <Table
          rowKey="keys"
          size="small"
          columns={columns}
          dataSource={SHORTCUTS}
          pagination={false}
          data-testid="shortcut-table"
          onRow={() => ({ 'data-testid': 'shortcut-row' } as React.HTMLAttributes<HTMLTableRowElement>)}
        />
      </Card>
    </div>
  );
}
