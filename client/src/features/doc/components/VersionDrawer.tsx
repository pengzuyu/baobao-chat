/**
 * 版本时间线抽屉（PDOC-06 务实版：v3 版本号/类型徽标/时间/恢复按钮；
 * 下载票据与双版对比阶段二，登记）。
 */

import { ApiError, getErrorText } from '../../../shared/api/http';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import type { DocVersion } from '../model/types';

const SNAP_LABEL: Record<string, string> = {
  create: '创建',
  manual: '手动',
  restore: '恢复',
  auto: '自动',
  close: '关闭',
  import: '导入',
};

export function VersionDrawer(props: {
  title: string;
  currentVersion: number;
  versions: DocVersion[];
  loading: boolean;
  error: unknown;
  restoring: number | null;
  onRestore: (version: number) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="doc-drawer-mask" data-testid="doc-version-drawer" onClick={props.onClose}>
      <aside className="doc-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="doc-drawer__head">
          <div className="doc-drawer__title">版本历史 · {props.title}</div>
          <div className="doc-drawer__sub">当前 v{props.currentVersion} · 恢复将生成新版本（不覆盖既有版本）</div>
          <button type="button" className="doc-link-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="doc-drawer__body">
          {props.loading ? (
            <SkeletonList count={4} />
          ) : props.error ? (
            <div className="doc-inline-error">
              {props.error instanceof ApiError ? getErrorText(props.error.code) : '版本线加载失败'}
              <button type="button" className="doc-link-btn" onClick={props.onRetry}>
                重试
              </button>
            </div>
          ) : props.versions.length === 0 ? (
            <div className="doc-drawer__empty">尚无版本</div>
          ) : (
            <ol className="doc-timeline" data-testid="doc-version-list">
              {props.versions.map((v) => (
                <li
                  key={v.version}
                  className={`doc-timeline__item${v.version === props.currentVersion ? ' doc-timeline__item--current' : ''}`}
                  data-testid="doc-version-item"
                >
                  <span className="doc-timeline__dot" aria-hidden />
                  <div className="doc-timeline__main">
                    <div className="doc-timeline__head">
                      <span className="doc-timeline__ver">v{v.version}</span>
                      <span className={`doc-snap-badge doc-snap-badge--${v.snapshot_type}`}>
                        {SNAP_LABEL[v.snapshot_type] ?? v.snapshot_type}
                      </span>
                      {v.version === props.currentVersion ? <span className="doc-timeline__cur">当前</span> : null}
                    </div>
                    <div className="doc-timeline__meta">{formatListTime(v.created_at)}</div>
                  </div>
                  {v.version !== props.currentVersion ? (
                    <Button
                      variant="secondary"
                      data-testid={`doc-restore-btn-${v.version}`}
                      loading={props.restoring === v.version}
                      onClick={() => props.onRestore(v.version)}
                    >
                      恢复
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}
