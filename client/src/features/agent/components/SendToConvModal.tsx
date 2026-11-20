/**
 * 工作台「发送到聊天」目标选择弹窗（2026-11-20）：
 * 把工作台某回合的最终回答以**纯文本消息**（拍板口径：只发结论不带过程）发到
 * 选定私聊/群聊——走 im store sendText 全链（乐观上屏+outbox 弱网重试+settle
 * 回填），对方与自己在 IM 里看到的都是一条普通文本消息，与手打一致；
 * 目标候选/搜索/最近 chip 照 ForwardModal 同款口径（status=1、广播群非
 * publisher 隐藏）；工作台打开时 IM convs 可能未加载 → 挂载即拉一次补投。
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Flex, Input, Modal, Tag, Typography, message, theme } from 'antd';
import { Send } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useConnectionStore } from '../../../shared/store/connection';
import { fetchConvs } from '../../im/api/im';
import { useImStore } from '../../im/store/im';
import type { Conversation } from '../../im/model/types';

/** 最近会话 chip 数量（ForwardModal 同款） */
const RECENT_CHIPS = 5;

interface SendToConvModalProps {
  /** 要发送的最终回答全文（markdown 源码，随文本消息原样发出） */
  answerText: string;
  onClose: () => void;
}

export function SendToConvModal({ answerText, onClose }: SendToConvModalProps) {
  const { token } = theme.useToken();
  const convs = useImStore((s) => s.convs);
  const [keyword, setKeyword] = useState('');
  const [target, setTarget] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const offline = useConnectionStore((s) => s.status) === 'offline';

  // 工作台打开时 IM 会话列表常未加载（ChatPage 未开过）——挂载补拉一次；
  // 已有数据不重拉（避免覆盖 WS 增量），失败静默置错误态（列表空+提示）
  useEffect(() => {
    if (useImStore.getState().convs.length > 0) return;
    void fetchConvs('all')
      .then((res) => useImStore.getState().setConvs(res.items))
      .catch(() => setLoadError(true));
  }, []);

  // 目标候选：active 会话；广播群前置隐藏（ForwardModal 同款 3013 口径）
  const candidates = useMemo(
    () => convs.filter((c) => c.status === 1 && !(c.type === 3 && c.myRole !== 4)),
    [convs],
  );
  const filtered = useMemo(() => {
    const kw = keyword.trim();
    if (!kw) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(kw.toLowerCase()));
  }, [candidates, keyword]);
  const recents = useMemo(
    () => [...candidates].sort((a, b) => (b.lastMsgTs ?? 0) - (a.lastMsgTs ?? 0)).slice(0, RECENT_CHIPS),
    [candidates],
  );

  const targetConv = candidates.find((c) => c.id === target);

  const doSend = async () => {
    if (!target || sending || offline) return;
    setSending(true);
    try {
      await useImStore.getState().sendText(target, answerText);
      message.success(`已发送到 ${targetConv?.name ?? '会话'}`);
      onClose();
    } catch {
      // sendText 内部 settle 已置 failed 红叹号（outbox 可重试），此处仅提示
      message.error('发送失败，可在聊天页重试');
      setSending(false);
    }
  };

  const convLabel = (c: Conversation) => (c.type === 1 ? c.name : `${c.name} (${c.memberCount})`);

  return (
    <Modal
      open
      title="发送到聊天"
      width={480}
      onCancel={onClose}
      destroyOnClose
      data-testid="send-to-conv-modal"
      footer={[
        <Button key="cancel" variant="secondary" disabled={sending} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="ok"
          loading={sending}
          disabled={!target || offline}
          onClick={() => void doSend()}
          data-testid="send-to-conv-send"
        >
          <Send size={14} />
          {sending ? '发送中…' : '发送'}
        </Button>,
      ]}
    >
      {/* 回答预览（两行截断——确认发的是什么再选目标） */}
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        style={{ marginBottom: 12, fontSize: 12 }}
      >
        {answerText}
      </Typography.Paragraph>

      {/* 搜索会话（ForwardModal 同款） */}
      <Input.Search
        placeholder="搜索会话"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onSearch={(v) => setKeyword(v)}
        allowClear
        data-testid="send-to-conv-search"
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
              data-testid="send-to-conv-chip"
            >
              {convLabel(c)}
            </Tag.CheckableTag>
          ))}
        </Flex>
      ) : null}

      {/* 会话列表（单选） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 264, overflowY: 'auto', marginBottom: 12 }}>
        {filtered.length === 0 ? (
          <Typography.Text type="secondary" style={{ textAlign: 'center', padding: '16px 0' }}>
            {loadError ? '会话列表加载失败，请重进本弹窗重试' : '没有可发送的会话'}
          </Typography.Text>
        ) : (
          filtered.map((c) => {
            const active = target === c.id;
            return (
              <button
                key={c.id}
                type="button"
                data-testid="send-to-conv-item"
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

      {/* 错误/离线提示（ForwardModal 六态口径同款收窄） */}
      {offline ? <Alert type="warning" showIcon message="离线中，暂不能发送" style={{ marginTop: 12 }} /> : null}
    </Modal>
  );
}
