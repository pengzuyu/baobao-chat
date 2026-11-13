/**
 * MAI-03 邮箱设置抽屉（22 §3.5）：签名/自动转发/远程图片 + 应用专用密码
 * （命名生成·仅显示一次·即时吊销——第三方客户端 Foxmail/Outlook 接入，§3.4 路径②）。
 * D26-O3：自研 mail-settings 壳退役，antd Drawer+Form vertical 化
 * （专用密码区 Card+List；明文密码 Text code+复制钮）。
 */
import { useState } from 'react';
import { Card, Checkbox, Drawer, Flex, Form, Input, List, Space, Typography } from 'antd';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { AppPasswordPlain } from '../model/types';

interface Props {
  onClose: () => void;
  settings: { signature: string; auto_forward: string; keep_copy: boolean; remote_images: boolean };
  onSave: (s: Props['settings']) => void;
  passwords: { id: string; name: string; created_at: number }[];
  onCreatePassword: (name: string) => Promise<AppPasswordPlain | undefined>;
  onRevokePassword: (id: string) => void;
}

export function SettingsDrawer({ onClose, settings, onSave, passwords, onCreatePassword, onRevokePassword }: Props) {
  const [sig, setSig] = useState(settings.signature);
  const [forward, setForward] = useState(settings.auto_forward);
  const [keepCopy, setKeepCopy] = useState(settings.keep_copy);
  const [remote, setRemote] = useState(settings.remote_images);
  const [pwdName, setPwdName] = useState('');
  const [plain, setPlain] = useState<AppPasswordPlain | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (!pwdName.trim()) return;
    setCreating(true);
    try {
      const p = await onCreatePassword(pwdName.trim());
      if (p) {
        setPlain(p);
        setPwdName('');
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <Drawer
      title="邮箱设置"
      open
      onClose={onClose}
      width={420}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button
            onClick={() => onSave({ signature: sig, auto_forward: forward, keep_copy: keepCopy, remote_images: remote })}
          >
            保存设置
          </Button>
        </div>
      }
    >
      <Form layout="vertical">
        <Form.Item label="签名">
          <Input.TextArea value={sig} onChange={(e) => setSig(e.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="随正文追加的签名" />
        </Form.Item>
        <Form.Item label="自动转发（执行随阶段二，先落配置）">
          <Input value={forward} onChange={(e) => setForward(e.target.value)} placeholder="转发地址（空=关闭）" />
          <Checkbox
            checked={keepCopy}
            onChange={(e) => setKeepCopy(e.target.checked)}
            style={{ marginTop: 8 }}
          >
            转发时保留本箱副本
          </Checkbox>
        </Form.Item>
        <Form.Item label="隐私">
          <Checkbox checked={remote} onChange={(e) => setRemote(e.target.checked)}>
            自动加载远程图片（默认关闭，22 §7）
          </Checkbox>
        </Form.Item>
      </Form>

      <Card
        size="small"
        title={
          <Space size={4}>
            <KeyRound size={14} /> 应用专用密码
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          供第三方客户端（Outlook/Foxmail）经 IMAP/SMTP 接入；仅生成时显示一次，吊销即时生效。
        </Typography.Paragraph>
        {plain && (
          <div style={{ marginBottom: 12 }}>
            <Space size={8} align="center" wrap>
              <Typography.Text code>{plain.secret}</Typography.Text>
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void navigator.clipboard?.writeText(plain.secret);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Copy size={12} /> {copied ? '已复制' : '复制'}
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              「{plain.name}」的密码仅此一次展示，请立即抄录
            </Typography.Paragraph>
          </div>
        )}
        <Space.Compact style={{ marginBottom: 12 }}>
          <Input
            style={{ width: 220 }}
            value={pwdName}
            onChange={(e) => setPwdName(e.target.value)}
            onPressEnter={() => void create()}
            placeholder="命名（如 Foxmail）"
          />
          <Button loading={creating} onClick={() => void create()}>
            生成
          </Button>
        </Space.Compact>
        <List
          size="small"
          dataSource={passwords}
          locale={{ emptyText: '暂无专用密码' }}
          renderItem={(p) => (
            <List.Item style={{ padding: '6px 0' }}>
              <Flex justify="space-between" align="center" style={{ width: '100%' }}>
                <span>{p.name}</span>
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(p.created_at).toLocaleDateString()}
                  </Typography.Text>
                  <Button variant="danger" size="small" onClick={() => onRevokePassword(p.id)} aria-label="吊销">
                    <Trash2 size={12} /> 吊销
                  </Button>
                </Space>
              </Flex>
            </List.Item>
          )}
        />
      </Card>
    </Drawer>
  );
}
