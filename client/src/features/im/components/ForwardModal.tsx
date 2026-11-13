/**
 * 转发面板（PIM-10b 完整版，D03 §3.10 / INT-IM-05）：
 * - 搜索会话 + 最近会话 chip + 会话列表单选
 * - 方式 radio（>1 条出现：合并转发 ≤30 / 逐条转发）；附言 textarea ≤500
 * - 合并 >30 条前端拦截（3021 文案 toast，不发请求）；目标广播群非 publisher 前置隐藏（3013）
 * - 六态：loading=发送中按钮态 / empty=无会话提示 / error=3013 等错误码文案 + 逐条失败明细 /
 *   offline=禁发提示 / forbidden=广播群目标过滤 / degraded 不适用（登记）
 * D26-O5：自研 forward-modal 壳退役，antd Modal 化（搜索→Input.Search、chip→CheckableTag、
 * 列表行内联化、radio→Radio.Group、附言→Input.TextArea showCount、error/offline→Alert）。
 */

import { useMemo, useState } from 'react';
import { Alert, Flex, Input, Modal, Radio, Tag, Typography, theme } from 'antd';
import { Send } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { useConnectionStore } from '../../../shared/store/connection';
import { forwardMessages } from '../api/im';
import type { Conversation } from '../model/types';

/** 合并转发条数上限（3021，D03 INT-IM-05；服务端同规则兜底） */
export const MERGE_FORWARD_LIMIT = 30;
/** 3021 文案（shared ERROR_TEXT 未登记 3021，本域内置） */
const MERGE_LIMIT_TEXT = '合并转发超限（≤30 条）';
/** 最近会话 chip 数量 */
const RECENT_CHIPS = 5;
/** 附言上限（INT-IM-05） */
const NOTE_MAX = 500;

interface ForwardModalProps {
  convs: Conversation[];
  /** 转发消息 msgId 列表（单条或多选） */
  msgIds: string[];
  /** 打开时的默认方式（批量条「合并转发」入口预置 merge；单条固定逐条） */
  defaultMode?: 'merge' | 'one_by_one';
  onClose: () => void;
  onDone: (result: { sent: number; failed: number; targetConvId: string }) => void;
}

export function ForwardModal({ convs, msgIds, defaultMode, onClose, onDone }: ForwardModalProps) {
  const { token } = theme.useToken();
  // 单条转发无方式选择（合并无意义），>1 条默认合并（飞书同款）
  const [mode, setMode] = useState<'merge' | 'one_by_one'>(
    defaultMode ?? (msgIds.length > 1 ? 'merge' : 'one_by_one'),
  );
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState('');
  const offline = useConnectionStore((s) => s.status) === 'offline';

  // 目标候选：active 会话；广播群前置隐藏（非 publisher 转发必被 3013 拦截，PIM-10 六态 forbidden）
  const candidates = useMemo(
    () => convs.filter((c) => c.status === 1 && !(c.type === 3 && c.myRole !== 4)),
    [convs],
  );
  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(kw.toLowerCase()));
  }, [candidates, keyword]);
  // 最近会话 chip：按最近活跃排序取前 N（同样走 3013 前置过滤）
  const recents = useMemo(
    () => [...candidates].sort((a, b) => (b.lastMsgTs ?? 0) - (a.lastMsgTs ?? 0)).slice(0, RECENT_CHIPS),
    [candidates],
  );

  const doForward = async () => {
    if (!target || sending || offline) return;
    // 合并 ≤30 前端拦截（3021 文案；服务端同规则兜底）
    if (mode === 'merge' && msgIds.length > MERGE_FORWARD_LIMIT) {
      setErrorText(`${MERGE_LIMIT_TEXT}（已选 ${msgIds.length} 条）`);
      return;
    }
    setSending(true);
    setErrorText('');
    try {
      const res = await forwardMessages(target, msgIds, mode, note.trim() || undefined);
      onDone({ sent: res.sentCount, failed: res.failed.length, targetConvId: target });
    } catch (err) {
      // 整单失败：3013 只读 / 3021 超限 / 3006 禁言等按错误码映射，保留弹窗可重试
      const code = err instanceof ApiError ? err.code : 0;
      setErrorText(code > 0 ? getErrorText(code) : '转发失败，请重试');
      setSending(false);
    }
  };

  const convLabel = (c: Conversation) => (c.type === 1 ? c.name : `${c.name} (${c.memberCount})`);

  return (
    <Modal
      open
      title={`转发 ${msgIds.length > 1 ? `${msgIds.length} 条消息` : '消息'}`}
      width={480}
      onCancel={onClose}
      destroyOnClose
      data-testid="forward-modal"
      footer={[
        <Button key="cancel" variant="secondary" disabled={sending} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="ok"
          loading={sending}
          disabled={!target || offline}
          onClick={() => void doForward()}
          data-testid="forward-send"
        >
          <Send size={14} />
          {sending ? '转发中…' : '发送'}
        </Button>,
      ]}
    >
      {/* 搜索会话（PIM-10 弹窗规格） */}
      <Input.Search
        placeholder="搜索会话"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={(v) => setKeyword(v)}
        allowClear
        data-testid="forward-search"
        style={{ marginBottom: 12 }}
      />

      {/* 最近会话 chip */}
      {recents.length > 0 ? (
        <Flex gap={4} wrap style={{ marginBottom: 8 }}>
          {recents.map((c) => (
            <Tag.CheckableTag
              key={c.id}
              checked={target === c.id}
              onChange={() => setTarget(c.id)}
              data-testid="forward-chip"
            >
              {convLabel(c)}
            </Tag.CheckableTag>
          ))}
        </Flex>
      ) : null}

      {/* 会话列表（单选；empty 六态） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 264, overflowY: 'auto', marginBottom: 12 }}>
        {filtered.length === 0 ? (
          <Typography.Text type="secondary" style={{ textAlign: 'center', padding: '16px 0' }}>
            没有可转发的会话
          </Typography.Text>
        ) : (
          filtered.map((c) => {
            const active = target === c.id;
            return (
              <button
                key={c.id}
                type="button"
                data-testid="forward-item"
                onClick={() => setTarget(c.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  padding: '6px 10px',
                  borderRadius: token.borderRadius,
                  border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
                  background: active ? token.colorPrimaryBg : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span>{convLabel(c)}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {c.lastMsgDigest?.slice(0, 20) ?? ''}
                </Typography.Text>
              </button>
            );
          })
        )}
      </div>

      {/* 方式 radio：>1 条时出现（D03 §3.10） */}
      {msgIds.length > 1 ? (
        <Radio.Group
          value={mode}
          onChange={(e) => setMode(e.target.value as 'merge' | 'one_by_one')}
          style={{ marginBottom: 12 }}
        >
          <Radio value="merge" data-testid="forward-mode-merge">
            合并转发（≤30 条）
          </Radio>
          <Radio value="one_by_one" data-testid="forward-mode-one">
            逐条转发
          </Radio>
        </Radio.Group>
      ) : null}

      {/* 附言 ≤500（INT-IM-05；随首条发送，服务端同规则兜底） */}
      <Input.TextArea
        rows={2}
        maxLength={NOTE_MAX}
        showCount
        placeholder="附言（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        data-testid="forward-note"
      />

      {/* 错误/离线提示（error/offline 六态） */}
      {errorText ? (
        <Alert type="error" showIcon message={errorText} data-testid="forward-error" style={{ marginTop: 12 }} />
      ) : offline ? (
        <Alert type="warning" showIcon message="离线中，暂不能转发" style={{ marginTop: 12 }} />
      ) : null}
    </Modal>
  );
}
