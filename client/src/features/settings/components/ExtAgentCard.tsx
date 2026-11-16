/**
 * 外部智能体接入授权卡（D30 批4，设置·Agent 页）：
 * 本机回环 A2A/MCP 面的状态、token 展示/复制/重发（=撤销），接入指引。
 * 知识检索按当前登录用户权限；会话与审批卡都在本 App 内——面随 App 生命周期。
 */

import { useEffect, useState } from 'react';
import { Alert, Card, List, Popconfirm, Space, Typography } from 'antd';
import { Check, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { fetchExtAgentStatus, isExtAgentUiAvailable, regenExtAgentToken, type ExtAgentStatus } from '../api/extAgent';

export function ExtAgentCard() {
  const [status, setStatus] = useState<ExtAgentStatus | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenning, setRegen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isExtAgentUiAvailable()) return;
    fetchExtAgentStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);

  if (!isExtAgentUiAvailable()) {
    return (
      <Card size="small" title="外部 Agent 接入">
        <Typography.Text type="secondary">桌面端功能——Web 预览不可用</Typography.Text>
      </Card>
    );
  }

  const token = status?.token ?? '';
  const masked = token ? `${token.slice(0, 8)}…${token.slice(-4)}` : '—';
  const port = status?.port ?? 0;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板被拒（焦点策略）：手动选 copy */
    }
  };

  const regen = async () => {
    setRegen(true);
    setError('');
    try {
      await regenExtAgentToken();
      setStatus(await fetchExtAgentStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setRegen(false);
    }
  };

  return (
    <Card size="small" data-testid="agent-ext-agent" title="外部 Agent 接入（A2A / MCP）">
      <List
        size="small"
        dataSource={[
          {
            key: 'state',
            name: '接入面状态',
            desc: '127.0.0.1 本机回环，随 BaobaoChat 打开而在线；关闭 App 即下线',
            control: status?.online ? (
              <Typography.Text type="success" style={{ fontSize: 12 }}>
                在线 · 127.0.0.1:{port}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">未启动</Typography.Text>
            ),
          },
          {
            key: 'token',
            name: '本机 token',
            desc: '外部 Agent（Claude Code / zcode / bbw CLI）接入凭证；仅本机有效',
            control: (
              <Space size={4}>
                <Typography.Text code style={{ fontSize: 12 }}>
                  {revealed ? token : masked}
                </Typography.Text>
                <Button variant="secondary" size="small" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
                </Button>
                <Button variant="secondary" size="small" onClick={() => void copy(token)}>
                  {copied ? <Check size={12} /> : <Copy size={12} />} 复制
                </Button>
                <Popconfirm
                  title="重新生成 token？"
                  description="既有外部接入立即失效（旧 token 401），需重新配置"
                  okText="重新生成"
                  cancelText="取消"
                  onConfirm={() => void regen()}
                >
                  <Button variant="secondary" size="small" loading={regenning}>
                    <RefreshCw size={12} /> 撤销并重发
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
        renderItem={(row) => (
          <List.Item actions={[row.control]}>
            <div>
              <div>{row.name}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.desc}
              </Typography.Text>
            </div>
          </List.Item>
        )}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
        把 BaobaoChat agent 当子智能体调用——知识检索/记忆/专家/公司工具按你的权限执行；审批卡会在本窗口弹出，请留意确认。
      </Typography.Paragraph>
      <Typography.Paragraph style={{ fontSize: 12, marginBottom: 2 }}>
        Claude Code 挂载：
      </Typography.Paragraph>
      <Typography.Paragraph code copyable style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginBottom: 6 }}>
        {`claude mcp add --transport http bbw http://127.0.0.1:${port}/mcp \\\n  --header "Authorization: Bearer ${token}"`}
      </Typography.Paragraph>
      <Typography.Paragraph style={{ fontSize: 12, marginBottom: 2 }}>
        CLI（bbw ask）：
      </Typography.Paragraph>
      <Typography.Paragraph code copyable style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
        {`bbw ask "帮我查一下…"        # 新会话\nbbw ask --session <id> "续问"  # 续聊`}
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} /> : null}
    </Card>
  );
}
