/**
 * 供应商模型清单编辑器（0023；admin 供应商面板与个人 BYOK 表单共享）：
 * - 探测候选 chips 点选/取消（选中高亮）
 * - 手动输入任意模型 ID（回车/「添加」）——上游 /models 清单不全时的唯一入口
 *   （如智谱只返回付费模型，glm-4.7-flash 等免费档须手填）
 * - 已选但不在候选中的项带「手动」小标（虚线描边），✕ 移除
 */

import { useState } from 'react';
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
    <div className="admin-provider-models" data-testid={testId}>
      {candidates.map((m) => (
        <button
          key={m}
          type="button"
          className={`admin-chip${models.includes(m) ? ' admin-chip--active' : ''}`}
          onClick={() => onToggle(m)}
          title={models.includes(m) ? '点击取消选择' : '点击选择'}
        >
          {m}
        </button>
      ))}
      {models
        .filter((m) => !candidates.includes(m))
        .map((m) => (
          <button
            key={m}
            type="button"
            className="admin-chip admin-chip--active admin-chip--manual"
            onClick={() => onToggle(m)}
            title="手动添加的模型，点击移除"
          >
            {m}
            <i className="admin-chip__tag">手动</i>✕
          </button>
        ))}
      <span className="admin-provider-models__entry">
        <input
          className="bbw-input"
          style={{ width: 220 }}
          value={manual}
          placeholder="手动输入模型 ID（上游清单缺省时）"
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addManual();
            }
          }}
          data-testid={testId ? `${testId}-input` : undefined}
        />
        <Button variant="secondary" onClick={addManual} disabled={!manual.trim()}>
          <Plus size={13} /> 添加
        </Button>
      </span>
    </div>
  );
}
