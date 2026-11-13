/**
 * 设置 · Agent · 会话云备份卡（OQ-B09 / 08 篇 §5.2/§6.3；零知识端侧加密）：
 * - 未设置：设口令（≥8 位）→ 生成恢复码（仅展示一次，可复制）→ 本机缓存 DEK
 * - 已设置：[备份全部会话]（壳侧会话列表 → DEK 加密 → POST 密文+envelope）
 * - 备份列表：时间/大小/标题；[恢复]（票据下载 → 口令或恢复码解密 → 明文 JSON 导出）
 * - 跨设备：本机无 DEK 时凭口令/恢复码解包（envelope 随备份行取回）
 * v0.1 取舍：备份体=壳侧会话缓存快照（事件级 JSONL 导出随 RT 协议导出命令扩展，登记）。
 * D26-O3：卡片壳→Card、备份列表→List、口令/通道控件→Input.Password/Select（settings-* 退役）。
 */

import { useEffect, useState } from 'react';
import { Alert, Card, Flex, Input, List, Select, Space, Typography } from 'antd';
import { CloudUpload, Download, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import {
  clearLocalBackupKeys,
  createEnvelope,
  decryptJson,
  encryptJson,
  loadLocalBackupKeys,
  saveLocalBackupKeys,
  unwrapDek,
  type BackupKeyEnvelope,
  type DekMaterial,
} from '../../../shared/utils/backupCrypto';
import { createBackup, deleteBackup, downloadBackupBlob, issueRestoreTicket, listBackups, type BackupItem } from '../../agent/api/backup';
import { getAgentBridge } from '../../agent/bridge';

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64(s: Uint8Array): string {
  let out = '';
  for (const b of s) out += String.fromCharCode(b);
  return btoa(out);
}

export function CloudBackupCard() {
  const [local, setLocal] = useState(() => loadLocalBackupKeys());
  const [items, setItems] = useState<BackupItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [errText, setErrText] = useState('');
  const [note, setNote] = useState('');
  // 设置流：口令输入 → 恢复码一次性展示
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  // 恢复流：选备份 → 口令/恢复码输入
  const [restoreSecret, setRestoreSecret] = useState('');
  const [restoreChannel, setRestoreChannel] = useState<'password' | 'recovery'>('password');

  const reload = () => {
    void listBackups()
      .then(setItems)
      .catch(() => setItems([]));
  };
  useEffect(reload, []);

  /** 设置口令：生成 envelope+DEK+恢复码；DEK 缓存本机（后续备份免输） */
  const setup = async () => {
    if (pw.length < 8) {
      setErrText('口令至少 8 个字符');
      return;
    }
    if (pw !== pw2) {
      setErrText('两次输入不一致');
      return;
    }
    setBusy(true);
    setErrText('');
    try {
      const created = await createEnvelope(pw);
      saveLocalBackupKeys({ dek: b64(created.dek), envelope: created.envelope });
      setLocal(loadLocalBackupKeys());
      setRecoveryCode(created.recoveryCode);
      setPw('');
      setPw2('');
    } catch (e) {
      setErrText(e instanceof Error ? e.message : '初始化失败');
    } finally {
      setBusy(false);
    }
  };

  /** 备份全部：壳侧会话快照 → DEK 加密 → 上行密文+envelope（envelope 与本机同源） */
  const backupNow = async () => {
    let dek: DekMaterial;
    let envelope: BackupKeyEnvelope;
    if (local) {
      dek = unb64(local.dek);
      envelope = local.envelope;
    } else {
      setErrText('本机未缓存密钥——请先用恢复码恢复密钥（在备份列表任一行[恢复]并选择恢复码通道）');
      return;
    }
    setBusy(true);
    setErrText('');
    setNote('');
    try {
      const sessions = await getAgentBridge().listSessions();
      const payload = { v: 1, exportedAt: new Date().toISOString(), sessions };
      const data = await encryptJson(dek, payload);
      await createBackup({
        local_session_id: `all-${Date.now()}`,
        title: `全部会话 ×${sessions.length}`,
        enc_alg: 'AES-256-GCM',
        key_envelope: JSON.stringify(envelope),
        data,
        idempotencyKey: `web-${Date.now()}`,
      });
      setNote('备份完成（服务端仅存密文）');
      reload();
    } catch (e) {
      setErrText(e instanceof Error ? e.message : getErrorText(9004));
    } finally {
      setBusy(false);
    }
  };

  /** 恢复/导出：票据下载密文 → 口令或恢复码解包 DEK → 明文 JSON 导出下载 */
  const restore = async (item: BackupItem) => {
    if (!restoreSecret.trim()) {
      setErrText('请输入口令或恢复码');
      return;
    }
    setBusy(true);
    setErrText('');
    try {
      const tk = await issueRestoreTicket(item.id);
      const blob = await downloadBackupBlob(tk.url);
      let dek = local ? unb64(local.dek) : null;
      if (!dek) {
        const env = blob.envelope ?? (JSON.parse(item.keyEnvelope) as BackupKeyEnvelope);
        dek = await unwrapDek(env, restoreSecret, restoreChannel);
        // 恢复成功：DEK 回缓存本机（后续备份免输）
        saveLocalBackupKeys({ dek: b64(dek), envelope: blob.envelope ?? env });
        setLocal(loadLocalBackupKeys());
      }
      const plain = await decryptJson<unknown>(dek, blob.data);
      const url = URL.createObjectURL(new Blob([JSON.stringify(plain, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent-backup-${item.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNote('已解密并导出明文 JSON（仅本机）');
    } catch (e) {
      setErrText(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await deleteBackup(id);
      reload();
    } catch {
      setErrText('删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      size="small"
      data-testid="cloud-backup-card"
      title={
        <Space size={6}>
          <ShieldCheck size={15} /> 会话云备份（端侧加密）
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        会话数据在本机以口令派生密钥加密后上传，服务器零知识（不可读明文）；恢复码可跨设备找回。
        不含工作区文件内容（08 篇 §5.2）。租户级开关随 feature_flag 表接入（登记）。
      </Typography.Paragraph>

      {errText ? <Alert type="error" showIcon message={errText} style={{ marginBottom: 8 }} /> : null}
      {note ? <Alert type="success" showIcon message={note} style={{ marginBottom: 8 }} /> : null}

      {!local && !recoveryCode ? (
        <Flex vertical gap={8} style={{ marginBottom: 8 }}>
          <Space size={6}>
            <KeyRound size={14} /> <span>设置备份口令</span>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            口令 ≥8 位；设置后生成恢复码（仅显示一次，请妥善保存）
          </Typography.Text>
          <Space size={8} wrap>
            <Input.Password
              style={{ width: 180 }}
              placeholder="备份口令"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
            />
            <Input.Password
              style={{ width: 180 }}
              placeholder="再次输入"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
            />
            <Button variant="secondary" disabled={busy} onClick={() => void setup()}>
              生成密钥与恢复码
            </Button>
          </Space>
        </Flex>
      ) : null}

      {recoveryCode ? (
        <div data-testid="recovery-code-box" style={{ marginBottom: 8 }}>
          <span>恢复码（仅此一次展示）</span>
          <Flex align="center" gap={8} style={{ marginTop: 4 }}>
            <Typography.Text code style={{ fontSize: 14 }}>
              {recoveryCode}
            </Typography.Text>
            <Button variant="secondary" size="small" onClick={() => void navigator.clipboard?.writeText(recoveryCode)}>
              复制
            </Button>
          </Flex>
        </div>
      ) : null}

      {local ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <List size="small">
            <List.Item actions={[<Button key="backup" variant="secondary" disabled={busy} onClick={() => void backupNow()}>{busy ? '处理中…' : '备份'}</Button>]}>
              <List.Item.Meta
                title={
                  <Space size={6}>
                    <CloudUpload size={14} /> 立即备份全部会话
                  </Space>
                }
                description="备份体=本机会话列表快照（v0.1；事件级导出随 RT 协议扩展）"
              />
            </List.Item>
            <List.Item>
              <List.Item.Meta
                title="恢复密钥（跨设备/清缓存后）"
                description={
                  <Space size={8} wrap>
                    <Select
                      size="small"
                      style={{ width: 100 }}
                      value={restoreChannel}
                      onChange={(v) => setRestoreChannel(v as 'password' | 'recovery')}
                      options={[
                        { value: 'password', label: '口令' },
                        { value: 'recovery', label: '恢复码' },
                      ]}
                    />
                    <Input.Password
                      size="small"
                      style={{ width: 200 }}
                      placeholder={restoreChannel === 'password' ? '备份口令' : '恢复码（XXXX-XXXX-…）'}
                      value={restoreSecret}
                      onChange={(e) => setRestoreSecret(e.target.value)}
                    />
                  </Space>
                }
              />
            </List.Item>
          </List>

          {items === null ? (
            <Typography.Text type="secondary">加载备份列表…</Typography.Text>
          ) : items.length === 0 ? (
            <Typography.Text type="secondary">暂无备份</Typography.Text>
          ) : (
            <List
              size="small"
              split
              dataSource={items}
              renderItem={(it) => (
                <List.Item
                  data-testid="backup-item"
                  actions={[
                    <Button
                      key="restore"
                      variant="secondary"
                      size="small"
                      disabled={busy}
                      onClick={() => void restore(it)}
                      title="解密并导出 JSON"
                      icon={<Download size={12} />}
                    >
                      恢复
                    </Button>,
                    <Button key="del" variant="secondary" size="small" disabled={busy} onClick={() => void remove(it.id)} icon={<Trash2 size={12} />} />,
                  ]}
                >
                  <List.Item.Meta
                    title={it.title || it.localSessionId}
                    description={`${new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false })} · ${formatBytes(it.size)} · ${it.encAlg}`}
                  />
                </List.Item>
              )}
            />
          )}

          <Flex align="center" gap={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本机已缓存密钥（备份免输口令）。清除本机缓存：
            </Typography.Text>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                clearLocalBackupKeys();
                setLocal(null);
                setNote('本机密钥已清除；下次恢复需口令或恢复码');
              }}
            >
              清除
            </Button>
          </Flex>
        </Space>
      ) : null}
    </Card>
  );
}
