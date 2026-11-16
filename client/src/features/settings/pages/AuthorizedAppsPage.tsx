/**
 * 设置 · 登录与授权（D28 批3/Q3）：
 * - 已授权应用：生态应用 OIDC 授权列表 + 一键撤销（refresh/access 全灭）
 * - 浏览器登录会话：IdP 统一登录的 web 会话 + 远端下线（SSO 免密即失效）
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  apiMeOidcGrants,
  apiMeOidcRevokeGrant,
  apiMeOidcRevokeSession,
  apiMeOidcSessions,
  type OidcGrant,
  type OidcSession,
} from '../../auth/api/oidc';

const { Title, Text } = Typography;

function fmtTime(s: string): string {
  return s ? s.replace('T', ' ').replace(/([+\-]\d{2}:\d{2}|Z)$/, '') : '-';
}

export function AuthorizedAppsPage() {
  const [grants, setGrants] = useState<OidcGrant[]>([]);
  const [sessions, setSessions] = useState<OidcSession[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, s] = await Promise.all([apiMeOidcGrants(), apiMeOidcSessions()]);
      setGrants(g);
      setSessions(s);
    } catch {
      // 失败保持现状（信封错误已全局兜底）
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeGrant = async (clientId: string, appName: string) => {
    try {
      await apiMeOidcRevokeGrant(clientId);
      void message.success(`已撤销「${appName}」的授权`);
      void load();
    } catch {
      // 信封错误已全局兜底
    }
  };

  const revokeSession = async (id: number) => {
    try {
      await apiMeOidcRevokeSession(id);
      void message.success('该浏览器会话已下线');
      void load();
    } catch {
      // 信封错误已全局兜底
    }
  };

  const grantCols: ColumnsType<OidcGrant> = [
    {
      title: '应用',
      key: 'app',
      render: (_, g) => (
        <Space direction="vertical" size={0}>
          <Text strong>{g.app_name || g.client_id}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{g.client_id}</Text>
        </Space>
      ),
    },
    {
      title: '授权范围',
      dataIndex: 'scopes',
      render: (scopes: string[]) => (
        <Space size={[4, 4]} wrap>
          {scopes.map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </Space>
      ),
    },
    { title: '授权时间', dataIndex: 'granted_at', render: (v: string) => fmtTime(v), width: 170 },
    {
      title: '状态',
      dataIndex: 'revoked',
      width: 90,
      render: (revoked: boolean) => (revoked ? <Tag>已撤销</Tag> : <Tag color="green">生效中</Tag>),
    },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_, g) =>
        g.revoked ? null : (
          <Popconfirm title={`撤销「${g.app_name || g.client_id}」的授权？`} description="该应用将无法继续使用你的身份访问，已签发的访问令牌最迟 15 分钟后失效。" onConfirm={() => void revokeGrant(g.client_id, g.app_name)}>
            <Button size="small" danger>
              撤销
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const sessionCols: ColumnsType<OidcSession> = [
    {
      title: '浏览器',
      key: 'ua',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <Text>{s.user_agent ? s.user_agent.slice(0, 40) : '浏览器'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{s.ip} · 会话 #{s.id}</Text>
        </Space>
      ),
    },
    { title: '最近使用', dataIndex: 'last_used_at', render: (v: string) => fmtTime(v), width: 170 },
    { title: '滑动到期', dataIndex: 'expires_at', render: (v: string) => fmtTime(v), width: 170 },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_, s) => (
        <Popconfirm title="下线该浏览器会话？" description="该浏览器上的统一登录免密将立即失效，需要重新输入密码。" onConfirm={() => void revokeSession(s.id)}>
          <Button size="small" danger>
            下线
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ marginTop: 0 }}>
          已授权应用
        </Title>
        <Text type="secondary">通过统一登录授权给生态应用的身份访问；撤销后应用需重新走授权确认。</Text>
        <Table
          style={{ marginTop: 12 }}
          rowKey="client_id"
          size="small"
          loading={loading}
          columns={grantCols}
          dataSource={grants}
          pagination={false}
          locale={{ emptyText: '暂无已授权的应用' }}
        />
      </div>
      <div>
        <Title level={5} style={{ marginTop: 0 }}>
          浏览器登录会话
        </Title>
        <Text type="secondary">网页端统一登录（IdP 浏览器会话）的活跃记录；下线即该浏览器免密失效。</Text>
        <Table
          style={{ marginTop: 12 }}
          rowKey="id"
          size="small"
          loading={loading}
          columns={sessionCols}
          dataSource={sessions}
          pagination={false}
          locale={{ emptyText: '暂无活跃的浏览器会话' }}
        />
      </div>
      <Alert
        type="info"
        showIcon
        message="修改密码会使以上全部授权与会话立即失效"
        description="按安全策略，改密后所有应用授权、浏览器会话与各端登录态将同时吊销。"
      />
    </Space>
  );
}
