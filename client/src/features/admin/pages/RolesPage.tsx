/**
 * 角色编辑器（D10 PAD-08 阶段二）：角色列表（内置徽标/授权人数/权限点数）+
 * 新建/编辑抽屉（名称/描述/权限点分组勾选）+ 删除（内置拒）+ 用户授权管理
 * （输入 uid → 角色下拉授权/收回）。scope 部门范围授权随 D12 组织树阶段二。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import {
  PERMISSION_GROUPS,
  createRole,
  deleteRole,
  fetchRoles,
  fetchUserGrants,
  grantRole,
  revokeRole,
  updateRole,
  type AdminGrant,
  type AdminRole,
} from '../api/admin';

interface EditorState {
  mode: 'create' | 'edit';
  role?: AdminRole;
  name: string;
  description: string;
  permissions: Set<string>;
}

export function RolesPage() {
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  // 授权管理（按 uid 查询）
  const [grantUid, setGrantUid] = useState('');
  const [grants, setGrants] = useState<AdminGrant[] | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setRoles(await fetchRoles());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () =>
    setEditor({ mode: 'create', name: '', description: '', permissions: new Set() });
  const openEdit = (r: AdminRole) =>
    setEditor({ mode: 'edit', role: r, name: r.name, description: r.description ?? '', permissions: new Set(r.permissions) });

  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    const payload = { name: editor.name.trim(), description: editor.description.trim(), permissions: [...editor.permissions] };
    try {
      if (editor.mode === 'create') {
        await createRole(payload);
      } else if (editor.role) {
        await updateRole(editor.role.id, payload);
      }
      setEditor(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: AdminRole) => {
    if (!window.confirm(`确认删除角色「${r.name}」？已授权用户将一并收回`)) return;
    setError(null);
    try {
      await deleteRole(r.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '删除失败');
    }
  };

  const loadGrants = async () => {
    const uid = grantUid.trim();
    if (!uid) return;
    setError(null);
    try {
      setGrants(await fetchUserGrants(uid));
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '查询失败');
    }
  };

  const doGrant = async (roleId: string) => {
    setError(null);
    try {
      await grantRole(grantUid.trim(), roleId);
      setGrants(await fetchUserGrants(grantUid.trim()));
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '授权失败');
    }
  };

  const doRevoke = async (grantId: string) => {
    setError(null);
    try {
      await revokeRole(grantId);
      setGrants(await fetchUserGrants(grantUid.trim()));
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '收回失败');
    }
  };

  const togglePerm = (p: string) => {
    if (!editor) return;
    const next = new Set(editor.permissions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setEditor({ ...editor, permissions: next });
  };

  const allPerms = useMemo(() => PERMISSION_GROUPS.flatMap((g) => g.items), []);

  return (
    <div className="admin-page__section" data-testid="admin-roles">
      <div className="admin-page__head">
        <h2>角色编辑器</h2>
        <button type="button" className="btn btn--primary" onClick={openCreate} data-testid="role-create-btn">
          <Plus size={14} /> 新建角色
        </button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {roles === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : (
        <table className="admin-table" data-testid="roles-table">
          <thead>
            <tr>
              <th>角色</th>
              <th>类型</th>
              <th>权限点</th>
              <th>授权人数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} data-testid="role-row">
                <td>
                  <div className="admin-role__name">
                    <ShieldCheck size={13} /> {r.name}
                  </div>
                  {r.description ? <div className="admin-role__desc">{r.description}</div> : null}
                </td>
                <td>{r.is_builtin ? <span className="tag tag--builtin">内置</span> : <span className="tag">自定义</span>}</td>
                <td>
                  <span className="admin-role__perms" title={r.permissions.join('\n')}>
                    {r.permissions.length} 项
                  </span>
                </td>
                <td>{r.user_count}</td>
                <td>
                  <div className="admin-role__ops">
                    <button type="button" className="btn btn--sm" onClick={() => openEdit(r)}>
                      {r.is_builtin ? '权限点' : '编辑'}
                    </button>
                    {!r.is_builtin ? (
                      <button type="button" className="btn btn--sm btn--danger" onClick={() => void remove(r)}>
                        <Trash2 size={12} /> 删除
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 用户授权管理 */}
      <div className="admin-grants">
        <div className="admin-grants__head">用户授权</div>
        <div className="admin-grants__query">
          <input
            className="bbw-input"
            placeholder="用户 uid"
            value={grantUid}
            onChange={(e) => setGrantUid(e.target.value)}
            data-testid="grant-uid-input"
          />
          <button type="button" className="btn" onClick={() => void loadGrants()} data-testid="grant-query-btn">
            查询
          </button>
        </div>
        {grants !== null ? (
          <div className="admin-grants__body">
            {grants.length === 0 ? (
              <div className="admin-page__empty">该用户暂无角色</div>
            ) : (
              grants.map((g) => (
                <div className="admin-grants__row" key={g.id}>
                  <span>{g.role_name}</span>
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => void doRevoke(g.id)}>
                    收回
                  </button>
                </div>
              ))
            )}
            <div className="admin-grants__row admin-grants__row--add">
              <select className="gm-select" data-testid="grant-role-select" defaultValue="">
                <option value="" disabled>
                  选择角色授予…
                </option>
                {(roles ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => {
                  const sel = document.querySelector<HTMLSelectElement>('[data-testid="grant-role-select"]');
                  if (sel?.value) void doGrant(sel.value);
                }}
              >
                授予
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 新建/编辑抽屉 */}
      {editor ? (
        <div className="modal-mask" onClick={() => setEditor(null)}>
          <div className="role-editor" onClick={(e) => e.stopPropagation()} data-testid="role-editor">
            <div className="role-editor__head">
              <span>{editor.mode === 'create' ? '新建角色' : `编辑角色 · ${editor.role?.name}`}</span>
              <button type="button" className="icon-btn" onClick={() => setEditor(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="role-editor__body">
              <label className="gm-field__label">角色名（≤50 字）{editor.role?.is_builtin ? '（内置锁定）' : ''}</label>
              <input
                className="bbw-input"
                value={editor.name}
                disabled={editor.role?.is_builtin}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                data-testid="role-name-input"
              />
              <label className="gm-field__label">描述</label>
              <input
                className="bbw-input"
                value={editor.description}
                disabled={editor.role?.is_builtin}
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
              <label className="gm-field__label">
                权限点（已选 {editor.permissions.size} 项；字典外权限点随 D12 接口下发，登记）
              </label>
              <div className="role-editor__perms">
                {PERMISSION_GROUPS.map((g) => (
                  <div className="role-editor__group" key={g.group}>
                    <div className="role-editor__group-label">{g.group}</div>
                    {g.items.map((p) => (
                      <label key={p} className={`role-editor__perm${editor.permissions.has(p) ? ' role-editor__perm--on' : ''}`}>
                        <input type="checkbox" checked={editor.permissions.has(p)} onChange={() => togglePerm(p)} />
                        <code>{p}</code>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
              <label className="gm-field__label">附加权限点（逗号分隔；含字典外项）</label>
              <input
                className="bbw-input"
                placeholder="如 oa:todo:read, custom:perm"
                onChange={(e) => {
                  const extras = e.target.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
                  const next = new Set([...editor.permissions].filter((p) => allPerms.includes(p)));
                  extras.forEach((p) => next.add(p));
                  setEditor({ ...editor, permissions: next });
                }}
              />
            </div>
            <div className="role-editor__foot">
              <button type="button" className="btn" onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !editor.name.trim() || editor.permissions.size === 0}
                onClick={() => void save()}
                data-testid="role-save-btn"
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
