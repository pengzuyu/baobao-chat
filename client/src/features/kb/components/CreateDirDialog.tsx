/**
 * 新建目录弹窗（D24 真机修正轮二）：维度 radio+父目录下拉（根/首层）+目录名；
 * 与树内 hover「+」（建子目录）互补——本弹窗建首层/根级专栏。
 */

import { useState } from 'react';
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
    <div className="kb-dialog" onClick={props.onClose}>
      <div className="kb-dialog__card" onClick={(e) => e.stopPropagation()} data-testid="kb-create-dir">
        <div className="kb-dialog__title">新建目录（专栏）</div>
        <div className="kb-dialog__field">
          <span className="kb-dialog__label">所属</span>
          <div className="kb-dialog__radios">
            {list.map((s) => (
              <label key={s.id} className={`kb-dialog__radio${spaceId === s.id ? ' kb-dialog__radio--on' : ''}`}>
                <input
                  type="radio"
                  name="kb-create-dir-space"
                  checked={spaceId === s.id}
                  onChange={() => {
                    setSpaceId(s.id);
                    setParentId('');
                  }}
                />
                {s.space_type === 'personal' ? '我的文章' : s.name}
              </label>
            ))}
          </div>
        </div>
        <label className="kb-dialog__field">
          <span className="kb-dialog__label">父目录（可选）</span>
          <select className="kb-dialog__input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">（根目录）</option>
            {dirs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="kb-dialog__field">
          <span className="kb-dialog__label">目录名</span>
          <input
            className="kb-dialog__input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="如：技术分享"
          />
        </label>
        {err ? <div className="kb-dialog__err">{err}</div> : null}
        <div className="kb-dialog__actions">
          <button type="button" className="kb-dialog__btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="kb-dialog__btn kb-dialog__btn--primary" disabled={!name.trim()} onClick={() => void submit()}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
