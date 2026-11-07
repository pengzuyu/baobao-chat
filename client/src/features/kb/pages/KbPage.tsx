/**
 * PKB-01/02/04 合并最小可用页（D07 阶段一务实版，路由 /kb）：
 * - 顶部检索框（POST /kb/query）：结果卡 = 标题 + heading 锚点 + <mark> 高亮 snippet +
 *   [展开上下文]（chunks?around=seq 原地展开）+ [查看文档]（开详情抽屉）
 * - 左栏空间列表：个人/公司分组（dept 阶段二）+ 配额占用 + 新建空间（dept|company）
 * - 右栏文档列表：[+上传]（粘贴文本 / 文件上传→file_id 引用复用 D06 files API）
 *   + [☰新建目录]（7014 内联报错）+ 文档卡（标题/状态徽标/来源/大小/时间）
 * - 详情抽屉：元信息 + 大纲锚点（点击滚动）+ 分块正文 + [↻重新摄入]（失败重试入口）
 * - 六态：loading 骨架 / empty / error（错误码文案+重试）/ offline 遮罩 /
 *   forbidden（7002 文案）/ degraded（检索响应 degraded=vector 黄条）
 */

import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BrainCircuit, CornerDownRight, FolderPlus, Plus, RefreshCw, Search, Upload } from 'lucide-react';
import { formatListTime } from '../../../shared/utils/time';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { fetchChunksAround, fetchDoc, queryKb } from '../api/kb';
import { useChunks, useCreateDir, useCreateSpace, useIngest, useNodes, useOutline, useReingest, useSpaces } from '../api/hooks';
import { uploadFile } from '../../im/api/files';
import { HighlightText } from '../components/HighlightText';
import { IngestBadge } from '../components/IngestBadge';
import type { KbChunk, KbDoc, KbQueryHit, KbSpace } from '../model/types';

/** 空间分组顺序与标题（dept 阶段二——列表透出但标注未接入） */
const GROUPS: Array<{ type: KbSpace['space_type']; label: string }> = [
  { type: 'personal', label: '个人空间' },
  { type: 'dept', label: '部门空间' },
  { type: 'company', label: '公司空间' },
];

const SOURCE_LABEL: Record<KbDoc['source_type'], string> = {
  text: '粘贴文本',
  file: '文件引用',
  markdown: 'Markdown',
};

