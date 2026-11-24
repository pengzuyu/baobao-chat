/**
 * 默认模型解析（0023 多供应商）：settings.ai_default → 会话 model 直达引用。
 * 原内联于 AgentWorkbenchPage，2026-11-23 新建会话页（AgentComposeView）共用，
 * 挪出避免页面↔组件循环引用。
 */

import { fetchMeSettings, type AIDefaultSetting } from '../../settings/api/ai';

/** ai_default → 会话 model 直达引用（mode=org/解析失败 → undefined=档位别名） */
export async function resolveDefaultModel(): Promise<string | undefined> {
  try {
    const settings = await fetchMeSettings();
    const ai = settings.ai_default as AIDefaultSetting | undefined;
    if (ai?.mode === 'provider' && ai.providerId && ai.model) return `p:${ai.providerId}:${ai.model}`;
  } catch {
    /* mock 桥/未登录：回落档位 */
  }
  return undefined;
}
