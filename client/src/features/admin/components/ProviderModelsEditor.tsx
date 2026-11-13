/**
 * 供应商模型清单编辑器（0023；admin 供应商面板与个人 BYOK 表单共享）：
 * - 探测候选 Tag.CheckableTag 点选/取消（选中高亮）
 * - 手动输入任意模型 ID（回车/「添加」）——上游 /models 清单不全时的唯一入口
 *   （如智谱只返回付费模型，glm-4.7-flash 等免费档须手填）
 * - 已选但不在候选中的项为 closable Tag（带「手动」标注），✕ 移除
 * D26-O2：chips/input 换 antd（CheckableTag/Tag closable/Input）。
 */

import { useState } from 'react';
import { Flex, Input, Tag } from 'antd';
import { Plus } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

interface ProviderModelsEditorProps {
  /** 已选模型 id 集（有序按加入序） */
  models: string[];
  /** 探测到的上游 /models 清单（可点选） */
  candidates: string[];
  /** 候选点选/取消；也用于移除手填项 */
  onToggle: (id: string) => void;
  /** 手动加入（已存在则忽略） */
  onAdd: (id: string) => void;
  testId?: string;
}

export function ProviderModelsEditor({ models, candidates, onToggle, onAdd, testId }: ProviderModelsEditorProps) {
  const [manual, setManual] = useState('');

  const addManual = () => {
    const id = manual.trim();
    if (!id || models.includes(id)) {
      setManual('');
      return;
    }
    onAdd(id);
    setManual('');
  };

  return (
    <Flex gap={4} wrap="wrap" align="center" data-testid={testId}>
      {candidates.map((m) => (
        <Tag.CheckableTag key={m} checked={models.includes(m)} onChange={() => onToggle(m)}>
          {m}
        </Tag.CheckableTag>
      ))}
      {models
        .filter((m) => !candidates.includes(m))
        .map((m) => (
          <Tag key={m} color="blue" closable onClose={(e) => { e.preventDefault(); onToggle(m); }}>
            {m}（手动）
          </Tag>
        ))}
      <Flex gap={4} align="center">
        <Input
          style={{ width: 220 }}
          value={manual}
          placeholder="手动输入模型 ID（上游清单缺省时）"
          onChange={(e) => setManual(e.target.value)}
          onPressEnter={addManual}
          data-testid={testId ? `${testId}-input` : undefined}
        />
        <Button variant="secondary" onClick={addManual} disabled={!manual.trim()}>
          <Plus size={13} /> 添加
        </Button>
      </Flex>
    </Flex>
  );
}
