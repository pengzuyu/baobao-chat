/**
 * 通讯录页（M2 落地后按用户口径二改，2026-11-12）：
 * - 单棵树：全公司 → 部门树 → 用户叶子（按主部门挂靠；未挂部门用户归虚拟「未分组」）
 * - 搜索与聊天页同款：输入先出下拉结果（联系人段=服务端四路检索；组织段=树内名称过滤），
 *   点击结果定位回树——展开祖先 + 滚动入视 + 闪烁高亮（不直接跳走）
 * - 交互：双击用户 → 发起单聊直达（conv.create type=1 幂等）；hover 用户 → 详情卡
 *   （姓名/工号/组织链路 + 发消息）；管理动作仍在 /admin/org
 * 数据源：GET /org/tree + GET /org/users（全量翻页拉齐后端内组树）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Input, Popover } from 'antd';
import { Building2, ChevronDown, ChevronRight, FolderTree, MessageCircle, Search, Users } from 'lucide-react';
import { fetchDirectoryUsers, fetchOrgTree } from '../api/contacts';
import type { DirectoryUser } from '../api/contacts';
import type { DeptNode } from '../../admin/api/admin';
import { convCreate } from '../../im/api/im';
import { qk } from '../../../shared/api/keys';
import { errText } from '../../../shared/api/http';
import { useAuthStore } from '../../auth/store/auth';

/** 搜索防抖（与聊天页/选人器同节奏） */
const SEARCH_DEBOUNCE_MS = 300;
/** 下拉各段最多行数 */
const RESULT_MAX_ROWS = 5;
/** 定位闪烁时长（ms） */
const FLASH_MS = 1200;
/** DOM 节点键（定位/选中/闪烁共用） */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dmBusy, setDmBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── 数据：树 + 全量用户 ──
  const tree = useQuery({ queryKey: ['org', 'tree'], queryFn: fetchOrgTree });
  const usersQuery = useQuery({ queryKey: ['org', 'users', 'all'], queryFn: fetchAllUsers });
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);

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
    if (tree.data) setExpanded(new Set([...deptIndex.byId.keys(), 'ungrouped']));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.data]);

  // ── 搜索（下拉先行：联系人=服务端四路检索；组织=树内名称过滤） ──
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [ddOpen, setDdOpen] = useState(false);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const seqRef = useRef(0);
  const headRef = useRef<HTMLDivElement>(null);

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

  // 点击外部收起下拉
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (headRef.current && !headRef.current.contains(e.target as Node)) setDdOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Esc 收起
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
      for (const id of deptIdsToExpand) next.add(id);
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

  // 闪烁节点滚动入视（展开重渲染后生效）
  useEffect(() => {
    if (!flashId) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-node-id="${flashId}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.classList.add('bbw-contacts__flash');
      setTimeout(() => el?.classList.remove('bbw-contacts__flash'), FLASH_MS);
    });
    return () => cancelAnimationFrame(raf);
  }, [flashId, expanded, tree.data, users]);

  /** 发消息：单聊幂等创建直达（双击用户/详情卡按钮共用） */
  const startDm = async (u: DirectoryUser) => {
    if (dmBusy || u.uid === myUid) return;
    setDmBusy(true);
    try {
      const conv = await convCreate({ type: 1, memberIds: [u.uid] });
      await queryClient.invalidateQueries({ queryKey: qk.im.convs() });
      navigate(`/im/c/${conv.id}`);
    } catch (e) {
      window.alert(errText(e, '发起会话失败，请稍后重试'));
    } finally {
      setDmBusy(false);
    }
  };

  /** 用户叶子行（hover 详情卡 + 双击进聊 + 点击选中） */
  const renderUserRow = (u: DirectoryUser, depth: number) => (
    <Popover
      key={u.uid}
      trigger="hover"
      mouseEnterDelay={0.35}
      mouseLeaveDelay={0.15}
      placement="right"
      content={
        <div className="bbw-contacts__card" data-testid="contacts-user-card">
          <span className="bbw-contacts__avatar bbw-contacts__avatar--lg">{(u.display_name || '?').slice(0, 1)}</span>
          <div className="bbw-contacts__card-main">
            <div className="bbw-contacts__card-name">
              {u.display_name}
              <span className="bbw-contacts__card-empno">{u.employee_no}</span>
            </div>
            <div className="bbw-contacts__card-path">{u.org_path || '未分组'}</div>
            {u.uid === myUid ? (
              <span className="bbw-contacts__card-self">我自己</span>
            ) : (
              <button
                type="button"
                className="bbw-contacts__msg-btn"
                disabled={dmBusy}
                onClick={() => void startDm(u)}
                data-testid="contacts-card-msg"
              >
                <MessageCircle size={13} />
                发消息
              </button>
            )}
          </div>
        </div>
      }
    >
      <div
        className={`bbw-contacts__user-row${selectedId === userDomId(u.uid) ? ' bbw-contacts__user-row--selected' : ''}`}
        style={{ marginLeft: depth * 16 + 26 }}
        data-node-id={userDomId(u.uid)}
        data-testid="contacts-user-row"
        onClick={() => setSelectedId(userDomId(u.uid))}
        onDoubleClick={() => void startDm(u)}
        title="双击发消息"
      >
        <span className="bbw-contacts__avatar bbw-contacts__avatar--sm">{(u.display_name || '?').slice(0, 1)}</span>
        <span className="bbw-contacts__user-name">{u.display_name}</span>
        <span className="bbw-contacts__user-empno">{u.employee_no}</span>
      </div>
    </Popover>
  );

  const renderUsers = (list: DirectoryUser[], depth: number) => list.map((u) => renderUserRow(u, depth));

  const loading = tree.isLoading || usersQuery.isLoading;
  const error = tree.isError || usersQuery.isError;

  /** 右侧详情：用户卡（发消息等操作落位区）/ 部门概览（直接成员+子部门，点击切换选中） */
  const renderDetail = () => {
    // 用户详情：头像/姓名/工号/组织链路 + 发消息（后续操作继续加在这）
    if (selectedId?.startsWith('user-')) {
      const u = users.find((x) => x.uid === selectedId.slice('user-'.length));
      if (!u) return <div className="bbw-contacts__hint">用户不存在</div>;
      return (
        <div className="bbw-contacts__detail-user" data-testid="contacts-detail-user">
          <span className="bbw-contacts__avatar bbw-contacts__avatar--xl">{(u.display_name || '?').slice(0, 1)}</span>
          <div className="bbw-contacts__detail-main">
            <div className="bbw-contacts__card-name">
              {u.display_name}
              <span className="bbw-contacts__card-empno">{u.employee_no}</span>
              {u.uid === myUid ? <span className="bbw-contacts__badge">我自己</span> : null}
            </div>
            <div className="bbw-contacts__card-path">{u.org_path || '未分组'}</div>
            {u.uid === myUid ? (
              <span className="bbw-contacts__card-self">这是你自己的账号</span>
            ) : (
              <button
                type="button"
                className="bbw-contacts__msg-btn bbw-contacts__msg-btn--lg"
                disabled={dmBusy}
                onClick={() => void startDm(u)}
                data-testid="contacts-detail-msg"
              >
                <MessageCircle size={14} />
                发消息
              </button>
            )}
            <div className="bbw-contacts__detail-hint">双击左侧树中用户也可直接发起聊天</div>
          </div>
        </div>
      );
    }

    // 部门/根/未分组概览
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
      if (!node) return <div className="bbw-contacts__hint">部门不存在</div>;
      name = node.name;
      pathLabel = node.path;
      members = grouped.deptUsers.get(id) ?? [];
      subDepts = deptIndex.childDepts.get(id) ?? [];
      count = subtreeCount.get(id) ?? 0;
    } else {
      return <div className="bbw-contacts__hint">从左侧选择用户或部门查看详情</div>;
    }
    return (
      <div className="bbw-contacts__detail-dept">
        <div className="bbw-contacts__detail-dept-head">
          <FolderTree size={18} className="org-node__icon" />
          <span className="bbw-contacts__detail-dept-name">{name}</span>
          <span className="bbw-contacts__badge">{count} 人</span>
        </div>
        {pathLabel ? <div className="bbw-contacts__card-path">{pathLabel}</div> : null}
        {members.length > 0 ? (
          <>
            <div className="bbw-contacts__dd-section">{memberSection}（{members.length}）</div>
            {members.map((u) => (
              <button
                key={u.uid}
                type="button"
                className="bbw-contacts__dd-row"
                onClick={() => setSelectedId(userDomId(u.uid))}
                onDoubleClick={() => void startDm(u)}
              >
                <span className="bbw-contacts__avatar bbw-contacts__avatar--sm">{(u.display_name || '?').slice(0, 1)}</span>
                <span className="bbw-contacts__user-name">{u.display_name}</span>
                <span className="bbw-contacts__user-empno">{u.employee_no}</span>
              </button>
            ))}
          </>
        ) : null}
        {subDepts.length > 0 ? (
          <>
            <div className="bbw-contacts__dd-section">子部门（{subDepts.length}）</div>
            {subDepts.map((d) => (
              <button
                key={d.id}
                type="button"
                className="bbw-contacts__dd-row"
                onClick={() => setSelectedId(deptDomId(d.id))}
              >
                <FolderTree size={15} className="org-node__icon" />
                <span className="bbw-contacts__user-name">{d.name}</span>
                <span className="bbw-contacts__dd-path">{subtreeCount.get(d.id) ?? 0} 人</span>
              </button>
            ))}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="bbw-contacts" data-testid="contacts-page">
      <div className="bbw-contacts__head" ref={headRef}>
        <span className="bbw-contacts__title">通讯录</span>
        <div className="bbw-contacts__search">
          <Input
            allowClear
            placeholder="搜索 联系人/部门"
            prefix={<Search size={14} />}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onFocus={() => q && setDdOpen(true)}
          />
          {ddOpen && q ? (
            <div className="bbw-contacts__search-dd" data-testid="contacts-search-dd">
              {peopleLoading && people.length === 0 && deptHits.length === 0 ? (
                <div className="bbw-contacts__hint">搜索中…</div>
              ) : people.length === 0 && deptHits.length === 0 ? (
                <div className="bbw-contacts__hint">未找到相关的人或部门</div>
              ) : (
                <>
                  {people.length > 0 ? (
                    <>
                      <div className="bbw-contacts__dd-section">联系人</div>
                      {people.map((u) => (
                        <button key={u.uid} type="button" className="bbw-contacts__dd-row" onClick={() => locateUser(u)}>
                          <span className="bbw-contacts__avatar bbw-contacts__avatar--sm">{(u.display_name || '?').slice(0, 1)}</span>
                          <span className="bbw-contacts__user-name">{u.display_name}</span>
                          <span className="bbw-contacts__user-empno">{u.employee_no}</span>
                          <span className="bbw-contacts__dd-path">{u.org_path || '未分组'}</span>
                        </button>
                      ))}
                    </>
                  ) : null}
                  {deptHits.length > 0 ? (
                    <>
                      <div className="bbw-contacts__dd-section">部门</div>
                      {deptHits.map(({ node, pathLabel }) => (
                        <button key={node.id} type="button" className="bbw-contacts__dd-row" onClick={() => locateDept(node.id)}>
                          <FolderTree size={16} className="org-node__icon" />
                          <span className="bbw-contacts__user-name">{node.name}</span>
                          <span className="bbw-contacts__dd-path">{pathLabel}</span>
                        </button>
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="bbw-contacts__body">
      <div className="bbw-contacts__tree">
        {loading ? (
          <div className="bbw-contacts__hint">加载中…</div>
        ) : error ? (
          <div className="bbw-contacts__hint">通讯录加载失败（{errText(tree.error ?? usersQuery.error)}）</div>
        ) : (
          <>
            <div
              className={`org-node__row org-node__row--root${selectedId === deptDomId('root') ? ' org-node__row--selected' : ''}`}
              data-node-id={deptDomId('root')}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelectedId(deptDomId('root'))}
            >
              <Building2 size={14} className="org-node__icon" />
              <span className="org-node__name">全公司</span>
              <span className="bbw-contacts__badge">{users.length}</span>
            </div>
            {(tree.data ?? []).map((n) => renderDept(n, 1))}
            {/* 虚拟「未分组」：未挂部门用户（自助注册默认落此组），管理员挂部门后自动离开 */}
            {grouped.ungrouped.length > 0 ? (
              <div>
                <div
                  className={`org-node__row org-node__row--root${selectedId === deptDomId('ungrouped') ? ' org-node__row--selected' : ''}`}
                  style={{ cursor: 'pointer' }}
                  data-node-id={deptDomId('ungrouped')}
                  onClick={() => setExpanded((prev) => toggleIn(prev, 'ungrouped'))}
                >
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => toggleIn(prev, 'ungrouped'));
                    }}
                  >
                    {expanded.has('ungrouped') ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <Users size={14} className="org-node__icon" />
                  <span className="org-node__name">未分组</span>
                  <span className="bbw-contacts__badge">{grouped.ungrouped.length}</span>
                </div>
                {expanded.has('ungrouped') ? renderUsers(grouped.ungrouped, 1) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

        {/* 右侧详情栏：用户卡（发消息等操作落位区）/ 部门概览（成员+子部门可点切换） */}
        <aside className="bbw-contacts__detail" data-testid="contacts-detail">
          {renderDetail()}
        </aside>
      </div>
    </div>
  );

  /** 部门节点渲染（闭包拿 grouped/deptIndex/subtreeCount，替代上面的占位组件） */
  function renderDept(node: DeptNode, depth: number) {
    const open = expanded.has(node.id);
    const childUsers = grouped.deptUsers.get(node.id) ?? [];
    return (
      <div key={node.id}>
        <div
          className={`org-node__row${selectedId === deptDomId(node.id) ? ' org-node__row--selected' : ''}`}
          style={{ marginLeft: depth * 16, cursor: 'pointer' }}
          data-node-id={deptDomId(node.id)}
          onClick={() => setExpanded((prev) => toggleIn(prev, node.id))}
        >
          <button
            type="button"
            className="icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => toggleIn(prev, node.id));
            }}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          <FolderTree size={14} className="org-node__icon" />
          <span className="org-node__name" title={node.path}>
            {node.name}
          </span>
          {(subtreeCount.get(node.id) ?? 0) > 0 ? <span className="bbw-contacts__badge">{subtreeCount.get(node.id)}</span> : null}
        </div>
        {open ? (
          <div>
            {renderUsers(childUsers, depth + 1)}
            {(node.children ?? []).map((c) => renderDept(c, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }
}

/** 展开集不可变切换 */
function toggleIn(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
