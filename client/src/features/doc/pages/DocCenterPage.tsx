/**
 * 文档中心首页（PDOC-01/02 务实版合并页，路由 /doc）：
 * - 左树：搜索框 + [+ 新建] + 「最近打开」（localStorage LRU）+「全部文档」分组 + 回收站入口
 * - 右栏：文档列表（标题/更新时间/版本数 vN）+ 行内重命名 + 移入回收站（toast）
 * - 六态：loading 骨架 / empty（新建 CTA）/ error（码文案+重试；6001/2003 → forbidden）/
 *   offline 遮罩 / degraded 黄条（连接降级只读浏览）/ ok
 * 不做（阶段二登记）：scope 四视图（与我共享/部门/公司）、文件夹树（doc_folder）、
 * 视图切换/列配置/批量操作/虚拟滚动、右键菜单（改行内按钮）。
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock3, FileText, FolderOpen, PencilLine, Plus, Search, Trash2 } from 'lucide-react';
import { ApiError } from '../../../shared/api/http';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useCreateDoc, useDocFiles, useDocTrash, useRenameDoc, useTrashDoc } from '../api/hooks';
import { listRecent, pushRecent, removeRecent, touchRecent } from '../api/recent';
import { DocToast, type DocToastState } from '../components/DocToast';
import type { DocFile } from '../model/types';

export function DocCenterPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState(''); // 已提交搜索词（400ms 防抖简化为 Enter/失焦提交，登记）
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [createErr, setCreateErr] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [renameErr, setRenameErr] = useState('');
  const [toast, setToast] = useState<DocToastState | null>(null);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);
  const filesQuery = useDocFiles(keyword);
  const trashQuery = useDocTrash();
  const createDoc = useCreateDoc();
  const renameDoc = useRenameDoc();
  const trashDoc = useTrashDoc();

  const files = filesQuery.data?.items ?? [];
  const trashCount = trashQuery.data?.items.length ?? 0;
  const recent = useMemo(() => listRecent().filter((r) => files.some((f) => f.id === r.id)), [files]);

  const doSearch = () => setKeyword(input.trim());

  const openDoc = (f: DocFile) => {
    pushRecent(f.id, f.title, f.current_version);
    navigate(`/doc/${f.id}`);
  };

  const doCreate = () => {
    const title = newTitle.trim();
    if (!title) return;
    setCreateErr('');
    createDoc.mutate(title, {
      onSuccess: (d) => {
        setCreating(false);
        setNewTitle('');
        pushRecent(d.id, d.title, d.current_version);
        navigate(`/doc/${d.id}`);
      },
      onError: (err) => {
        setCreateErr(err instanceof ApiError && err.code === 6015 ? '同名文档已存在' : '创建失败，请重试');
      },
    });
  };

  const doRename = (f: DocFile) => {
    const title = renameVal.trim();
    if (!title || title === f.title) {
      setRenamingId(null);
      return;
    }
    setRenameErr('');
    renameDoc.mutate(
      { id: f.id, title },
      {
        onSuccess: (d) => {
          touchRecent(d.id, { title: d.title });
          setRenamingId(null);
          setToast({ ok: true, text: '已重命名' });
        },
        onError: (err) => {
          setRenameErr(err instanceof ApiError && err.code === 6015 ? '同名文档已存在' : '重命名失败');
        },
      },
    );
  };

  const doTrash = (f: DocFile) => {
    trashDoc.mutate(f.id, {
      onSuccess: () => {
        removeRecent(f.id);
        setToast({ ok: true, text: `已移入回收站（30 天内可恢复）：《${f.title}》` });
      },
      onError: () => setToast({ ok: false, text: '移入回收站失败' }),
    });
  };

  // 六态判定：error 且码为 2003/6001 → forbidden（v0.1 owner 私有下理论不达，防御性接线）
  const apiErr = filesQuery.error instanceof ApiError ? filesQuery.error : null;
  const forbidden = !!apiErr && (apiErr.code === 2003 || apiErr.code === 6001);
  const state: ViewState | 'ok' = filesQuery.isPending
    ? 'loading'
    : filesQuery.isError && forbidden
      ? 'forbidden'
      : filesQuery.isError
        ? 'error'
        : files.length === 0
          ? 'empty'
          : connStatus === 'offline'
            ? 'offline'
            : degradedText
              ? 'degraded'
              : 'ok';

  return (
    <div className="doc-page" data-testid="doc-center-page">
      <header className="doc-page__header">
        <h1 className="doc-page__title">
          <FileText size={16} aria-hidden />
          文档中心
        </h1>
        <div className="doc-search-box">
          <Search size={15} aria-hidden />
          <input
            className="doc-search-box__input"
            data-testid="doc-search-input"
            placeholder="搜索文档（Enter 执行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch();
              if (e.key === 'Escape') {
                setInput('');
                setKeyword('');
              }
            }}
          />
          {keyword ? (
            <button
              type="button"
              className="doc-link-btn"
              onClick={() => {
                setInput('');
                setKeyword('');
              }}
            >
              清除
            </button>
          ) : null}
        </div>
      </header>

      <div className="doc-page__body">
        {/* ── 左树：最近打开 + 全部文档 + 回收站 ── */}
        <aside className="doc-tree" data-testid="doc-tree">
          <div className="doc-tree__head">
            <span>我的文档</span>
            <button type="button" className="doc-link-btn" data-testid="doc-new-btn" onClick={() => setCreating(true)}>
              <Plus size={13} /> 新建
            </button>
          </div>

          {creating ? (
            <div className="doc-tree__create">
              <input
                className="doc-input"
                data-testid="doc-new-title-input"
                placeholder="文档标题"
                autoFocus
                value={newTitle}
                onChange={(e) => {
                  setNewTitle(e.target.value);
                  setCreateErr('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doCreate();
                  if (e.key === 'Escape') setCreating(false);
                }}
              />
              <Button onClick={doCreate} loading={createDoc.isPending} data-testid="doc-new-submit">
                创建
              </Button>
              <Button variant="text" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
          ) : null}
          {createErr ? <div className="doc-inline-error" data-testid="doc-create-error">{createErr}</div> : null}

          <div className="doc-tree__group">
            <div className="doc-tree__label">
              <Clock3 size={12} aria-hidden /> 最近打开（{recent.length}）
            </div>
            {recent.length === 0 ? (
              <div className="doc-tree__hint">打开文档后出现在这里</div>
            ) : (
              recent.map((r) => {
                const f = files.find((x) => x.id === r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="doc-tree__item"
                    data-testid="doc-recent-item"
                    onClick={() => f && openDoc(f)}
                    title={r.title}
                  >
                    <span className="doc-tree__name">{r.title}</span>
                    <span className="doc-tree__meta">v{f ? f.current_version : r.version}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="doc-tree__group">
            <div className="doc-tree__label">
              <FolderOpen size={12} aria-hidden /> 全部文档（{files.length}）
            </div>
            {state === 'ok' || state === 'offline' || state === 'degraded'
              ? files.slice(0, 30).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="doc-tree__item"
                    onClick={() => openDoc(f)}
                    title={f.title}
                  >
                    <span className="doc-tree__name">{f.title}</span>
                    <span className="doc-tree__meta">{formatListTime(f.updated_at)}</span>
                  </button>
                ))
              : null}
          </div>

          <button
            type="button"
            className="doc-tree__trash"
            data-testid="doc-trash-entry"
            onClick={() => navigate('/doc/trash')}
          >
            <Trash2 size={13} aria-hidden /> 回收站
            {trashCount > 0 ? <span className="doc-tree__badge">{trashCount}</span> : null}
          </button>
        </aside>

        {/* ── 右栏：文档列表 ── */}
        <main className="doc-list-pane">
          <StateView
            state={state}
            skeleton={<SkeletonList count={6} />}
            error={filesQuery.error}
            onRetry={() => void filesQuery.refetch()}
            emptyText={keyword ? `未找到与「${keyword}」匹配的文档` : '这里还没有文档：点左侧「新建」创建第一篇'}
            forbiddenText="无权限访问文档中心"
            offlineText="离线中，仅可浏览已加载列表"
            degradedText={degradedText ?? '文档服务降级中，仅可浏览'}
          >
            {state === 'ok' || state === 'offline' || state === 'degraded' ? (
              <div className="doc-table" data-testid="doc-file-table">
                <div className="doc-table__row doc-table__row--head">
                  <span className="doc-table__cell doc-table__cell--title">标题</span>
                  <span className="doc-table__cell">更新时间</span>
                  <span className="doc-table__cell">版本</span>
                  <span className="doc-table__cell doc-table__cell--ops">操作</span>
                </div>
                {files.map((f) =>
                  renamingId === f.id ? (
                    <div key={f.id} className="doc-table__row doc-table__row--renaming">
                      <span className="doc-table__cell doc-table__cell--title">
                        <input
                          className="doc-input"
                          data-testid="doc-rename-input"
                          autoFocus
                          value={renameVal}
                          onChange={(e) => {
                            setRenameVal(e.target.value);
                            setRenameErr('');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') doRename(f);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                        {renameErr ? <span className="doc-inline-error" data-testid="doc-rename-error">{renameErr}</span> : null}
                      </span>
                      <span className="doc-table__cell">
                        <button type="button" className="doc-link-btn" onClick={() => doRename(f)}>
                          保存
                        </button>
                        <button type="button" className="doc-link-btn" onClick={() => setRenamingId(null)}>
                          取消
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div key={f.id} className="doc-table__row" data-testid="doc-file-row">
                      <button
                        type="button"
                        className="doc-table__cell doc-table__cell--title doc-table__title-btn"
                        data-testid="doc-open-btn"
                        onClick={() => openDoc(f)}
                        title="打开文档"
                      >
                        <FileText size={14} aria-hidden />
                        <span className="doc-table__name">{f.title}</span>
                      </button>
                      <span className="doc-table__cell">{formatListTime(f.updated_at)}</span>
                      <span className="doc-table__cell">
                        <span className="doc-ver-badge" data-testid="doc-ver-badge">
                          v{f.current_version}
                        </span>
                      </span>
                      <span className="doc-table__cell doc-table__cell--ops">
                        <button
                          type="button"
                          className="doc-icon-btn"
                          title="重命名"
                          onClick={() => {
                            setRenamingId(f.id);
                            setRenameVal(f.title);
                            setRenameErr('');
                          }}
                        >
                          <PencilLine size={14} />
                        </button>
                        <button
                          type="button"
                          className="doc-icon-btn doc-icon-btn--danger"
                          data-testid="doc-trash-btn"
                          title="移入回收站"
                          onClick={() => doTrash(f)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                  ),
                )}
              </div>
            ) : null}
          </StateView>
        </main>
      </div>

      <DocToast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
