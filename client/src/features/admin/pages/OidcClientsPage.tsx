/**
 * 管理后台 · 登录接入（D28 批3/Q3）：OIDC 客户端（RP）凭证管理。
 * 一期只开 public client（PKCE-only）——client_id 服务端生成即下发；
 * redirect_uris 精确匹配白名单；禁用=拒新授权（存量靠过期收敛）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Switch, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  apiAdminOidcClientCreate,
  apiAdminOidcClients,
  apiAdminOidcClientStatus,
  type AdminOidcClient,
} from '../../auth/api/oidc';

interface CreateForm {
  name: string;
  redirect_uris: string;
  scopes?: string;
}

export function OidcClientsPage() {
  const [items, setItems] = useState<AdminOidcClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const created = await apiAdminOidcClientCreate({
        name: values.name.trim(),
        redirect_uris: values.redirect_uris.split('\n').map((s) => s.trim()).filter(Boolean),
        scopes: values.scopes?.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      });
      void message.success(`已创建 ${created.client_id}，请填入应用的 OIDC 配置（issuer 见部署文档）`);
      setOpen(false);
      form.resetFields();
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
          <Typography.Text code style={{ fontSize: 12 }}>{c.client_id}</Typography.Text>
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
            <Tag key={s}>{s}</Tag>
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
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary">
          接入统一登录的生态应用凭证（public client · PKCE-only）；应用侧只需配 issuer 即可对接。
        </Typography.Text>
        <Button type="primary" onClick={() => setOpen(true)}>
          新建接入
        </Button>
      </Space>
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={items} pagination={false} />
      <Modal
        title="新建 OIDC 接入"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ scopes: 'openid profile' }}>
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
          <Form.Item name="scopes" label="scope 白名单（空格分隔，缺省 openid profile）" extra="可填公司权限点（如 kb:query:use），用户权限收敛由服务端强制">
            <Input placeholder="openid profile" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
