/**
 * 通讯录页（M2 落地后按用户口径二改，2026-11-12）：
 * - 单棵树：全公司 → 部门树 → 用户叶子（按主部门挂靠；未挂部门用户归虚拟「未分组」）
 * - 搜索与聊天页同款：输入先出下拉结果（联系人段=服务端四路检索；组织段=树内名称过滤），
 *   点击结果定位回树——展开祖先 + 滚动入视 + 闪烁高亮（不直接跳走）
 * - 交互：双击用户 → 发起单聊直达（conv.create type=1 幂等）；hover 用户 → 详情卡
 *   （姓名/工号/组织链路 + 发消息）；管理动作仍在 /admin/org
 * 数据源：GET /org/tree + GET /org/users（全量翻页拉齐后端内组树）。
 * D26-O3 antd 换装：树→antd Tree（titleRender 图标/人数 Tag/hover Popover 详情卡/徽标）；
 * 搜索下拉→Popover+Menu（分组段+禁用占位行）；右侧档案→Card+Descriptions+Breadcrumb；
 * 头像→Avatar、等宽字→Text code、提示→Text secondary、alert→Modal.error；
 * 布局内联 style + antd token（bbw-contacts / org-node / icon-btn 等自研样式全退役，
 * 定位闪烁由 CSS 类改 WAAPI el.animate——无 CSS 依赖）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Breadcrumb,
  Card,
  Descriptions,
  Flex,
  Input,
  Menu,
  Modal,
  Popover,
  Space,
  Tag,
  Tree,
  Typography,
  theme,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { MenuProps } from 'antd';
import { Building2, FolderTree, MessageCircle, Search, Users } from 'lucide-react';
import { fetchDirectoryUsers, fetchOrgTree } from '../api/contacts';
import type { DirectoryUser } from '../api/contacts';
import type { DeptNode } from '../../admin/api/admin';
import { convCreate } from '../../im/api/im';
import { qk } from '../../../shared/api/keys';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SplitHandle, useSplitWidth } from '../../../shared/ui/Splitter';
import { useAuthStore } from '../../auth/store/auth';

/** 搜索防抖（与聊天页/选人器同节奏） */
const SEARCH_DEBOUNCE_MS = 300;
/** 下拉各段最多行数 */
const RESULT_MAX_ROWS = 5;
/** 定位闪烁时长（ms） */
const FLASH_MS = 1200;
/** DOM 节点键（定位/选中/闪烁共用；同时作 Tree 节点 key） */
const deptDomId = (id: string) => `dept-${id}`;
const userDomId = (uid: string) => `user-${uid}`;

