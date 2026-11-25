/**
 * 管理后台 · 登录接入（D28 批3/Q3）：OIDC 客户端（RP）凭证管理。
 * 一期只开 public client（PKCE-only）——client_id 服务端生成即下发；
 * redirect_uris 精确匹配白名单；禁用=拒新授权（存量靠过期收敛）。
 * 2026-11-25：scope 白名单改勾选组+说明（管理员可读）、创建成功态展示
 * client_id 可复制、补编辑（PATCH {id}：name/回调/scope 全量覆盖，client_id 恒定）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Space, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Copy, Check } from 'lucide-react';
import {
  apiAdminOidcClientCreate,
  apiAdminOidcClients,
  apiAdminOidcClientStatus,
  apiAdminOidcClientUpdate,
  type AdminOidcClient,
} from '../../auth/api/oidc';
import { SCOPE_LABEL } from '../../auth/scopeLabels';

interface CreateForm {
  name: string;
  redirect_uris: string;
  custom_scopes?: string;
}

/** 标准 scope 勾选项（openid 恒选锁定；说明文案对齐 OidcConfirmCard 用户面词表） */
const STD_SCOPES: { key: string; desc: string; locked?: boolean }[] = [
  { key: 'openid', desc: '身份标识（OIDC 必需，恒开启）', locked: true },
  { key: 'profile', desc: '基础资料——姓名/工号，授权页向用户明示' },
  { key: 'email', desc: '邮箱地址——第三方以邮箱建立账号时勾选（如 phebs）' },
  { key: 'offline_access', desc: '离线保持登录——签发 refresh token，第三方可静默续期' },
];
const STD_KEYS = STD_SCOPES.map((s) => s.key);

