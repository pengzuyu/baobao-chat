/**
 * 角色编辑器（D10 PAD-08 阶段二）：角色列表（内置徽标/授权人数/权限点数）+
 * 新建/编辑弹窗（名称/描述/权限点分组勾选）+ 删除（内置拒）+ 用户授权管理
 * （输入 uid → 角色下拉授权/收回）。权限点字典来自 GET /admin/perm-points
 * （服务端权威清单 D12 §2.4，API-ADM-02——前端不硬编码；字典外点服务端拒绝，
 * 旧种子裸码 admin 编辑时自动收敛）。scope 部门范围授权随 D12 组织树阶段二。
 * D26-O2：Table/Modal/Select/Input/Checkbox/Tag 全量 antd 化；补充轮：
 * 头部 Flex/授权区 Card+List/错误条 Alert（自研 admin-* 样式退役）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, Checkbox, Flex, Input, List, Modal, Select, Space, Table, Tag, Typography } from 'antd';
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
          <Space size={4}>
            <ShieldCheck size={13} /> {r.name}
          </Space>
          {r.description ? (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {r.description}
            </Typography.Paragraph>
          ) : null}
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
        <span title={perms.join('\n')}>{perms.length} 项</span>
      ),
    },
    { title: '授权人数', dataIndex: 'user_count', width: 90 },
    {
      title: '操作',
      key: 'ops',
      width: 170,
      render: (_, r) => (
        <Space size={4}>
          <Button variant="secondary" size="small" onClick={() => openEdit(r)}>
            {r.is_builtin ? '权限点' : '编辑'}
          </Button>
          {!r.is_builtin ? (
            <Button variant="danger" size="small" onClick={() => remove(r)}>
              <Trash2 size={12} /> 删除
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div data-testid="admin-roles">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          角色编辑器
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button onClick={openCreate} data-testid="role-create-btn">
          <Plus size={14} /> 新建角色
        </Button>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}

      {roles === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
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
      <Card size="small" title="用户授权" style={{ marginTop: 16 }}>
        <Space.Compact style={{ marginBottom: 12 }}>
          <Input
            placeholder="用户 uid"
            style={{ width: 220 }}
            value={grantUid}
            onChange={(e) => setGrantUid(e.target.value)}
            onPressEnter={() => void loadGrants()}
            data-testid="grant-uid-input"
          />
          <Button variant="secondary" onClick={() => void loadGrants()} data-testid="grant-query-btn">
            查询
          </Button>
        </Space.Compact>
        {grants !== null ? (
          <>
            <List
              size="small"
              locale={{ emptyText: '该用户暂无角色' }}
              dataSource={grants}
              renderItem={(g) => (
                <List.Item style={{ padding: '6px 0' }}>
                  <Flex justify="space-between" align="center" style={{ width: '100%' }}>
                    <Space size={8}>
                      <span>{g.role_name}</span>
                      <Tag>
                        {(g.scope_type ?? 4) === 1 ? '本人' : (g.scope_type ?? 4) === 2 ? `本部门#${g.scope_dept_id ?? ''}` : (g.scope_type ?? 4) === 3 ? `本部门及以下#${g.scope_dept_id ?? ''}` : '全租户'}
                      </Tag>
                    </Space>
                    <Button variant="danger" size="small" onClick={() => void doRevoke(g.id)}>
                      收回
                    </Button>
                  </Flex>
                </List.Item>
              )}
            />
            <Space size={8} wrap style={{ marginTop: 8 }}>
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
                  style={{ width: 140 }}
                  data-testid="grant-scope-dept"
                  placeholder="部门 ID"
                  value={scopeDeptId}
                  onChange={(e) => setScopeDeptId(e.target.value)}
                />
              ) : null}
              <Button disabled={!grantRoleId} onClick={() => grantRoleId && void doGrant(grantRoleId)}>
                授予
              </Button>
            </Space>
          </>
        ) : null}
      </Card>

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
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <label>
              <Typography.Text>
                角色名（≤50 字）{editor.role?.is_builtin ? '（内置锁定）' : ''}
              </Typography.Text>
            </label>
            <Input
              value={editor.name}
              disabled={editor.role?.is_builtin}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              data-testid="role-name-input"
            />
            <Typography.Text>描述</Typography.Text>
            <Input
              value={editor.description}
              disabled={editor.role?.is_builtin}
              onChange={(e) => setEditor({ ...editor, description: e.target.value })}
            />
            <Typography.Text>
              权限点（已选 {editor.permissions.size} 项；字典共 {permDoc?.total ?? '…'} 项，服务端权威清单 D12 §2.4）
            </Typography.Text>
            {permDoc === null ? (
              <Alert type="warning" showIcon message="权限点字典加载失败（编辑需字典校验）——请稍后重开编辑器重试" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {permDoc.groups.map((g) => (
                  <div key={g.domain}>
                    <Typography.Text type="secondary">
                      {g.label}（{g.points.length} 项）
                    </Typography.Text>
                    <div>
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
                          <Typography.Text code>{p.code}</Typography.Text>{' '}
                          <Typography.Text type="secondary">{p.desc}</Typography.Text>
                        </Checkbox>
                      ))}
                    </div>
                  </div>
                ))}
              </Space>
            )}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
