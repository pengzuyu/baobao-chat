/**
 * 组织用户（通讯录合并页，2026-11-12 用户裁决：原「用户」+「组织」两页合一）：
 * - 左：组织树=通讯录骨架——根「全公司」+ 部门节点，节点上直接「＋子部门」「＋用户」
 * - 右：选中「全公司」=全量用户表（原 UsersPage 能力：搜索/状态过滤/禁用/启用/离职交接）；
 *       选中部门=该部门成员表（工号/姓名/邮箱/主部门/状态/操作——挂靠已有用户/移出）
 * - 创建用户弹窗：工号自动建议（姓名全拼+重名两位补零递增，可手改）/姓名/邮箱/
 *   所属组织（默认=触发节点）/角色（默认不授权）——初始口令=工号+!BBW 首登强制改密
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import {
  attachDeptMember,
  createUser,
  deleteDept,
  fetchDeptMembers,
  fetchDeptTree,
  fetchRoles,
  offboardUser,
  renameDept,
  createDept,
  detachDeptMember,
  suggestEmpno,
  type AdminRole,
  type DeptMemberRow,
  type DeptNode,
} from '../api/admin';
import type { AdminUser } from '../model/types';
import { useUsers, useUserStatus } from '../api/hooks';

const STATUS_FILTERS = [
  { value: 0, label: '全部' },
  { value: 1, label: '启用' },
  { value: 2, label: '禁用' },
] as const;

/* ── 左栏：组织树（含虚拟根「全公司」） ── */

function flattenTree(nodes: DeptNode[], depth = 0, out: { id: string; name: string; depth: number }[] = []): { id: string; name: string; depth: number }[] {
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children?.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
  onAddChild,
  onAddUser,
  onRename,
  onDelete,
}: {
  node: DeptNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onAddChild: (id: string, name: string) => void;
  onAddUser: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const hasChildren = (node.children?.length ?? 0) > 0;

  const add = () => {
    if (!newName.trim()) return;
    onAddChild(node.id, newName.trim());
    setAdding(false);
    setNewName('');
  };

  return (
    <div className="org-node" style={{ marginLeft: depth * 16 }}>
      <div className={`org-node__row${selected === node.id ? ' org-node__row--selected' : ''}`}>
        <button type="button" className="icon-btn" onClick={() => setOpen(!open)} disabled={!hasChildren}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <FolderTree size={14} className="org-node__icon" />
        {editing ? (
          <span className="org-node__edit">
            <input
              className="bbw-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  onRename(node.id, name.trim());
                  setEditing(false);
                }
              }}
            />
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!name.trim()}
              onClick={() => {
                onRename(node.id, name.trim());
                setEditing(false);
              }}
            >
              保存
            </button>
          </span>
        ) : (
          <span className="org-node__name" title={node.path} onClick={() => onSelect(node.id)} onDoubleClick={() => setEditing(true)}>
            {node.name}
          </span>
        )}
        <span className="org-node__ops">
          <button type="button" className="btn btn--sm" onClick={() => onAddUser(node.id)} title="在此组织下新增用户">
            <UserPlus size={12} />
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setAdding(!adding)} title="新增子部门">
            <Plus size={12} />
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => {
              if (window.confirm(`确认删除部门「${node.name}」？（有子部门或挂人时服务端拒绝）`)) onDelete(node.id);
            }}
            title="删除（有子/挂人拒）"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {adding ? (
        <div className="org-node__add" style={{ marginLeft: 24 }}>
          <input
            className="bbw-input"
            placeholder="子部门名（≤50 字）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && void add()}
          />
          <button type="button" className="btn btn--sm btn--primary" disabled={!newName.trim()} onClick={() => void add()}>
            创建
          </button>
        </div>
      ) : null}
      {open && hasChildren
        ? node.children!.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onAddUser={onAddUser}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        : null}
    </div>
  );
}

/* ── 创建用户弹窗 ── */

