/**
 * 建群弹窗（D03 INT-IM-15；M3 2026-11-12 改版）：
 * - 单聊不再走本弹窗——「+」菜单「发起单聊」直达选人器（ChatPage PersonPickerModal）
 * - 群聊：群名 + 通讯录多选人（PersonPickerCore 内嵌，替代手输 uid 兜底）≤499
 * D26-O5：自研 forward-modal 壳退役，antd Modal+Form vertical 化
 * （群名→Input、已选成员 chip→Tag closable、错误→Alert）。
 */

import { useState } from 'react';
import { Alert, Form, Input, Modal, Space, Tag } from 'antd';
import { Button } from '../../../shared/ui/Button';
import { errText } from '../../../shared/api/http';
import { convCreate } from '../api/im';
import type { DirectoryUser } from '../../contacts/api/contacts';
import { PersonPickerCore } from './PersonPicker';

interface CreateConvModalProps {
  onClose: () => void;
  /** 创建成功：跳转新会话 */
  onCreated: (convId: string) => void;
}

export function CreateConvModal({ onClose, onCreated }: CreateConvModalProps) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<DirectoryUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError('群名必填');
      return;
    }
    if (members.length === 0) {
      setError('至少选择 1 名成员');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const conv = await convCreate({
        type: 2,
        name: name.trim(),
        memberIds: members.map((m) => m.uid),
      });
      onCreated(conv.id);
    } catch (e) {
      setError(errText(e, '创建失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="发起群聊"
      width={480}
      onCancel={onClose}
      destroyOnClose
      data-testid="create-conv-modal"
      footer={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" loading={busy} disabled={members.length === 0} onClick={() => void submit()} data-testid="create-conv-submit">
          {busy ? '创建中…' : '创建群聊'}
        </Button>,
      ]}
    >
      <Form layout="vertical">
        <Form.Item label="群名称（≤50 字）">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：产品研发群"
            onPressEnter={() => void submit()}
            data-testid="create-conv-name"
          />
        </Form.Item>
        <Form.Item label={`选择成员（已选 ${members.length}/499）`}>
          {members.length > 0 ? (
            <Space size={4} wrap style={{ marginBottom: 8 }} data-testid="create-conv-chips">
              {members.map((m) => (
                <Tag
                  key={m.uid}
                  closable
                  title={`移除 ${m.display_name}`}
                  onClose={() => setMembers((prev) => prev.filter((p) => p.uid !== m.uid))}
                >
                  {m.display_name}
                </Tag>
              ))}
            </Space>
          ) : null}
          <PersonPickerCore multiple selected={members} onToggle={(u) => setMembers((prev) => (prev.some((p) => p.uid === u.uid) ? prev.filter((p) => p.uid !== u.uid) : [...prev, u]))} />
        </Form.Item>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Form>
    </Modal>
  );
}
