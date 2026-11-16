/**
 * 主题色色板行（D27 修订2 accent 化）：六套预置主题色圆形色块点选（AntD Pro 同款交互）。
 * 色值取当前 resolved 模式对应档（暗色自动换提亮档，所见即所得）；选中显对勾+同色外环。
 * 消费方：设置页「外观」卡片 + MainLayout 头像下拉（紧凑 size）。
 */

import { Flex, Tooltip } from 'antd';
import { Check } from 'lucide-react';
import { ACCENTS, type ThemeAccent } from './themeConstants';
import { useThemeStore } from '../store/theme';

/** 色块上对勾前景色（近白主色如墨黑暗档需深色对勾；--bbw-text-on-fill 的对比推导，D27 白名单） */
const checkColorOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const luma = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luma > 0.6 ? '#171717' : '#ffffff';
};

export function AccentSwatches({ size = 24 }: { size?: number }) {
  const resolved = useThemeStore((s) => s.resolved);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  return (
    <Flex align="center" gap={size >= 20 ? 8 : 6} wrap="wrap">
      {(Object.keys(ACCENTS) as ThemeAccent[]).map((key) => {
        const tone = ACCENTS[key][resolved];
        const selected = key === accent;
        return (
          <Tooltip key={key} title={ACCENTS[key].label}>
            <button
              type="button"
              aria-label={`主题色：${ACCENTS[key].label}`}
              aria-pressed={selected}
              onClick={() => setAccent(key)}
              style={{
                width: size,
                height: size,
                borderRadius: '50%',
                background: tone.primary,
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                // 选中=外环（gap 用容器底色隔开）；未选中=1px 中性描边。均走 boxShadow 无布局抖动
                boxShadow: selected
                  ? `0 0 0 2px var(--bbw-gray-1), 0 0 0 ${Math.max(3, Math.round(size / 7))}px ${tone.primary}`
                  : '0 0 0 1px var(--bbw-gray-3)',
              }}
            >
              {selected && <Check size={Math.round(size * 0.55)} strokeWidth={2.5} color={checkColorOf(tone.primary)} />}
            </button>
          </Tooltip>
        );
      })}
    </Flex>
  );
}
