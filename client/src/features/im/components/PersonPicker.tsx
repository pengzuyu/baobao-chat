/**
 * 通讯录选人器（M3，2026-11-12：替代 CreateConvModal/邀请成员的手输 uid 兜底）：
 * - PersonPickerCore：搜索（工号/姓名/拼音，300ms 防抖）+ 结果列表 + cursor 加载更多；
 *   single=点行即选（onPick 单发），multiple=勾选累积（onToggle）——两种消费形态共用
 * - PersonPickerModal：弹窗壳（发起单聊 ChatPage / 邀请成员 ConvInfoSidebar），
 *   single 点行即回调；multiple 底栏「确认（n）」
 * 数据源 GET /org/users（登录后含 uid 口径）；excludeUids 客户端过滤（如已有成员）。
 * D26-O5：仅外壳换 antd Modal（遮罩/Esc/底栏由 Modal 承载）；搜索框→antd Input；
 * 结果列表行属内容渲染，保守保留（列表行内联化随气泡域批次另行处理）。
 */

import { useEffect, useRef, useState } from 'react';
import { Input, Modal } from 'antd';
import { Check, Search } from 'lucide-react';
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

  return (
    <div className="bbw-pp" data-testid="person-picker">
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
      <div className="bbw-pp__list">
        {error ? (
          <div className="bbw-pp__hint bbw-pp__hint--warn">{error}</div>
        ) : loading && rows.length === 0 ? (
          <div className="bbw-pp__hint">搜索中…</div>
        ) : rows.length === 0 ? (
          <div className="bbw-pp__hint">{q ? '无匹配人员' : '暂无人员'}</div>
        ) : (
          rows.map((u) => (
            <button
              key={u.uid}
              type="button"
              className={`bbw-pp__row${selectedUids.has(u.uid) ? ' bbw-pp__row--selected' : ''}`}
              data-testid="person-picker-row"
              onClick={() => (multiple ? onToggle?.(u) : onPick?.(u))}
            >
              <span className="bbw-contacts__avatar bbw-contacts__avatar--sm">{(u.display_name || '?').slice(0, 1)}</span>
              <span className="bbw-pp__name">{u.display_name}</span>
              <span className="bbw-pp__empno">{u.employee_no}</span>
              <span className="bbw-pp__path">{u.org_path || '未分组'}</span>
              {multiple && selectedUids.has(u.uid) ? <Check size={14} className="bbw-pp__check" /> : null}
            </button>
          ))
        )}
        {nextCursor && rows.length > 0 ? (
          <button type="button" className="bbw-contacts__more" onClick={loadMore} disabled={loading}>
            {loading ? '加载中…' : '加载更多'}
          </button>
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
