/**
 * 维度浏览页（D24）：/kb/s/:spaceId——目录（专栏）面包屑逐层进入 + 文章列表。
 * 旧 KbPage 的空间浏览区重写：去上传/去授权/去摄入任务面板（页面无写入 UI 拍板），
 * 加浏览量列；目录树以路径栈手风琴实现（逐层 fetchNodes 懒加载——接通现状 UI 未接的 parent_id）。
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Eye, Folder, RotateCcw } from 'lucide-react';
import { useCreateDir, useNodes, useSpaces } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';

interface DirCrumb {
  id: string;
  name: string;
}

export function SpaceBrowsePage() {
  const { spaceId = '' } = useParams();
  const navigate = useNavigate();
  const spaces = useSpaces('all');
  const space = spaces.data?.find((s) => s.id === spaceId);
  const spaceName = space ? (space.space_type === 'personal' ? '我的笔记' : space.name) : '知识库';

  const [dirStack, setDirStack] = useState<DirCrumb[]>([]);
  const parentId = dirStack.length > 0 ? dirStack[dirStack.length - 1].id : '';
  const nodes = useNodes(spaceId, parentId);
  const createDir = useCreateDir(spaceId, parentId);

  const [newDir, setNewDir] = useState('');
  const [dirErr, setDirErr] = useState('');
  const [creating, setCreating] = useState(false);

  const submitDir = async () => {
    const name = newDir.trim();
    if (!name) return;
    setDirErr('');
    setCreating(true);
    try {
      const n = await createDir.mutateAsync(name);
      setDirStack((s) => [...s, { id: n.id, name: n.name }]);
      setNewDir('');
    } catch (e) {
      setDirErr(errText(e)); // 7014 同名内联提示
    } finally {
      setCreating(false);
    }
  };

  const docs = nodes.data?.docs ?? [];
  const dirs = nodes.data?.dirs ?? [];
  const state: 'loading' | 'error' | 'ok' = spaces.isPending || nodes.isPending
    ? 'loading'
    : spaces.isError || nodes.isError
      ? 'error'
      : 'ok';

  return (
    <div className="kb-browse-page" data-testid="kb-browse-page">
      <div className="kb-browse-page__head">
        <div className="kb-browse-page__crumbs">
          <button type="button" className="kb-browse-page__crumb" onClick={() => setDirStack([])}>
            {spaceName}
          </button>
          {dirStack.map((d, i) => (
            <span key={d.id} className="kb-browse-page__crumb-wrap">
              <ChevronRight size={13} className="kb-browse-page__sep" />
              <button
                type="button"
                className="kb-browse-page__crumb"
                onClick={() => setDirStack((s) => s.slice(0, i + 1))}
              >
                {d.name}
              </button>
            </span>
          ))}
        </div>
        <div className="kb-browse-page__actions">
          {dirStack.length > 0 ? (
            <button type="button" className="kb-link-btn" onClick={() => setDirStack((s) => s.slice(0, -1))}>
              <RotateCcw size={13} /> 上一级
            </button>
          ) : null}
          <span className="kb-browse-page__newdir">
            <input
              className="kb-browse-page__newdir-input"
              placeholder="新建专栏目录"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitDir();
              }}
            />
            <button type="button" className="kb-link-btn" onClick={() => void submitDir()} disabled={creating || !newDir.trim()}>
              创建
            </button>
          </span>
          {dirErr ? <span className="kb-browse-page__dir-err">{dirErr}</span> : null}
        </div>
      </div>

      <StateView
        state={state}
        skeleton={<SkeletonList count={6} />}
        error={spaces.error ?? nodes.error}
        onRetry={() => {
          void spaces.refetch();
          void nodes.refetch();
        }}
      >
        <div className="kb-browse-page__body">
          {dirs.length > 0 ? (
            <div className="kb-browse-page__dirs">
              {dirs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="kb-browse-page__dir"
                  onClick={() => setDirStack((s) => [...s, { id: d.id, name: d.name }])}
                >
                  <Folder size={16} className="kb-browse-page__dir-icon" />
                  <span className="kb-browse-page__dir-name">{d.name}</span>
                  <ChevronRight size={14} className="kb-browse-page__dir-arrow" />
                </button>
              ))}
            </div>
          ) : null}

          {docs.length > 0 ? (
            <div className="kb-browse-page__docs">
              {docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className="kb-browse-page__doc"
                  data-testid="kb-browse-doc"
                  onClick={() => navigate(`/kb/d/${doc.id}`)}
                >
                  <span className="kb-browse-page__doc-title">{doc.title}</span>
                  <span className="kb-browse-page__doc-meta">
                    <Eye size={12} className="kb-board__eye" /> {doc.view_count ?? 0} · {formatListTime(doc.updated_at)}
                  </span>
                </button>
              ))}
            </div>
          ) : dirs.length === 0 ? (
            <StateView
              state="empty"
              emptyText={dirStack.length > 0 ? '目录为空' : '还没有文章——让 AI 把会话结论沉淀进知识库'}
            />
          ) : null}
        </div>
      </StateView>
    </div>
  );
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('7014')) return '同级已有同名目录';
  return msg;
}
