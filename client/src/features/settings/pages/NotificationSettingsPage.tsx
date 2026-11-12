/**
 * 设置 · 通知（D01 §4.2 / D12）：服务端驱动存储（user_notify_pref 0030）。
 * 三项：会话消息通知/@我强提醒/免打扰时段；dnd 即刻生效于 agent 完成系统
 * 通知（notify.ts 静默），红点保留；IM 桌面通知触发点随通知中心深度接（登记）。
 * 六态：loading / error 重试 / ok 服务端态即时保存（乐观更新+失败回滚）。
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Select, Switch } from 'antd';
import { ApiError, getErrorText , errText } from '../../../shared/api/http';
import { fetchNotifyPref, patchNotifyPref, type NotifyPref } from '../api/notifyPref';

const DEFAULT_PREF: NotifyPref = { msg_notify: true, mention_notify: true, dnd_range: 'off' };

export function NotificationSettingsPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'notify-pref'], queryFn: fetchNotifyPref });
  // 本地乐观态（服务端值到达后对齐）
  const [local, setLocal] = useState<NotifyPref>(DEFAULT_PREF);
  const [error, setError] = useState('');

  useEffect(() => {
    if (query.data) setLocal(query.data);
  }, [query.data]);

  /** 即时保存：乐观更新 → PATCH → 失败回滚+错误提示 */
  const save = (next: NotifyPref) => {
    const prev = local;
    setLocal(next);
    setError('');
    void patchNotifyPref(next)
      .then((saved) => {
        setLocal(saved);
        void qc.invalidateQueries({ queryKey: ['settings', 'notify-pref'] });
      })
      .catch((e) => {
        setLocal(prev);
        setError(errText(e, '保存失败'));
      });
  };

  if (query.isPending) {
    return (
      <div className="settings-section">
        <h2 className="settings-section__title">通知</h2>
        <div className="settings-card">加载中…</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="settings-section">
        <h2 className="settings-section__title">通知</h2>
        <div className="settings-card">
          {query.error instanceof ApiError ? getErrorText(query.error.code) : '加载失败'}
          <button type="button" className="doc-link-btn" onClick={() => void query.refetch()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section" data-testid="settings-notification">
      <h2 className="settings-section__title">通知</h2>
      {error ? <div className="settings-card__error" data-testid="notify-pref-error">{error}</div> : null}

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">会话消息通知</div>
            <div className="settings-row__desc">新消息桌面通知与红点提醒</div>
          </div>
          <Switch
            checked={local.msg_notify}
            size="small"
            data-testid="notify-msg-switch"
            onChange={(v) => save({ ...local, msg_notify: v })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">@我特别提醒</div>
            <div className="settings-row__desc">被提及（含 @所有人）时强提醒</div>
          </div>
          <Switch
            checked={local.mention_notify}
            size="small"
            data-testid="notify-mention-switch"
            onChange={(v) => save({ ...local, mention_notify: v })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">免打扰时段</div>
            <div className="settings-row__desc">时段内系统通知静默，红点保留（即刻生效于 Agent 完成通知）</div>
          </div>
          <Select
            size="small"
            style={{ width: 200 }}
            value={local.dnd_range}
            data-testid="notify-dnd-select"
            onChange={(v) => save({ ...local, dnd_range: v })}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'work-night', label: '每天 22:00 - 次日 08:00' },
              { value: 'all-day', label: '全天免打扰' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
