/**
 * 通讯录页（M2，2026-11-12 用户裁决：通讯录结构全员可见——找人/看谁在用）：
 * - 左：组织树只读（全公司 + 部门树 + 虚拟「未分组」——未挂部门用户默认落此组，
 *   自助注册账号即此形态；建部门/挂人等管理动作仍在 /admin/org）
 * - 右：成员列表（搜索命中 工号/姓名/拼音；点「发消息」→ conv.create type=1
 *   单聊幂等直达会话——服务端同对成员已有单聊直接复用）
 * 数据源：GET /org/tree + GET /org/users（登录后含 uid 口径）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Input } from 'antd';
import { Search } from 'lucide-react';
import { Building2, ChevronDown, ChevronRight, FolderTree, MessageCircle, Users } from 'lucide-react';
import { fetchDirectoryUsers, fetchOrgTree } from '../api/contacts';
import type { DirectoryUser } from '../api/contacts';
import type { DeptNode } from '../../admin/api/admin';
import { convCreate } from '../../im/api/im';
import { qk } from '../../../shared/api/keys';
import { errText } from '../../../shared/api/http';
import { useAuthStore } from '../../auth/store/auth';

/** 左树选中态：全公司 / 具体部门 / 虚拟「未分组」 */
type Sel = { kind: 'all' } | { kind: 'dept'; id: string; name: string } | { kind: 'ungrouped' };

/** 部门树节点行（只读复用 org-node 样式族——管理端同款视觉，无编辑/新增按钮） */
function TreeRow({ node, depth, sel, onSelect }: { node: DeptNode; depth: number; sel: Sel; onSelect: (s: Sel) => void }) {
  const [open, setOpen] = useState(true);
  const hasChildren = !!node.children?.length;
  const active = sel.kind === 'dept' && sel.id === node.id;
  return (
    <div className="org-node" style={{ marginLeft: depth * 16 }}>
      <div className={`org-node__row${active ? ' org-node__row--selected' : ''}`}>
        <button type="button" className="icon-btn" onClick={() => setOpen(!open)} disabled={!hasChildren}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <FolderTree size={14} className="org-node__icon" />
        <span className="org-node__name" title={node.path} onClick={() => onSelect({ kind: 'dept', id: node.id, name: node.name })}>
          {node.name}
        </span>
      </div>
      {open && hasChildren ? (
        <div>
          {node.children!.map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} sel={sel} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ContactsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const myUid = useAuthStore((s) => s.user?.uid);
  const [sel, setSel] = useState<Sel>({ kind: 'all' });
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [dmBusy, setDmBusy] = useState<string | null>(null);

  // 搜索防抖 300ms（与登录页选人同节奏；q 变化重置翻页）
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [qInput]);

  const tree = useQuery({ queryKey: ['org', 'tree'], queryFn: fetchOrgTree });

  const selKey = sel.kind === 'dept' ? `dept:${sel.id}` : sel.kind;
  const users = useInfiniteQuery({
    queryKey: ['org', 'users', selKey, q],
    queryFn: ({ pageParam }) =>
      fetchDirectoryUsers({
        q: q || undefined,
        deptId: sel.kind === 'dept' ? sel.id : undefined,
        ungrouped: sel.kind === 'ungrouped' || undefined,
        cursor: pageParam === '' ? undefined : pageParam,
        limit: 50,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
  });

  const rows = useMemo(() => users.data?.pages.flatMap((p) => p.items) ?? [], [users.data]);
  const totalLoaded = rows.length;

  const title = sel.kind === 'all' ? '全公司' : sel.kind === 'ungrouped' ? '未分组' : sel.name;

  /** 发消息：单聊幂等创建直达（创建者本人=收件人过滤在渲染层） */
  const startDm = async (u: DirectoryUser) => {
    if (dmBusy) return;
    setDmBusy(u.uid);
    try {
      const conv = await convCreate({ type: 1, memberIds: [u.uid] });
      await queryClient.invalidateQueries({ queryKey: qk.im.convs() });
      navigate(`/im/c/${conv.id}`);
    } catch (e) {
      window.alert(errText(e, '发起会话失败，请稍后重试'));
    } finally {
      setDmBusy(null);
    }
  };

  return (
    <div className="bbw-contacts" data-testid="contacts-page">
      <aside className="bbw-contacts__tree">
        <div className="bbw-contacts__tree-head">组织结构</div>
        <div className={`org-node__row org-node__row--root${sel.kind === 'all' ? ' org-node__row--selected' : ''}`} onClick={() => setSel({ kind: 'all' })}>
          <Building2 size={14} className="org-node__icon" />
          <span className="org-node__name">全公司</span>
        </div>
        {tree.isLoading ? (
          <div className="bbw-contacts__hint">加载中…</div>
        ) : tree.isError ? (
          <div className="bbw-contacts__hint">组织结构加载失败（{errText(tree.error)}）</div>
        ) : !tree.data?.length ? (
          <div className="bbw-contacts__hint">暂无部门</div>
        ) : (
          tree.data.map((n) => <TreeRow key={n.id} node={n} depth={1} sel={sel} onSelect={setSel} />)
        )}
        {/* 虚拟「未分组」：未挂部门用户（自助注册默认落此组），管理员挂部门后自动离开 */}
        <div
          className={`org-node__row org-node__row--root${sel.kind === 'ungrouped' ? ' org-node__row--selected' : ''}`}
          onClick={() => setSel({ kind: 'ungrouped' })}
          style={{ marginTop: 8 }}
        >
          <Users size={14} className="org-node__icon" />
          <span className="org-node__name">未分组</span>
        </div>
      </aside>

      <div className="bbw-contacts__main">
        <div className="bbw-contacts__main-head">
          <span className="bbw-contacts__title">{title}</span>
          <Input
            allowClear
            size="middle"
            placeholder="搜索 工号/姓名/拼音"
            prefix={<Search size={14} />}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            style={{ width: 240 }}
          />
        </div>
        <div className="bbw-contacts__list">
          {users.isLoading ? (
            <div className="bbw-contacts__hint">加载中…</div>
          ) : users.isError ? (
            <div className="bbw-contacts__hint">成员加载失败（{errText(users.error)}）</div>
          ) : rows.length === 0 ? (
            <div className="bbw-contacts__hint">{q ? '无匹配成员' : '暂无成员'}</div>
          ) : (
            rows.map((u) => (
              <div key={u.uid} className="bbw-contacts__row" data-testid="contacts-row">
                <span className="bbw-contacts__avatar">{(u.display_name || '?').slice(0, 1)}</span>
                <div className="bbw-contacts__info">
                  <div className="bbw-contacts__name-line">
                    <span className="bbw-contacts__name">{u.display_name}</span>
                    <span className="bbw-contacts__empno">{u.employee_no}</span>
                  </div>
                  <div className="bbw-contacts__path">{u.org_path || '未分组'}</div>
                </div>
                {u.uid === myUid ? (
                  <span className="bbw-contacts__self">我</span>
                ) : (
                  <button
                    type="button"
                    className="bbw-contacts__msg-btn"
                    disabled={dmBusy === u.uid}
                    onClick={() => startDm(u)}
                  >
                    <MessageCircle size={13} />
                    发消息
                  </button>
                )}
              </div>
            ))
          )}
          {/* 翻页：cursor 触底加载（server limit 50） */}
          {users.hasNextPage ? (
            <button type="button" className="bbw-contacts__more" onClick={() => users.fetchNextPage()} disabled={users.isFetchingNextPage}>
              {users.isFetchingNextPage ? '加载中…' : `加载更多（已 ${totalLoaded} 人）`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
