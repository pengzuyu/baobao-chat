/**
 * 新建文章弹窗（D24 真机修正轮二 2026-11-13：用户拍板恢复页面写入入口——
 * 修订原「页面零写入 UI」口径）：标题+markdown 正文+落点（维度 radio「我的文章/
 * 公司知识库」+专栏下拉首层），提交走既有 ingestDoc 同步管线；成功开 tab 看文。
 * D26-O1：外壳与控件换 antd（Modal/Form.Item/Input.TextArea/Radio.Group/Select/Button）。
 */

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Radio, Select } from 'antd';
import { useNodes, useSpaces, useIngest } from '../api/hooks';
import type { KbDoc } from '../model/types';

export function CreateDocDialog(props: { onClose: () => void; onCreated: (doc: KbDoc) => void }) {
  const spaces = useSpaces('all');
  const list = spaces.data ?? [];
  const [spaceId, setSpaceId] = useState(() => list.find((s) => s.space_type === 'personal')?.id ?? list[0]?.id ?? '');
  const [nodeId, setNodeId] = useState(''); // 空=维度根
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const ingest = useIngest(spaceId, nodeId);

  const nodes = useNodes(spaceId, '');
  const dirs = nodes.data?.dirs ?? [];

  const submit = () => {
    if (!title.trim() || !text.trim() || !spaceId) return;
    setErr('');
    void ingest
      .mutateAsync({ title: title.trim(), text, format: 'markdown', node_id: nodeId || undefined })
      .then((doc) => {
        if (doc.status === 'ready') {
          props.onCreated(doc);
        } else {
          setErr(doc.error_msg || '保存失败（嵌入服务不可用，稍后可在目录中重试）');
        }
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : '保存失败'));
  };

  return (
    <Modal
      open
      title="新建文章"
      width={640}
      onCancel={props.onClose}
      data-testid="kb-create-doc"
      footer={[
        <Button key="cancel" onClick={props.onClose}>
          取消
        </Button>,
        <Button key="ok" type="primary" disabled={!title.trim() || !text.trim()} loading={ingest.isPending} onClick={submit}>
          保存
        </Button>,
      ]}
    >
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="标题">
          <Input
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文章标题"
            onPressEnter={submit}
          />
        </Form.Item>
        <Form.Item label="正文（Markdown）">
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 10, maxRows: 18 }}
            placeholder={'# 标题\n\n正文支持 Markdown：**粗体**、列表、表格、图片 ![](url)…'}
          />
        </Form.Item>
        <Form.Item label="发布到">
          <Radio.Group
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value as string);
              setNodeId('');
            }}
          >
            {list.map((s) => (
              <Radio key={s.id} value={s.id}>
                {s.space_type === 'personal' ? '我的文章' : s.name}
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        <Form.Item label="专栏（可选）">
          <Select
            value={nodeId}
            onChange={setNodeId}
            options={[{ value: '', label: '（根目录）' }, ...dirs.map((d) => ({ value: d.id, label: d.name }))]}
          />
        </Form.Item>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </Form>
    </Modal>
  );
}
