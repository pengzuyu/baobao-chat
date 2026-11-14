/**
 * PIM-06 入群审批卡（D03 §3.6）：
 * 嵌入系统消息流内（kind=apply.submitted）——申请人（姓名）+ 申请理由 +
 * [同意][拒绝]（仅 owner/admin 可见按钮；member 视角只见文案）。
 * 终态回显：已通过 / 已拒绝 / 已过期（7 天未处理）。
 * D26 antd 换装：Card+Flex+Tag+shared Button、错误→Alert（apply-card 自研类退役）。
 */

import { useEffect, useState } from 'react';
import { Alert, Card, Flex, Space, Tag, Typography } from 'antd';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { getErrorText } from '../../../shared/api/http';
import { handleApply } from '../api/im';
import type { MemberRole, SystemBody } from '../model/types';

interface ApplyCardProps {
  body: SystemBody;
  /** 申请提交时间（消息 ts；7 天未处理过期，D03 §3.6） */
  submittedAt: number;
  /** 我的会话角色（按钮显隐：owner/admin） */
  myRole?: MemberRole;
  /** 审批终态（store.handledApplies） */
  handled?: 'approved' | 'rejected';
  onHandled: (applyId: string, result: 'approved' | 'rejected') => void;
}

/** 申请待审时长（7 天，与服务端懒过期对齐，D03 §3.6） */
const APPLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function ApplyCard({ body, submittedAt, myRole, handled, onHandled }: ApplyCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // 过期判定（分钟级刷新；服务端懒判同步兜底）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!body.apply_id) return null;
  const canHandle = myRole === 1 || myRole === 2;
  const expired = !handled && now - submittedAt > APPLY_TTL_MS;

  const submit = (action: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    handleApply(body.apply_id as string, action)
      .then(() => onHandled(body.apply_id as string, action === 'approve' ? 'approved' : 'rejected'))
      .catch((e: { code?: number }) => setError(e?.code ?? 9004))
      .finally(() => setBusy(false));
  };

  const statusLine = handled
    ? handled === 'approved'
      ? '已通过'
      : '已拒绝'
    : expired
      ? '已过期'
      : null;

  return (
    <Card
      size="small"
      data-apply-id={body.apply_id}
      style={{ width: 'min(480px, 84%)', margin: '4px auto' }}
      styles={{ body: { padding: '10px 12px' } }}
    >
      <Flex align="center" gap={8} wrap="wrap">
        <Avatar name={body.actor_name || body.actor || '申请人'} size={24} />
        <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13 }}>
            <strong>{body.actor_name || body.actor}</strong> 申请加入群聊
          </span>
          {body.extra ? (
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
              {body.extra}
            </Typography.Text>
          ) : null}
          {error ? (
            <Alert type="error" showIcon style={{ marginTop: 4 }} message={getErrorText(error)} />
          ) : null}
        </Flex>
        {statusLine ? (
          <Tag
            color={handled === 'approved' ? 'success' : handled === 'rejected' ? 'error' : 'default'}
            style={{ marginInlineEnd: 0, flexShrink: 0 }}
          >
            {statusLine}
          </Tag>
        ) : canHandle ? (
          <Space size={6} style={{ flexShrink: 0 }}>
            <Button variant="secondary" size="small" disabled={busy} onClick={() => submit('reject')}>
              拒绝
            </Button>
            <Button size="small" disabled={busy} onClick={() => submit('approve')}>
              同意
            </Button>
          </Space>
        ) : null}
      </Flex>
    </Card>
  );
}
