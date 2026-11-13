/**
 * Agent 治理（D10 PAD-14）：活跃 Agent 用户（网关计量聚合：请求/tokens/
 * 会话数）+ 通道撤销（吊销令牌+踢线）+ 平台总闸 killswitch（紧急停止）。
 * 会话明细在端侧 SQLite（D08）——服务端视角为计量聚合，登记。
 * D26-O2：Table/Alert/Modal.confirm 化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Flex, Modal, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Power, ShieldOff } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { agentKillswitch, fetchAgentUsers, revokeAgentAccess, type AgentUserRow } from '../api/admin';

export function AgentGovernancePage() {
  const [rows, setRows] = useState<AgentUserRow[] | null>(null);
  const [kill, setKill] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, on] = await Promise.all([fetchAgentUsers(), agentKillswitch()]);
      setRows(list);
      setKill(on);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = (r: AgentUserRow) => {
    Modal.confirm({
      title: `撤销 ${r.name || r.user_id} 的 Agent 通道？`,
      content: '其全部令牌吊销并强制下线',
      okText: '撤销通道',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBusy(r.user_id);
        setError(null);
        try {
          await revokeAgentAccess(r.user_id);
          await reload();
        } catch (e) {
          setError(errText(e, '撤销失败'));
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const toggleKill = () => {
    const next = !kill;
    if (next) {
      Modal.confirm({
        title: '开启 Agent 平台总闸？',
        content: '开启后 OBO 签发即刻拒绝（1013）、网关侧 Agent 请求 503——双点拦截（D9）',
        okText: '开启总闸',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => runKillswitch(next),
      });
      return;
    }
    void runKillswitch(next);
  };

  const runKillswitch = async (next: boolean) => {
    setBusy('kill');
    setError(null);
    try {
      setKill(await agentKillswitch(next));
    } catch (e) {
      setError(errText(e, '操作失败'));
    } finally {
      setBusy(null);
    }
  };

  const columns: ColumnsType<AgentUserRow> = [
    {
      title: '用户',
      key: 'user',
      render: (_, r) => (
        <div>
          {r.name || '—'}
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            {r.user_id}
          </Typography.Paragraph>
        </div>
      ),
    },
    { title: '请求', dataIndex: 'requests', width: 100 },
    { title: 'Tokens', dataIndex: 'tokens', width: 120, render: (v: number) => v.toLocaleString() },
    { title: '活跃会话', dataIndex: 'sessions', width: 100 },
    {
      title: '最近活跃',
      dataIndex: 'last_hour',
      width: 180,
      render: (v: number | null) => (v ? new Date(v).toLocaleString() : '—'),
    },
    {
      title: '操作',
      key: 'ops',
      width: 140,
      render: (_, r) => (
        <Button variant="danger" size="small" disabled={busy === r.user_id} onClick={() => revoke(r)}>
          <ShieldOff size={12} /> 撤销通道
        </Button>
      ),
    },
  ];

  return (
    <div data-testid="admin-agent">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Agent 治理
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button
          variant={kill ? 'danger' : 'primary'}
          disabled={busy === 'kill'}
          onClick={() => toggleKill()}
          data-testid="agent-killswitch-btn"
        >
          <Power size={14} /> 总闸：{kill ? '已拉起（紧急停止：OBO 签发拒 1013 + 网关 503）' : '运行中'}
        </Button>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}

      {rows === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : rows.length === 0 ? (
        <Typography.Text type="secondary">暂无活跃 Agent 用量（计量窗内无请求）</Typography.Text>
      ) : (
        <Table<AgentUserRow>
          rowKey="user_id"
          columns={columns}
          dataSource={rows}
          data-testid="agent-users-table"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      )}
    </div>
  );
}
