/**
 * 本地常用模型 + 思考强度（2026-11-26 对话档位单档化）：
 * - 选择即记住——任何入口选模型/调思考强度都即时落盘 localStorage（偏好类，同 D36 模型
 *   上下文本机覆盖、右栏收起态的口径：本机持久、不落服务端）；新建会话默认沿用
 * - 模型取值两态：DEFAULT_MODEL_KEY='default'=公司默认档（网关别名 bbc-default，全员
 *   共用，不另选供应商的人都走它）/ 'p:<供应商ID>:<模型>'=直达引用（公司级或我的 BYOK）
 * - 失效自愈：记住的直达引用在当前账号的供应商清单（公司级+我的）里找不到时（换账号/
 *   供应商被删/模型下架）回退公司默认并改写偏好，不让新建会话带着死引用去撞网关
 */

import { fetchMyProviders, fetchSharedProviders } from '../../settings/api/ai';
import type { AIProvider } from '../../admin/model/types';

export type ThinkLevel = 'low' | 'medium' | 'high';

/** 公司默认档的选择值（不发直达引用，网关按 bbc-default 路由） */
export const DEFAULT_MODEL_KEY = 'default';

const STORE_KEY = 'bbc:agent:model-pref';
const THINK_LEVELS: readonly ThinkLevel[] = ['low', 'medium', 'high'];

export interface ModelPref {
  model: string;
  think: ThinkLevel;
}

const DEFAULT_PREF: ModelPref = { model: DEFAULT_MODEL_KEY, think: 'medium' };

/** 直达引用形态判定 p:<供应商ID>:<模型> */
export function isModelRef(value: string): boolean {
  return /^p:\d+:.+$/.test(value);
}

export function readModelPref(): ModelPref {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_PREF;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREF;
    const { model, think } = parsed as { model?: unknown; think?: unknown };
    return {
      model: typeof model === 'string' && (model === DEFAULT_MODEL_KEY || isModelRef(model)) ? model : DEFAULT_MODEL_KEY,
      think: THINK_LEVELS.includes(think as ThinkLevel) ? (think as ThinkLevel) : 'medium',
    };
  } catch {
    return DEFAULT_PREF; // localStorage 不可用/内容损坏：缺省值
  }
}

export function writeModelPref(pref: ModelPref): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pref));
  } catch {
    /* 持久化失败静默——仅本次会话生效 */
  }
}

export type ModelProviders = { shared: AIProvider[]; mine: AIProvider[] };

export interface ModelOption {
  value: string;
  label: string;
  /** 供应商名（公司级不带前缀；我的 BYOK 带「我的 · 」） */
  sub?: string;
}

export interface ModelOptionGroup {
  label: string;
  options: ModelOption[];
}

/** 模型选项分组（ModelThinkPicker 面板与定时任务下拉共用同一份数据源） */
export function buildModelGroups(providers: ModelProviders): ModelOptionGroup[] {
  const ofProvider = (p: AIProvider, prefix: string): ModelOption[] =>
    p.models.map((m) => ({ value: `p:${p.id}:${m.id}`, label: m.label || m.id, sub: `${prefix}${p.name}` }));
  return [
    {
      label: '模型',
      options: [{ value: DEFAULT_MODEL_KEY, label: '公司默认', sub: 'bbc-default · 全员共用' }],
    },
    ...(providers.shared.length > 0
      ? [{ label: '公司供应商', options: providers.shared.flatMap((p) => ofProvider(p, '')) }]
      : []),
    ...(providers.mine.length > 0
      ? [{ label: '我的供应商', options: providers.mine.flatMap((p) => ofProvider(p, '我的 · ')) }]
      : []),
  ];
}

/** 选择值是否仍可选（公司默认恒为 true；直达引用须在供应商清单内） */
export function modelRefListed(value: string, providers: ModelProviders): boolean {
  if (value === DEFAULT_MODEL_KEY) return true;
  return buildModelGroups(providers).some((g) => g.options.some((o) => o.value === value));
}

/** 选择值的展示名：公司默认→「默认」；直达引用→模型展示名（清单未加载/已失效退回模型 ID） */
export function modelLabelOf(value: string, providers?: ModelProviders): string {
  if (value === DEFAULT_MODEL_KEY) return '默认';
  const id = value.split(':')[2] ?? value;
  const hit = providers ? buildModelGroups(providers).flatMap((g) => g.options).find((o) => o.value === value) : undefined;
  return hit?.label ?? id;
}

// ---- 供应商清单缓存（工作台拉取时顺手登记；建会话前校验常用引用用，免得每次重拉）----
let cachedProviders: ModelProviders | null = null;

export function cacheModelProviders(shared: AIProvider[], mine: AIProvider[]): void {
  cachedProviders = { shared, mine };
}

/**
 * 常用模型是否已失效：记住的直达引用不在当前账号的供应商清单里（换账号/供应商被删/
 * 模型下架）。清单未加载（无缓存）时不做判断。调用方判真后经 store.setModelPref
 * 回退公司默认（顺带落盘）
 */
export function isModelPrefStale(current: string): boolean {
  if (current === DEFAULT_MODEL_KEY || !cachedProviders) return false;
  return !modelRefListed(current, cachedProviders);
}

/**
 * 解析「跟随本地常用」时的实际模型：公司默认→undefined（不发直达引用）；直达引用→
 * 建会话前校验仍可用（无缓存则拉一次清单），失效则回退公司默认并落盘。
 * 返回 undefined=公司默认档，字符串=直达引用。
 */
export async function resolveRememberedModel(current: string): Promise<string | undefined> {
  if (current === DEFAULT_MODEL_KEY) return undefined;
  if (!cachedProviders) {
    try {
      const [shared, mine] = await Promise.all([fetchSharedProviders(), fetchMyProviders().catch(() => [])]);
      cacheModelProviders(shared, mine);
    } catch {
      return current; // 清单拉不到：不武断改写用户偏好，交网关裁决（错误卡可见）
    }
  }
  if (modelRefListed(current, cachedProviders!)) return current;
  // 失效：落盘回退（store 侧由调用方同步 modelPref）
  writeModelPref({ ...readModelPref(), model: DEFAULT_MODEL_KEY });
  return undefined;
}
