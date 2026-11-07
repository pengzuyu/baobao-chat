/**
 * 摄入状态徽标（D07 §3.6 IngestBadge 的 v0.1 三态裁剪：
 * processing 灰蓝 / ready 绿 / failed 红；五态细分随阶段二 job 表）。
 */

import type { DocStatus } from '../model/types';

const BADGE: Record<DocStatus, { label: string; cls: string }> = {
  processing: { label: '⏳ 摄入中', cls: 'kb-badge--processing' },
  ready: { label: '✅ 就绪', cls: 'kb-badge--ready' },
  failed: { label: '❌ 失败', cls: 'kb-badge--failed' },
};

export function IngestBadge({ status, version }: { status: DocStatus; version?: number }) {
  const b = BADGE[status] ?? BADGE.processing;
  return (
    <span className={`kb-badge ${b.cls}`} data-testid={`kb-badge-${status}`}>
      {b.label}
      {status === 'ready' && version ? ` v${version}` : ''}
    </span>
  );
}