export function KbPage() {
  // ── 左栏：空间 ──
  const spacesQuery = useSpaces();
  const createSpace = useCreateSpace();
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceType, setNewSpaceType] = useState<KbSpace['space_type']>('company');

  // ── 右栏：目录 + 文档 ──
  const nodesQuery = useNodes(selectedSpace);
  const createDir = useCreateDir(selectedSpace ?? '');
  const ingest = useIngest(selectedSpace ?? '');
  const [dirName, setDirName] = useState('');
  const [dirError, setDirError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);

  // ── 检索 ──
  const [keyword, setKeyword] = useState('');
  const [searchText, setSearchText] = useState(''); // 已提交的查询
  const search = useMutation({ mutationFn: (kw: string) => queryKb({ keyword: kw, top_k: 10 }) });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [aroundMap, setAroundMap] = useState<Record<string, KbChunk[]>>({});

  // ── 详情抽屉 ──
  const [detailDoc, setDetailDoc] = useState<KbDoc | null>(null);
  const chunksQuery = useChunks(detailDoc?.id ?? null);
  const outlineQuery = useOutline(detailDoc?.id ?? null);
  const reingest = useReingest();
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const connStatus = useConnectionStore((s) => s.status);

  const spaces = spacesQuery.data ?? [];
  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, items: spaces.filter((s) => s.space_type === g.type) })),
    [spaces],
  );
  const current = spaces.find((s) => s.id === selectedSpace) ?? null;
  const docs = nodesQuery.data?.docs ?? [];
  const dirs = nodesQuery.data?.dirs ?? [];

  const spacesState: ViewState | 'ok' = spacesQuery.isPending
    ? 'loading'
    : spacesQuery.isError
      ? 'error'
      : spaces.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  const docsState: ViewState | 'ok' = !current
    ? 'empty'
    : nodesQuery.isPending
      ? 'loading'
      : nodesQuery.isError
        ? 'error'
        : docs.length === 0 && dirs.length === 0
          ? 'empty'
          : connStatus === 'offline'
            ? 'offline'
            : 'ok';

  const doSearch = () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearchText(kw);
    setExpanded({});
    search.mutate(kw);
  };

  const doCreateSpace = () => {
    const name = newSpaceName.trim();
    if (!name) return;
    createSpace.mutate(
      { type: newSpaceType, name },
      {
        onSuccess: (sp) => {
          setNewSpaceOpen(false);
          setNewSpaceName('');
          setSelectedSpace(sp.id);
        },
      },
    );
  };

  const doCreateDir = () => {
    const name = dirName.trim();
    if (!name || !selectedSpace) return;
    setDirError('');
    createDir.mutate(name, {
      onSuccess: () => setDirName(''),
      onError: (err) => {
        // 7014 同名冲突 → 内联红字（INT-KB-02）
        setDirError(err instanceof Error && err.message.includes('同名') ? err.message : '创建目录失败，请重试');
      },
    });
  };

  return (
    <div className="kb-page" data-testid="kb-page">
      <header className="kb-page__header">
        <h1 className="kb-page__title">
          <BrainCircuit size={16} aria-hidden />
          知识库
        </h1>
        <div className="kb-search-box">
          <Search size={15} aria-hidden />
          <input
            className="kb-search-box__input"
            data-testid="kb-search-input"
            placeholder="检索知识库（自然语言/关键词，Enter 执行）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch();
              if (e.key === 'Escape') setKeyword('');
            }}
          />
          <Button variant="secondary" onClick={doSearch} loading={search.isPending} data-testid="kb-search-btn">
            检索
          </Button>
        </div>
      </header>

      <div className="kb-page__body">
        {/* ── 左栏：空间列表 ── */}
        <aside className="kb-spaces" data-testid="kb-spaces">
          <div className="kb-spaces__head">
            <span>空间</span>
            <button type="button" className="kb-link-btn" onClick={() => setNewSpaceOpen((v) => !v)} data-testid="kb-new-space-btn">
              <Plus size={13} /> 新建空间
            </button>
          </div>
          {newSpaceOpen ? (
            <div className="kb-spaces__create">
              <select
                className="kb-select"
                value={newSpaceType}
                onChange={(e) => setNewSpaceType(e.target.value as KbSpace['space_type'])}
                aria-label="空间类型"
              >
                <option value="company">公司空间</option>
                <option value="dept">部门空间</option>
              </select>
              <input
                className="kb-input"
                placeholder="空间名称"
                value={newSpaceName}
                onChange={(e) => setNewSpaceName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doCreateSpace()}
              />
              <Button onClick={doCreateSpace} loading={createSpace.isPending}>
                创建
              </Button>
            </div>
          ) : null}
          {spacesState === 'ok' ? (
            grouped.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.type} className="kb-space-group">
                    <div className="kb-space-group__label">{g.label}</div>
                    {g.items.map((sp) => (
                      <button
                        key={sp.id}
                        type="button"
                        className={`kb-space-card${selectedSpace === sp.id ? ' kb-space-card--active' : ''}`}
                        data-testid="kb-space-card"
                        onClick={() => setSelectedSpace(sp.id)}
                      >
                        <span className="kb-space-card__name">{sp.name}</span>
                        <span className="kb-space-card__meta">
                          {sp.doc_count} 篇 · {fmtBytes(sp.used_bytes)}/{fmtBytes(sp.quota_bytes)}
                        </span>
                      </button>
                    ))}
                  </div>
                ),
            )
          ) : (
            <StateView
              state={spacesState}
              skeleton={<SkeletonList count={3} />}
              error={spacesQuery.error}
              onRetry={() => void spacesQuery.refetch()}
              emptyText="暂无可见空间"
            />
          )}
        </aside>

        {/* ── 右栏：检索结果 或 空间浏览 ── */}
        <main className="kb-main">
          {searchText ? (
            <SearchPanel
              keyword={searchText}
              isPending={search.isPending}
              isError={search.isError}
              error={search.error}
              items={search.data?.items ?? []}
              degraded={search.data?.degraded ?? []}
              tookMs={search.data?.took_ms ?? 0}
              expanded={expanded}
              onToggleExpand={async (hit) => {
                const key = `${hit.doc_id}#${hit.chunk_seq}`;
                if (expanded[key]) {
                  setExpanded((m) => ({ ...m, [key]: false }));
                  return;
                }
                const around = await fetchChunksAround(hit.doc_id, hit.chunk_seq);
                setExpanded((m) => ({ ...m, [key]: true }));
                setAroundMap((m) => ({ ...m, [key]: around }));
              }}
              aroundMap={aroundMap}
              onOpenDoc={async (docId) => {
                const d = await fetchDoc(docId);
                setDetailDoc(d);
              }}
              onRetry={() => search.mutate(searchText)}
              onExit={() => {
                setSearchText('');
                search.reset();
              }}
            />
          ) : (
            <section className="kb-browse">
              <div className="kb-browse__toolbar">
                <span className="kb-browse__title">{current ? current.name : '选择左侧空间浏览'}</span>
                {current ? (
                  <div className="kb-browse__actions">
                    <div className="kb-browse__mkdir">
                      <input
                        className="kb-input"
                        placeholder="新目录名"
                        value={dirName}
                        onChange={(e) => {
                          setDirName(e.target.value);
                          setDirError('');
                        }}
                        onKeyDown={(e) => e.key === 'Enter' && doCreateDir()}
                        data-testid="kb-dir-name-input"
                      />
                      <Button variant="secondary" onClick={doCreateDir} loading={createDir.isPending} data-testid="kb-mkdir-btn">
                        <FolderPlus size={13} /> 新建目录
                      </Button>
                    </div>
                    <Button onClick={() => setUploadOpen(true)} data-testid="kb-upload-btn">
                      <Upload size={13} /> 上传
                    </Button>
                  </div>
                ) : null}
              </div>
              {dirError ? <div className="kb-inline-error" data-testid="kb-dir-error">{dirError}</div> : null}

              {docsState !== 'ok' ? (
                <StateView
                  state={docsState}
                  skeleton={<SkeletonList count={5} />}
                  error={nodesQuery.error}
                  onRetry={() => void nodesQuery.refetch()}
                  emptyText={current ? '空空间：点「上传」粘贴文本或引用文件开始摄入' : '先在左侧选择一个空间'}
                />
              ) : (
                <div className="kb-doc-list" data-testid="kb-doc-list">
                  {dirs.map((d) => (
                    <div key={d.id} className="kb-doc-card kb-doc-card--dir">
                      <FolderPlus size={15} aria-hidden />
                      <span className="kb-doc-card__title">{d.name}</span>
                    </div>
                  ))}
                  {docs.map((d) => (
                    <button key={d.id} type="button" className="kb-doc-card" data-testid="kb-doc-card" onClick={() => setDetailDoc(d)}>
                      <span className="kb-doc-card__title">{d.title}</span>
                      <IngestBadge status={d.status} version={d.version} />
                      <span className="kb-doc-card__meta">
                        {SOURCE_LABEL[d.source_type]} · {fmtBytes(d.size)} · {formatListTime(d.updated_at)}
                      </span>
                      {d.status === 'failed' && d.error_msg ? (
                        <span className="kb-doc-card__error" title={d.error_msg}>
                          {d.error_msg}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {uploadOpen && current ? (
        <UploadModal
          space={current}
          loading={ingest.isPending}
          error={ingest.error}
          onSubmit={(payload) =>
            ingest.mutate(payload, {
              onSuccess: (doc) => {
                setUploadOpen(false);
                setDetailDoc(doc); // 摄入同步返回即终态：直接开抽屉看结果
              },
            })
          }
          onClose={() => setUploadOpen(false)}
        />
      ) : null}

      {detailDoc ? (
        <DocDrawer
          doc={detailDoc}
          chunks={chunksQuery.data ?? []}
          chunksPending={chunksQuery.isPending}
          outline={outlineQuery.data ?? []}
          reingesting={reingest.isPending}
          onReingest={() =>
            reingest.mutate(detailDoc.id, {
              onSuccess: (d) => setDetailDoc(d),
            })
          }
          onClose={() => setDetailDoc(null)}
          bodyRef={detailBodyRef}
        />
      ) : null}
    </div>
  );
}

/** 检索面板（PKB-04 结果卡流） */
function SearchPanel(props: {
  keyword: string;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  items: KbQueryHit[];
  degraded: string[];
  tookMs: number;
  expanded: Record<string, boolean>;
  aroundMap: Record<string, KbChunk[]>;
  onToggleExpand: (hit: KbQueryHit) => void;
  onOpenDoc: (docId: string) => void;
  onRetry: () => void;
  onExit: () => void;
}) {
  const { keyword, items, degraded, tookMs } = props;
  const state: ViewState | 'ok' = props.isPending
    ? 'loading'
    : props.isError
      ? 'error'
      : items.length === 0
        ? 'empty'
        : 'ok';
  return (
    <section className="kb-search-panel" data-testid="kb-search-panel">
      <div className="kb-search-panel__head">
        <span>
          「{keyword}」 命中 {items.length} · {tookMs}ms
        </span>
        <button type="button" className="kb-link-btn" onClick={props.onExit}>
          返回空间浏览
        </button>
      </div>
      {degraded.includes('vector') ? (
        <div className="kb-degraded-bar">语义检索暂不可用，已切换关键词模式</div>
      ) : null}
      {state !== 'ok' ? (
        <StateView
          state={state}
          skeleton={<SkeletonList count={3} />}
          error={props.error}
          onRetry={props.onRetry}
          emptyText="未找到相关内容：尝试更换关键词"
        />
      ) : (
        <div className="kb-hit-list">
          {items.map((hit) => {
            const key = `${hit.doc_id}#${hit.chunk_seq}`;
            return (
              <div key={key} className="kb-hit-card" data-testid="kb-hit-card">
                <div className="kb-hit-card__head">
                  <span className={`kb-space-badge kb-space-badge--${hit.space_type}`}>
                    {hit.space_type === 'company' ? '公司' : hit.space_type === 'dept' ? '部门' : '个人'}
                  </span>
                  <button type="button" className="kb-hit-card__title" onClick={() => props.onOpenDoc(hit.doc_id)}>
                    {hit.title}
                    {hit.heading_path ? ` · ${hit.heading_path}` : ''}
                  </button>
                  <span className="kb-hit-card__score">{hit.score.toFixed(4)}</span>
                </div>
                <div className="kb-hit-card__snippet">
                  <HighlightText text={hit.snippet} ranges={hit.highlight} />
                </div>
                <div className="kb-hit-card__actions">
                  <button type="button" className="kb-link-btn" onClick={() => void props.onToggleExpand(hit)} data-testid="kb-expand-btn">
                    <CornerDownRight size={12} /> {props.expanded[key] ? '收起上下文' : '展开上下文'}
                  </button>
                  <button type="button" className="kb-link-btn" onClick={() => props.onOpenDoc(hit.doc_id)}>
                    查看文档
                  </button>
                </div>
                {props.expanded[key] ? (
                  <div className="kb-hit-card__around">
                    {(props.aroundMap[key] ?? []).map((c) => (
                      <div key={c.seq} className="kb-hit-card__around-chunk">
                        <span className="kb-chunk-seq">#{c.seq}</span>
                        <span>{c.content}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 上传与摄入弹层（PKB-05 简版：粘贴文本 / 文件上传→file_id 引用） */
function UploadModal(props: {
  space: KbSpace;
  loading: boolean;
  error: unknown;
  onSubmit: (payload: { title?: string; text?: string; format?: 'text' | 'markdown'; file_id?: string }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'text' | 'file'>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [isMarkdown, setIsMarkdown] = useState(false);
  const [fileId, setFileId] = useState('');
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');

  const submitText = () => {
    if (!text.trim()) return;
    props.onSubmit({ title: title.trim() || undefined, text, format: isMarkdown ? 'markdown' : 'text' });
  };
  const submitFile = () => {
    if (!fileId) return;
    props.onSubmit({ title: title.trim() || fileName || undefined, file_id: fileId });
  };
  const pickFile = async (f: File | null) => {
    if (!f) return;
    setUploadErr('');
    setUploading(true);
    try {
      const res = await uploadFile(f); // D06 /files/upload（multipart 直传）
      setFileId(res.id);
      setFileName(res.name);
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="kb-modal-mask" data-testid="kb-upload-modal" onClick={props.onClose}>
      <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal__head">
          摄入到「{props.space.name}」
          <button type="button" className="kb-link-btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="kb-modal__tabs">
          <button type="button" className={`kb-tab${tab === 'text' ? ' kb-tab--active' : ''}`} onClick={() => setTab('text')}>
            粘贴文本
          </button>
          <button type="button" className={`kb-tab${tab === 'file' ? ' kb-tab--active' : ''}`} onClick={() => setTab('file')}>
            上传文件
          </button>
        </div>
        <label className="kb-field">
          标题（可选）
          <input className="kb-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="缺省取首个标题/首行" data-testid="kb-upload-title" />
        </label>
        {tab === 'text' ? (
          <>
            <label className="kb-field kb-field--grow">
              正文（按空行/标题分段，块 ≤800 字）
              <textarea
                className="kb-textarea"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'# 标题可作为大纲锚点\n\n正文第一段。\n\n正文第二段。'}
                data-testid="kb-upload-text"
              />
            </label>
            <label className="kb-check">
              <input type="checkbox" checked={isMarkdown} onChange={(e) => setIsMarkdown(e.target.checked)} />
              作为 Markdown（保留 # 标题结构）
            </label>
          </>
        ) : (
          <div className="kb-field kb-field--grow">
            文件（支持 txt / md / markdown；先上传得 file_id 再引用摄入）
            <label className="kb-file-pick" data-testid="kb-file-pick">
              <input type="file" accept=".txt,.md,.markdown" onChange={(e) => void pickFile(e.target.files?.[0] ?? null)} />
              {uploading ? '上传中…' : fileId ? `已上传：${fileName}（file_id=${fileId}）` : '点击选择文件'}
            </label>
            {uploadErr ? <div className="kb-inline-error">{uploadErr}</div> : null}
          </div>
        )}
        {props.error ? <div className="kb-inline-error">{props.error instanceof Error ? props.error.message : '摄入失败'}</div> : null}
        <div className="kb-modal__foot">
          <span className="kb-modal__hint">同步摄入：返回即终态（ready / failed 可重试）</span>
          <Button
            onClick={tab === 'text' ? submitText : submitFile}
            loading={props.loading}
            disabled={tab === 'text' ? !text.trim() : !fileId}
            data-testid="kb-ingest-submit"
          >
            开始摄入
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 文档详情抽屉（PKB-03 简版：元信息 + 大纲 + 分块正文 + 重摄入） */
function DocDrawer(props: {
  doc: KbDoc;
  chunks: KbChunk[];
  chunksPending: boolean;
  outline: Array<{ heading_path: string; seq: number }>;
  reingesting: boolean;
  onReingest: () => void;
  onClose: () => void;
  bodyRef: React.RefObject<HTMLDivElement>;
}) {
  const { doc } = props;
  const jumpTo = (seq: number) => {
    const el = props.bodyRef.current?.querySelector(`[data-chunk-seq="${seq}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return (
    <div className="kb-drawer-mask" data-testid="kb-drawer-mask" onClick={props.onClose}>
      <aside className="kb-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="kb-drawer__head">
          <div className="kb-drawer__title-row">
            <span className="kb-drawer__title">{doc.title}</span>
            <IngestBadge status={doc.status} version={doc.version} />
          </div>
          <div className="kb-drawer__meta">
            {SOURCE_LABEL[doc.source_type]} · {doc.ext || '-'} · {fmtBytes(doc.size)} · v{doc.version} · {formatListTime(doc.updated_at)}
          </div>
          {doc.status === 'failed' && doc.error_msg ? <div className="kb-inline-error">失败原因：{doc.error_msg}</div> : null}
          <div className="kb-drawer__actions">
            <Button variant="secondary" onClick={props.onReingest} loading={props.reingesting} data-testid="kb-reingest-btn">
              <RefreshCw size={13} /> 重新摄入
            </Button>
            <Button variant="text" onClick={props.onClose}>
              关闭
            </Button>
          </div>
        </div>
        <div className="kb-drawer__body">
          {props.outline.length > 0 ? (
            <nav className="kb-drawer__outline">
              <div className="kb-drawer__outline-label">大纲</div>
              {props.outline.map((o) => (
                <button key={`${o.heading_path}-${o.seq}`} type="button" onClick={() => jumpTo(o.seq)} title={`跳到 ${o.heading_path}`}>
                  {o.heading_path}
                </button>
              ))}
            </nav>
          ) : null}
          <div className="kb-drawer__chunks" ref={props.bodyRef}>
            {props.chunksPending ? (
              <SkeletonList count={4} />
            ) : props.chunks.length === 0 ? (
              <div className="kb-drawer__empty">暂无分块（failed 文档摄入成功后可检索）</div>
            ) : (
              props.chunks.map((c) => (
                <div key={c.seq} className="kb-chunk" data-chunk-seq={c.seq}>
                  <div className="kb-chunk__head">
                    <span className="kb-chunk-seq">#{c.seq}</span>
                    {c.heading_path ? <span className="kb-chunk__heading">{c.heading_path}</span> : null}
                  </div>
                  <pre className="kb-chunk__text">{c.content}</pre>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
