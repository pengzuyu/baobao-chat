/**
 * 组织树管理（D10 PAD-04 / D12 §3）：树形展示（物化路径 title）+ 新增子部门
 * + 行内改名 + 删除（有子拒——服务端保护）。用户挂部门（user_dept）与
 * "本部门及以下"范围授权随 D12 阶段二（路径前缀匹配基建已备）。
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, Plus, Trash2 } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { createDept, deleteDept, fetchDeptTree, renameDept, type DeptNode } from '../api/admin';

function DeptRow({ node, depth, onChanged, onError }: {
  node: DeptNode;
  depth: number;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);

  const add = async () => {
    try {
      await createDept(node.id, newName.trim());
      setAdding(false);
      setNewName('');
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? getErrorText(e.code) : '创建失败');
    }
  };

  const rename = async () => {
    try {
      await renameDept(node.id, name.trim());
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? getErrorText(e.code) : '改名失败');
    }
  };

  const remove = async () => {
    if (!window.confirm(`确认删除部门「${node.name}」？`)) return;
    try {
      await deleteDept(node.id);
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? getErrorText(e.code) : '删除失败');
    }
  };

  const hasChildren = (node.children?.length ?? 0) > 0;
  return (
    <div className="org-node" style={{ marginLeft: depth * 18 }} data-testid="org-node">
      <div className="org-node__row">
        <button type="button" className="icon-btn" onClick={() => setOpen(!open)} disabled={!hasChildren}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <FolderTree size={14} className="org-node__icon" />
        {editing ? (
          <span className="org-node__edit">
            <input className="bbw-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && void rename()} />
            <button type="button" className="btn btn--sm btn--primary" disabled={!name.trim()} onClick={() => void rename()}>保存</button>
          </span>
        ) : (
          <span className="org-node__name" title={node.path} onDoubleClick={() => setEditing(true)} data-testid="org-node-name">
            {node.name}
          </span>
        )}
        <span className="org-node__ops">
          <button type="button" className="btn btn--sm" onClick={() => setAdding(!adding)} title="新增子部门">
            <Plus size={12} />
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setEditing(true)} title="改名（双击名称亦可）">
            改名
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={() => void remove()} title="删除（有子部门拒）">
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {adding ? (
        <div className="org-node__add" style={{ marginLeft: 26 }}>
          <input className="bbw-input" placeholder="子部门名（≤50 字）" value={newName}
            onChange={(e) => setNewName(e.target.value)} autoFocus
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && void add()} data-testid="org-add-input" />
          <button type="button" className="btn btn--sm btn--primary" disabled={!newName.trim()} onClick={() => void add()}>
            创建
          </button>
        </div>
      ) : null}
      {open && hasChildren
        ? node.children!.map((c) => (
            <DeptRow key={c.id} node={c} depth={depth + 1} onChanged={onChanged} onError={onError} />
          ))
        : null}
    </div>
  );
}

export function OrgTreePage() {
  const [tree, setTree] = useState<DeptNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rootAdding, setRootAdding] = useState(false);
  const [rootName, setRootName] = useState('');

  const reload = useCallback(async () => {
    setError(null);
    try {
      setTree(await fetchDeptTree());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addRoot = async () => {
    try {
      await createDept('', rootName.trim());
      setRootAdding(false);
      setRootName('');
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '创建失败');
    }
  };

  return (
    <div className="admin-page__section" data-testid="admin-org">
      <div className="admin-page__head">
        <h2>组织树</h2>
        <button type="button" className="btn btn--primary" onClick={() => setRootAdding(!rootAdding)} data-testid="org-root-add">
          <Plus size={14} /> 新增根部门
        </button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}
      {rootAdding ? (
        <div className="org-node__add">
          <input className="bbw-input" placeholder="根部门名" value={rootName} onChange={(e) => setRootName(e.target.value)} autoFocus
            onKeyDown={(e) => e.key === 'Enter' && rootName.trim() && void addRoot()} />
          <button type="button" className="btn btn--sm btn--primary" disabled={!rootName.trim()} onClick={() => void addRoot()}>
            创建
          </button>
        </div>
      ) : null}
      {tree === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : tree.length === 0 ? (
        <div className="admin-page__empty">暂无部门——点右上「新增根部门」建立组织树</div>
      ) : (
        tree.map((n) => <DeptRow key={n.id} node={n} depth={0} onChanged={() => void reload()} onError={setError} />)
      )}
    </div>
  );
}
