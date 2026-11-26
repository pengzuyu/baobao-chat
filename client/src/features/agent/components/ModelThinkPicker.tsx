/**
 * 模型 + 思考强度选择器（2026-11-11 对齐 zcode：合并为单个 Popover 两段式）：
 * - 上段「模型」：公司默认 + 公司供应商 + 我的供应商（antd Menu 分组+选中态）。
 *   2026-11-26 对话档位单档化：原快/强两档退役，不另选供应商的人走公司默认档
 *   （网关 bbc-default 全员共用）；选项分组与定时任务下拉共用 utils/modelPref
 * - 下段「思考强度」：三档 antd Slider，轮级生效随下一条消息下发；选择即记住（本地持久化）
 * - 触发器 = 输入框左下角模型按钮（shared Button text）
 * D26-O4：agent-mt-* / agent-model-chip 自研样式退役（面板 Menu 化、滑杆原生观感）。
 */

import { useMemo } from 'react';
import { Flex, Menu, Popover, Slider, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { Sparkles } from 'lucide-react';
import { useAgentStore } from '../store/agent';
import { buildModelGroups, DEFAULT_MODEL_KEY, modelLabelOf, type ModelProviders, type ThinkLevel } from '../utils/modelPref';
import { Button } from '../../../shared/ui/Button';

const THINK_LEVELS: readonly ThinkLevel[] = ['low', 'medium', 'high'];
const THINK_LABELS: Record<ThinkLevel, string> = { low: '低', medium: '中', high: '高' };
const THINK_DESCS: Record<ThinkLevel, string> = {
  low: '快速直答，不展开思考',
  medium: '默认思考强度',
  high: '深度思考，更大的思考预算',
};

interface ModelThinkPickerProps {
  providers: ModelProviders;
  /** 当前选择：DEFAULT_MODEL_KEY=公司默认档 / 'p:<providerId>:<model>'=直达引用 */
  value: string;
  /** key='default'=公司默认档 / 'p:<id>:<model>'=直达引用（页面沿用模型菜单口径） */
  onSelect: (key: string) => void;
}

export function ModelThinkPicker({ providers, value, onSelect }: ModelThinkPickerProps) {
  const thinkLevel = useAgentStore((s) => s.thinkLevel);
  const setThinkLevel = useAgentStore((s) => s.setThinkLevel);

  const items: MenuProps['items'] = useMemo(
    () =>
      buildModelGroups(providers).map((sec) => ({
        key: sec.label,
        type: 'group' as const,
        label: <Typography.Text type="secondary" style={{ fontSize: 11 }}>{sec.label}</Typography.Text>,
        children: sec.options.map((r) => ({
          key: r.value,
          title: r.sub,
          label: (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontWeight: 500, flexShrink: 0 }}>{r.label}</span>
              {r.sub ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                  {r.sub}
                </Typography.Text>
              ) : null}
            </span>
          ),
        })),
      })),
    [providers],
  );
  const chipLabel = modelLabelOf(value, providers);
  const isDefault = value === DEFAULT_MODEL_KEY;

  const panel = (
    <div style={{ width: 250 }}>
      <Menu
        mode="vertical"
        selectable
        items={items}
        selectedKeys={[value]}
        onClick={(e) => onSelect(e.key)}
        style={{ border: 'none' }}
      />
      <div style={{ padding: '4px 12px 8px' }}>
        <Flex justify="space-between" align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            思考强度
          </Typography.Text>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {THINK_LABELS[thinkLevel]}
          </Typography.Text>
        </Flex>
        <Slider
          min={0}
          max={2}
          step={1}
          value={THINK_LEVELS.indexOf(thinkLevel)}
          tooltip={{ open: false }}
          onChange={(v) => setThinkLevel(THINK_LEVELS[v as 0 | 1 | 2])}
        />
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {THINK_DESCS[thinkLevel]}
        </Typography.Text>
      </div>
    </div>
  );

  return (
    <Popover trigger="click" placement="topLeft" arrow={false} content={panel}>
      <Button
        variant="text"
        size="small"
        title={isDefault ? '公司默认模型（全员共用）· 思考强度随下一条消息生效' : `模型 ${value} · 思考强度随下一条消息生效`}
        icon={<Sparkles size={13} aria-hidden />}
      >
        模型 {chipLabel}
      </Button>
    </Popover>
  );
}
