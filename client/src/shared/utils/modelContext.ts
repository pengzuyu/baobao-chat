/**
 * 模型上下文上限注册表（D36，2026-11-19；**桌面端本地知识，不落服务端**）：
 * - 内置常见模型预设（MODEL_CONTEXT_PRESETS）：更新桌面应用即可新增/修正，不需要动服务端
 * - 本机覆盖：用户按「模型 ID → 上限」覆盖（Agent 设置页编辑，localStorage 持久化），
 *   匹配=精确优先 → 最长前缀（如覆盖 `gpt-4o` 可命中 `gpt-4o-2024-08-06`）
 * - 单位智能解析/格式化：K/M 按 1024 进制（128K=131072；与模型厂商标称的 128K 对应）；
 *   输入接受 `128K` / `1.5M` / `200000`（大小写/空格容忍），显示统一 128K/1M/200K
 * - 解析不到（含 bbc-fast/bbc-strong 档位别名）→ 调用方不得显示占比（只显示已用量）
 */

const K = 1024;
const M = 1024 * 1024;

/**
 * 内置预设（命中规则：去 provider 前缀后的小写 id；后缀单位 > 精确 > 最长前缀）。
 * 数值按「厂商标称的 K」×1024 记（128K→131072），只影响占比小数位，不影响可用性。
 */
export const MODEL_CONTEXT_PRESETS: ReadonlyArray<readonly [model: string, tokens: number]> = [
  // OpenAI
  ['gpt-4.1', 1024 * K],
  ['gpt-4o', 128 * K],
  ['gpt-4-turbo', 128 * K],
  ['gpt-4', 8 * K],
  ['gpt-3.5-turbo', 16 * K],
  ['o1-mini', 128 * K],
  ['o1-preview', 128 * K],
  ['o1', 200 * K],
  ['o3', 200 * K],
  ['o4-mini', 200 * K],
  // Anthropic
  ['claude', 200 * K],
  // DeepSeek
  ['deepseek', 128 * K],
  // 智谱 GLM
  ['glm-5.3', 1024 * K],
  ['glm-4.7', 200 * K],
  ['glm-4.6', 200 * K],
  ['glm-4.5', 128 * K],
  ['glm-4', 128 * K],
  // 通义千问
  ['qwen-turbo', 1024 * K],
  ['qwen-max', 32 * K],
  ['qwen', 128 * K],
  // Moonshot / Kimi
  ['kimi', 256 * K],
  ['moonshot', 128 * K],
  // 其他常见
  ['gemini', 1024 * K],
  ['llama', 128 * K],
  ['mistral', 128 * K],
  ['grok', 131 * K],
];

/** 模型 ID 归一：trim + 小写；去 `provider/` 前缀后作为候选（`openai/gpt-4o` → `gpt-4o`） */
function candidatesOf(modelId: string): string[] {
  const id = modelId.trim().toLowerCase();
  if (!id) return [];
  const slash = id.lastIndexOf('/');
  return slash >= 0 && slash < id.length - 1 ? [id, id.slice(slash + 1)] : [id];
}

/** 从模型名后缀识别单位（`xxx-128k` / `xxx-1m` → tokens；无则 undefined） */
function suffixContextWindow(candidate: string): number | undefined {
  const m = /[-_](\d+(?:\.\d+)?)([kmg])$/.exec(candidate);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = m[2] === 'k' ? K : m[2] === 'm' ? M : M * K;
  const tokens = Math.round(n * mult);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** 内置预设匹配（精确 → 后缀单位 → 最长前缀） */
export function presetContextWindow(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const candidates = candidatesOf(modelId);
  if (candidates.length === 0) return undefined;
  for (const c of candidates) {
    const exact = MODEL_CONTEXT_PRESETS.find(([p]) => p === c);
    if (exact) return exact[1];
  }
  for (const c of candidates) {
    const suffix = suffixContextWindow(c);
    if (suffix) return suffix;
  }
  // 最长前缀：gpt-4o-2024-08-06 → gpt-4o；openai/o1-preview 已由候选2命中
  let best: { len: number; tokens: number } | undefined;
  for (const c of candidates) {
    for (const [p, tokens] of MODEL_CONTEXT_PRESETS) {
      if (c === p || c.startsWith(`${p}-`)) {
        if (!best || p.length > best.len) best = { len: p.length, tokens };
      }
    }
  }
  return best?.tokens;
}

/** 本机覆盖归一（键统一小写；值须为正整数 tokens） */
export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/**
 * 解析上下文上限：本机覆盖（精确 → 最长前缀）优先，其次内置预设。
 * 返回 source 供 UI 提示来源（override=本机覆盖 / preset=内置预设）。
 */
export function resolveContextWindow(
  modelId: string | undefined,
  overrides: Record<string, number> = {},
): { tokens: number; source: 'override' | 'preset' } | undefined {
  if (!modelId) return undefined;
  const candidates = candidatesOf(modelId);
  if (candidates.length === 0) return undefined;
  // 本机覆盖：精确
  for (const c of candidates) {
    const hit = overrides[c];
    if (hit && hit > 0) return { tokens: hit, source: 'override' };
  }
  // 本机覆盖：最长前缀（覆盖 gpt-4o → gpt-4o-2024-08-06）
  let best: { len: number; tokens: number } | undefined;
  for (const c of candidates) {
    for (const [key, tokens] of Object.entries(overrides)) {
      if (!tokens || tokens <= 0) continue;
      if (c === key || c.startsWith(`${key}-`)) {
        if (!best || key.length > best.len) best = { len: key.length, tokens };
      }
    }
  }
  if (best) return { tokens: best.tokens, source: 'override' };
  const preset = presetContextWindow(modelId);
  return preset ? { tokens: preset, source: 'preset' } : undefined;
}

/** 单位智能解析：`128K` / `1.5M` / `200000`（容忍空格/逗号/下划线；K/M=1024） */
export function parseTokenSize(input: string): number | undefined {
  const t = input.trim().replace(/[\s,_]/g, '').toLowerCase();
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)([kmg]?)$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const mult = m[2] === 'k' ? K : m[2] === 'm' ? M : m[2] === 'g' ? M * K : 1;
  const tokens = Math.round(n * mult);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

/** 上限显示：128K / 1M / 200K / 8192（非整值时保留 1 位小数） */
export function formatTokenSize(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= M) return `${trimNum(tokens / M)}M`;
  if (tokens >= K) return `${trimNum(tokens / K)}K`;
  return String(tokens);
}

/** 已用量显示：12.3K / 9.8K / 1.2M / 842（更偏「读数」精度） */
export function formatTokensUsed(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= M) return `${(tokens / M).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= K) return `${(tokens / K).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(tokens));
}

function trimNum(v: number): string {
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}