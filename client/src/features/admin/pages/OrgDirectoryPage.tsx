/**
 * 组织用户（通讯录合并页，2026-11-12 用户裁决：原「用户」+「组织」两页合一）：
 * - 左：组织树=通讯录骨架——根「全公司」+ 部门节点，节点上直接「＋子部门」「＋用户」
 * - 右：选中「全公司」=全量用户表（原 UsersPage 能力：搜索/状态过滤/禁用/启用/离职交接）；
 *       选中部门=该部门成员表（工号/姓名/邮箱/主部门/状态/操作——挂靠已有用户/移出）
 * - 创建用户弹窗：工号自动建议（姓名全拼+重名两位补零递增，可手改）/姓名/邮箱/
 *   所属组织（默认=触发节点）/角色（默认不授权）——初始口令=工号+!BBW 首登强制改密
 * D26-O2：Table/Modal/Select/Input/Segmented/Alert/Tag 全量 antd 化。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Input, Modal, Segmented, Select, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { ApiError, getErrorText, errText } from '../../../shared/api/http';
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
  onDelete: (id: string, name: string) => void;
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
        <Button variant="text" size="small" onClick={() => setOpen(!open)} disabled={!hasChildren} icon={open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} />
        <FolderTree size={14} className="org-node__icon" />
        {editing ? (
          <span className="org-node__edit">
            <Input
              size="small"
              style={{ width: 160 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onPressEnter={() => {
                if (name.trim()) {
                  onRename(node.id, name.trim());
                  setEditing(false);
                }
              }}
            />
            <Button
              size="small"
              disabled={!name.trim()}
              onClick={() => {
                onRename(node.id, name.trim());
                setEditing(false);
              }}
            >
              保存
            </Button>
          </span>
        ) : (
          <span className="org-node__name" title={node.path} onClick={() => onSelect(node.id)} onDoubleClick={() => setEditing(true)}>
            {node.name}
          </span>
        )}
        <span className="org-node__ops">
          <Button variant="text" size="small" onClick={() => onAddUser(node.id)} title="在此组织下新增用户" icon={<UserPlus size={12} />} />
          <Button variant="text" size="small" onClick={() => setAdding(!adding)} title="新增子部门" icon={<Plus size={12} />} />
          <Button
            variant="text"
            size="small"
            danger
            onClick={() => onDelete(node.id, node.name)}
            title="删除（有子/挂人拒）"
            icon={<Trash2 size={12} />}
          />
        </span>
      </div>
      {adding ? (
        <div className="org-node__add" style={{ marginLeft: 24 }}>
          <Input.Search
            size="small"
            style={{ width: 220 }}
            placeholder="子部门名（≤50 字）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            enterButton="创建"
            onSearch={() => newName.trim() && add()}
          />
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
      setErr(errText(e, '创建失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新增用户"
      onCancel={onClose}
      destroyOnClose
      data-testid="create-user-modal"
      footer={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" loading={submitting} disabled={!name.trim()} onClick={() => void submit()} data-testid="create-user-submit">
          创建
        </Button>,
      ]}
    >
      <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
        <Typography.Text>姓名 *</Typography.Text>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="真实姓名（≤50 字）" data-testid="create-user-name" />
        <Typography.Text>
          工号 *（登录账号）{' '}
          <Button variant="text" size="small" onClick={regenerate} title="按姓名重新生成拼音建议">
            <RefreshCw size={11} /> 重新生成
          </Button>
        </Typography.Text>
        <Input
          value={empno}
          onChange={(e) => {
            setEmpno(e.target.value);
            setEmpnoDirty(true);
          }}
          placeholder="留空=按姓名全拼自动生成"
          data-testid="create-user-empno"
        />
        <Typography.Text type="secondary">建议值=姓名全拼，重名自动补零递增（zhangsan02）；多音字/生僻字可手改</Typography.Text>
        <Typography.Text>邮箱</Typography.Text>
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="选填" />
        <Typography.Text>所属组织</Typography.Text>
        <Select
          value={dept}
          onChange={setDept}
          data-testid="create-user-dept"
          options={[
            { value: '', label: '不挂部门' },
            ...flat.map((d) => ({ value: d.id, label: `${'　'.repeat(d.depth)}${d.name}` })),
          ]}
        />
        <Typography.Text>角色</Typography.Text>
        <Select
          value={roleId}
          onChange={setRoleId}
          data-testid="create-user-role"
          options={[
            { value: '0', label: '不授权（普通成员）' },
            ...roles.map((r) => ({ value: r.id, label: `${r.name}${r.is_builtin ? '（内置）' : ''}` })),
          ]}
        />
        <Typography.Text type="secondary">初始口令 = 工号 +“!BBW”，首次登录强制修改</Typography.Text>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </div>
    </Modal>
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
      setActionError(errText(e, '部门创建失败'));
    }
  };

  const renameNode = async (id: string, newName: string) => {
    try {
      await renameDept(id, newName);
      await reloadTree();
    } catch (e) {
      setActionError(errText(e, '改名失败'));
    }
  };

  const deleteNode = (id: string, deptName: string) => {
    Modal.confirm({
      title: `删除部门「${deptName}」？`,
      content: '有子部门或挂人时服务端拒绝',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteDept(id);
          if (selected === id) setSelected(null);
          await reloadTree();
        } catch (e) {
          setActionError(errText(e, '删除失败（有子部门或挂人）'));
        }
      },
    });
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
        onError: (err) => setActionError(errText(err, '操作失败，请稍后再试')),
      },
    );
  };

  const offboard = (userId: string, uname: string) => {
    Modal.confirm({
      title: `离职交接 ${uname}？`,
      content: '将执行：禁用账号 + 全端下线 + 令牌吊销（已记审计）。',
      okText: '离职交接',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setActionError('');
        setActionOk('');
        try {
          await offboardUser(userId);
          setActionOk(`已离职交接 ${uname}：账号禁用并全端下线`);
          void query.refetch();
          if (selected) void reloadMembers(selected);
        } catch (e) {
          setActionError(errText(e, '操作失败，请稍后重试'));
        }
      },
    });
  };

  const attach = async () => {
    const uid = attachUid.trim();
    if (!uid || !selected) return;
    try {
      await attachDeptMember(selected, uid, false);
      setAttachUid('');
      await reloadMembers(selected);
    } catch (e) {
      setActionError(errText(e, '挂靠失败（用户不存在？）'));
    }
  };

  const detach = (uid: string, uname: string) => {
    if (!selected) return;
    Modal.confirm({
      title: `将 ${uname || uid} 移出该部门？`,
      okText: '移出',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await detachDeptMember(selected, uid);
          await reloadMembers(selected);
        } catch {
          setActionError('移出失败');
        }
      },
    });
  };

  const selectedName = useMemo(() => {
    if (!selected) return null;
    const flat = flattenTree(tree ?? []);
    return flat.find((d) => d.id === selected)?.name ?? selected;
  }, [selected, tree]);

  const userColumns: ColumnsType<AdminUser> = [
    { title: '工号', dataIndex: 'employee_no', width: 110, render: (v: string) => <span className="admin-mono">{v}</span> },
    { title: '姓名', dataIndex: 'display_name', width: 110 },
    { title: '邮箱', dataIndex: 'email', render: (v: string) => <span className="admin-mono">{v || '—'}</span> },
    { title: '权限', key: 'scopes', render: (_, u) => <span className="admin-scope-cell">{scopesText(u.scopes)}</span> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number) => <Tag color={v === 1 ? 'green' : 'red'}>{v === 1 ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 210,
      render: (_, u) =>
        u.status === 1 ? (
          <>
            <Button
              variant="danger"
              size="small"
              loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
              onClick={() => toggle(u.id, u.display_name, u.status)}
            >
              禁用
            </Button>{' '}
            <Button variant="danger" size="small" disabled={statusMutation.isPending} onClick={() => offboard(u.id, u.display_name)}>
              离职交接
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="small"
            loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
            onClick={() => toggle(u.id, u.display_name, u.status)}
          >
            启用
          </Button>
        ),
    },
  ];

  const memberColumns: ColumnsType<DeptMemberRow> = [
    { title: '工号', key: 'empno', width: 110, render: (_, m) => <span className="admin-mono">{m.employee_no || m.user_id}</span> },
    { title: '姓名', key: 'name', width: 110, render: (_, m) => m.name || m.user_id },
    { title: '邮箱', key: 'email', render: (_, m) => <span className="admin-mono">{m.email || '—'}</span> },
    { title: '主部门', key: 'primary', width: 90, render: (_, m) => (m.is_primary ? <Tag color="geekblue">主部门</Tag> : '—') },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number | null) => <Tag color={v === 1 ? 'green' : v === 2 ? 'red' : 'default'}>{v === 1 ? '启用' : v === 2 ? '禁用' : '—'}</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 230,
      render: (_, m) => (
        <>
          {m.status === 2 ? (
            <Button
              variant="secondary"
              size="small"
              loading={statusMutation.isPending && statusMutation.variables?.userId === m.user_id}
              onClick={() => toggle(m.user_id, m.name, m.status ?? 1)}
            >
              启用
            </Button>
          ) : (
            <Button
              variant="danger"
              size="small"
              loading={statusMutation.isPending && statusMutation.variables?.userId === m.user_id}
              onClick={() => toggle(m.user_id, m.name, m.status ?? 1)}
            >
              禁用
            </Button>
          )}{' '}
          <Button variant="danger" size="small" onClick={() => offboard(m.user_id, m.name)}>
            离职
          </Button>{' '}
          <Button variant="secondary" size="small" onClick={() => detach(m.user_id, m.name)}>
            移出
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="admin-directory" data-testid="admin-directory">
      {/* 左栏：组织树（通讯录骨架） */}
      <aside className="admin-directory__tree">
        <div className="admin-directory__tree-head">
          <span>组织树</span>
          <Button variant="text" size="small" onClick={() => setRootAdding(!rootAdding)} title="新增根部门" icon={<Plus size={12} />}>
            根部门
          </Button>
        </div>
        <div
          className={`org-node__row org-node__row--root${selected === null ? ' org-node__row--selected' : ''}`}
          onClick={() => setSelected(null)}
          data-testid="dir-node-all"
        >
          <Building2 size={14} className="org-node__icon" />
          <span className="org-node__name">全公司</span>
          <span className="org-node__ops">
            <Button variant="text" size="small" onClick={(e) => { e.stopPropagation(); openCreate(''); }} title="新增用户（不挂部门）" icon={<UserPlus size={12} />} />
          </span>
        </div>
        {rootAdding ? (
          <div className="org-node__add">
            <Input.Search
              size="small"
              style={{ width: 220 }}
              placeholder="根部门名"
              value={rootName}
              onChange={(e) => setRootName(e.target.value)}
              enterButton="创建"
              onSearch={() => {
                if (rootName.trim()) {
                  void addDept('', rootName.trim());
                  setRootAdding(false);
                  setRootName('');
                }
              }}
            />
          </div>
        ) : null}
        {treeError ? <Alert type="error" showIcon message={treeError} style={{ marginTop: 8 }} /> : null}
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
              onDelete={(id, nm) => deleteNode(id, nm)}
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
          <Button onClick={() => openCreate(selected ?? '')} data-testid="dir-create-user">
            <UserPlus size={14} /> 新增用户
          </Button>
        </header>

        {actionError ? <Alert type="error" showIcon message={actionError} style={{ marginBottom: 8 }} /> : null}
        {actionOk ? <Alert type="success" showIcon message={actionOk} style={{ marginBottom: 8 }} /> : null}

        {selected === null ? (
          /* 全公司：原用户页能力（搜索/状态过滤/无限加载/行操作） */
          <>
            <div className="admin-toolbar">
              <Input.Search
                allowClear
                className="admin-toolbar__search"
                placeholder="搜索工号 / 姓名 / 邮箱，回车检索"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onSearch={(v) => setKeyword(v.trim())}
              />
              <Segmented
                value={status}
                onChange={(v) => setStatus(v as number)}
                options={[
                  { value: 0, label: '全部' },
                  { value: 1, label: '启用' },
                  { value: 2, label: '禁用' },
                ]}
              />
            </div>
            <Table<AdminUser>
              rowKey="id"
              columns={userColumns}
              dataSource={items}
              loading={query.isPending}
              data-testid="admin-users-table"
              locale={{ emptyText: query.isError ? ' ' : '无匹配用户' }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
            />
            {query.isError ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message={query.error instanceof ApiError ? getErrorText(query.error.code) : '加载失败'}
                action={
                  <Button variant="secondary" size="small" onClick={() => void query.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}
            {lastPage?.has_more && lastPage.next_cursor ? (
              <div className="admin-loadmore">
                <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  加载更多
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          /* 部门：成员表 */
          <>
            <div className="admin-toolbar">
              <Input.Search
                allowClear
                className="admin-toolbar__search"
                placeholder="挂靠已有用户：输入其用户 ID 回车"
                value={attachUid}
                onChange={(e) => setAttachUid(e.target.value)}
                onSearch={() => void attach()}
                data-testid="dir-attach-uid"
              />
            </div>
            <Table<DeptMemberRow>
              rowKey="user_id"
              columns={memberColumns}
              dataSource={members ?? []}
              loading={members === null}
              data-testid="dir-members-table"
              locale={{ emptyText: '该组织暂无成员——点节点上 ＋ 用户 直接开人' }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
            />
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
