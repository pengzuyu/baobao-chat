/**
 * 模型 + 思考强度选择器（2026-11-11 对齐 zcode：合并为单个 Popover 两段式）：
 * - 上段「模型」：档位（快/强）+ 公司供应商 + 我的供应商（antd Menu 分组+选中态）
 * - 下段「思考强度」：三档 antd Slider，轮级生效随下一条消息下发
 * - 触发器 = 输入框左下角模型按钮（shared Button text）
 * D26-O4：agent-mt-* / agent-model-chip 自研样式退役（面板 Menu 化、滑杆原生观感）。
 */

import { useMemo } from 'react';
import { Flex, Menu, Popover, Slider, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { Sparkles } from 'lucide-react';
import { MODEL_TIER_LABELS } from '../bridge/types';
import type { AIProvider } from '../../admin/model/types';
import { useAgentStore } from '../store/agent';
import { Button } from '../../../shared/ui/Button';

type ThinkLevel = 'low' | 'medium' | 'high';

const THINK_LEVELS: readonly ThinkLevel[] = ['low', 'medium', 'high'];
const THINK_LABELS: Record<ThinkLevel, string> = { low: '低', medium: '中', high: '高' };
const THINK_DESCS: Record<ThinkLevel, string> = {
  low: '快速直答，不展开思考',
  medium: '默认思考强度',
  high: '深度思考，更大的思考预算',
};

interface ModelRow {
  key: string;
  name: string;
  sub?: string;
}

interface ModelThinkPickerProps {
  providers: { shared: AIProvider[]; mine: AIProvider[] };
  /** 当前名义档位（override 存在时为名义值） */
  policy: 'fast' | 'strong' | 'auto';
  /** 直达引用 p:<providerId>:<model>（选中态判定优先） */
  override?: string;
  /** key='tier:fast'…=档位 / 'p:<id>:<model>'=直达引用（页面沿用模型菜单口径） */
  onSelect: (key: string) => void;
}

export function ModelThinkPicker({ providers, policy, override, onSelect }: ModelThinkPickerProps) {
  const thinkLevel = useAgentStore((s) => s.thinkLevel);
  const setThinkLevel = useAgentStore((s) => s.setThinkLevel);

  const sections = useMemo(() => {
    const ofProvider = (p: AIProvider, prefix: string): ModelRow[] =>
      p.models.map((m) => ({ key: `p:${p.id}:${m.id}`, name: m.label || m.id, sub: `${prefix}${p.name}` }));
    return [
      {
        title: '模型',
        rows: [
          { key: 'tier:fast', name: '快', sub: 'bbw-fast · 公司默认快档' },
          { key: 'tier:strong', name: '强', sub: 'bbw-strong · 公司默认强档' },
        ] as ModelRow[],
      },
      ...(providers.shared.length > 0 ? [{ title: '公司供应商', rows: providers.shared.flatMap((p) => ofProvider(p, '')) }] : []),
      ...(providers.mine.length > 0 ? [{ title: '我的供应商', rows: providers.mine.flatMap((p) => ofProvider(p, '我的 · ')) }] : []),
    ];
  }, [providers]);

  const selectedKey = override ?? `tier:${policy}`;
  const chipLabel = override ? (override.split(':')[2] ?? MODEL_TIER_LABELS[policy]) : MODEL_TIER_LABELS[policy];

  const items: MenuProps['items'] = sections.map((sec) => ({
    key: sec.title,
    type: 'group' as const,
    label: <Typography.Text type="secondary" style={{ fontSize: 11 }}>{sec.title}</Typography.Text>,
    children: sec.rows.map((r) => ({
      key: r.key,
      title: r.sub,
      label: (
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 500, flexShrink: 0 }}>{r.name}</span>
          {r.sub ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
              {r.sub}
            </Typography.Text>
          ) : null}
        </span>
      ),
    })),
  }));

  const panel = (
    <div style={{ width: 250 }}>
      <Menu
        mode="vertical"
        selectable
        items={items}
        selectedKeys={[selectedKey]}
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
        title="模型与思考强度（思考强度随下一条消息生效）"
        icon={<Sparkles size={13} aria-hidden />}
      >
        模型 {chipLabel}
      </Button>
    </Popover>
  );
}
