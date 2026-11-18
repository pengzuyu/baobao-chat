/**
 * 组织用户（通讯录合并页，2026-11-12 用户裁决：原「用户」+「组织」两页合一）：
 * - 左：组织树=通讯录骨架——裸容器与左侧管理菜单栏同款观感（无 Card 卡片：背景+
 *   右边框+定高内滚，可拖宽 220~480）；树与通讯录同构：部门节点（行尾快捷 ＋用户/
 *   ＋组织+人数计数；根节点亦有 FolderPlus=新建根组织）+ 部门下用户叶子（数据源
 *   共用通讯录 ['org','users','all'] 缓存，未挂主部门用户挂「全公司」根下）；
 *   分界线全高可拖（SplitHandle），其上叠窄竖条把手（箭头+竖排文字「收起/展开
 *   组织树」）点击折叠/拖动调宽（拖过最小继续左拖=折叠，展开回折叠前宽度）
 * - 右：选中「全公司」=全量用户表（搜索/状态过滤/禁用/启用）；
 *       选中部门=该部门成员表（工号/姓名/邮箱/主部门/状态/操作——挂靠已有用户/移出）
 * - 创建用户弹窗：工号自动建议（姓名全拼+重名两位补零递增，可手改）/姓名/
 *   邮箱=前缀@统一后缀 MAIL_DOMAIN（前缀默认跟工号可改；2026-11-18 品牌单源）/
 *   所属组织（默认=触发节点）/角色（默认不授权）——初始口令=工号+!BBC 首登强制改密
 * - 批量导入弹窗（2026-11-18 收编，原独立 ImportPage 退役）：导入前选目标组织（可
 *   无组织）；文件只认姓名，工号/邮箱服务端按规范生成不支持自定义（邮箱同走 MAIL_DOMAIN）
 * - 用户表角色列（2026-11-18）：服务端 ListUsers 聚合 roles 引用，点击角色 Tag 开
 *   右抽屉只读展示全量权限字典（勾上该角色已授权项；编辑仍走角色管理页）
 * D26-O2：Table/Modal/Select/Input/Segmented/Alert/Tag 化；补充轮：组织树→antd Tree
 * titleRender（双击改名/行内 ops，样板对齐 kb ArticleTree——org-node 自研样式退役）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button as AntdButton, Checkbox, Drawer, Flex, Input, Modal, Segmented, Select, Space, Table, Tag, Tree, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DataNode } from 'antd/es/tree';
import {
  Building2,
  FileUp,
  FolderPlus,
  FolderTree,
  RefreshCw,
  Trash2,
  UserPlus,
  UserRound,
} from 'lucide-react';
import { ApiError, getErrorText, errText } from '../../../shared/api/http';
import { MAIL_DOMAIN } from '../../../shared/brand';
import { Button } from '../../../shared/ui/Button';
import { ImportUsersModal, flattenTree } from '../components/ImportUsersModal';
import { SplitCollapseTab, SplitHandle, useCollapsibleSplit } from '../../../shared/ui/Splitter';
import { fetchAllDirectoryUsers, type DirectoryUser } from '../../contacts/api/contacts';
import {
  attachDeptMember,
  createUser,
  deleteDept,
  fetchDeptMembers,
  fetchDeptTree,
  fetchPermPoints,
  fetchRoles,
  renameDept,
  createDept,
  detachDeptMember,
  suggestEmpno,
  type AdminRole,
  type DeptMemberRow,
  type DeptNode,
  type ImportResult,
  type PermPointsDoc,
} from '../api/admin';
import type { AdminUser } from '../model/types';
import { useUsers, useUserStatus } from '../api/hooks';

/** 用户叶子节点 key（`u-` 前缀与部门 id 区隔；onSelect/titleRender 按前缀分派） */
const userNodeKey = (uid: string) => `u-${uid}`;

