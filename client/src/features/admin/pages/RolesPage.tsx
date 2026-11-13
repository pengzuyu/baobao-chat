/**
 * 角色编辑器（D10 PAD-08 阶段二）：角色列表（内置徽标/授权人数/权限点数）+
 * 新建/编辑弹窗（名称/描述/权限点分组勾选）+ 删除（内置拒）+ 用户授权管理
 * （输入 uid → 角色下拉授权/收回）。权限点字典来自 GET /admin/perm-points
 * （服务端权威清单 D12 §2.4，API-ADM-02——前端不硬编码；字典外点服务端拒绝，
 * 旧种子裸码 admin 编辑时自动收敛）。scope 部门范围授权随 D12 组织树阶段二。
 * D26-O2：Table/Modal/Select/Input/Checkbox/Tag 全量 antd 化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Checkbox, Input, Modal, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
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

const SCOPE_OPTIONS = [
  { value: 4, label: '范围：全租户' },
  { value: 1, label: '范围：本人' },
  { value: 2, label: '范围：本部门' },
  { value: 3, label: '范围：本部门及以下' },
];

export function RolesPage() {
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [permDoc, setPermDoc] = useState<PermPointsDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  // 授权管理（按 uid 查询）
  const [grantUid, setGrantUid] = useState('');
  const [grantRoleId, setGrantRoleId] = useState<string | undefined>(undefined);
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
      setError(errText(e, '保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const remove = (r: AdminRole) => {
    Modal.confirm({
      title: `删除角色「${r.name}」？`,
      content: '已授权用户将一并收回',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setError(null);
        try {
          await deleteRole(r.id);
          await reload();
        } catch (e) {
          setError(errText(e, '删除失败'));
        }
      },
    });
  };

  const loadGrants = async () => {
    const uid = grantUid.trim();
    if (!uid) return;
    setError(null);
    try {
      setGrants(await fetchUserGrants(uid));
    } catch (e) {
      setError(errText(e, '查询失败'));
    }
  };

  const doGrant = async (roleId: string) => {
    setError(null);
    try {
      await grantRole(grantUid.trim(), roleId);
      setGrants(await fetchUserGrants(grantUid.trim()));
      await reload();
    } catch (e) {
      setError(errText(e, '授权失败'));
    }
  };

  const doRevoke = async (grantId: string) => {
    setError(null);
    try {
      await revokeRole(grantId);
      setGrants(await fetchUserGrants(grantUid.trim()));
      await reload();
    } catch (e) {
      setError(errText(e, '收回失败'));
    }
  };

  const columns: ColumnsType<AdminRole> = [
    {
      title: '角色',
      dataIndex: 'name',
      render: (_, r) => (
        <div>
          <div className="admin-role__name">
            <ShieldCheck size={13} /> {r.name}
          </div>
          {r.description ? <div className="admin-role__desc">{r.description}</div> : null}
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'is_builtin',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="geekblue">内置</Tag> : <Tag>自定义</Tag>),
    },
    {
      title: '权限点',
      dataIndex: 'permissions',
      width: 90,
      render: (perms: string[]) => (
        <span className="admin-role__perms" title={perms.join('\n')}>
          {perms.length} 项
        </span>
      ),
    },
    { title: '授权人数', dataIndex: 'user_count', width: 90 },
    {
      title: '操作',
      key: 'ops',
      width: 160,
      render: (_, r) => (
        <>
          <Button variant="secondary" onClick={() => openEdit(r)}>
            {r.is_builtin ? '权限点' : '编辑'}
          </Button>{' '}
          {!r.is_builtin ? (
            <Button variant="danger" onClick={() => remove(r)}>
              <Trash2 size={12} /> 删除
            </Button>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div className="admin-page__section" data-testid="admin-roles">
      <div className="admin-page__head">
        <h2>角色编辑器</h2>
        <Button onClick={openCreate} data-testid="role-create-btn">
          <Plus size={14} /> 新建角色
        </Button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {roles === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : (
        <Table<AdminRole>
          rowKey="id"
          columns={columns}
          dataSource={roles}
          data-testid="roles-table"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      )}

      {/* 用户授权管理 */}
      <div className="admin-grants">
        <div className="admin-grants__head">用户授权</div>
        <div className="admin-grants__query">
          <Input
            placeholder="用户 uid"
            style={{ width: 220 }}
            value={grantUid}
            onChange={(e) => setGrantUid(e.target.value)}
            data-testid="grant-uid-input"
          />
          <Button variant="secondary" onClick={() => void loadGrants()} data-testid="grant-query-btn">
            查询
          </Button>
        </div>
        {grants !== null ? (
          <div className="admin-grants__body">
            {grants.length === 0 ? (
              <div className="admin-page__empty">该用户暂无角色</div>
            ) : (
              grants.map((g) => (
                <div className="admin-grants__row" key={g.id}>
                  <span>{g.role_name}</span>
                  <Tag>
                    {(g.scope_type ?? 4) === 1 ? '本人' : (g.scope_type ?? 4) === 2 ? `本部门#${g.scope_dept_id ?? ''}` : (g.scope_type ?? 4) === 3 ? `本部门及以下#${g.scope_dept_id ?? ''}` : '全租户'}
                  </Tag>
                  <Button variant="danger" onClick={() => void doRevoke(g.id)}>
                    收回
                  </Button>
                </div>
              ))
            )}
            <div className="admin-grants__row admin-grants__row--add">
              <Select
                placeholder="选择角色授予…"
                style={{ width: 200 }}
                value={grantRoleId}
                onChange={setGrantRoleId}
                options={(roles ?? []).map((r) => ({ value: r.id, label: r.name }))}
                data-testid="grant-role-select"
              />
              <Select
                style={{ width: 200 }}
                value={scopeType}
                onChange={setScopeType}
                options={SCOPE_OPTIONS}
                data-testid="grant-scope-select"
                title="数据范围（D12 §S5；权限判定按范围收敛随引擎接线）"
              />
              {scopeType === 2 || scopeType === 3 ? (
                <Input
                  style={{ width: 160 }}
                  data-testid="grant-scope-dept"
                  placeholder="部门 ID"
                  value={scopeDeptId}
                  onChange={(e) => setScopeDeptId(e.target.value)}
                />
              ) : null}
              <Button disabled={!grantRoleId} onClick={() => grantRoleId && void doGrant(grantRoleId)}>
                授予
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 新建/编辑弹窗 */}
      <Modal
        open={!!editor}
        title={editor ? (editor.mode === 'create' ? '新建角色' : `编辑角色 · ${editor.role?.name}`) : ''}
        width={560}
        onCancel={() => setEditor(null)}
        destroyOnClose
        data-testid="role-editor"
        footer={[
          <Button key="cancel" variant="secondary" onClick={() => setEditor(null)}>
            取消
          </Button>,
          <Button
            key="ok"
            loading={busy}
            disabled={!editor?.name.trim() || editor?.permissions.size === 0}
            onClick={() => void save()}
            data-testid="role-save-btn"
          >
            保存
          </Button>,
        ]}
      >
        {editor ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <label className="gm-field__label">
              角色名（≤50 字）{editor.role?.is_builtin ? '（内置锁定）' : ''}
            </label>
            <Input
              value={editor.name}
              disabled={editor.role?.is_builtin}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              data-testid="role-name-input"
            />
            <label className="gm-field__label">描述</label>
            <Input
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
              <div style={{ display: 'grid', gap: 12 }}>
                {permDoc.groups.map((g) => (
                  <div key={g.domain}>
                    <div className="admin-role__desc" style={{ marginBottom: 4 }}>
                      {g.label}（{g.points.length} 项）
                    </div>
                    {g.points.map((p) => (
                      <Checkbox
                        key={p.code}
                        checked={editor.permissions.has(p.code)}
                        onChange={() => {
                          const next = new Set(editor.permissions);
                          if (next.has(p.code)) next.delete(p.code);
                          else next.add(p.code);
                          setEditor({ ...editor, permissions: next });
                        }}
                      >
                        <code>{p.code}</code> <span className="admin-role__desc">{p.desc}</span>
                      </Checkbox>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
