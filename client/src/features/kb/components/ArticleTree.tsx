/**
 * 文章树（D24 真机修正轮 2026-11-13）：知识库左栏——两维度根（公司知识库/我的笔记）
 * → 专栏目录递归嵌套（fetchNodes 懒加载逐层展开）→ 文章叶子（点击开 tab）。
 * 目录节点 hover「+」新建子目录（唯一写入动作——文章本体无写入 UI 拍板）。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, FolderPlus, Plus } from 'lucide-react';
import { useCreateDir, useNodes, useSpaces } from '../api/hooks';
import { SkeletonList } from '../../../shared/ui/Skeleton';

/** 目录子层 props（懒加载 hook 化在 DirChildren 内） */
interface DirChildrenProps {
  spaceId: string;
  parentId: string; // 空=维度根
  depth: number;
  onOpenDoc: (docId: string, title: string) => void;
}

/** 目录节点 props */
interface DirNodeProps {
  spaceId: string;
  node: { id: string; name: string };
  depth: number;
  onOpenDoc: (docId: string, title: string) => void;
}

export function ArticleTree(props: { onOpenDoc: (docId: string, title: string) => void }) {
  const spaces = useSpaces('all');

  if (spaces.isError) {
    return <div className="kb-tree__error">维度加载失败，请重试</div>;
  }
  if (spaces.isPending) {
    return <SkeletonList count={5} />;
  }

  // 两维度根：公司在前（公共分享主场），我的笔记在后
  const ordered = [...(spaces.data ?? [])].sort((a, b) => (a.space_type === 'company' ? -1 : b.space_type === 'company' ? 1 : 0));

  return (
    <div className="kb-tree" data-testid="kb-tree">
      {ordered.map((sp) => (
        <SpaceRoot
          key={sp.id}
          spaceId={sp.id}
          name={sp.space_type === 'personal' ? '我的笔记' : sp.name}
          docCount={sp.doc_count}
          onOpenDoc={props.onOpenDoc}
        />
      ))}
    </div>
  );
}

/** 维度根（可折叠；默认展开首访） */
function SpaceRoot(props: { spaceId: string; name: string; docCount: number; onOpenDoc: (docId: string, title: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="kb-tree__root">
      <button type="button" className="kb-tree__row kb-tree__row--root" onClick={() => setOpen((v) => !v)} data-testid="kb-tree-root">
        {open ? <ChevronDown size={13} className="kb-tree__caret" /> : <ChevronRight size={13} className="kb-tree__caret" />}
        <span className="kb-tree__name">{props.name}</span>
        <span className="kb-tree__count">{props.docCount}</span>
      </button>
      {open ? <DirChildren spaceId={props.spaceId} parentId="" depth={1} onOpenDoc={props.onOpenDoc} /> : null}
    </div>
  );
}

/** 目录子层（懒加载 + 递归） */
function DirChildren(props: DirChildrenProps) {
  const { spaceId, parentId, depth, onOpenDoc } = props;
  const nodes = useNodes(spaceId, parentId);
  if (nodes.isPending) return <div className="kb-tree__loading"><SkeletonList count={3} /></div>;
  if (nodes.isError) return <div className="kb-tree__error">加载失败</div>;

  const { dirs = [], docs = [] } = nodes.data ?? {};
  if (dirs.length === 0 && docs.length === 0) {
    return <div className="kb-tree__empty">（空）</div>;
  }
  return (
    <div className="kb-tree__children">
      {dirs.map((d) => (
        <DirNode key={d.id} spaceId={spaceId} node={d} depth={depth} onOpenDoc={onOpenDoc} />
      ))}
      {docs.map((doc) => (
        <button
          key={doc.id}
          type="button"
          className="kb-tree__row kb-tree__row--doc"
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid="kb-tree-doc"
          onClick={() => onOpenDoc(doc.id, doc.title)}
        >
          <FileText size={13} className="kb-tree__doc-icon" />
          <span className="kb-tree__name">{doc.title}</span>
        </button>
      ))}
    </div>
  );
}

/** 目录节点（可折叠展开子层；hover「+」新建子目录内联输入） */
function DirNode(props: DirNodeProps) {
  const { spaceId, node, depth, onOpenDoc } = props;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const createDir = useCreateDir(spaceId, node.id);

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setErr('');
    try {
      await createDir.mutateAsync(n);
      setName('');
      setAdding(false);
      setOpen(true); // 展开看新目录
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('7014') ? '同名目录' : '创建失败');
    }
  };

  return (
    <div className="kb-tree__dir">
      <div className="kb-tree__row-wrap">
        <button
          type="button"
          className="kb-tree__row kb-tree__row--dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
          data-testid="kb-tree-dir"
        >
          {open ? <ChevronDown size={12} className="kb-tree__caret" /> : <ChevronRight size={12} className="kb-tree__caret" />}
          <span className="kb-tree__name">{node.name}</span>
        </button>
        {/* 新建子目录：目录行 hover 出现（唯一写入动作） */}
        <button type="button" className="kb-tree__add" title="新建子目录" onClick={() => { setAdding((v) => !v); setErr(''); }}>
          {adding ? <Plus size={12} className="kb-tree__add-icon kb-tree__add-icon--close" /> : <FolderPlus size={12} className="kb-tree__add-icon" />}
        </button>
      </div>
      {adding ? (
        <div className="kb-tree__add-form" style={{ paddingLeft: 22 + depth * 14 }}>
          <input
            className="kb-tree__add-input"
            placeholder="目录名"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <button type="button" className="kb-link-btn" onClick={() => void submit()} disabled={!name.trim()}>
            建
          </button>
          {err ? <span className="kb-tree__add-err">{err}</span> : null}
        </div>
      ) : null}
      {open ? <DirChildren spaceId={spaceId} parentId={node.id} depth={depth + 1} onOpenDoc={onOpenDoc} /> : null}
    </div>
  );
}