/** 部门树 → antd Tree 节点（部门+部门下用户叶子——通讯录同构；key=部门 id，title 由 titleRender 接管） */
function toTreeData(nodes: DeptNode[], deptUsers: Map<string, DirectoryUser[]>): DataNode[] {
  return nodes.map((n) => ({
    key: n.id,
    title: n.name,
    children: [
      ...(n.children?.length ? toTreeData(n.children, deptUsers) : []),
      ...(deptUsers.get(n.id) ?? []).map((u) => ({ key: userNodeKey(u.uid), title: u.display_name, isLeaf: true })),
    ],
  }));
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
  // 邮箱前缀（2026-11-18 统一后缀制：前缀@MAIL_DOMAIN；未手改时前缀跟随工号）
  const [emailPrefix, setEmailPrefix] = useState('');
  const [emailDirty, setEmailDirty] = useState(false);
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

  // 邮箱前缀默认跟随工号（工号建议刷新/重新生成/手改均联动；手改过前缀则不再跟随）
  useEffect(() => {
    if (!emailDirty) setEmailPrefix(empno);
  }, [empno, emailDirty]);

  const regenerate = () => {
    setEmpnoDirty(false);
    const trimmed = name.trim();
    if (trimmed) void suggestEmpno(trimmed).then(setEmpno).catch(() => undefined);
  };

  const submit = async () => {
    setErr('');
    setSubmitting(true);
    try {
      const prefix = emailPrefix.trim();
      const u = await createUser({
        employee_no: empno.trim() || undefined,
        display_name: name.trim(),
        email: prefix ? `${prefix}@${MAIL_DOMAIN}` : undefined,
        dept_id: dept ? Number(dept) : undefined,
        role_id: roleId !== '0' ? Number(roleId) : undefined,
      });
      onCreated(u);
      // 复位（下次打开干净）
      setName('');
      setEmpno('');
      setEmpnoDirty(false);
      setEmailPrefix('');
      setEmailDirty(false);
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
      <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 8 }}>
        <Typography.Text>姓名 *</Typography.Text>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="真实姓名（≤50 字）" data-testid="create-user-name" />
        <Flex align="center" gap={8}>
          <Typography.Text>工号 *（登录账号）</Typography.Text>
          <AntdButton type="text" size="small" onClick={regenerate} title="按姓名重新生成拼音建议">
            <RefreshCw size={11} /> 重新生成
          </AntdButton>
        </Flex>
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
        <Typography.Text>邮箱（前缀@统一后缀）</Typography.Text>
        <Input
          value={emailPrefix}
          onChange={(e) => {
            setEmailPrefix(e.target.value);
            setEmailDirty(true);
          }}
          addonAfter={`@${MAIL_DOMAIN}`}
          placeholder="默认=工号，留空=不设邮箱"
          data-testid="create-user-email"
        />
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
        <Typography.Text type="secondary">初始口令 = 工号 +“!BBC”，首次登录强制修改</Typography.Text>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </Space>
    </Modal>
  );
}

/* ── 新建组织弹窗（2026-11-18：原树内内联输入退役，统一弹窗） ── */

