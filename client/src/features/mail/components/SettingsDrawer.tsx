/**
 * MAI-03 邮箱设置抽屉（22 §3.5）：签名/自动转发/远程图片 + 应用专用密码
 * （命名生成·仅显示一次·即时吊销——第三方客户端 Foxmail/Outlook 接入，§3.4 路径②）。
 */
import { useState } from 'react';
import { Copy, KeyRound, Trash2, X } from 'lucide-react';
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
    <div className="mail-settings__mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="mail-settings">
        <div className="mail-settings__head">
          <span>邮箱设置</span>
          <button className="mail-settings__close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="mail-settings__body">
          <section>
            <h4>签名</h4>
            <textarea rows={4} value={sig} onChange={(e) => setSig(e.target.value)} placeholder="随正文追加的签名" />
          </section>
          <section>
            <h4>自动转发 <small>（执行随阶段二，先落配置）</small></h4>
            <input value={forward} onChange={(e) => setForward(e.target.value)} placeholder="转发地址（空=关闭）" />
            <label className="mail-settings__check">
              <input type="checkbox" checked={keepCopy} onChange={(e) => setKeepCopy(e.target.checked)} />
              转发时保留本箱副本
            </label>
          </section>
          <section>
            <h4>隐私</h4>
            <label className="mail-settings__check">
              <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
              自动加载远程图片（默认关闭，22 §7）
            </label>
          </section>
          <div className="mail-settings__save">
            <Button variant="primary" onClick={() => onSave({ signature: sig, auto_forward: forward, keep_copy: keepCopy, remote_images: remote })}>
              保存设置
            </Button>
          </div>

          <section className="mail-settings__pwd">
            <h4>
              <KeyRound size={14} /> 应用专用密码
            </h4>
            <p className="mail-settings__pwd-tip">
              供第三方客户端（Outlook/Foxmail）经 IMAP/SMTP 接入；仅生成时显示一次，吊销即时生效。
            </p>
            {plain && (
              <div className="mail-settings__plain">
                <code>{plain.secret}</code>
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(plain.secret);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Copy size={13} /> {copied ? '已复制' : '复制'}
                </button>
                <small>「{plain.name}」的密码仅此一次展示，请立即抄录</small>
              </div>
            )}
            <div className="mail-settings__pwd-create">
              <input
                value={pwdName}
                onChange={(e) => setPwdName(e.target.value)}
                placeholder="命名（如 Foxmail）"
              />
              <Button variant="secondary" loading={creating} onClick={() => void create()}>
                生成
              </Button>
            </div>
            <ul className="mail-settings__pwd-list">
              {passwords.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <time>{new Date(p.created_at).toLocaleDateString()}</time>
                  <button className="mail-settings__revoke" onClick={() => onRevokePassword(p.id)} aria-label="吊销">
                    <Trash2 size={13} /> 吊销
                  </button>
                </li>
              ))}
              {passwords.length === 0 && <li className="mail-settings__pwd-empty">暂无专用密码</li>}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}
