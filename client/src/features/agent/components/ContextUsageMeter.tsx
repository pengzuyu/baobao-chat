/**
 * 输入框状态条（D36）：当前上下文消耗 / 占比 / 缓存命中率。
 * - 上限来源=桌面端本机注册表（本机覆盖 > 内置预设；`shared/utils/modelContext.ts`），
 *   **完全不知道上限时不显示占比**，只显示已用量与缓存命中率（用户口径）
 * - 模型名优先取 stream.done.usage.model（上游实际模型，快/强档位也能解析）；
 *   缺失时回退会话 modelOverride 的 p:<provider>:<model>
 * - 缓存命中率 = cached / in（上游未上报 → 显示「缓存 —」，不臆造 0%）
 * - 颜色：≥80% 警告色、≥95% 错误色；tooltip 给精确 token 数/上限来源/模型
 */

import { Tooltip, Typography, theme } from 'antd';
import type { TurnUsage } from '../bridge/types';
import { useAgentStore } from '../store/agent';
import { formatTokenSize, formatTokensUsed, resolveContextWindow } from '../../../shared/utils/modelContext';

/** 档位别名（非真实模型名，不能用于上下文预设匹配）。2026-11-26 单档化新增 default；
 *  fast/strong 保留以识别历史 WAL 用量行里的旧别名 */
const TIER_ALIAS = /^bbc-(default|fast|strong|auto|embed|rerank)$/;

/** 模型名解析：wire 实际模型优先；否则回退 p:<provider>:<model> 直达引用 */
function pickModel(usageModel: string | undefined, override: string | undefined): string | undefined {
  if (usageModel && !TIER_ALIAS.test(usageModel.trim().toLowerCase())) return usageModel;
  if (override && override.startsWith('p:')) {
    const parts = override.split(':');
    if (parts.length >= 3 && parts[2]) return parts[2];
  }
  return undefined;
}

export function ContextUsageMeter({ usage, modelHint }: { usage?: TurnUsage; modelHint?: string }) {
  const { token } = theme.useToken();
  const overrides = useAgentStore((s) => s.modelContextOverrides);
  if (!usage || !Number.isFinite(usage.in) || usage.in <= 0) return null;

  const model = pickModel(usage.model, modelHint);
  const window = resolveContextWindow(model, overrides);
  const pct = window ? (usage.in / window.tokens) * 100 : undefined;
  const cachePct =
    typeof usage.cached === 'number' && Number.isFinite(usage.cached) && usage.in > 0
      ? (usage.cached / usage.in) * 100
      : undefined;
  // 展示口径：0~100（上游计数偶有 cached>in，防御性夹取）
  const cacheShown = cachePct === undefined ? undefined : Math.min(100, Math.max(0, Math.round(cachePct)));

  const pctText = pct === undefined ? undefined : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  const pctColor =
    pct === undefined
      ? token.colorTextTertiary
      : pct >= 95
        ? token.colorError
        : pct >= 80
          ? token.colorWarning
          : token.colorTextTertiary;

  const tipLines = [
    `上下文：${usage.in.toLocaleString()} tokens（最近一次模型调用的输入）`,
    window
      ? `上限：${window.tokens.toLocaleString()} tokens（${window.source === 'override' ? '本机覆盖' : '内置预设'}${model ? ` · ${model}` : ''}）`
      : `上限未知${model ? `（未识别模型 ${model}）` : '（模型名未上报）'}——可在 设置 · Agent → 模型上下文上限 本机补充`,
    cachePct === undefined
      ? '缓存命中率：上游未上报'
      : `缓存命中：${(usage.cached ?? 0).toLocaleString()} tokens（${cacheShown}%）`,
  ];

  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tipLines.join('\n')}</span>}>
      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }} aria-label="上下文用量">
        上下文 <span style={{ color: token.colorTextSecondary }}>{formatTokensUsed(usage.in)}</span>
        {window ? (
          <>
            {' / '}
            <span>{formatTokenSize(window.tokens)}</span>
            {' · '}
            <span style={{ color: pctColor }}>{pctText}</span>
          </>
        ) : null}
        <span style={{ marginInlineStart: 8, color: token.colorTextTertiary }}>
          缓存 {cacheShown === undefined ? '—' : `${cacheShown}%`}
        </span>
      </Typography.Text>
    </Tooltip>
  );
}