function CreateDeptModal({
  open,
  parentId,
  tree,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** 触发节点（'' = 作为根部门） */
  parentId: string;
  tree: DeptNode[];
  onClose: () => void;
  onCreated: (node: DeptNode) => void;
}) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(parentId);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const flat = useMemo(() => flattenTree(tree), [tree]);

  useEffect(() => {
    if (!open) return;
    setParent(parentId);
    setName('');
    setErr('');
  }, [open, parentId]);

  const submit = async () => {
    setErr('');
    setSubmitting(true);
    try {
      const node = await createDept(parent, name.trim());
      onCreated(node);
      setName('');
    } catch (e) {
      setErr(errText(e, '创建失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建组织"
      onCancel={onClose}
      destroyOnClose
      data-testid="create-dept-modal"
      footer={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" loading={submitting} disabled={!name.trim()} onClick={() => void submit()} data-testid="create-dept-submit">
          创建
        </Button>,
      ]}
    >
      <Space direction="vertical" size={4} style={{ width: '100%', marginTop: 8 }}>
        <Typography.Text>组织名称 *</Typography.Text>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="部门名（≤50 字）"
          onPressEnter={() => name.trim() && void submit()}
          data-testid="create-dept-name"
        />
        <Typography.Text>上级组织</Typography.Text>
        <Select
          value={parent}
          onChange={setParent}
          data-testid="create-dept-parent"
          options={[
            { value: '', label: '作为根部门（不挂上级）' },
            ...flat.map((d) => ({ value: d.id, label: `${'　'.repeat(d.depth)}${d.name}` })),
          ]}
        />
        <Typography.Text type="secondary">有子部门或挂人时不可删除；名称支持双击树节点改名</Typography.Text>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </Space>
    </Modal>
  );
}

/* ── 角色权限只读抽屉（用户表角色 Tag 点击；全量字典勾选态只读，编辑走角色管理页） ── */

function RolePermDrawer({ role, onClose }: { role: { id: string; name: string } | null; onClose: () => void }) {
  const [detail, setDetail] = useState<AdminRole | null>(null);
  const [permDoc, setPermDoc] = useState<PermPointsDoc | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!role) return;
    setDetail(null);
    setPermDoc(null);
    setErr('');
    let alive = true;
    void Promise.all([
      fetchRoles()
        .then((rs) => rs.find((r) => r.id === role.id) ?? null)
        .catch(() => null),
      fetchPermPoints().catch(() => null),
    ]).then(([d, doc]) => {
      if (!alive) return;
      if (!d) setErr('角色信息加载失败——请稍后重试');
      if (!doc) setErr('权限点字典加载失败——请稍后重试');
      setDetail(d);
      setPermDoc(doc);
    });
    return () => {
      alive = false;
    };
  }, [role]);

  const owned = useMemo(() => new Set(detail?.permissions ?? []), [detail]);

  return (
    <Drawer
      open={!!role}
      title={role ? `${role.name} · 权限（只读）` : ''}
      placement="right"
      width={480}
      onClose={onClose}
      destroyOnClose
      data-testid="role-perm-drawer"
      footer={
        <Button variant="secondary" onClick={onClose} style={{ width: '100%' }}>
          关闭
        </Button>
      }
    >
      {detail ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {detail.description || '（无描述）'}
            {detail.is_builtin ? ' · 内置角色' : ''}
          </Typography.Text>
          <Typography.Text type="secondary">
            已授权 {owned.size} / {permDoc?.total ?? '…'} 项权限点——只读视图，调整请前往「角色权限」页编辑
          </Typography.Text>
          {permDoc?.groups.map((g) => (
            <div key={g.domain}>
              <Typography.Text type="secondary">
                {g.label}（{g.points.length} 项）
              </Typography.Text>
              <div>
                {g.points.map((p) => (
                  <Checkbox key={p.code} checked={owned.has(p.code)} disabled>
                    <Typography.Text code>{p.code}</Typography.Text>{' '}
                    <Typography.Text type="secondary">{p.desc}</Typography.Text>
                  </Checkbox>
                ))}
              </div>
            </div>
          ))}
        </Space>
      ) : err ? (
        <Alert type="error" showIcon message={err} />
      ) : (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      )}
    </Drawer>
  );
}

/* ── 主页面 ── */