function CreateUserModal({
  open,
  deptId,
  tree,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** 触发节点（'' = 不挂部门） */
  deptId: string;
  tree: DeptNode[];
  onClose: () => void;
  onCreated: (u: AdminUser) => void;
}) {
  const [name, setName] = useState('');
  const [empno, setEmpno] = useState('');
  const [empnoDirty, setEmpnoDirty] = useState(false);
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState(deptId);
  const [roleId, setRoleId] = useState('0');
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const flat = useMemo(() => flattenTree(tree), [tree]);

  useEffect(() => {
    if (!open) return;
    setDept(deptId);
    void fetchRoles().then(setRoles).catch(() => setRoles([]));
  }, [open, deptId]);

  // 工号建议：姓名变化且管理员未手改工号时跟随刷新（多音字/生僻字手改兜底）
  useEffect(() => {
    if (!open || empnoDirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setEmpno('');
      return;
    }
    let alive = true;
    void suggestEmpno(trimmed)
      .then((s) => alive && setEmpno(s))
      .catch(() => alive && setEmpno(''));
    return () => {
      alive = false;
    };
  }, [open, name, empnoDirty]);

  if (!open) return null;

  const regenerate = () => {
    setEmpnoDirty(false);
    const trimmed = name.trim();
    if (trimmed) void suggestEmpno(trimmed).then(setEmpno).catch(() => undefined);
  };

  const submit = async () => {
    setErr('');
    setSubmitting(true);
    try {
      const u = await createUser({
        employee_no: empno.trim() || undefined,
        display_name: name.trim(),
        email: email.trim() || undefined,
        dept_id: dept ? Number(dept) : undefined,
        role_id: roleId !== '0' ? Number(roleId) : undefined,
      });
      onCreated(u);
      // 复位（下次打开干净）
      setName('');
      setEmpno('');
      setEmpnoDirty(false);
      setEmail('');
      setRoleId('0');
    } catch (e) {
      setErr(e instanceof ApiError ? getErrorText(e.code) || e.message : '创建失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-modal" onClick={onClose}>
      <div className="admin-modal__card" onClick={(e) => e.stopPropagation()} data-testid="create-user-modal">
        <div className="admin-modal__head">
          <h3>新增用户</h3>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="admin-modal__body">
          <label className="admin-modal__field">
            <span>姓名 *</span>
            <input className="bbw-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="真实姓名（≤50 字）" data-testid="create-user-name" />
          </label>
          <label className="admin-modal__field">
            <span>
              工号 *（登录账号）
              <button type="button" className="btn btn--sm" onClick={regenerate} title="按姓名重新生成拼音建议">
                <RefreshCw size={11} /> 重新生成
              </button>
            </span>
            <input
              className="bbw-input"
              value={empno}
              onChange={(e) => {
                setEmpno(e.target.value);
                setEmpnoDirty(true);
              }}
              placeholder="留空=按姓名全拼自动生成"
              data-testid="create-user-empno"
            />
            <em className="admin-modal__hint">建议值=姓名全拼，重名自动补零递增（zhangsan02）；多音字/生僻字可手改</em>
          </label>
          <label className="admin-modal__field">
            <span>邮箱</span>
            <input className="bbw-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="选填" />
          </label>
          <label className="admin-modal__field">
            <span>所属组织</span>
            <select className="bbw-input" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="create-user-dept">
              <option value="">不挂部门</option>
              {flat.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(d.depth)}
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-modal__field">
            <span>角色</span>
            <select className="bbw-input" value={roleId} onChange={(e) => setRoleId(e.target.value)} data-testid="create-user-role">
              <option value="0">不授权（普通成员）</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.is_builtin ? '（内置）' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="admin-modal__hint">初始口令 = 工号 + “!BBW”，首次登录强制修改</div>
          {err ? <div className="admin-error-bar">{err}</div> : null}
        </div>
        <div className="admin-modal__foot">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} disabled={!name.trim()} onClick={() => void submit()} data-testid="create-user-submit">
            创建
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── 主页面 ── */

export function OrgDirectoryPage() {
  // 左栏树
  const [tree, setTree] = useState<DeptNode[] | null>(null);
  const [treeError, setTreeError] = useState('');
  const [selected, setSelected] = useState<string | null>(null); // null=全公司
  const [rootAdding, setRootAdding] = useState(false);
  const [rootName, setRootName] = useState('');
  // 弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [modalDept, setModalDept] = useState('');
  // 右栏（全公司=用户列表原 UsersPage 能力）
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<number>(0);
  const [actionError, setActionError] = useState('');
  const [actionOk, setActionOk] = useState('');
  // 右栏（部门=成员表）
  const [members, setMembers] = useState<DeptMemberRow[] | null>(null);
  const [attachUid, setAttachUid] = useState('');

  const query = useUsers(keyword, status);
  const statusMutation = useUserStatus();
  const items: AdminUser[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];

  const reloadTree = useCallback(async () => {
    try {
      setTree(await fetchDeptTree());
      setTreeError('');
    } catch {
      setTreeError('组织树加载失败');
    }
  }, []);

  useEffect(() => {
    void reloadTree();
  }, [reloadTree]);

  const reloadMembers = useCallback(async (deptId: string) => {
    try {
      setMembers(await fetchDeptMembers(deptId));
    } catch {
      setMembers([]);
    }
  }, []);

  // 切节点：null=全公司（用户列表），部门=成员表
  useEffect(() => {
    setActionError('');
    setActionOk('');
    if (selected) void reloadMembers(selected);
    else setMembers(null);
  }, [selected, reloadMembers]);

  const addDept = async (parentId: string, deptName: string) => {
    try {
      await createDept(parentId, deptName);
      await reloadTree();
    } catch (e) {
      setActionError(e instanceof ApiError ? getErrorText(e.code) : '部门创建失败');
    }
  };

  const renameNode = async (id: string, newName: string) => {
    try {
      await renameDept(id, newName);
      await reloadTree();
    } catch (e) {
      setActionError(e instanceof ApiError ? getErrorText(e.code) : '改名失败');
    }
  };

  const deleteNode = async (id: string) => {
    try {
      await deleteDept(id);
      if (selected === id) setSelected(null);
      await reloadTree();
    } catch (e) {
      setActionError(e instanceof ApiError ? getErrorText(e.code) : '删除失败（有子部门或挂人）');
    }
  };

  const openCreate = (deptId: string) => {
    setModalDept(deptId);
    setModalOpen(true);
  };

  const onCreated = (u: AdminUser) => {
    setModalOpen(false);
    setActionOk(`已创建 ${u.display_name}（${u.employee_no}）——初始口令=工号+“!BBW”，首登强制改密`);
    void query.refetch();
    if (selected) void reloadMembers(selected);
  };

  /** 禁用/启用（全公司表与部门成员表共用；u 状态未知按 启用 处理按钮分支由调用方给） */
  const toggle = (userId: string, uname: string, currentStatus: number) => {
    setActionError('');
    setActionOk('');
    statusMutation.mutate(
      { userId, action: currentStatus === 1 ? 'disable' : 'enable' },
      {
        onSuccess: (_d, vars) => {
          setActionOk(vars.action === 'disable' ? `已禁用 ${uname}：全端下线并吊销刷新令牌（已记审计）` : `已启用 ${uname}（已记审计）`);
          if (selected) void reloadMembers(selected);
        },
        onError: (err) => setActionError(err instanceof ApiError ? getErrorText(err.code) : '操作失败，请稍后再试'),
      },
    );
  };

  const offboard = async (userId: string, uname: string) => {
    if (!window.confirm(`离职交接 ${uname}？\n将执行：禁用账号 + 全端下线 + 令牌吊销（已记审计）。`)) return;
    setActionError('');
    setActionOk('');
    try {
      await offboardUser(userId);
      setActionOk(`已离职交接 ${uname}：账号禁用并全端下线`);
      void query.refetch();
      if (selected) void reloadMembers(selected);
    } catch (e) {
      setActionError(e instanceof ApiError ? getErrorText(e.code) : '操作失败，请稍后重试');
    }
  };

  const attach = async () => {
    const uid = attachUid.trim();
    if (!uid || !selected) return;
    try {
      await attachDeptMember(selected, uid, false);
      setAttachUid('');
      await reloadMembers(selected);
    } catch (e) {
      setActionError(e instanceof ApiError ? getErrorText(e.code) : '挂靠失败（用户不存在？）');
    }
  };

  const detach = async (uid: string, uname: string) => {
    if (!selected) return;
    if (!window.confirm(`将 ${uname || uid} 移出该部门？`)) return;
    try {
      await detachDeptMember(selected, uid);
      await reloadMembers(selected);
    } catch {
      setActionError('移出失败');
    }
  };

  const selectedName = useMemo(() => {
    if (!selected) return null;
    const flat = flattenTree(tree ?? []);
    return flat.find((d) => d.id === selected)?.name ?? selected;
  }, [selected, tree]);

  return (
    <div className="admin-directory" data-testid="admin-directory">
      {/* 左栏：组织树（通讯录骨架） */}
      <aside className="admin-directory__tree">
        <div className="admin-directory__tree-head">
          <span>组织树</span>
          <button type="button" className="btn btn--sm" onClick={() => setRootAdding(!rootAdding)} title="新增根部门">
            <Plus size={12} /> 根部门
          </button>
        </div>
        <div
          className={`org-node__row org-node__row--root${selected === null ? ' org-node__row--selected' : ''}`}
          onClick={() => setSelected(null)}
          data-testid="dir-node-all"
        >
          <Building2 size={14} className="org-node__icon" />
          <span className="org-node__name">全公司</span>
          <span className="org-node__ops">
            <button type="button" className="btn btn--sm" onClick={(e) => { e.stopPropagation(); openCreate(''); }} title="新增用户（不挂部门）">
              <UserPlus size={12} />
            </button>
          </span>
        </div>
        {rootAdding ? (
          <div className="org-node__add">
            <input
              className="bbw-input"
              placeholder="根部门名"
              value={rootName}
              onChange={(e) => setRootName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && rootName.trim()) {
                  void addDept('', rootName.trim());
                  setRootAdding(false);
                  setRootName('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!rootName.trim()}
              onClick={() => {
                void addDept('', rootName.trim());
                setRootAdding(false);
                setRootName('');
              }}
            >
              创建
            </button>
          </div>
        ) : null}
        {treeError ? <div className="admin-error-bar">{treeError}</div> : null}
        {tree === null ? (
          <div className="admin-directory__hint">加载中…</div>
        ) : tree.length === 0 ? (
          <div className="admin-directory__hint">暂无部门——点上方「根部门」开始搭建组织</div>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={1}
              selected={selected}
              onSelect={setSelected}
              onAddChild={(id, nm) => void addDept(id, nm)}
              onAddUser={(id) => openCreate(id)}
              onRename={(id, nm) => void renameNode(id, nm)}
              onDelete={(id) => void deleteNode(id)}
            />
          ))
        )}
      </aside>

      {/* 右栏：通讯录内容 */}
      <div className="admin-directory__main">
        <header className="admin-page__header">
          <h2 className="admin-page__title">{selectedName ?? '全公司'}</h2>
          <span className="admin-page__meta">
            {selected ? '组织成员（含主部门标记）——可在节点上新增用户/子部门' : '全量用户（跨部门检索）——点左侧部门查看该组织通讯录'}
          </span>
          <Button variant="primary" onClick={() => openCreate(selected ?? '')} data-testid="dir-create-user">
            <UserPlus size={14} /> 新增用户
          </Button>
        </header>

        {actionError ? <div className="admin-error-bar">{actionError}</div> : null}
        {actionOk ? <div className="admin-ok-bar">{actionOk}</div> : null}

        {selected === null ? (
          /* 全公司：原用户页能力（搜索/状态过滤/无限加载/行操作） */
          <>
            <div className="admin-toolbar">
              <div className="bbw-input bbw-input--search admin-toolbar__search">
                <input
                  value={keywordInput}
                  placeholder="搜索工号 / 姓名 / 邮箱，回车检索"
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setKeyword(keywordInput.trim());
                  }}
                />
              </div>
              <div className="admin-toolbar__filters">
                {STATUS_FILTERS.map((f) => (
                  <button key={f.value} type="button" className={`admin-chip${status === f.value ? ' admin-chip--active' : ''}`} onClick={() => setStatus(f.value)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {query.isError ? (
              <div className="admin-error-bar">
                {query.error instanceof ApiError ? getErrorText(query.error.code) : '加载失败'}
                <button type="button" className="btn btn--sm" onClick={() => void query.refetch()}>
                  重试
                </button>
              </div>
            ) : items.length === 0 && !query.isPending ? (
              <div className="admin-directory__hint">无匹配用户</div>
            ) : (
              <>
                <table className="admin-table" data-testid="admin-users-table">
                  <thead>
                    <tr>
                      <th>工号</th>
                      <th>姓名</th>
                      <th>邮箱</th>
                      <th>权限</th>
                      <th>状态</th>
                      <th style={{ width: 132 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u) => (
                      <tr key={u.id} data-testid={`admin-user-${u.employee_no}`}>
                        <td className="admin-mono">{u.employee_no}</td>
                        <td>{u.display_name}</td>
                        <td className="admin-mono">{u.email || '—'}</td>
                        <td className="admin-scope-cell">{scopesText(u.scopes)}</td>
                        <td>
                          <span className={`admin-status${u.status === 1 ? ' admin-status--active' : ' admin-status--disabled'}`}>
                            {u.status === 1 ? '启用' : '禁用'}
                          </span>
                        </td>
                        <td>
                          {u.status === 1 ? (
                            <span className="admin-role__ops">
                              <Button
                                variant="danger"
                                loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
                                onClick={() => toggle(u.id, u.display_name, u.status)}
                              >
                                禁用
                              </Button>
                              <Button variant="danger" disabled={statusMutation.isPending} onClick={() => void offboard(u.id, u.display_name)}>
                                离职交接
                              </Button>
                            </span>
                          ) : (
                            <Button
                              variant="secondary"
                              loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
                              onClick={() => toggle(u.id, u.display_name, u.status)}
                            >
                              启用
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {lastPage?.has_more && lastPage.next_cursor ? (
                  <div className="admin-loadmore">
                    <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                      加载更多
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : (
          /* 部门：成员表 */
          <>
            <div className="admin-toolbar">
              <div className="bbw-input bbw-input--search admin-toolbar__search">
                <input
                  value={attachUid}
                  placeholder="挂靠已有用户：输入其用户 ID 回车"
                  onChange={(e) => setAttachUid(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void attach()}
                  data-testid="dir-attach-uid"
                />
              </div>
            </div>
            {members === null ? (
              <div className="admin-directory__hint">加载中…</div>
            ) : members.length === 0 ? (
              <div className="admin-directory__hint">该组织暂无成员——点节点上 ＋ 用户 直接开人</div>
            ) : (
              <table className="admin-table" data-testid="dir-members-table">
                <thead>
                  <tr>
                    <th>工号</th>
                    <th>姓名</th>
                    <th>邮箱</th>
                    <th>主部门</th>
                    <th>状态</th>
                    <th style={{ width: 180 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.user_id}>
                      <td className="admin-mono">{m.employee_no || m.user_id}</td>
                      <td>{m.name || m.user_id}</td>
                      <td className="admin-mono">{m.email || '—'}</td>
                      <td>{m.is_primary ? <span className="tag tag--builtin">主部门</span> : '—'}</td>
                      <td>
                        <span className={`admin-status${m.status === 1 ? ' admin-status--active' : ' admin-status--disabled'}`}>
                          {m.status === 1 ? '启用' : m.status === 2 ? '禁用' : '—'}
                        </span>
                      </td>
                      <td>
                        <span className="admin-role__ops">
                          {m.status === 2 ? (
                            <Button
                              variant="secondary"
                              loading={statusMutation.isPending && statusMutation.variables?.userId === m.user_id}
                              onClick={() => toggle(m.user_id, m.name, m.status ?? 1)}
                            >
                              启用
                            </Button>
                          ) : (
                            <Button
                              variant="danger"
                              loading={statusMutation.isPending && statusMutation.variables?.userId === m.user_id}
                              onClick={() => toggle(m.user_id, m.name, m.status ?? 1)}
                            >
                              禁用
                            </Button>
                          )}
                          <Button variant="danger" onClick={() => void offboard(m.user_id, m.name)}>
                            离职
                          </Button>
                          <Button variant="secondary" onClick={() => void detach(m.user_id, m.name)}>
                            移出
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <CreateUserModal open={modalOpen} deptId={modalDept} tree={tree ?? []} onClose={() => setModalOpen(false)} onCreated={onCreated} />
    </div>
  );
}

/** 权限列：优先展示 admin:*，否则取前两项普通权限点（?? [] 兜底——历史 scopes:null 白屏教训） */
function scopesText(scopes: string[] | null | undefined): string {
  const list = scopes ?? [];
  if (list.length === 0) return '—';
  const adminScopes = list.filter((s) => s === 'admin' || s.startsWith('admin:'));
  if (adminScopes.length > 0) return adminScopes.join(', ');
  return list.slice(0, 2).join(', ');
}
