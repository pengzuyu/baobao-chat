/**
 * 文档编辑页（PDOC-03 务实版：markdown 原生 textarea 壳层，路由 /doc/:id）：
 * - 编辑：textarea + 保存（Ctrl/Cmd+S / 按钮，乐观锁 base_version → 6004 冲突红条
 *   +「强制覆盖」（重取最新基线再存）/「加载最新」两出路）
 * - 预览：MarkdownLite 简版渲染（标题/列表/代码块/引用/粗体/行内码，登记）
 * - 版本时间线抽屉（恢复=restore 快照新版本，正文回写）
 * - 重命名（6015 内联）/ 移入回收站（toast+返回）/ 分享占位（share_id+7d 假 URL）
 * - 发送 doc_card 到会话（WS msg.send；im 气泡简版渲染——06 §4.8 联动 v0.1）
 * - 六态：loading / error（6005 文案+返回）/ offline（遮罩+禁存）/ degraded 黄条 /
 *   forbidden（6001 防御接线）/ ok
 * 不做（阶段二登记）：WOPI iframe 会话/心跳/token 滚动、协作头像 presence、水印、
 * @提及、自动快照（auto/close）、版本对比/下载。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Eye,
  FileText,
  History,
  PencilLine,
  Send,
  Share2,
  Trash2,
} from 'lucide-react';
import { qk } from '../../../shared/api/keys';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonBlock } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { fetchConvsForCard, fetchDocFile, sendDocCard, shareDoc } from '../api/doc';
import { useDocFile, useDocVersions, useRenameDoc, useRestoreDocVersion, useSaveDocContent, useTrashDoc } from '../api/hooks';
import { pushRecent, removeRecent, touchRecent } from '../api/recent';
import { DocToast, type DocToastState } from '../components/DocToast';
import { MarkdownLite } from '../components/MarkdownLite';
import { VersionDrawer } from '../components/VersionDrawer';
import type { ShareResp } from '../model/types';

export function DocEditorPage() {
  const { docId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const docQuery = useDocFile(docId || null);
  const doc = docQuery.data;

  const [content, setContent] = useState('');
  const [baseVersion, setBaseVersion] = useState(0);
  const [serverContent, setServerContent] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [conflict, setConflict] = useState(false); // 6004 红条态
  const [conflictMsg, setConflictMsg] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<DocToastState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [renameErr, setRenameErr] = useState('');
  const [share, setShare] = useState<ShareResp | null>(null);
  const [cardOpen, setCardOpen] = useState(false);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);

  const saveMut = useSaveDocContent();
  const restoreMut = useRestoreDocVersion();
  const renameMut = useRenameDoc();
  const trashMut = useTrashDoc();
  const versionsQuery = useDocVersions(drawerOpen ? (docId || null) : null);

  // 服务端快照 → 本地态同步（新建进入/保存回执/恢复回写/重命名后失效重拉均走此通道；
  // 快照键 updated_at+version 变化才覆写，避免 query 后台刷新抖动打字内容）
  const syncKey = doc ? `${doc.id}:${doc.updated_at}:${doc.current_version}` : '';
  const lastSyncRef = useRef('');
  useEffect(() => {
    if (!doc || syncKey === lastSyncRef.current) return;
    lastSyncRef.current = syncKey;
    setContent(doc.content_md ?? '');
    setServerContent(doc.content_md ?? '');
    setBaseVersion(doc.current_version);
    setConflict(false);
    pushRecent(doc.id, doc.title, doc.current_version);
  }, [doc, syncKey]);

  const dirty = content !== serverContent;

  /** 保存（乐观锁）：成功重置基线；6004 → 冲突红条 */
  const doSave = useCallback(
    (overrideBase?: number) => {
      if (!doc || connStatus === 'offline') return;
      const base = overrideBase ?? baseVersion;
      setConflict(false);
      saveMut.mutate(
        { id: doc.id, baseVersion: base, contentMd: content },
        {
          onSuccess: (r) => {
            setBaseVersion(r.next_version);
            setToast({ ok: true, text: `已保存 v${r.next_version}` });
          },
          onError: (err) => {
            if (err instanceof ApiError && err.code === 6004) {
              setConflict(true);
              setConflictMsg(getErrorText(6004));
            } else {
              setToast({ ok: false, text: err instanceof ApiError ? getErrorText(err.code) : '保存失败' });
            }
          },
        },
      );
    },
    [doc, content, baseVersion, saveMut, connStatus],
  );

  /** 强制覆盖：重取最新详情拿新基线 → 以最新基线落本端内容（06 §7.1"以新基线重开"口径） */
  const doForceSave = async () => {
    if (!doc) return;
    const latest = await qc.fetchQuery({
      queryKey: qk.doc.file(doc.id),
      queryFn: () => fetchDocFile(doc.id),
      staleTime: 0,
    });
    doSave(latest.current_version);
  };

  /** 加载最新：放弃本端改动，服务端正文覆写本地（fetchQuery 会更新缓存触发 effect 重同步） */
  const doReloadLatest = async () => {
    lastSyncRef.current = ''; // 强制 effect 重新覆写
    await qc.fetchQuery({
      queryKey: qk.doc.file(docId),
      queryFn: () => fetchDocFile(docId),
      staleTime: 0,
    });
    setConflict(false);
  };

  // Ctrl/Cmd+S（textarea 与页面级兜底）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && mode === 'edit') doSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, mode, doSave]);

  const doRestore = (version: number) => {
    if (!doc) return;
    restoreMut.mutate(
      { id: doc.id, version },
      {
        onSuccess: (r) => {
          lastSyncRef.current = ''; // 触发 effect 以服务端回写正文重同步
          void qc.invalidateQueries({ queryKey: qk.doc.file(doc.id) });
          setToast({ ok: true, text: `已恢复 v${version}：生成新版本 v${r.new_version_no}，正文已回写` });
        },
        onError: (err) => setToast({ ok: false, text: err instanceof ApiError ? getErrorText(err.code) : '恢复失败' }),
      },
    );
  };

  const doRename = () => {
    if (!doc) return;
    const title = renameVal.trim();
    if (!title || title === doc.title) {
      setRenaming(false);
      return;
    }
    setRenameErr('');
    renameMut.mutate(
      { id: doc.id, title },
      {
        onSuccess: (d) => {
          touchRecent(d.id, { title: d.title });
          setRenaming(false);
        },
        onError: (err) => setRenameErr(err instanceof ApiError && err.code === 6015 ? '同名文档已存在' : '重命名失败'),
      },
    );
  };

  const doTrash = () => {
    if (!doc) return;
    trashMut.mutate(doc.id, {
      onSuccess: () => {
        removeRecent(doc.id);
        setToast({ ok: true, text: '已移入回收站（30 天内可恢复）' });
        navigate('/doc');
      },
    });
  };

  const doShare = async () => {
    try {
      const res = await shareDoc(docId);
      setShare(res);
    } catch (err) {
      setToast({ ok: false, text: err instanceof ApiError ? getErrorText(err.code) : '分享失败' });
    }
  };

  // 六态判定（详情查询）
  const apiErr = docQuery.error instanceof ApiError ? docQuery.error : null;
  const forbidden = !!apiErr && (apiErr.code === 6001 || apiErr.code === 2003);
  const state: ViewState | 'ok' = docQuery.isPending
    ? 'loading'
    : docQuery.isError && forbidden
      ? 'forbidden'
      : docQuery.isError
        ? 'error'
        : connStatus === 'offline'
          ? 'offline'
          : degradedText
            ? 'degraded'
            : 'ok';

  const savedLabel = useMemo(() => {
    if (conflict) return '版本冲突（基线 v' + baseVersion + ' 已落后）';
    if (dirty) return '有未保存修改';
    return `已保存 v${baseVersion}`;
  }, [conflict, dirty, baseVersion]);

  if (state === 'loading') {
    return (
      <div className="doc-editor" data-testid="doc-editor-page">
        <div className="doc-editor__loading">
          <SkeletonBlock height={46} />
          <SkeletonBlock height={320} />
        </div>
      </div>
    );
  }
  if (state !== 'ok' && state !== 'offline' && state !== 'degraded') {
    return (
      <div className="doc-editor" data-testid="doc-editor-page">
        <StateView
          state={state}
          error={docQuery.error}
          onRetry={() => void docQuery.refetch()}
          forbiddenText="无权限访问该文档"
        />
        <div className="doc-editor__back-row">
          <Button variant="secondary" onClick={() => navigate('/doc')}>
            <ArrowLeft size={14} /> 返回文档中心
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-editor" data-testid="doc-editor-page">
      <header className="doc-editor__bar">
        <button type="button" className="doc-icon-btn" title="返回" onClick={() => navigate('/doc')}>
          <ArrowLeft size={16} />
        </button>
        {renaming ? (
          <span className="doc-editor__rename">
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
                if (e.key === 'Enter') doRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
            <button type="button" className="doc-link-btn" onClick={doRename}>
              保存
            </button>
            <button type="button" className="doc-link-btn" onClick={() => setRenaming(false)}>
              取消
            </button>
            {renameErr ? <span className="doc-inline-error" data-testid="doc-rename-error">{renameErr}</span> : null}
          </span>
        ) : (
          <button
            type="button"
            className="doc-editor__title"
            data-testid="doc-editor-title"
            title="点击重命名"
            onClick={() => {
              setRenaming(true);
              setRenameVal(doc?.title ?? '');
            }}
          >
            <FileText size={15} aria-hidden />
            <span>{doc?.title}</span>
            <span className="doc-ver-badge">v{baseVersion}</span>
            <PencilLine size={12} aria-hidden />
          </button>
        )}

        <div className="doc-editor__ops">
          <div className="doc-seg" data-testid="doc-mode-seg">
            <button
              type="button"
              className={`doc-seg__btn${mode === 'edit' ? ' doc-seg__btn--active' : ''}`}
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
            <button
              type="button"
              className={`doc-seg__btn${mode === 'preview' ? ' doc-seg__btn--active' : ''}`}
              data-testid="doc-preview-toggle"
              onClick={() => setMode('preview')}
            >
              <Eye size={13} aria-hidden /> 预览
            </button>
          </div>
          <Button
            variant="secondary"
            onClick={() => setDrawerOpen(true)}
            data-testid="doc-versions-btn"
            title="版本时间线"
          >
            <History size={14} /> 版本
          </Button>
          <Button variant="secondary" onClick={() => void doShare()} data-testid="doc-share-btn" title="分享（占位）">
            <Share2 size={14} /> 分享
          </Button>
          <Button variant="secondary" onClick={() => setCardOpen(true)} data-testid="doc-sendcard-btn" title="发送文档卡片到会话">
            <Send size={14} /> 发卡片
          </Button>
          {mode === 'edit' ? (
            <Button
              onClick={() => doSave()}
              loading={saveMut.isPending}
              disabled={!dirty || connStatus === 'offline'}
              data-testid="doc-save-btn"
              title="保存（Ctrl/Cmd+S）"
            >
              保存
            </Button>
          ) : null}
          <button type="button" className="doc-icon-btn doc-icon-btn--danger" data-testid="doc-trash-btn" title="移入回收站" onClick={doTrash}>
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      {/* 冲突红条（6004）：强制覆盖（以最新基线重存本端内容）/ 加载最新（放弃本端改动） */}
      {conflict ? (
        <div className="doc-conflict-bar" data-testid="doc-conflict-bar" role="alert">
          <span className="doc-conflict-bar__text">{conflictMsg}（你的基线 v{baseVersion}，文档已被其他窗口修改）</span>
          <button type="button" className="doc-conflict-bar__btn" data-testid="doc-force-save" onClick={() => void doForceSave()}>
            强制覆盖
          </button>
          <button type="button" className="doc-conflict-bar__btn doc-conflict-bar__btn--ghost" data-testid="doc-reload-latest" onClick={() => void doReloadLatest()}>
            加载最新（放弃本地修改）
          </button>
        </div>
      ) : null}

      <div className="doc-editor__body">
        <StateView
          state={state}
          offlineText="离线中：编辑暂存本端，恢复连接后可保存"
          degradedText={degradedText ?? '文档服务降级中'}
        >
          {mode === 'edit' ? (
            <textarea
              className="doc-editor__textarea"
              data-testid="doc-editor-textarea"
              value={content}
              spellCheck={false}
              placeholder="# 标题&#10;&#10;markdown 正文…（Ctrl/Cmd+S 保存）"
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  if (dirty) doSave();
                }
              }}
            />
          ) : (
            <div className="doc-editor__preview">
              <MarkdownLite md={content} />
            </div>
          )}
        </StateView>
      </div>

      <footer className="doc-editor__foot">
        <span data-testid="doc-save-state">{savedLabel}</span>
        {doc ? <span>更新于 {formatListTime(doc.updated_at)}</span> : null}
        <span className="doc-editor__foot-hint">markdown 原生文档 · 阶段一（协作编辑/WOPI 阶段二）</span>
      </footer>

      {drawerOpen && doc ? (
        <VersionDrawer
          title={doc.title}
          currentVersion={baseVersion}
          versions={versionsQuery.data?.items ?? []}
          loading={versionsQuery.isPending}
          error={versionsQuery.error}
          restoring={restoreMut.isPending ? restoreMut.variables?.version ?? null : null}
          onRestore={doRestore}
          onRetry={() => void versionsQuery.refetch()}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      {share ? (
        <div className="doc-modal-mask" data-testid="doc-share-modal" onClick={() => setShare(null)}>
          <div className="doc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="doc-modal__head">
              分享《{doc?.title}》（阶段一占位）
              <button type="button" className="doc-link-btn" onClick={() => setShare(null)}>
                关闭
              </button>
            </div>
            <div className="doc-modal__body">
              <label className="doc-field">
                链接（占位——外链解析页阶段二）
                <input className="doc-input" readOnly value={share.url} data-testid="doc-share-url" />
              </label>
              <label className="doc-field">
                share_id
                <input className="doc-input" readOnly value={share.share_id} />
              </label>
              <label className="doc-field">
                有效期至
                <input className="doc-input" readOnly value={new Date(share.expires_at).toLocaleString()} />
              </label>
              <div className="doc-modal__foot">
                <span className="doc-modal__hint">{share.note}</span>
                <Button
                  variant="secondary"
                  onClick={() => void navigator.clipboard?.writeText(share.url).then(() => setToast({ ok: true, text: '链接已复制' }))}
                >
                  复制链接
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {cardOpen ? (
        <SendCardModal docId={docId} title={doc?.title ?? ''} version={baseVersion} onClose={() => setCardOpen(false)} onSent={() => setToast({ ok: true, text: '文档卡片已发送到会话' })} />
      ) : null}

      <DocToast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/** 发送 doc_card 到会话弹层（conv 列表经 REST /convs；发送走 WS msg.send） */
function SendCardModal(props: {
  docId: string;
  title: string;
  version: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const [convs, setConvs] = useState<Array<{ id: string; name: string }> | null>(null);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState('');

  useEffect(() => {
    let alive = true;
    fetchConvsForCard()
      .then((list) => alive && setConvs(list))
      .catch(() => alive && setConvs([]));
    return () => {
      alive = false;
    };
  }, []);

  const doSend = async (convId: string) => {
    setErr('');
    setSending(convId);
    try {
      await sendDocCard(convId, props.docId, props.title, props.version);
      props.onSent();
      props.onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? getErrorText(e.code) : '发送失败');
    } finally {
      setSending('');
    }
  };

  return (
    <div className="doc-modal-mask" data-testid="doc-sendcard-modal" onClick={props.onClose}>
      <div className="doc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="doc-modal__head">
          发送文档卡片《{props.title}》
          <button type="button" className="doc-link-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="doc-modal__body">
          {convs === null ? (
            <SkeletonBlock height={60} />
          ) : convs.length === 0 ? (
            <div className="doc-modal__hint">暂无可发送的会话</div>
          ) : (
            convs.map((c) => (
              <button
                key={c.id}
                type="button"
                className="doc-conv-row"
                data-testid="doc-sendcard-conv"
                disabled={sending !== ''}
                onClick={() => void doSend(c.id)}
              >
                <span className="doc-conv-row__name">{c.name}</span>
                <span className="doc-conv-row__hint">{sending === c.id ? '发送中…' : '发送 doc_card'}</span>
              </button>
            ))
          )}
          {err ? <div className="doc-inline-error">{err}</div> : null}
        </div>
      </div>
    </div>
  );
}
