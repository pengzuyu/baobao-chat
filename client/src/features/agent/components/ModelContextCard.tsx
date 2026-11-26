/**
 * Agent「模型上下文上限（本地）」（D36；2026-11-25 随 Agent 设置页自设置域迁入 agent 工作台域）：
 * - 用于输入框状态条计算上下文占比；**只存本机 localStorage，不落服务端**
 * - 内置预设覆盖常见模型（`shared/utils/modelContext.ts`）；本卡片按模型 ID 覆盖，
 *   匹配=精确 → 最长前缀；填入模型 ID 时按内置预设自动填充上限
 * - 单位智能：`128K` / `1.5M` / `200000`（K/M=1024；失焦规范化显示）
 * - 语义：行内「模型 ID + 上限」= 一条覆盖；清空上限/删除行=移除覆盖（回到内置预设）
 */

import { useState } from 'react';
import { Card, Collapse, Flex, Input, Tag, Typography } from 'antd';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useAgentStore } from '../store/agent';
import {
  MODEL_CONTEXT_PRESETS,
  formatTokenSize,
  normalizeModelId,
  parseTokenSize,
  presetContextWindow,
} from '../../../shared/utils/modelContext';

interface Row {
  uid: string;
  /** 当前输入（未归一） */
  id: string;
  sizeText: string;
  /** 已提交到 store 的键（改 ID 时用于清除旧键） */
  committedId?: string;
  invalid?: boolean;
}

let rowSeq = 0;
const nextUid = () => `mctx-${++rowSeq}`;

export function ModelContextCard() {
  const overrides = useAgentStore((s) => s.modelContextOverrides);
  const setOverride = useAgentStore((s) => s.setModelContextOverride);
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(overrides).map(([id, tokens]) => ({
      uid: nextUid(),
      id,
      sizeText: formatTokenSize(tokens),
      committedId: id,
    })),
  );

  const patchRow = (uid: string, patch: Partial<Row>) => {
    setRows((list) => list.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  /** 失焦提交：ID 归一 → 清旧键 → 有合法上限则写入（空/非法=移除覆盖） */
  const commit = (row: Row) => {
    const id = normalizeModelId(row.id);
    if (!id) return;
    if (row.committedId && row.committedId !== id) setOverride(row.committedId, null);
    const tokens = parseTokenSize(row.sizeText);
    const invalid = row.sizeText.trim() !== '' && !tokens;
    if (invalid) {
      patchRow(row.uid, { id, invalid: true });
      return;
    }
    setOverride(id, tokens ?? null);
    patchRow(row.uid, {
      id,
      sizeText: tokens ? formatTokenSize(tokens) : '',
      committedId: tokens ? id : undefined,
      invalid: false,
    });
  };

  const addRow = () => {
    setRows((list) => [...list, { uid: nextUid(), id: '', sizeText: '' }]);
  };

  const removeRow = (row: Row) => {
    if (row.committedId) setOverride(row.committedId, null);
    setRows((list) => list.filter((r) => r.uid !== row.uid));
  };

  const presets = [...MODEL_CONTEXT_PRESETS].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Card
      size="small"
      title="模型上下文上限（本地）"
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          仅存本机
        </Typography.Text>
      }
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        用于输入框旁的上下文占比。内置常见模型预设；这里按模型 ID 覆盖（精确或前缀匹配，如 <Tag style={{ marginInline: 2 }}>gpt-4o</Tag> 覆盖
        <Tag style={{ marginInline: 2 }}>gpt-4o-2024-08-06</Tag>）。单位支持 K/M（128K、1.5M）或原始 token 数。
      </Typography.Text>
      <Flex vertical gap={6} style={{ marginTop: 10 }}>
        {rows.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            暂无本机覆盖——内置预设已覆盖常见模型；需要修正或新增时点下方「添加模型」。
          </Typography.Text>
        ) : (
          rows.map((row) => (
            <Flex key={row.uid} gap={6} align="center">
              <Input
                size="small"
                style={{ width: 240 }}
                value={row.id}
                placeholder="模型 ID（如 glm-4.6 / gpt-4o-2024-08-06）"
                onChange={(e) => {
                  const id = e.target.value;
                  // 填模型 ID 时按内置预设自动填充上限（仅在未填时；用户可再改）
                  const preset = row.sizeText.trim() ? undefined : presetContextWindow(id);
                  patchRow(row.uid, {
                    id,
                    invalid: false,
                    ...(preset ? { sizeText: formatTokenSize(preset) } : {}),
                  });
                }}
                onBlur={() => commit(row)}
              />
              <Input
                size="small"
                style={{ width: 140 }}
                value={row.sizeText}
                status={row.invalid ? 'error' : undefined}
                placeholder="如 128K / 1M"
                onChange={(e) => patchRow(row.uid, { sizeText: e.target.value, invalid: false })}
                onBlur={() => commit(row)}
                onPressEnter={() => commit(row)}
              />
              <Button variant="text" size="small" danger icon={<Trash2 size={13} aria-hidden />} title="移除该覆盖" onClick={() => removeRow(row)} />
            </Flex>
          ))
        )}
        <Flex align="center" gap={8}>
          <Button variant="secondary" size="small" onClick={addRow}>
            <Plus size={13} aria-hidden /> 添加模型
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            修改模型名/上限后失焦即保存；清空上限=回到内置预设。
          </Typography.Text>
        </Flex>
      </Flex>
      <Collapse
        size="small"
        ghost
        style={{ marginTop: 4 }}
        items={[
          {
            key: 'presets',
            label: <Typography.Text style={{ fontSize: 12 }}>内置预设（{presets.length} 个常见模型，只读）</Typography.Text>,
            children: (
              <Flex vertical gap={2} style={{ maxHeight: 240, overflowY: 'auto' }}>
                {presets.map(([pattern, tokens]) => (
                  <Flex key={pattern} justify="space-between" gap={12}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {pattern}*
                    </Typography.Text>
                    <Typography.Text style={{ fontSize: 12 }}>{formatTokenSize(tokens)}</Typography.Text>
                  </Flex>
                ))}
              </Flex>
            ),
          },
        ]}
      />
    </Card>
  );
}