/** scopes 组装/回显：openid 恒在首位，标准勾选 + 自定义输入合并去重 */
function buildScopes(checked: string[], custom?: string): string[] {
  const customList = (custom ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return ['openid', ...checked.filter((s) => s !== 'openid'), ...customList.filter((s) => !STD_KEYS.includes(s))];
}

function splitStdCustom(scopes: string[]): { checked: string[]; custom: string } {
  const checked = scopes.filter((s) => STD_KEYS.includes(s) && s !== 'openid');
  const custom = scopes.filter((s) => !STD_KEYS.includes(s)).join(' ');
  return { checked, custom };
}

export function OidcClientsPage() {
  const [items, setItems] = useState<AdminOidcClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdminOidcClient | null>(null); // null=新建
  const [created, setCreated] = useState<AdminOidcClient | null>(null); // 新建成功态（展示凭证）
  const [stdChecked, setStdChecked] = useState<string[]>(['profile']); // 标准 scope 勾选（openid 恒含）
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form] = Form.useForm<CreateForm>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await apiAdminOidcClients());
    } catch {
      // 信封错误已全局兜底
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setCreated(null);
    setStdChecked(['profile']);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (c: AdminOidcClient) => {
    setEditing(c);
    setCreated(null);
    const { checked, custom } = splitStdCustom(c.scopes);
    setStdChecked(checked);
    form.setFieldsValue({ name: c.name, redirect_uris: c.redirect_uris.join('\n'), custom_scopes: custom });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const scopes = buildScopes(stdChecked, values.custom_scopes);
    const body = {
      name: values.name.trim(),
      redirect_uris: values.redirect_uris.split('\n').map((s) => s.trim()).filter(Boolean),
      scopes,
    };
    setSubmitting(true);
    try {
      if (editing) {
        await apiAdminOidcClientUpdate(editing.id, body);
        void message.success(`已更新「${body.name}」，改动即时生效`);
        setOpen(false);
      } else {
        const c = await apiAdminOidcClientCreate(body);
        setCreated(c); // 成功态：弹窗内展示 client_id 可复制
      }
      void load();
    } catch {
      // 信封错误已全局兜底
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (c: AdminOidcClient, enabled: boolean) => {
    try {
      await apiAdminOidcClientStatus(c.id, enabled ? 'active' : 'disabled');
      void load();
    } catch {
      // 信封错误已全局兜底
    }
  };

  const cols: ColumnsType<AdminOidcClient> = [
    {
      title: '应用',
      key: 'app',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{c.name}</Typography.Text>
          <Typography.Text code copyable={{ text: c.client_id, tooltips: ['复制 client_id', '已复制'] }} style={{ fontSize: 12 }}>
            {c.client_id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '回调地址（白名单）',
      dataIndex: 'redirect_uris',
      render: (uris: string[]) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          {uris.map((u) => (
            <Typography.Text key={u} type="secondary">{u}</Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: 'scope 白名单',
      dataIndex: 'scopes',
      render: (scopes: string[]) => (
        <Space size={[4, 4]} wrap>
          {scopes.map((s) => (
            <Tag key={s}>{SCOPE_LABEL[s] ?? s}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '启用',
      dataIndex: 'status',
      width: 80,
      render: (_, c) => <Switch size="small" checked={c.status === 'active'} onChange={(v) => void toggle(c, v)} />,
    },
    {
      title: '操作',
      key: 'ops',
      width: 70,
      render: (_, c) => (
        <Button size="small" variant="link" onClick={() => openEdit(c)}>
          编辑
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary">
          接入统一登录的生态应用凭证（public client · PKCE-only）；应用侧只需配 issuer 即可对接。
        </Typography.Text>
        <Button type="primary" onClick={openCreate}>
          新建接入
        </Button>
      </Space>
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={items} pagination={false} />
      <Modal
        title={created ? '接入已创建' : editing ? `编辑接入 · ${editing.name}` : '新建 OIDC 接入'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        okText={editing ? '保存' : '创建'}
        footer={
          created
            ? [
                <Button key="ok" type="primary" onClick={() => setOpen(false)}>
                  我已保存，关闭
                </Button>,
              ]
            : undefined
        }
        destroyOnHidden
      >
        {created ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Paragraph>
              「{created.name}」创建成功。应用侧凭证（public client 无 secret）：
            </Typography.Paragraph>
            <Space size={8} align="center" wrap>
              <Typography.Text code>{created.client_id}</Typography.Text>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  void navigator.clipboard?.writeText(created.client_id);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? '已复制' : '复制'}
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              请将 client_id 填入应用的 OIDC 配置（issuer 见部署文档，/oauth2 根路径）。回调白名单与 scope
              后续可在列表「编辑」中随时调整。
            </Typography.Paragraph>
          </Space>
        ) : (
          <Form form={form} layout="vertical" initialValues={{ custom_scopes: '' }}>
            <Form.Item name="name" label="应用名称" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="如：报销系统" />
            </Form.Item>
            <Form.Item
              name="redirect_uris"
              label="回调地址（每行一个，精确匹配）"
              rules={[{ required: true, message: '必填' }]}
            >
              <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder="https://expense.company.com/oidc/callback" />
            </Form.Item>
            <Form.Item label="scope 白名单">
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {STD_SCOPES.map((s) => (
                  <Checkbox
                    key={s.key}
                    checked={s.locked || stdChecked.includes(s.key)}
                    disabled={s.locked}
                    onChange={(e) =>
                      setStdChecked((prev) => (e.target.checked ? [...prev, s.key] : prev.filter((k) => k !== s.key)))
                    }
                  >
                    <Typography.Text code style={{ fontSize: 12 }}>{s.key}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>　{s.desc}</Typography.Text>
                  </Checkbox>
                ))}
              </Space>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                说明：scope 决定授权页向用户明示的范围，也是该应用可申请的自定义权限上限——超出的部分会被静默丢弃，最终仍以用户本人权限为准。
              </Typography.Paragraph>
            </Form.Item>
            <Form.Item
              name="custom_scopes"
              label="自定义权限点（空格分隔，可选）"
              extra="公司权限点（如 kb:query:use）；未勾选的标准 scope 与未填的权限点即使用户授权请求携带也会被收敛"
            >
              <Input placeholder="kb:query:use" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Space>
  );
}
