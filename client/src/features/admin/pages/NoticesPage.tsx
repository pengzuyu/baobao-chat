/**
 * 公告发布（D10 PAD-15）：发布表单（标题/正文，全员通知中心触达）+ 历史列表
 * （触达快照 reach）。发布通道=kind=announcement 系统公告分组（PIM-09 既有）。
 * D26-O2：Input/Input.TextArea/Button/Alert 化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Input, Tag } from 'antd';
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
    <div className="admin-page__section" data-testid="admin-notices">
      <div className="admin-page__head">
        <h2>公告发布</h2>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {ok ? <Alert type="success" showIcon message="已发布并广播全员通知中心" style={{ marginBottom: 8 }} /> : null}

      <div className="admin-notice__form">
        <Input
          placeholder="标题（≤100 字）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="notice-title-input"
        />
        <Input.TextArea
          autoSize={{ minRows: 5, maxRows: 12 }}
          placeholder="正文（≤4000 字；全员将通过通知中心「系统公告」分组收到）"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          data-testid="notice-content-input"
        />
        <Button
          loading={busy}
          disabled={!title.trim() || !content.trim()}
          onClick={() => void publish()}
          data-testid="notice-publish-btn"
        >
          <Megaphone size={14} /> {busy ? '发布中…' : '发布并广播'}
        </Button>
      </div>

      <div className="admin-notice__history">
        <h3>历史公告</h3>
        {items === null ? (
          <div className="admin-page__empty">加载中…</div>
        ) : items.length === 0 ? (
          <div className="admin-page__empty">暂无公告</div>
        ) : (
          items.map((n) => (
            <div className="admin-notice__item" key={n.id} data-testid="notice-item">
              <div className="admin-notice__item-head">
                <strong>{n.title}</strong>
                <Tag title="发布时全员触达快照">触达 {n.reach}</Tag>
              </div>
              <pre className="admin-notice__content">{n.content}</pre>
              <div className="admin-notice__ts">{new Date(n.created_at).toLocaleString()}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
