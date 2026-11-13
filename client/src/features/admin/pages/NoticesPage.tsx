/**
 * 公告发布（D10 PAD-15）：发布表单（标题/正文，全员通知中心触达）+ 历史列表
 * （触达快照 reach）。发布通道=kind=announcement 系统公告分组（PIM-09 既有）。
 * D26-O2：Input/Input.TextArea/Button/Alert 化；补充轮：表单→Form、历史→List（admin-notice 退役）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Flex, Form, Input, List, Space, Tag, Typography } from 'antd';
import { Megaphone } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { fetchNotices, publishNotice, type AdminNotice } from '../api/admin';

export function NoticesPage() {
  const [items, setItems] = useState<AdminNotice[] | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchNotices({ limit: 50 });
      setItems(page.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const publish = async () => {
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      await publishNotice(title.trim(), content.trim());
      setTitle('');
      setContent('');
      setOk(true);
      await reload();
    } catch (e) {
      setError(errText(e, '发布失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="admin-notices">
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          公告发布
        </Typography.Title>
      </Flex>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {ok ? <Alert type="success" showIcon message="已发布并广播全员通知中心" style={{ marginBottom: 8 }} /> : null}

      <Form layout="vertical" style={{ maxWidth: 720 }}>
        <Form.Item label="标题">
          <Input
            placeholder="标题（≤100 字）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="notice-title-input"
          />
        </Form.Item>
        <Form.Item label="正文">
          <Input.TextArea
            autoSize={{ minRows: 5, maxRows: 12 }}
            placeholder="正文（≤4000 字；全员将通过通知中心「系统公告」分组收到）"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            data-testid="notice-content-input"
          />
        </Form.Item>
        <Button
          loading={busy}
          disabled={!title.trim() || !content.trim()}
          onClick={() => void publish()}
          data-testid="notice-publish-btn"
        >
          <Megaphone size={14} /> {busy ? '发布中…' : '发布并广播'}
        </Button>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        历史公告
      </Typography.Title>
      {items === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : items.length === 0 ? (
        <Typography.Text type="secondary">暂无公告</Typography.Text>
      ) : (
        <List
          dataSource={items}
          renderItem={(n) => (
            <List.Item data-testid="notice-item">
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Flex gap={8} align="center" wrap>
                  <Typography.Text strong>{n.title}</Typography.Text>
                  <Tag title="发布时全员触达快照">触达 {n.reach}</Tag>
                  <Typography.Text type="secondary">{new Date(n.created_at).toLocaleString()}</Typography.Text>
                </Flex>
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {n.content}
                </Typography.Paragraph>
              </Space>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
