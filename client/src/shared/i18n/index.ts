/**
 * 轻量 i18n（E12 / D01 §12.1 资源键 `域.页面.键`；不引运行时依赖——字典即模块）：
 * - locale 三态：zh-CN（默认）/ en / system（跟 navigator.language）
 * - t(key, params?)：字典未命中回退 zh-CN，再未命中回 key 本身（开发期可见缺译）
 * - 存储：localStorage('bbw-locale')（设备 UI 偏好，主题同款口径）
 * - antd 组件内置文案：main 的 ConfigProvider 消费 localeOf()
 * - 覆盖范围 v0.1：设置页族 + 主导航/登录页骨架键（全量文案迁移随阶段二渐入）
 */

import { create } from 'zustand';

export type Locale = 'zh-CN' | 'en';

const STORAGE_KEY = 'bbw-locale';

type LocalePref = Locale | 'system';

function readInitial(): LocalePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'zh-CN' || v === 'en' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'zh-CN';
}

function resolve(pref: LocalePref): Locale {
  if (pref !== 'system') return pref;
  return (typeof navigator !== 'undefined' && navigator.language?.startsWith('zh')) ? 'zh-CN' : 'en';
}

interface I18nState {
  pref: LocalePref;
  locale: Locale;
  setPref: (p: LocalePref) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  pref: readInitial(),
  locale: resolve(readInitial()),
  setPref: (p) => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* 隐私模式静默 */
    }
    set({ pref: p, locale: resolve(p) });
  },
}));

/** 当前生效 locale（非 React 上下文用；ConfigProvider/文档标题等） */
export function localeOf(): Locale {
  return useI18nStore.getState().locale;
}

// ── 字典（zh-CN 为源语言；en 为覆盖层——缺键回退 zh）──

const zh: Record<string, string> = {
  // 设置页族
  'settings.title': '设置',
  'settings.tab.general': '通用',
  'settings.tab.notification': '通知',
  'settings.tab.transfer': '传输',
  'settings.tab.shortcuts': '快捷键',
  'settings.tab.agent': 'Agent',
  'settings.tab.mcp': 'MCP 服务',
  'settings.tab.about': '关于',
  'settings.general.language': '语言',
  'settings.general.language.desc': '界面显示语言（切换即时生效）',
  'settings.general.theme': '主题',
  'settings.general.theme.light': '浅色',
  'settings.general.theme.dark': '深色',
  'settings.general.theme.system': '跟随系统',
  'settings.notification.msg': '会话消息通知',
  'settings.notification.mention': '@我特别提醒',
  'settings.notification.dnd': '免打扰时段',
  'settings.transfer.upLimit': '上传限速',
  'settings.transfer.downLimit': '下载限速',
  'settings.transfer.downloadDir': '默认下载目录',
  // 导航/壳
  'nav.im': '消息',
  'nav.contacts': '通讯录',
  'nav.notification': '通知',
  'nav.experts': '专家',
  'nav.kb': '知识库',
  'nav.mail': '邮件',
  'nav.agent': 'Agent',
  // 登录
  'login.title': 'BaobaoWork',
  'login.account': '账号',
  'login.password': '口令',
  'login.submit': '登 录',
};

const en: Record<string, string> = {
  'settings.title': 'Settings',
  'settings.tab.general': 'General',
  'settings.tab.notification': 'Notifications',
  'settings.tab.transfer': 'Transfer',
  'settings.tab.shortcuts': 'Shortcuts',
  'settings.tab.agent': 'Agent',
  'settings.tab.mcp': 'MCP',
  'settings.tab.about': 'About',
  'settings.general.language': 'Language',
  'settings.general.language.desc': 'Interface language (applies immediately)',
  'settings.general.theme': 'Theme',
  'settings.general.theme.light': 'Light',
  'settings.general.theme.dark': 'Dark',
  'settings.general.theme.system': 'System',
  'settings.notification.msg': 'Message notifications',
  'settings.notification.mention': 'Mention alerts',
  'settings.notification.dnd': 'Do not disturb',
  'settings.transfer.upLimit': 'Upload limit',
  'settings.transfer.downLimit': 'Download limit',
  'settings.transfer.downloadDir': 'Default download folder',
  'nav.im': 'Messages',
  'nav.contacts': 'Contacts',
  'nav.notification': 'Notifications',
  'nav.experts': 'Experts',
  'nav.kb': 'Knowledge',
  'nav.mail': 'Mail',
  'nav.agent': 'Agent',
  'login.title': 'BaobaoWork',
  'login.account': 'Account',
  'login.password': 'Password',
  'login.submit': 'Sign in',
};

const DICTS: Record<Locale, Record<string, string>> = { 'zh-CN': zh, en };

/** 翻译函数：命中 en → zh-CN → key；{name} 占位替换 */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = useI18nStore.getState().locale;
  let s = DICTS[locale][key] ?? DICTS['zh-CN'][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** antd 内置 locale 包名（ConfigProvider locale 懒加载键） */
export function antdLocaleOf(): 'zh-cn' | 'en-us' {
  return localeOf() === 'zh-CN' ? 'zh-cn' : 'en-us';
}
