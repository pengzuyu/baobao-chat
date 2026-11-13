/**
 * 新建文章弹窗（D24 真机修正轮二 2026-11-13：用户拍板恢复页面写入入口——
 * 修订原「页面零写入 UI」口径）：标题+markdown 正文+落点（维度 radio「我的文章/
 * 公司知识库」+专栏下拉首层），提交走既有 ingestDoc 同步管线；成功开 tab 看文。
 */

import { useState } from 'react';
import { useNodes, useSpaces } from '../api/hooks';
import { useIngest } from '../api/hooks';
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
    <div className="kb-dialog" onClick={props.onClose}>
      <div className="kb-dialog__card" onClick={(e) => e.stopPropagation()} data-testid="kb-create-doc">
        <div className="kb-dialog__title">新建文章</div>
        <label className="kb-dialog__field">
          <span className="kb-dialog__label">标题</span>
          <input className="kb-dialog__input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="文章标题" />
        </label>
        <label className="kb-dialog__field">
          <span className="kb-dialog__label">正文（Markdown）</span>
          <textarea
            className="kb-dialog__textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'# 标题\n\n正文支持 Markdown：**粗体**、列表、表格、图片 ![](url)…'}
          />
        </label>
        <div className="kb-dialog__field">
          <span className="kb-dialog__label">发布到</span>
          <div className="kb-dialog__radios">
            {list.map((s) => (
              <label key={s.id} className={`kb-dialog__radio${spaceId === s.id ? ' kb-dialog__radio--on' : ''}`}>
                <input
                  type="radio"
                  name="kb-create-space"
                  checked={spaceId === s.id}
                  onChange={() => {
                    setSpaceId(s.id);
                    setNodeId('');
                  }}
                />
                {s.space_type === 'personal' ? '我的文章' : s.name}
              </label>
            ))}
          </div>
        </div>
        <label className="kb-dialog__field">
          <span className="kb-dialog__label">专栏（可选）</span>
          <select className="kb-dialog__input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">（根目录）</option>
            {dirs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {err ? <div className="kb-dialog__err">{err}</div> : null}
        <div className="kb-dialog__actions">
          <button type="button" className="kb-dialog__btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="kb-dialog__btn kb-dialog__btn--primary" disabled={!title.trim() || !text.trim() || ingest.isPending} onClick={submit}>
            {ingest.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
