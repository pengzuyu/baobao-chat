/**
 * 通讯录选人器（M3，2026-11-12：替代 CreateConvModal/邀请成员的手输 uid 兜底）：
 * - PersonPickerCore：搜索（工号/姓名/拼音，300ms 防抖）+ 结果列表 + cursor 加载更多；
 *   single=点行即选（onPick 单发），multiple=勾选累积（onToggle）——两种消费形态共用
 * - PersonPickerModal：弹窗壳（发起单聊 ChatPage / 邀请成员 ConvInfoSidebar），
 *   single 点行即回调；multiple 底栏「确认（n）」
 * 数据源 GET /org/users（登录后含 uid 口径）；excludeUids 客户端过滤（如已有成员）。
 * D26-O5：外壳/搜索框已 antd 化（Modal/Input）。
 * D26-O6（本批）：列表内容行的 bbc-pp 与 bbc-contacts 自研类残留退役——内联 + shared
 * Avatar + Typography，加载更多→shared Button。
 */

import { useEffect, useRef, useState } from 'react';
import { Input, Modal, Typography, theme } from 'antd';
import { Check, Search } from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { errText } from '../../../shared/api/http';
import { fetchDirectoryUsers } from '../../contacts/api/contacts';
import type { DirectoryUser } from '../../contacts/api/contacts';

/** 防抖窗口（与通讯录页/登录页选人同节奏） */
const PICKER_DEBOUNCE_MS = 300;

interface CoreProps {
  multiple?: boolean;
  /** 多选已选集（受控） */
  selected: DirectoryUser[];
  onToggle?: (u: DirectoryUser) => void;
  /** 单选点行即选 */
  onPick?: (u: DirectoryUser) => void;
  /** 排除 uid（如群内已有成员） */
  excludeUids?: string[];
}

export function PersonPickerCore({ multiple, selected, onToggle, onPick, excludeUids }: CoreProps) {
  const { token } = theme.useToken();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<DirectoryUser[]>([]);
  const [nextCursor, setNextCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0); // 竞态防护：仅采纳最后一次发起的结果

  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);

  // 首开 + q 变化：重置翻页重查（空 q=全量，工号升序）
  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    fetchDirectoryUsers({ q: q || undefined, limit: 20 })
      .then((res) => {
        if (seqRef.current !== seq) return;
        setItems(res.items);
        setNextCursor(res.nextCursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seqRef.current !== seq) return;
        setError(errText(e, '通讯录检索失败'));
        setItems([]);
        setNextCursor('');
        setLoading(false);
      });
  }, [q]);

  const excluded = new Set(excludeUids ?? []);
  const rows = items.filter((u) => !excluded.has(u.uid));
  const selectedUids = new Set(selected.map((u) => u.uid));

  const loadMore = () => {
    if (!nextCursor || loading) return;
    const seq = seqRef.current;
    setLoading(true);
    fetchDirectoryUsers({ q: q || undefined, cursor: nextCursor, limit: 20 })
      .then((res) => {
        if (seqRef.current !== seq) return;
        setItems((prev) => [...prev, ...res.items]);
        setNextCursor(res.nextCursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seqRef.current !== seq) return;
        setError(errText(e, '通讯录检索失败'));
        setLoading(false);
      });
  };

  /** 提示行（搜索中/空态/错误；原 bbc-pp__hint） */
  const hint = (text: string, warn = false): React.ReactNode => (
    <Typography.Text type={warn ? 'warning' : 'secondary'} style={{ display: 'block', padding: '18px 8px', textAlign: 'center', fontSize: 12 }}>
      {text}
    </Typography.Text>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }} data-testid="person-picker">
      <Input
        autoFocus
        allowClear
        prefix={<Search size={14} aria-hidden />}
        placeholder="搜索 工号/姓名/拼音"
        value={qInput}
        data-testid="person-picker-input"
        onChange={(e) => setQInput(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div style={{ overflow: 'auto', maxHeight: 320, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {error ? (
          hint(error, true)
        ) : loading && rows.length === 0 ? (
          hint('搜索中…')
        ) : rows.length === 0 ? (
          hint(q ? '无匹配人员' : '暂无人员')
        ) : (
          rows.map((u) => {
            const picked = selectedUids.has(u.uid);
            return (
              <button
                key={u.uid}
                type="button"
                data-testid="person-picker-row"
                onClick={() => (multiple ? onToggle?.(u) : onPick?.(u))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: token.borderRadius,
                  border: 'none',
                  background: picked ? token.colorPrimaryBg : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: token.colorText,
                }}
              >
                <Avatar name={u.display_name || '?'} size={32} />
                <Typography.Text style={{ fontSize: 13, fontWeight: 500, flexShrink: 0 }}>
                  {u.display_name}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                  {u.employee_no}
                </Typography.Text>
                <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  {u.org_path || '未分组'}
                </Typography.Text>
                {multiple && picked ? <Check size={14} aria-hidden style={{ flexShrink: 0, color: token.colorPrimary }} /> : null}
              </button>
            );
          })
        )}
        {nextCursor && rows.length > 0 ? (
          <Button variant="secondary" size="small" onClick={loadMore} disabled={loading} loading={loading} style={{ margin: '8px auto', borderRadius: 14 }}>
            {loading ? '加载中…' : '加载更多'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface PersonPickerModalProps {
  open: boolean;
  title: string;
  multiple?: boolean;
  /** 多选确认（single 时点行即 onConfirm([u]) 后自动关） */
  onConfirm: (picked: DirectoryUser[]) => void;
  onClose: () => void;
  excludeUids?: string[];
}

export function PersonPickerModal({ open, title, multiple, onConfirm, onClose, excludeUids }: PersonPickerModalProps) {
  const [selected, setSelected] = useState<DirectoryUser[]>([]);
  // 每次打开重置已选（复用弹窗实例场景）
  useEffect(() => {
    if (open) setSelected([]);
  }, [open]);
  if (!open) return null;

  const toggle = (u: DirectoryUser) =>
    setSelected((prev) => (prev.some((p) => p.uid === u.uid) ? prev.filter((p) => p.uid !== u.uid) : [...prev, u]));

  return (
    <Modal
      open={open}
      title={title}
      width={480}
      onCancel={onClose}
      destroyOnClose
      data-testid="person-picker-modal"
      footer={
        multiple
          ? [
              <Button key="cancel" variant="secondary" onClick={onClose}>
                取消
              </Button>,
              <Button
                key="ok"
                disabled={selected.length === 0}
                data-testid="person-picker-confirm"
                onClick={() => {
                  onConfirm(selected);
                  onClose();
                }}
              >
                确认（{selected.length}）
              </Button>,
            ]
          : null
      }
    >
      {multiple ? (
        <PersonPickerCore
          multiple
          selected={selected}
          onToggle={toggle}
          excludeUids={excludeUids}
        />
      ) : (
        <PersonPickerCore
          selected={selected}
          onPick={(u) => {
            onConfirm([u]);
            onClose();
          }}
          excludeUids={excludeUids}
        />
      )}
    </Modal>
  );
}
