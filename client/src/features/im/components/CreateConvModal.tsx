/**
 * 建会话弹窗（D03 INT-IM-15 最简版）：
 * - 单聊：选 1 人（手输 uid，服务端去重复用已有单聊）
 * - 群聊：群名 + 手输 uid 列表（≤499）
 * 正式版成员选择器接通讯录（org 域 API），当前以手输 uid 列表兜底（登记）。
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
import { convCreate } from '../api/im';

interface CreateConvModalProps {
  onClose: () => void;
  /** 创建成功：跳转新会话 */
  onCreated: (convId: string) => void;
}

export function CreateConvModal({ onClose, onCreated }: CreateConvModalProps) {
  const [type, setType] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uids = members.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);

  const submit = async () => {
    if (busy) return;
    if (type === 1 && uids.length !== 1) {
      setError('单聊恰选 1 人');
      return;
    }
    if (type === 2 && !name.trim()) {
      setError('群名必填');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const conv = await convCreate({
        type,
        name: type === 2 ? name.trim() : undefined,
        memberIds: uids,
      });
      onCreated(conv.id);
    } catch (e) {
      setError(e && typeof e === 'object' && 'code' in e ? getErrorText((e as { code: number }).code) : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="forward-modal" onClick={(e) => e.stopPropagation()} data-testid="create-conv-modal">
        <div className="forward-modal__head">
          <span>新建会话</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="gm-create__body">
          <div className="gm-create__types">
            <button
              type="button"
              className={`gm-tab${type === 1 ? ' gm-tab--active' : ''}`}
              onClick={() => setType(1)}
              data-testid="create-type-single"
            >
              发起单聊
            </button>
            <button
              type="button"
              className={`gm-tab${type === 2 ? ' gm-tab--active' : ''}`}
              onClick={() => setType(2)}
              data-testid="create-type-group"
            >
              创建群聊
            </button>
          </div>

          {type === 2 ? (
            <div className="gm-field">
              <label className="gm-field__label">群名称（≤50 字）</label>
              <div className="bbw-input">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：产品研发群"
                  data-testid="create-conv-name"
                />
              </div>
            </div>
          ) : null}

          <div className="gm-field">
            <label className="gm-field__label">
              {type === 1 ? '对方用户 ID（恰 1 人）' : `成员用户 ID 列表（逗号分隔，已选 ${uids.length}/499）`}
            </label>
            <div className="bbw-input">
              <input
                value={members}
                onChange={(e) => setMembers(e.target.value)}
                placeholder={type === 1 ? '如 10002' : '如 10002, 10003'}
                data-testid="create-conv-members"
              />
            </div>
          </div>

          {error ? <div className="gm-error">{error}</div> : null}

          <div className="gm-create__foot">
            <Button variant="text" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={busy || uids.length === 0} onClick={() => void submit()} data-testid="create-conv-submit">
              {busy ? '创建中…' : '创建'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
