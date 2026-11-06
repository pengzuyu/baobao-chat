/**
 * 设置 · 通用（D01 §4.2）：
 * - 主题三态（浅色/深色/跟随系统）——全设置页族中本阶段唯一真实生效的设置，
 *   经 shared/store/theme 持久化（UI 偏好，localStorage bbw-theme）
 * - 语言/启动项为界面骨架（标注后续接入）
 */

import { Check, Languages, Monitor, Moon, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useThemeStore, type ThemeMode } from '../../../shared/store/theme';

/** 主题三选卡片（带迷你预览：左导航条 + 内容块示意） */
function ThemeCard({ mode, label, icon: Icon, active, onSelect }: { mode: ThemeMode; label: string; icon: LucideIcon; active: boolean; onSelect: () => void }) {
  return (
    <button className={`theme-card${active ? ' theme-card--active' : ''}`} onClick={onSelect} aria-pressed={active}>
      <div className={`theme-card__preview theme-card__preview--${mode}`}>
        <span className="theme-card__rail" />
        <span className="theme-card__block" />
        <span className="theme-card__block theme-card__block--accent" />
      </div>
      <div className="theme-card__label">
        <Icon size={14} />
        {label}
        {active ? <Check size={13} className="theme-card__check" /> : null}
      </div>
      <span className="sr-only">切换为{label}主题</span>
    </button>
  );
}

export function GeneralSettingsPage() {
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">通用</h2>

      <div className="settings-card">
        <div className="settings-card__head">
          <div className="settings-card__name">外观 · 主题</div>
          <div className="settings-card__desc">
            {mode === 'system' ? `跟随系统（当前：${resolved === 'dark' ? '深色' : '浅色'}）` : mode === 'dark' ? '深色' : '浅色'}
          </div>
        </div>
        <div className="theme-picker" role="radiogroup" aria-label="主题">
          <ThemeCard mode="light" label="浅色" icon={Sun} active={mode === 'light'} onSelect={() => setMode('light')} />
          <ThemeCard mode="dark" label="深色" icon={Moon} active={mode === 'dark'} onSelect={() => setMode('dark')} />
          <ThemeCard mode="system" label="跟随系统" icon={Monitor} active={mode === 'system'} onSelect={() => setMode('system')} />
        </div>
      </div>

      <div className="settings-card settings-card--static">
        <div className="settings-card__head">
          <div className="settings-card__name">
            <Languages size={14} /> 语言
          </div>
          <div className="settings-card__value">简体中文</div>
        </div>
        <div className="settings-card__desc">多语言支持在国际化阶段接入（shared/i18n，D01 §12.1）</div>
      </div>
    </div>
  );
}
