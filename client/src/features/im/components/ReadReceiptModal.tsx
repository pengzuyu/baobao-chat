/**
 * 已读回执面板（API-IM-06）：消息尾标点击弹出，已读/未读两 tab 成员名单。
 * 拉取时机=打开时（名单为查询时点快照，不订阅增量——面板短生命周期）。
 * D26-O5：自研 receipt-modal 壳退役，antd Modal 化；已读/未读 tab→antd Tabs，
 * 名单行内联化、空态→Text secondary、错误→Alert。
 */

import { useEffect, useState } from 'react';
import { Alert, Flex, Modal, Tabs, Typography } from 'antd';
import { Check } from 'lucide-react';
import { getErrorText } from '../../../shared/api/http';
import { Avatar } from '../../../shared/ui/Avatar';
import { fetchReceiptPanel, type ReceiptPanel } from '../api/im';

interface ReadReceiptModalProps {
  convId: string;
  seq: number;
  onClose: () => void;
}

export function ReadReceiptModal({ convId, seq, onClose }: ReadReceiptModalProps) {
  const [tab, setTab] = useState<'read' | 'unread'>('read');
  const [rows, setRows] = useState<ReceiptPanel | null>(null);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    let alive = true;
    setRows(null);
    setErrorText('');
    fetchReceiptPanel(convId, seq)
      .then((r) => alive && setRows(r))
      .catch((err) => alive && setErrorText(getErrorText((err as { code?: number }).code ?? 9004)));
    return () => {
      alive = false;
    };
  }, [convId, seq]);

  const list = rows ? (tab === 'read' ? rows.read : rows.unread) : [];

  return (
    <Modal
      open
      title="消息已读情况"
      width={420}
      onCancel={onClose}
      destroyOnClose
      footer={null}
      data-testid="receipt-modal"
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'read' | 'unread')}
        items={[
          { key: 'read', label: `已读 ${rows ? rows.readCount : '…'}` },
          { key: 'unread', label: `未读 ${rows ? rows.unreadCount : '…'}` },
        ]}
      />
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        {errorText ? <Alert type="error" showIcon message={errorText} /> : null}
        {!errorText && !rows ? (
          <Typography.Text type="secondary" style={{ display: 'block', padding: '12px 0' }}>
            加载中…
          </Typography.Text>
        ) : null}
        {!errorText && rows?.truncated ? (
          /* 大群仅计数（OQ-B04）：>200 人群不展开名单 */
          <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', padding: '12px 0' }}>
            已读 {rows.readCount} 人 · 未读 {rows.unreadCount} 人
            <br />
            超过 200 人的群不展示已读明细
          </Typography.Text>
        ) : null}
        {!errorText && rows && !rows.truncated && list.length === 0 ? (
          <Typography.Text type="secondary" style={{ display: 'block', padding: '12px 0' }}>
            {tab === 'read' ? '暂无已读' : '全部已读 🎉'}
          </Typography.Text>
        ) : null}
        {list.map((m) => (
          <Flex key={m.uid} align="center" gap={8} style={{ padding: '6px 0' }}>
            <Avatar name={m.displayName} size={24} />
            <span style={{ flex: 1 }}>{m.displayName}</span>
            {tab === 'read' ? <Check size={14} /> : null}
          </Flex>
        ))}
      </div>
    </Modal>
  );
}
