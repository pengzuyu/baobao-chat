/**
 * PAD-05 用户管理（D10 阶段一务实版，路由 /admin/users）：
 * - 搜索（工号/姓名/邮箱）+ 状态过滤（全部/启用/禁用）+ cursor 无限翻页（加载更多）
 * - 行操作：禁用（危险红钮，服务端语义=踢下线+吊销+审计）/ 启用（恢复）
 * - 六态：loading 表骨架 / empty（无匹配用户，清筛选 CTA）/ error 重试 /
 *   offline 只读遮罩 / forbidden（2003 整页锁）/ degraded（写操作失败黄条提示）
 */

import { useState } from 'react';
import { Search, ShieldBan, ShieldCheck, X } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useUserStatus, useUsers } from '../api/hooks';
import type { AdminUser } from '../model/types';

const STATUS_FILTERS = [
  { value: 0, label: '全部' },
  { value: 1, label: '启用' },
  { value: 2, label: '禁用' },
] as const;

export function UsersPage() {
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<number>(0);
  const [actionError, setActionError] = useState('');
  const [actionOk, setActionOk] = useState('');

  const connStatus = useConnectionStore((s) => s.status);
  const query = useUsers(keyword, status);
  const statusMutation = useUserStatus();

  const items: AdminUser[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];

  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  const toggle = (u: AdminUser) => {
    setActionError('');
    setActionOk('');
    statusMutation.mutate(
      { userId: u.id, action: u.status === 1 ? 'disable' : 'enable' },
      {
        onSuccess: (_d, vars) => {
          setActionOk(vars.action === 'disable' ? `已禁用 ${u.display_name}：全端下线并吊销刷新令牌（已记审计）` : `已启用 ${u.display_name}（已记审计）`);
        },
        onError: (err) => setActionError(err instanceof ApiError ? getErrorText(err.code) : '操作失败，请稍后再试'),
      },
    );
  };

  const resetFilters = () => {
    setKeywordInput('');
    setKeyword('');
    setStatus(0);
  };

  return (
    <div className="admin-users">
      <header className="admin-page__header">
        <h2 className="admin-page__title">用户管理</h2>
        <span className="admin-page__meta">禁用即全端下线（WS 断开 + 刷新令牌吊销 + 记审计）</span>
      </header>

      <div className="admin-toolbar">
        <div className="bbw-input bbw-input--search admin-toolbar__search">
          <Search size={14} aria-hidden />
          <input
            value={keywordInput}
            placeholder="搜索工号 / 姓名 / 邮箱，回车检索"
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setKeyword(keywordInput.trim());
              }
            }}
          />
        </div>
        <div className="admin-toolbar__filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`admin-chip${status === f.value ? ' admin-chip--active' : ''}`}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </button>
          ))}
          {keyword || status !== 0 ? (
            <button type="button" className="admin-chip admin-chip--clear" onClick={resetFilters} title="清除筛选">
              <X size={12} /> 清除
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <div className="admin-error-bar" data-testid="admin-users-error">
          {actionError}
        </div>
      ) : null}
      {actionOk ? (
        <div className="admin-ok-bar" data-testid="admin-users-ok">
          {actionOk}
        </div>
      ) : null}

      <StateView
        state={state}
        skeleton={<SkeletonList count={8} />}
        emptyText="无匹配用户"
        emptyAction={
          keyword || status !== 0 ? (
            <Button variant="secondary" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null
        }
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:user:manage 权限"
      >
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
                <td data-testid={`admin-action-${u.employee_no}`}>
                  {u.status === 1 ? (
                    <Button
                      variant="danger"
                      loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
                      onClick={() => toggle(u)}
                    >
                      <ShieldBan size={13} /> 禁用
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      loading={statusMutation.isPending && statusMutation.variables?.userId === u.id}
                      onClick={() => toggle(u)}
                    >
                      <ShieldCheck size={13} /> 启用
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
      </StateView>
    </div>
  );
}

/** 权限列：优先展示 admin:*，否则取前两项普通权限点 */
function scopesText(scopes: string[]): string {
  if (scopes.length === 0) return '—';
  const adminScopes = scopes.filter((s) => s === 'admin' || s.startsWith('admin:'));
  if (adminScopes.length > 0) return adminScopes.join(', ');
  return scopes.slice(0, 2).join(', ');
}
