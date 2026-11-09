/**
 * 角色编辑器（D10 PAD-08 阶段二）：角色列表（内置徽标/授权人数/权限点数）+
 * 新建/编辑抽屉（名称/描述/权限点分组勾选）+ 删除（内置拒）+ 用户授权管理
 * （输入 uid → 角色下拉授权/收回）。权限点字典来自 GET /admin/perm-points
 * （服务端权威清单 D12 §2.4，API-ADM-02——前端不硬编码；字典外点服务端拒绝，
 * 旧种子裸码 admin 编辑时自动收敛）。scope 部门范围授权随 D12 组织树阶段二。
 */

import { useCallback, useEffect, useState } from 'react';
import { Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import {
  createRole,
  deleteRole,
  fetchPermPoints,
  fetchRoles,
  fetchUserGrants,
  grantRole,
  revokeRole,
  updateRole,
  type AdminGrant,
  type AdminRole,
  type PermPointsDoc,
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
  const [permDoc, setPermDoc] = useState<PermPointsDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  // 授权管理（按 uid 查询）
  const [grantUid, setGrantUid] = useState('');
  // D10：数据范围四档（授予时携带；2/3 需部门 ID）
  const [scopeType, setScopeType] = useState(4);
  const [scopeDeptId, setScopeDeptId] = useState('');
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
    // 权限点字典（服务端下发；失败不阻断角色列表——编辑器内给出重试）
    fetchPermPoints().then(setPermDoc).catch(() => setPermDoc(null));
  }, [reload]);

  const openCreate = () =>
    setEditor({ mode: 'create', name: '', description: '', permissions: new Set() });
  const openEdit = (r: AdminRole) => {
    // 旧种子可能含字典外点（如裸码 admin）——编辑口径收敛到字典内，保存后落库收敛
    const known = new Set((permDoc?.groups ?? []).flatMap((g) => g.points.map((p) => p.code)));
    const keep = known.size > 0 ? r.permissions.filter((p) => known.has(p)) : r.permissions;
    setEditor({ mode: 'edit', role: r, name: r.name, description: r.description ?? '', permissions: new Set(keep) });
  };

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
                  <span className="tag">
                    {(g.scope_type ?? 4) === 1 ? '本人' : (g.scope_type ?? 4) === 2 ? `本部门#${g.scope_dept_id ?? ''}` : (g.scope_type ?? 4) === 3 ? `本部门及以下#${g.scope_dept_id ?? ''}` : '全租户'}
                  </span>
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
              <select
                className="gm-select"
                data-testid="grant-scope-select"
                value={scopeType}
                onChange={(e) => setScopeType(Number(e.target.value))}
                title="数据范围（D12 §S5；权限判定按范围收敛随引擎接线）"
              >
                <option value={4}>范围：全租户</option>
                <option value={1}>范围：本人</option>
                <option value={2}>范围：本部门</option>
                <option value={3}>范围：本部门及以下</option>
              </select>
              {scopeType === 2 || scopeType === 3 ? (
                <input
                  className="gm-input"
                  data-testid="grant-scope-dept"
                  placeholder="部门 ID"
                  value={scopeDeptId}
                  onChange={(e) => setScopeDeptId(e.target.value)}
                />
              ) : null}
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
                权限点（已选 {editor.permissions.size} 项；字典共 {permDoc?.total ?? '…'} 项，服务端权威清单 D12 §2.4）
              </label>
              {permDoc === null ? (
                <div className="admin-page__empty">权限点字典加载失败（编辑需字典校验）——请稍后重开编辑器重试</div>
              ) : (
                <div className="role-editor__perms">
                  {permDoc.groups.map((g) => (
                    <div className="role-editor__group" key={g.domain}>
                      <div className="role-editor__group-label">
                        {g.label} <span className="admin-role__perms">{g.points.length} 项</span>
                      </div>
                      {g.points.map((p) => (
                        <label key={p.code} className={`role-editor__perm${editor.permissions.has(p.code) ? ' role-editor__perm--on' : ''}`}>
                          <input type="checkbox" checked={editor.permissions.has(p.code)} onChange={() => togglePerm(p.code)} />
                          <code>{p.code}</code>
                          <span className="admin-role__desc">{p.desc}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
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
