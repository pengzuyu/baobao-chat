/**
 * 设置 · 通用（D01 §4.2）：
 * - 主题三态（浅色/深色/跟随系统）——全设置页族中本阶段唯一真实生效的设置，
 *   经 shared/store/theme 持久化（UI 偏好，localStorage bbw-theme）
 * - 语言三态真实生效（E12：zh-CN/en/system——切换即时生效，antd 内置文案联动）
 * D26-O3：主题三选卡→Segmented、语言下拉→Select、卡片壳→Card（theme-card/settings-* 退役）。
 */

import type { ReactNode } from 'react';
import { Card, Flex, Segmented, Select, Space, Typography } from 'antd';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, type ThemeMode } from '../../../shared/store/theme';
import { useI18nStore } from '../../../shared/i18n';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: ReactNode }> = [
  { value: 'light', label: '浅色', icon: <Sun size={14} /> },
  { value: 'dark', label: '深色', icon: <Moon size={14} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={14} /> },
];

export function GeneralSettingsPage() {
  // E12：语言偏好（三态；切换即时生效——设置页与导航文案走 t()，antd 走 ConfigProvider）
  const pref = useI18nStore((s) => s.pref);
  const setPref = useI18nStore((s) => s.setPref);
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        通用
      </Typography.Title>

      <Card size="small" title="外观 · 主题">
        <Flex align="center" gap={12} wrap="wrap">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as ThemeMode)}
            options={THEME_OPTIONS}
          />
          <Typography.Text type="secondary">
            {mode === 'system' ? `跟随系统（当前：${resolved === 'dark' ? '深色' : '浅色'}）` : mode === 'dark' ? '深色' : '浅色'}
          </Typography.Text>
        </Flex>
      </Card>

      <Card size="small" title={<Space size={6}><Languages size={14} /> 语言</Space>}>
        <Flex align="center" gap={12} wrap="wrap">
          <Select
            value={pref}
            onChange={(v) => setPref(v as 'zh-CN' | 'en' | 'system')}
            style={{ width: 200 }}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
              { value: 'system', label: '跟随系统 / System' },
            ]}
            data-testid="locale-select"
          />
          <Typography.Text type="secondary">切换即时生效（界面文案 + antd 组件内置文案）；英文覆盖范围渐入，未覆盖处回退中文</Typography.Text>
        </Flex>
      </Card>
    </Space>
  );
}
