/**
 * 新建目录弹窗（D24 真机修正轮二）：维度 radio+父目录下拉（根/首层）+目录名；
 * 与树内 hover「+」（建子目录）互补——本弹窗建首层/根级专栏。
 * D26-O1：外壳与控件换 antd（Modal/Form.Item/Input/Radio.Group/Select/Button）。
 */

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Radio, Select } from 'antd';
import { useCreateDir, useNodes, useSpaces } from '../api/hooks';

export function CreateDirDialog(props: { onClose: () => void }) {
  const spaces = useSpaces('all');
  const list = spaces.data ?? [];
  const [spaceId, setSpaceId] = useState(() => list.find((s) => s.space_type === 'personal')?.id ?? list[0]?.id ?? '');
  const [parentId, setParentId] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const createDir = useCreateDir(spaceId, parentId);

  const nodes = useNodes(spaceId, '');
  const dirs = nodes.data?.dirs ?? [];

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setErr('');
    try {
      await createDir.mutateAsync(n);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error && e.message.includes('7014') ? '同级已有同名目录' : '创建失败');
    }
  };

  return (
    <Modal
      open
      title="新建目录（专栏）"
      onCancel={props.onClose}
      data-testid="kb-create-dir"
      footer={[
        <Button key="cancel" onClick={props.onClose}>
          取消
        </Button>,
        <Button key="ok" type="primary" disabled={!name.trim()} onClick={() => void submit()}>
          创建
        </Button>,
      ]}
    >
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="所属">
          <Radio.Group
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value as string);
              setParentId('');
            }}
          >
            {list.map((s) => (
              <Radio key={s.id} value={s.id}>
                {s.space_type === 'personal' ? '我的文章' : s.name}
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        <Form.Item label="父目录（可选）">
          <Select
            value={parentId}
            onChange={setParentId}
            options={[{ value: '', label: '（根目录）' }, ...dirs.map((d) => ({ value: d.id, label: d.name }))]}
          />
        </Form.Item>
        <Form.Item label="目录名">
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onPressEnter={() => void submit()}
            placeholder="如：技术分享"
          />
        </Form.Item>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </Form>
    </Modal>
  );
}