export function OrgDirectoryPage() {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  // 左栏树
  const [tree, setTree] = useState<DeptNode[] | null>(null);
  const [treeError, setTreeError] = useState('');
  const [selected, setSelected] = useState<string | null>(null); // null=全公司
  // 左栏可拖宽 + 拖过头折叠（220~480；裸容器无头部按钮约束）
  const split = useCollapsibleSplit('org-tree', 300, 220, 480);
  // 树内联编辑态：renaming=节点 id（双击改名）
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  // 弹窗：新建用户 / 新建组织
  const [modalOpen, setModalOpen] = useState(false);
  const [modalDept, setModalDept] = useState('');
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [deptModalParent, setDeptModalParent] = useState('');
  // 弹窗：批量导入（2026-11-18 收编；默认挂当前选中部门）
  const [importOpen, setImportOpen] = useState(false);
  const [importDept, setImportDept] = useState('');
  // 角色权限只读抽屉（用户表角色 Tag 点击打开）
  const [permRole, setPermRole] = useState<{ id: string; name: string } | null>(null);
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

  /** 树内用户叶子数据源：共用通讯录 ['org','users','all'] 缓存（通讯录已拉过则挂载零请求）；
   * 用户/挂靠变更后 invalidate 同键两页同步 */
  const usersQuery = useQuery({ queryKey: ['org', 'users', 'all'], queryFn: fetchAllDirectoryUsers });
  const users = usersQuery.data;
  const refreshDirectory = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['org', 'users', 'all'] });
  }, [queryClient]);
  /** deptId → 直接挂靠用户 + uid → 用户；未挂主部门（或指向已删部门——数据漂移防御）→ ungrouped 挂根下（通讯录同款口径） */
  const { deptUsers, ungrouped, userById } = useMemo(() => {
    const deptUsers = new Map<string, DirectoryUser[]>();
    const ungrouped: DirectoryUser[] = [];
    const userById = new Map<string, DirectoryUser>();
    const deptIds = new Set(flattenTree(tree ?? []).map((d) => d.id));
    for (const u of users ?? []) {
      userById.set(u.uid, u);
      if (u.dept_id && deptIds.has(u.dept_id)) {
        const list = deptUsers.get(u.dept_id);
        if (list) list.push(u);
        else deptUsers.set(u.dept_id, [u]);
      } else {
        ungrouped.push(u);
      }
    }
    return { deptUsers, ungrouped, userById };
  }, [users, tree]);
  /** deptId → 子树用户总数（含递归子部门；部门行尾计数，通讯录 calc 同款） */
  const countOf = useMemo(() => {
    const childOf = new Map<string, string[]>();
    const walk = (nodes: DeptNode[], parent?: string) => {
      for (const n of nodes) {
        if (parent) childOf.set(parent, [...(childOf.get(parent) ?? []), n.id]);
        walk(n.children ?? [], n.id);
      }
    };
    walk(tree ?? []);
    const cache = new Map<string, number>();
    const calc = (id: string): number => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const n = (deptUsers.get(id)?.length ?? 0) + (childOf.get(id) ?? []).reduce((sum, cid) => sum + calc(cid), 0);
      cache.set(id, n);
      return n;
    };
    return calc;
  }, [tree, deptUsers]);

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

  const openDeptModal = (parentId: string) => {
    setDeptModalParent(parentId);
    setDeptModalOpen(true);
  };

  const onDeptCreated = (node: DeptNode) => {
    setDeptModalOpen(false);
    setActionOk(`已创建组织「${node.name}」`);
    setSelected(node.id);
    void reloadTree();
  };

  const onCreated = (u: AdminUser) => {
    setModalOpen(false);
    setActionOk(`已创建 ${u.display_name}（${u.employee_no}）——初始口令=工号+“!BBC”，首登强制改密`);
    void query.refetch();
    refreshDirectory(); // 树内用户叶子同步
    if (selected) void reloadMembers(selected);
  };

  // 批量导入提交回调（结果明细由弹窗自展示；此处刷新列表+汇总提示）
  const onImported = (r: ImportResult) => {
    setActionOk(`批量导入完成：成功 ${r.created} · 失败 ${r.failed}——工号与邮箱已按规范生成，初始口令=工号+“!BBC”`);
    void query.refetch();
    refreshDirectory();
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

  const attach = async () => {
    const uid = attachUid.trim();
    if (!uid || !selected) return;
    try {
      await attachDeptMember(selected, uid, false);
      setAttachUid('');
      refreshDirectory(); // 主部门可能随挂靠变化（首挂标主部门）
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
          refreshDirectory(); // 移出后主部门变化（回未分组或次部门递补）
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

  const treeData: DataNode[] = useMemo(
    () => [
      {
        key: 'all',
        title: '全公司',
        children: [
          ...(tree ? toTreeData(tree, deptUsers) : []),
          // 未挂主部门用户直接挂「全公司」根下（叶子）
          ...ungrouped.map((u) => ({ key: userNodeKey(u.uid), title: u.display_name, isLeaf: true })),
        ],
      },
    ],
    [tree, deptUsers, ungrouped],
  );

  /** titleRender：用户叶子=纯浏览（管理操作在右栏表）；根=全公司+加人/加组织+总人数；
   * 部门=名称（双击改名）+子树人数+ 加人/加子部门/删；renaming 态换内联输入 */
  const titleRender = (node: DataNode) => {
    const key = String(node.key);
    const name = node.title as string;
    if (key.startsWith('u-')) {
      const u = userById.get(key.slice(2));
      return (
        <Space size={4} data-testid="dir-node-user" title={u ? `${u.display_name}（${u.employee_no}）` : undefined}>
          <UserRound size={13} />
          <span>{u?.display_name ?? name}</span>
        </Space>
      );
    }
    if (key === 'all') {
      return (
        <Space size={4} data-testid="dir-node-all">
          <Building2 size={14} />
          <span>{name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {users ? users.length : '…'}
          </Typography.Text>
          <AntdButton
            type="text"
            size="small"
            title="新建用户（不挂部门）"
            icon={<UserPlus size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              openCreate('');
            }}
          />
          <AntdButton
            type="text"
            size="small"
            title="新建根组织"
            icon={<FolderPlus size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              openDeptModal('');
            }}
          />
        </Space>
      );
    }
    if (renaming === key) {
      return (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Input
            size="small"
            style={{ width: 140 }}
            value={renameName}
            autoFocus
            onChange={(e) => setRenameName(e.target.value)}
            onPressEnter={() => {
              if (renameName.trim()) {
                void renameNode(key, renameName.trim());
                setRenaming(null);
              }
            }}
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
          />
          <AntdButton
            size="small"
            type="primary"
            disabled={!renameName.trim()}
            onClick={() => {
              void renameNode(key, renameName.trim());
              setRenaming(null);
            }}
          >
            保存
          </AntdButton>
        </Space>
      );
    }
    return (
      <Space size={4}>
        <FolderTree size={13} />
        <span
          title="双击改名"
          onDoubleClick={() => {
            setRenaming(key);
            setRenameName(name);
          }}
        >
          {name}
        </span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {countOf(key)}
        </Typography.Text>
        <AntdButton
          type="text"
          size="small"
          title="在此组织下新增用户"
          icon={<UserPlus size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            openCreate(key);
          }}
        />
        <AntdButton
          type="text"
          size="small"
          title="新增子部门（弹窗）"
          icon={<FolderPlus size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            openDeptModal(key);
          }}
        />
        <AntdButton
          type="text"
          size="small"
          danger
          title="删除（有子/挂人拒）"
          icon={<Trash2 size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            deleteNode(key, name);
          }}
        />
      </Space>
    );
  };

  const userColumns: ColumnsType<AdminUser> = [
    { title: '工号', dataIndex: 'employee_no', width: 110, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '姓名', dataIndex: 'display_name', width: 110 },
    { title: '邮箱', dataIndex: 'email', render: (v: string) => (v ? <Typography.Text code>{v}</Typography.Text> : '—') },
    {
      // 角色列（2026-11-18：权限点直显改角色 Tag；点击开右抽屉只读看该角色权限集）
      title: '角色',
      key: 'roles',
      render: (_, u) => {
        const roles = u.roles ?? [];
        if (roles.length === 0) return '—';
        return (
          <Space size={4} wrap>
            {roles.map((r) => (
              <Tag
                key={r.role_id}
                color="geekblue"
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                onClick={() => setPermRole({ id: r.role_id, name: r.role_name })}
                data-testid="user-role-tag"
              >
                {r.role_name}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number) => <Tag color={v === 1 ? 'green' : 'red'}>{v === 1 ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 220,
      render: (_, u) =>
        u.status === 1 ? (
          <Button
            variant="danger"
            size="small"
            loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
            onClick={() => toggle(u.id, u.display_name, u.status)}
          >
            禁用
          </Button>
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
    { title: '工号', key: 'empno', width: 110, render: (_, m) => <Typography.Text code>{m.employee_no || m.user_id}</Typography.Text> },
    { title: '姓名', key: 'name', width: 110, render: (_, m) => m.name || m.user_id },
    { title: '邮箱', key: 'email', render: (_, m) => (m.email ? <Typography.Text code>{m.email}</Typography.Text> : '—') },
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
      width: 240,
      render: (_, m) => (
        <Space size={4}>
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
          )}
          <Button variant="secondary" size="small" onClick={() => detach(m.user_id, m.name)}>
            移出
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Flex gap={8} align="stretch" style={{ height: '100%', position: 'relative' }} data-testid="admin-directory">
      {/* 左栏 wrapper：宽度受控（paneRef 拖动直写；把手挂其内随右缘自动跟随，拖动零重渲也同步移动） */}
      <div ref={split.paneRef} style={{ position: 'relative', width: split.collapsed ? 0 : split.width, flex: 'none', height: '100%' }}>
        {!split.collapsed && (
          <div
            style={{
              width: '100%',
              height: '100%',
              overflowY: 'auto',
              background: token.colorBgContainer,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              padding: '8px 0',
            }}
            data-testid="org-tree-pane"
          >
            {treeError ? <Alert type="error" showIcon message={treeError} style={{ margin: '0 8px 8px' }} /> : null}
            {tree === null ? (
              <Typography.Text type="secondary" style={{ paddingInline: 8 }}>
                加载中…
              </Typography.Text>
            ) : (
              <Tree
                blockNode
                defaultExpandAll
                treeData={treeData}
                titleRender={titleRender}
                selectedKeys={[selected ?? 'all']}
                onSelect={(keys) => {
                  const k = keys[0] ? String(keys[0]) : null;
                  if (k?.startsWith('u-')) return; // 用户叶子仅浏览（管理操作在右栏表），不切换选中
                  setSelected(k && k !== 'all' ? k : null);
                }}
              />
            )}
          </div>
        )}
        {/* 把手（三改图例口径）在边界线右侧垂直中央：left=calc(100%+1px) 随 wrapper 宽度
            由布局自动跟随（直写宽度无重渲也移动）；折叠态 wrapper 宽 0=贴页面左缘 */}
        <div
          style={{
            position: 'absolute',
            left: split.collapsed ? 0 : 'calc(100% + 1px)',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 13,
          }}
        >
          <SplitCollapseTab collapsed={split.collapsed} label="组织树" bind={split.bind} onToggle={split.collapsed ? split.expand : split.collapse} />
        </div>
      </div>
      {/* 分界线（全高拖拽热区）：marginLeft -13 = 抵根 gap 8 + 自身叠边框 5——hover 线与容器边界线重合为一条 */}
      {!split.collapsed ? <SplitHandle bind={split.bind} style={{ marginLeft: -13 }} /> : null}

      {/* 右栏：通讯录内容（定高内滚——不与左栏比高） */}
      <div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {selectedName ?? '全公司'}
          </Typography.Title>
          <Typography.Text type="secondary">
            {selected ? '组织成员（含主部门标记）——新建入口在左侧组织树头部或节点上' : '全量用户（跨部门检索）——点左侧部门查看该组织通讯录'}
          </Typography.Text>
          <span style={{ flex: 1 }} />
          {/* 批量导入（2026-11-18 收编入口；默认挂当前选中部门，弹窗内可改/可无组织） */}
          <Button
            onClick={() => {
              setImportDept(selected ?? '');
              setImportOpen(true);
            }}
            data-testid="dir-import-users"
          >
            <FileUp size={14} /> 批量导入
          </Button>
        </Flex>

        {actionError ? <Alert type="error" showIcon message={actionError} style={{ marginBottom: 8 }} /> : null}
        {actionOk ? <Alert type="success" showIcon message={actionOk} style={{ marginBottom: 8 }} /> : null}

        {selected === null ? (
          /* 全公司：原用户页能力（搜索/状态过滤/无限加载/行操作） */
          <>
            <Space size={8} wrap style={{ marginBottom: 12 }}>
              <Input.Search
                allowClear
                placeholder="搜索工号 / 姓名 / 邮箱，回车检索"
                style={{ width: 280 }}
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
            </Space>
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
                style={{ marginTop: 8 }}
                message={query.error instanceof ApiError ? getErrorText(query.error.code) : '加载失败'}
                action={
                  <Button variant="secondary" size="small" onClick={() => void query.refetch()}>
                    重试
                  </Button>
                }
              />
            ) : null}
            {lastPage?.has_more && lastPage.next_cursor ? (
              <Flex justify="center" style={{ marginTop: 8 }}>
                <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  加载更多
                </Button>
              </Flex>
            ) : null}
          </>
        ) : (
          /* 部门：成员表 */
          <>
            <Input.Search
              allowClear
              placeholder="挂靠已有用户：输入其用户 ID 回车"
              style={{ width: 280, marginBottom: 12 }}
              value={attachUid}
              onChange={(e) => setAttachUid(e.target.value)}
              onSearch={() => void attach()}
              data-testid="dir-attach-uid"
            />
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
      <CreateDeptModal open={deptModalOpen} parentId={deptModalParent} tree={tree ?? []} onClose={() => setDeptModalOpen(false)} onCreated={onDeptCreated} />
      <ImportUsersModal open={importOpen} tree={tree ?? []} defaultDeptId={importDept} onClose={() => setImportOpen(false)} onImported={onImported} />
      <RolePermDrawer role={permRole} onClose={() => setPermRole(null)} />
    </Flex>
  );
}
