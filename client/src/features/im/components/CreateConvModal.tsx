/**
 * 建群弹窗（D03 INT-IM-15；M3 2026-11-12 改版）：
 * - 单聊不再走本弹窗——「+」菜单「发起单聊」直达选人器（ChatPage PersonPickerModal）
 * - 群聊：群名 + 通讯录多选人（PersonPickerCore 内嵌，替代手输 uid 兜底）≤499
 */

import { useState } from 'react';
import { X } from 'lucide-react';
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
    <div className="modal-mask" onClick={onClose}>
      <div className="forward-modal" onClick={(e) => e.stopPropagation()} data-testid="create-conv-modal">
        <div className="forward-modal__head">
          <span>发起群聊</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="gm-create__body">
          <div className="gm-field">
            <label className="gm-field__label">群名称（≤50 字）</label>
            <div className="bbw-input">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：产品研发群"
                data-testid="create-conv-name"
              />
            </div>
          </div>

          <div className="gm-field">
            <label className="gm-field__label">选择成员（已选 {members.length}/499）</label>
          </div>
          {members.length > 0 ? (
            <div className="bbw-pp__chips" data-testid="create-conv-chips">
              {members.map((m) => (
                <button
                  key={m.uid}
                  type="button"
                  className="bbw-pp__chip"
                  title={`移除 ${m.display_name}`}
                  onClick={() => setMembers((prev) => prev.filter((p) => p.uid !== m.uid))}
                >
                  {m.display_name}
                  <X size={11} />
                </button>
              ))}
            </div>
          ) : null}
          <PersonPickerCore multiple selected={members} onToggle={(u) => setMembers((prev) => (prev.some((p) => p.uid === u.uid) ? prev.filter((p) => p.uid !== u.uid) : [...prev, u]))} />

          {error ? <div className="gm-error">{error}</div> : null}

          <div className="gm-create__foot">
            <Button variant="text" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={busy || members.length === 0} onClick={() => void submit()} data-testid="create-conv-submit">
              {busy ? '创建中…' : '创建群聊'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
