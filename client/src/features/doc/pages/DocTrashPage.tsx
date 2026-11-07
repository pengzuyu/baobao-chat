/**
 * 回收站页（PDOC-07 务实版，路由 /doc/trash）：
 * - 列表：标题/删除时间（updated_at 软删时间）/剩余天数（ceil((purge_at-now)/86400)）/恢复
 * - 恢复成功 toast（同名冲突时服务端已加" (恢复)"后缀，toast 透出新名）
 * - 六态：loading / empty / error / offline；彻底删除/清空回收站（doc:trash:purge）
 *   阶段二随保留期定时任务，登记
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useDocTrash, useRestoreDocFromTrash } from '../api/hooks';
import { DocToast, type DocToastState } from '../components/DocToast';

/** 剩余天数（到期自动彻底删除；D05 §3.7 口径） */
function daysLeft(purgeAt?: number): number {
  if (!purgeAt) return 0;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / 86_400_000));
}

export function DocTrashPage() {
  const navigate = useNavigate();
  const trashQuery = useDocTrash();
  const restoreMut = useRestoreDocFromTrash();
  const [toast, setToast] = useState<DocToastState | null>(null);
  const connStatus = useConnectionStore((s) => s.status);

  const items = trashQuery.data?.items ?? [];

  const state: ViewState | 'ok' = trashQuery.isPending
    ? 'loading'
    : trashQuery.isError
      ? 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  const doRestore = (id: string, title: string) => {
    restoreMut.mutate(id, {
      onSuccess: (r) => {
        setToast({
          ok: true,
          text: r.renamed ? `已恢复（同名冲突，新名《${r.file.title}》）` : `已恢复《${title}》`,
        });
      },
      onError: () => setToast({ ok: false, text: '恢复失败（条目可能已过期）' }),
    });
  };

  return (
    <div className="doc-page doc-trash-page" data-testid="doc-trash-page">
      <header className="doc-page__header">
        <h1 className="doc-page__title">
          <Trash2 size={16} aria-hidden />
          回收站（{items.length}）
        </h1>
        <span className="doc-page__hint">保留期 30 天，到期自动彻底删除（彻底删除/清空阶段二）</span>
        <Button variant="secondary" onClick={() => navigate('/doc')} data-testid="doc-trash-back">
          <ArrowLeft size={14} /> 返回文档中心
        </Button>
      </header>

      <main className="doc-list-pane">
        <StateView
          state={state}
          skeleton={<SkeletonList count={4} />}
          error={trashQuery.error}
          onRetry={() => void trashQuery.refetch()}
          emptyText="回收站是空的"
          offlineText="离线中，恢复操作暂不可用"
        >
          {state === 'ok' || state === 'offline' ? (
            <div className="doc-table" data-testid="doc-trash-table">
              <div className="doc-table__row doc-table__row--head">
                <span className="doc-table__cell doc-table__cell--title">标题</span>
                <span className="doc-table__cell">删除时间</span>
                <span className="doc-table__cell">剩余天数</span>
                <span className="doc-table__cell doc-table__cell--ops">操作</span>
              </div>
              {items.map((f) => (
                <div key={f.id} className="doc-table__row" data-testid="doc-trash-row">
                  <span className="doc-table__cell doc-table__cell--title">
                    <span className="doc-table__name">{f.title}</span>
                    <span className="doc-table__sub">v{f.current_version}</span>
                  </span>
                  <span className="doc-table__cell">{formatListTime(f.updated_at)}</span>
                  <span className="doc-table__cell">
                    <span className="doc-days-badge" data-testid="doc-days-left">
                      {daysLeft(f.purge_at)} 天
                    </span>
                  </span>
                  <span className="doc-table__cell doc-table__cell--ops">
                    <Button
                      variant="secondary"
                      data-testid="doc-restore-from-trash"
                      loading={restoreMut.isPending && restoreMut.variables === f.id}
                      disabled={connStatus === 'offline'}
                      onClick={() => doRestore(f.id, f.title)}
                    >
                      <RotateCcw size={13} /> 恢复
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </StateView>
      </main>

      <DocToast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
