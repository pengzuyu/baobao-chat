/**
 * 组织树管理（D10 PAD-04 / D12 §3）：树形展示（物化路径 title）+ 新增子部门
 * + 行内改名 + 删除（有子拒——服务端保护）。D10 落地：部门成员区
 * （user_dept 挂/卸/主部门标记）；范围授权入口在「角色」页（scope 四档）。
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, Plus, Trash2, Users } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import {
  attachDeptMember,
  createDept,
  deleteDept,
  detachDeptMember,
  fetchDeptMembers,
  fetchDeptTree,
  renameDept,
  type DeptMemberRow,
  type DeptNode,
} from '../api/admin';

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
  // 成员区（D10：user_dept 挂/卸；懒加载）
  const [membersOpen, setMembersOpen] = useState(false);
  const [members, setMembers] = useState<DeptMemberRow[] | null>(null);
  const [attachUid, setAttachUid] = useState('');
  const [attachPrimary, setAttachPrimary] = useState(false);

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await fetchDeptMembers(node.id));
    } catch {
      setMembers([]);
      onError('成员读取失败');
    }
  }, [node.id, onError]);

  useEffect(() => {
    if (membersOpen && members === null) void loadMembers();
  }, [membersOpen, members, loadMembers]);

  const attach = async () => {
    const uid = attachUid.trim();
    if (!uid) return;
    try {
      await attachDeptMember(node.id, uid, attachPrimary);
      setAttachUid('');
      await loadMembers();
    } catch (e) {
      onError(e instanceof ApiError ? getErrorText(e.code) : '挂靠失败（用户不存在？）');
    }
  };

  const detach = async (uid: string, uname: string) => {
    if (!window.confirm(`将 ${uname || uid} 移出「${node.name}」？`)) return;
    try {
      await detachDeptMember(node.id, uid);
      await loadMembers();
    } catch {
      onError('卸挂失败');
    }
  };

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
          <button type="button" className="btn btn--sm" onClick={() => setMembersOpen(!membersOpen)} data-testid={`org-members-btn-${node.id}`} title="成员管理（挂/卸）">
            <Users size={12} />
          </button>
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
      {membersOpen ? (
        <div className="org-members" style={{ marginLeft: 26 }} data-testid={`org-members-${node.id}`}>
          <div className="org-members__head">成员（{members === null ? '…' : members.length}；主部门=钉钉式主属）</div>
          {members === null ? (
            <div className="org-members__hint">加载中…</div>
          ) : members.length === 0 ? (
            <div className="org-members__hint">暂无成员</div>
          ) : (
            members.map((m) => (
              <div key={m.user_id} className="org-members__row" data-testid="org-member-row">
                <span className="org-members__name">
                  {m.name || m.user_id}
                  {m.is_primary ? <span className="tag tag--builtin">主部门</span> : null}
                </span>
                <span className="org-members__uid">{m.user_id}</span>
                <button type="button" className="btn btn--sm btn--danger" onClick={() => void detach(m.user_id, m.name)}>
                  移出
                </button>
              </div>
            ))
          )}
          <div className="org-members__add">
            <input
              className="bbw-input"
              placeholder="用户 ID"
              value={attachUid}
              onChange={(e) => setAttachUid(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void attach()}
              data-testid={`org-attach-uid-${node.id}`}
            />
            <label className="org-members__primary">
              <input type="checkbox" checked={attachPrimary} onChange={(e) => setAttachPrimary(e.target.checked)} /> 设为主部门
            </label>
            <button type="button" className="btn btn--sm btn--primary" disabled={!attachUid.trim()} onClick={() => void attach()}>
              挂入
            </button>
          </div>
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
