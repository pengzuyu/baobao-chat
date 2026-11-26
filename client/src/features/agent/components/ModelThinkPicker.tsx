/**
 * 模型 + 思考强度选择器（2026-11-11 对齐 zcode：合并为单个 Popover 两段式）：
 * - 上段「模型」：两级悬浮菜单（2026-11-26 用户拍板：先选供应商再选模型）——顶级=
 *   公司默认 + 各供应商（公司供应商在前、我的 BYOK 归「我的供应商」组），供应商行
 *   悬浮向右弹出该供应商的模型子弹层再点选。协议引用本就是 p:<供应商ID>:<模型>
 *   两元组（同名模型可挂多家供应商，选到供应商才定得住用哪份凭证与网关路由），
 *   UI 与之对齐；空供应商子弹层给「暂无模型」禁用项
 * - 面板底部「管理模型」：跳 /agent/settings，供应商与模型清单的添加/编辑在 Agent 设置页
 * - 下段「思考强度」：三档 antd Slider，轮级生效随下一条消息下发；选择即记住（本地持久化）
 * - 触发器 = 输入框左下角模型按钮，chip 并显当前深度（「模型 默认 · 中」——2026-11-26
 *   用户拍板：不带「思考」字样，只显深度值）
 * D26-O4：agent-mt-* / agent-model-chip 自研样式退役（面板 Menu 化、滑杆原生观感）。
 */

import { useMemo } from 'react';
import { Flex, Menu, Popover, Slider, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { useNavigate } from 'react-router-dom';
import { Settings2, Sparkles } from 'lucide-react';
import { useAgentStore } from '../store/agent';
import { DEFAULT_MODEL_KEY, modelLabelOf, type ModelProviders, type ThinkLevel } from '../utils/modelPref';
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
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const thinkLevel = useAgentStore((s) => s.thinkLevel);
  const setThinkLevel = useAgentStore((s) => s.setThinkLevel);

  const items: MenuProps['items'] = useMemo(() => {
    // 两级：供应商=顶级 SubMenu（悬浮弹层），模型=其子弹层项；供应商无模型给禁用占位
    const ofProvider = (list: ModelProviders['shared']): MenuProps['items'] =>
      list.map((p) => ({
        key: `prov:${p.id}`,
        label: p.name,
        children:
          p.models.length > 0
            ? p.models.map((m) => ({ key: `p:${p.id}:${m.id}`, label: m.label || m.id }))
            : [{ key: `prov:${p.id}:empty`, label: '该供应商暂无模型', disabled: true }],
      }));
    return [
      {
        key: DEFAULT_MODEL_KEY,
        title: 'bbc-default · 全员共用，不另选供应商即走它',
        label: (
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 500 }}>公司默认</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              bbc-default · 全员共用
            </Typography.Text>
          </span>
        ),
      },
      ...(providers.shared.length > 0
        ? [
            {
              key: 'grp-shared',
              type: 'group' as const,
              label: <Typography.Text type="secondary" style={{ fontSize: 11 }}>公司供应商</Typography.Text>,
              children: ofProvider(providers.shared),
            },
          ]
        : []),
      ...(providers.mine.length > 0
        ? [
            {
              key: 'grp-mine',
              type: 'group' as const,
              label: <Typography.Text type="secondary" style={{ fontSize: 11 }}>我的供应商</Typography.Text>,
              children: ofProvider(providers.mine),
            },
          ]
        : []),
    ];
  }, [providers]);

  const chipLabel = modelLabelOf(value, providers);
  const isDefault = value === DEFAULT_MODEL_KEY;
  const hasCustom = providers.shared.length > 0 || providers.mine.length > 0;

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
      {!hasCustom ? (
        <div style={{ padding: '0 12px 4px' }}>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            还没有自选供应商，点下方「管理模型」去添加
          </Typography.Text>
        </div>
      ) : null}
      <div style={{ padding: '4px 12px' }}>
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
      <div style={{ padding: '6px 12px 8px', borderTop: `1px solid ${token.colorBorderSecondary}` }}>
        <Button
          variant="text"
          size="small"
          title="供应商与模型清单的添加/编辑在 Agent 设置页"
          icon={<Settings2 size={13} aria-hidden />}
          onClick={() => navigate('/agent/settings')}
        >
          管理模型
        </Button>
      </div>
    </div>
  );

  return (
    <Popover trigger="click" placement="topLeft" arrow={false} content={panel}>
      <Button
        variant="text"
        size="small"
        title={`${isDefault ? '公司默认模型（全员共用）' : `模型 ${value}`} · 思考深度 ${THINK_LABELS[thinkLevel]}，随下一条消息生效`}
        icon={<Sparkles size={13} aria-hidden />}
      >
        模型 {chipLabel} · {THINK_LABELS[thinkLevel]}
      </Button>
    </Popover>
  );
}