/** 全量拉齐用户（cursor 翻页聚合；v0.1 用户量级安全上限 100 页=5000 人同服务端口径） */
async function fetchAllUsers(): Promise<DirectoryUser[]> {
  const out: DirectoryUser[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await fetchDirectoryUsers({ cursor, limit: 50 });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

export function ContactsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const myUid = useAuthStore((s) => s.user?.uid);
  const { token } = theme.useToken();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dmBusy, setDmBusy] = useState(false);
  /** 展开集（antd Tree controlled expandedKeys；键=dept-* domId） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 左树拖拽调宽（全站左侧栏统一能力；按页记忆）
  const split = useSplitWidth('contacts-tree', 320, 220, 480);

  // ── 数据：树 + 全量用户 ──
  const tree = useQuery({ queryKey: ['org', 'tree'], queryFn: fetchOrgTree });
  const usersQuery = useQuery({ queryKey: ['org', 'users', 'all'], queryFn: fetchAllUsers });
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const usersByUid = useMemo(() => new Map(users.map((u) => [u.uid, u])), [users]);

  /** deptId → 节点与父链（定位展开祖先用；path 物化路径 /1/7/23/ 直拆） */
  const deptIndex = useMemo(() => {
    const byId = new Map<string, DeptNode>();
    const childDepts = new Map<string, DeptNode[]>();
    const walk = (nodes: DeptNode[]) => {
      for (const n of nodes) {
        byId.set(n.id, n);
        childDepts.set(n.id, []); // 确保空部门也有键
        (n.children ?? []).forEach((c) => childDepts.get(n.id)?.push(c));
        walk(n.children ?? []);
      }
    };
    walk(tree.data ?? []);
    return { byId, childDepts };
  }, [tree.data]);

  /** deptId → 直接用户；未挂主部门（或指向已不存在部门——数据漂移防御）→ ungrouped */
  const grouped = useMemo(() => {
    const deptUsers = new Map<string, DirectoryUser[]>();
    const ungrouped: DirectoryUser[] = [];
    for (const u of users) {
      if (u.dept_id && deptIndex.byId.has(u.dept_id)) {
        const list = deptUsers.get(u.dept_id);
        if (list) list.push(u);
        else deptUsers.set(u.dept_id, [u]);
      } else {
        ungrouped.push(u);
      }
    }
    return { deptUsers, ungrouped };
  }, [users, deptIndex]);

  /** 部门子树用户总数（含后代；徽标展示） */
  const subtreeCount = useMemo(() => {
    const memo = new Map<string, number>();
    const calc = (id: string): number => {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      let n = (grouped.deptUsers.get(id)?.length ?? 0);
      for (const c of deptIndex.childDepts.get(id) ?? []) n += calc(c.id);
      memo.set(id, n);
      return n;
    };
    for (const id of deptIndex.byId.keys()) calc(id);
    return memo;
  }, [deptIndex, grouped]);

  // 树首载：默认全展开（部门量小；「看一看都有谁」是本页主诉求）
  useEffect(() => {
    if (tree.data) setExpanded(new Set([...deptIndex.byId.keys()].map(deptDomId).concat(deptDomId('ungrouped'))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.data]);

  // ── 搜索（下拉先行：联系人=服务端四路检索；组织=树内名称过滤） ──
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [ddOpen, setDdOpen] = useState(false);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);

  useEffect(() => {
    const kw = q;
    if (!kw) {
      setPeople([]);
      setPeopleLoading(false);
      setDdOpen(false);
      return;
    }
    setDdOpen(true);
    setPeopleLoading(true);
    const seq = ++seqRef.current;
    void fetchDirectoryUsers({ q: kw, limit: RESULT_MAX_ROWS })
      .then((res) => {
        if (seqRef.current !== seq) return;
        setPeople(res.items);
        setPeopleLoading(false);
      })
      .catch(() => {
        if (seqRef.current !== seq) return;
        setPeople([]);
        setPeopleLoading(false);
      });
  }, [q]);

  /** 组织段：树内名称过滤（≤5；扁平带链路名） */
  const deptHits = useMemo(() => {
    if (!q) return [];
    const out: Array<{ node: DeptNode; pathLabel: string }> = [];
    const walk = (nodes: DeptNode[], prefix: string) => {
      for (const n of nodes) {
        const label = prefix ? `${prefix}/${n.name}` : n.name;
        if (n.name.toLowerCase().includes(q.toLowerCase())) out.push({ node: n, pathLabel: label });
        walk(n.children ?? [], label);
      }
    };
    walk(tree.data ?? [], '');
    return out.slice(0, RESULT_MAX_ROWS);
  }, [q, tree.data]);

  // Esc 收起（Popover 不接管 Esc）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 定位：展开祖先 + 滚动入视 + 闪烁（用户口径：搜索点击=定位回树，不跳走） */
  const locate = (domId: string, deptIdsToExpand: string[]) => {
    setDdOpen(false);
    setSelectedId(domId);
    setFlashId(domId);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of deptIdsToExpand) next.add(deptDomId(id));
      return next;
    });
  };

  const locateDept = (id: string) => {
    const node = deptIndex.byId.get(id);
    // 物化路径 /1/7/23/ 直拆祖先链（去自身——部门自身可见只需父链展开）
    const ancestors = (node?.path ?? '').split('/').filter(Boolean).slice(0, -1);
    locate(deptDomId(id), ancestors);
  };

  const locateUser = (u: DirectoryUser) => {
    if (!u.dept_id) {
      // 未挂部门：叶子在「未分组」节点下
      locate(userDomId(u.uid), ['ungrouped']);
      return;
    }
    const dept = deptIndex.byId.get(u.dept_id);
    // 主部门自身 + 其祖先链都要展开，用户叶子才渲染
    const chain = (dept?.path ?? '').split('/').filter(Boolean);
    locate(userDomId(u.uid), chain);
  };

  // 闪烁节点滚动入视（展开重渲染后生效；闪烁=WAAPI 内联动画，无 CSS 类依赖）
  useEffect(() => {
    if (!flashId) return;
    // 闪烁高亮色随主题主色（黑白反色系下单色闪现，无 CSS 类依赖）
    const r = 0.18;
    const b = 0.55;
    const rgb = token.colorPrimary.slice(1).match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [0, 0, 0];
    const flash = (a: number) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-node-id="${flashId}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.animate(
        [
          { backgroundColor: flash(r), boxShadow: `inset 0 0 0 1px ${flash(b)}` },
          { backgroundColor: flash(r), boxShadow: `inset 0 0 0 1px ${flash(b)}`, offset: 0.6 },
          { backgroundColor: 'transparent', boxShadow: 'none' },
        ],
        { duration: FLASH_MS, easing: 'ease-out' },
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [flashId, expanded, tree.data, users, token.colorPrimary]);

  /** 发消息：单聊幂等创建直达（双击用户/详情卡按钮共用） */
  const startDm = async (u: DirectoryUser) => {
    if (dmBusy || u.uid === myUid) return;
    setDmBusy(true);
    try {
      const conv = await convCreate({ type: 1, memberIds: [u.uid] });
      await queryClient.invalidateQueries({ queryKey: qk.im.convs() });
      navigate(`/im/c/${conv.id}`);
    } catch (e) {
      Modal.error({ title: '发起会话失败', content: errText(e, '发起会话失败，请稍后重试') });
    } finally {
      setDmBusy(false);
    }
  };

  /** 树数据：root（全公司）→ 部门递归（用户叶子 + 子部门）→ 虚拟「未分组」 */
  const treeData: DataNode[] = useMemo(() => {
    const userLeaf = (u: DirectoryUser): DataNode => ({ key: userDomId(u.uid), title: u.display_name, isLeaf: true });
    const branch = (n: DeptNode): DataNode => ({
      key: deptDomId(n.id),
      title: n.name,
      isLeaf: false,
      children: [
        ...(grouped.deptUsers.get(n.id) ?? []).map(userLeaf),
        ...(n.children ?? []).map(branch),
      ],
    });
    const children: DataNode[] = (tree.data ?? []).map(branch);
    // 虚拟「未分组」：未挂部门用户（自助注册默认落此组），管理员挂部门后自动离开
    if (grouped.ungrouped.length > 0) {
      children.push({ key: deptDomId('ungrouped'), title: '未分组', isLeaf: false, children: grouped.ungrouped.map(userLeaf) });
    }
    return [{ key: deptDomId('root'), title: '全公司', isLeaf: false, children }];
  }, [tree.data, grouped]);

  /** 用户叶子行（Tree title 内：hover 详情卡 + 双击进聊；点击选中由 Tree onSelect 接管） */
  const renderUserRow = (u: DirectoryUser) => (
    <Popover
      trigger="hover"
      mouseEnterDelay={0.35}
      mouseLeaveDelay={0.15}
      placement="right"
      content={
        <Flex gap={12} data-testid="contacts-user-card" style={{ minWidth: 220 }}>
          <Avatar size={44} style={{ flex: 'none' }}>
            {(u.display_name || '?').slice(0, 1)}
          </Avatar>
          <Flex vertical gap={4} style={{ minWidth: 0 }}>
            <Space size={8}>
              <span style={{ fontWeight: 500 }}>{u.display_name}</span>
              <Typography.Text code>{u.employee_no}</Typography.Text>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {u.org_path || '未分组'}
            </Typography.Text>
            {u.uid === myUid ? (
              <Tag style={{ marginInlineEnd: 0 }}>我自己</Tag>
            ) : (
              <Button
                size="small"
                icon={<MessageCircle size={13} />}
                disabled={dmBusy}
                onClick={() => void startDm(u)}
                data-testid="contacts-card-msg"
              >
                发消息
              </Button>
            )}
          </Flex>
        </Flex>
      }
    >
      <span
        data-node-id={userDomId(u.uid)}
        data-testid="contacts-user-row"
        title="双击发消息"
        onDoubleClick={() => void startDm(u)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, width: '100%' }}
      >
        <Avatar size={22} style={{ flex: 'none', fontSize: 12 }}>
          {(u.display_name || '?').slice(0, 1)}
        </Avatar>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.display_name}</span>
        <Typography.Text code type="secondary" style={{ fontSize: 12, flex: 'none' }}>
          {u.employee_no}
        </Typography.Text>
      </span>
    </Popover>
  );

  /** titleRender：根=全公司（人数）/未分组（人数）/部门（子树人数 + 路径 tooltip）/用户叶子（hover 卡） */
  const titleRender = (node: DataNode) => {
    const key = String(node.key);
    const title = node.title as string;
    if (key === deptDomId('root')) {
      return (
        <Space size={6}>
          <Building2 size={14} />
          <span>{title}</span>
          <Tag style={{ marginInlineEnd: 0 }}>{users.length}</Tag>
        </Space>
      );
    }
    if (key === deptDomId('ungrouped')) {
      return (
        <Space size={6}>
          <Users size={14} />
          <span>{title}</span>
          <Tag style={{ marginInlineEnd: 0 }}>{grouped.ungrouped.length}</Tag>
        </Space>
      );
    }
    if (key.startsWith('user-')) {
      const u = usersByUid.get(key.slice('user-'.length));
      if (!u) return <span>{title}</span>;
      return renderUserRow(u);
    }
    const cnt = subtreeCount.get(key.slice('dept-'.length)) ?? 0;
    return (
      <Space size={6}>
        <FolderTree size={14} />
        <span title={deptIndex.byId.get(key.slice('dept-'.length))?.path}>{title}</span>
        {cnt > 0 ? <Tag style={{ marginInlineEnd: 0 }}>{cnt}</Tag> : null}
      </Space>
    );
  };

  // ── 搜索下拉行（Popover+Menu；分组段=Menu group，加载/空态=禁用占位行） ──
  const ddUserLabel = (u: DirectoryUser) => (
    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
      <Avatar size={22} style={{ flex: 'none', fontSize: 12 }}>
        {(u.display_name || '?').slice(0, 1)}
      </Avatar>
      <span style={{ flex: 'none' }}>{u.display_name}</span>
      <Typography.Text code type="secondary" style={{ fontSize: 12, flex: 'none' }}>
        {u.employee_no}
      </Typography.Text>
      <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12, textAlign: 'right' }}>
        {u.org_path || '未分组'}
      </Typography.Text>
    </Flex>
  );

  const ddDeptLabel = (name: string, pathLabel: string) => (
    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
      <FolderTree size={14} style={{ flex: 'none' }} />
      <span style={{ flex: 'none' }}>{name}</span>
      <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12, textAlign: 'right' }}>
        {pathLabel}
      </Typography.Text>
    </Flex>
  );

  const ddItems: MenuProps['items'] = (() => {
    if (peopleLoading && people.length === 0 && deptHits.length === 0) {
      return [{ key: 'dd-loading', disabled: true, label: '搜索中…' }];
    }
    if (people.length === 0 && deptHits.length === 0) {
      return [{ key: 'dd-empty', disabled: true, label: '未找到相关的人或部门' }];
    }
    return [
      ...(people.length > 0
        ? [
            {
              type: 'group' as const,
              label: '联系人',
              children: people.map((u) => ({ key: userDomId(u.uid), label: ddUserLabel(u) })),
            },
          ]
        : []),
      ...(deptHits.length > 0
        ? [
            {
              type: 'group' as const,
              label: '部门',
              children: deptHits.map(({ node, pathLabel }) => ({
                key: deptDomId(node.id),
                label: ddDeptLabel(node.name, pathLabel),
              })),
            },
          ]
        : []),
    ];
  })();

  const onDdSelect: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('user-')) {
      const u = people.find((p) => userDomId(p.uid) === key);
      if (u) locateUser(u);
    } else if (key.startsWith('dept-')) {
      locateDept(key.slice('dept-'.length));
    }
  };

  const loading = tree.isLoading || usersQuery.isLoading;
  const error = tree.isError || usersQuery.isError;

  /** 详情栏空态/缺失提示（居中次要文字） */
  const hint = (text: string) => (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <Typography.Text type="secondary">{text}</Typography.Text>
    </div>
  );

  /** 右侧详情·整页档案风：用户档案（头图+基础信息+组织链路）/ 部门档案（成员/子部门卡片网格） */
  const renderDetail = () => {
    // ── 用户档案页（发消息等操作落位区，后续操作继续加在头图 actions 行） ──
    if (selectedId?.startsWith('user-')) {
      const u = users.find((x) => x.uid === selectedId.slice('user-'.length));
      if (!u) return hint('用户不存在');
      const crumbs = u.org_path ? u.org_path.split('/').filter(Boolean) : [];
      return (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }} data-testid="contacts-detail-user">
          <Flex
            gap={20}
            align="center"
            wrap="wrap"
            style={{ padding: '28px 32px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
          >
            <Avatar size={72} style={{ flex: 'none', fontSize: 26 }}>
              {(u.display_name || '?').slice(0, 1)}
            </Avatar>
            <Flex vertical gap={8} style={{ minWidth: 0 }}>
              <Flex align="center" gap={10} wrap="wrap">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {u.display_name}
                </Typography.Title>
                {u.uid === myUid ? <Tag style={{ marginInlineEnd: 0 }}>我自己</Tag> : null}
              </Flex>
              <Space size={6} wrap>
                <Typography.Text code>{u.employee_no}</Typography.Text>
                <Typography.Text type="secondary">·</Typography.Text>
                <Typography.Text type="secondary">{u.org_path || '未分组'}</Typography.Text>
                <Typography.Text type="secondary">·</Typography.Text>
                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                  在职
                </Tag>
              </Space>
              <Space size={12} wrap align="center" style={{ marginTop: 4 }}>
                {u.uid === myUid ? (
                  <Typography.Text type="secondary">这是你自己的账号</Typography.Text>
                ) : (
                  <Button
                    icon={<MessageCircle size={14} />}
                    disabled={dmBusy}
                    onClick={() => void startDm(u)}
                    data-testid="contacts-detail-msg"
                  >
                    发消息
                  </Button>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  双击左侧树中用户可直接发起聊天
                </Typography.Text>
              </Space>
            </Flex>
          </Flex>
          <Flex vertical gap={16} style={{ padding: '20px 32px 32px', flex: 1 }}>
            <Card size="small" title="基础信息">
              <Descriptions
                size="small"
                column={1}
                items={[
                  { key: 'name', label: '姓名', children: u.display_name },
                  { key: 'empno', label: '工号', children: <Typography.Text code>{u.employee_no}</Typography.Text> },
                  { key: 'org', label: '所属组织', children: u.org_path || '未分组' },
                  {
                    key: 'status',
                    label: '账号状态',
                    children: (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>
                        启用
                      </Tag>
                    ),
                  },
                ]}
              />
            </Card>
            <Card size="small" title="组织链路">
              {crumbs.length > 0 ? (
                <Breadcrumb items={crumbs.map((c) => ({ title: c }))} />
              ) : (
                <Typography.Text type="secondary">未挂部门——归入「未分组」，可由管理员调整归属</Typography.Text>
              )}
            </Card>
          </Flex>
        </div>
      );
    }

    // ── 部门/根/未分组档案页 ──
    let name = '';
    let pathLabel = '';
    let members: DirectoryUser[] = [];
    let subDepts: DeptNode[] = [];
    let count = 0;
    let memberSection = '直接成员';
    if (selectedId === deptDomId('root')) {
      name = '全公司';
      members = grouped.ungrouped;
      subDepts = tree.data ?? [];
      count = users.length;
      memberSection = '未分组成员';
    } else if (selectedId === deptDomId('ungrouped')) {
      name = '未分组';
      members = grouped.ungrouped;
      count = grouped.ungrouped.length;
    } else if (selectedId) {
      const id = selectedId.slice('dept-'.length);
      const node = deptIndex.byId.get(id);
      if (!node) return hint('部门不存在');
      name = node.name;
      pathLabel = node.path;
      members = grouped.deptUsers.get(id) ?? [];
      subDepts = deptIndex.childDepts.get(id) ?? [];
      count = subtreeCount.get(id) ?? 0;
    } else {
      return hint('从左侧选择用户或部门查看详情');
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }} data-testid="contacts-detail-dept">
        <Flex
          gap={20}
          align="center"
          wrap="wrap"
          style={{ padding: '28px 32px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
        >
          <Avatar size={72} icon={<FolderTree size={30} />} style={{ flex: 'none' }} />
          <Flex vertical gap={8} style={{ minWidth: 0 }}>
            <Flex align="center" gap={10} wrap="wrap">
              <Typography.Title level={4} style={{ margin: 0 }}>
                {name}
              </Typography.Title>
              <Tag style={{ marginInlineEnd: 0 }}>{count} 人</Tag>
            </Flex>
            {pathLabel ? <Typography.Text type="secondary">{pathLabel}</Typography.Text> : null}
          </Flex>
        </Flex>
        <Flex vertical gap={16} style={{ padding: '20px 32px 32px', flex: 1 }}>
          {members.length > 0 ? (
            <Card size="small" title={`${memberSection}（${members.length}）`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                {members.map((u) => (
                  <Card
                    key={u.uid}
                    size="small"
                    hoverable
                    onClick={() => setSelectedId(userDomId(u.uid))}
                    onDoubleClick={() => void startDm(u)}
                  >
                    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                      <Avatar size={32} style={{ flex: 'none' }}>
                        {(u.display_name || '?').slice(0, 1)}
                      </Avatar>
                      <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.display_name}
                        </span>
                        <Typography.Text code type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {u.employee_no}
                        </Typography.Text>
                      </Flex>
                    </Flex>
                  </Card>
                ))}
              </div>
            </Card>
          ) : null}
          {subDepts.length > 0 ? (
            <Card size="small" title={`子部门（${subDepts.length}）`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                {subDepts.map((d) => (
                  <Card key={d.id} size="small" hoverable onClick={() => setSelectedId(deptDomId(d.id))}>
                    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                      <Avatar size={32} icon={<FolderTree size={16} />} style={{ flex: 'none' }} />
                      <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {subtreeCount.get(d.id) ?? 0} 人
                        </Typography.Text>
                      </Flex>
                    </Flex>
                  </Card>
                ))}
              </div>
            </Card>
          ) : null}
          {members.length === 0 && subDepts.length === 0 ? hint('暂无成员') : null}
        </Flex>
      </div>
    );
  };

  return (
    <div
      data-testid="contacts-page"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        flex: 1,
        minWidth: 0,
        background: token.colorBgLayout,
      }}
    >
      {/* 头：标题 + 搜索（输入防抖；下拉=Popover+Menu，点击外部由 Popover 接管收起） */}
      <Flex
        align="center"
        gap={16}
        style={{ padding: '12px 20px', borderBottom: `1px solid ${token.colorBorderSecondary}`, flex: 'none' }}
      >
        <Typography.Title level={5} style={{ margin: 0, flex: 'none' }}>
          通讯录
        </Typography.Title>
        <span style={{ position: 'relative', width: 280 }}>
          <Popover
            open={ddOpen && !!q}
            trigger="click"
            placement="bottomLeft"
            arrow={false}
            destroyTooltipOnHide
            onOpenChange={(o) => {
              if (!o) setDdOpen(false);
            }}
            styles={{ body: { padding: 4 } }}
            content={
              <div data-testid="contacts-search-dd" style={{ minWidth: 280, maxWidth: 380 }}>
                <Menu selectable={false} mode="vertical" style={{ border: 'none' }} items={ddItems} onClick={onDdSelect} />
              </div>
            }
          >
            <Input
              allowClear
              placeholder="搜索 联系人/部门"
              prefix={<Search size={14} />}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onFocus={() => q && setDdOpen(true)}
            />
          </Popover>
        </span>
      </Flex>

      <Flex align="stretch" style={{ flex: 1, minHeight: 0 }}>
        {/* 左：组织+用户树（antd Tree；controlled 展开/选中） */}
        <div
          style={{
            width: split.width,
            flex: 'none',
            minHeight: 0,
            overflow: 'auto',
            padding: '8px 6px 24px',
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
          }}
        >
          {loading ? (
            hint('加载中…')
          ) : error ? (
            hint(`通讯录加载失败（${errText(tree.error ?? usersQuery.error)}）`)
          ) : (
            <Tree
              blockNode
              treeData={treeData}
              titleRender={titleRender}
              expandedKeys={[...expanded]}
              selectedKeys={selectedId ? [selectedId] : []}
              onExpand={(keys) => setExpanded(new Set(keys.map(String)))}
              onSelect={(_, info) => setSelectedId(String(info.node.key))}
            />
          )}
        </div>
        <SplitHandle bind={split.bind} />

        {/* 右侧详情栏：用户卡（发消息等操作落位区）/ 部门概览（成员+子部门可点切换） */}
        <aside
          data-testid="contacts-detail"
          style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}
        >
          {renderDetail()}
        </aside>
      </Flex>
    </div>
  );
}
