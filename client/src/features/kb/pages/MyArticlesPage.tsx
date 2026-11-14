/**
 * 我的文章页（D24）：/kb/my——概览卡数字的落点；两维度分组（公司知识库/我的文章）
 * 列出我写的全部文章（含浏览量）；无编辑操作（写入只留 API 给 AI 拍板）。
 * D26-O1 补充轮：分组→antd Card+Tag+List（kb-my 族自研样式退役，布局内联）。
 */

import { useNavigate } from 'react-router-dom';
import { Card, Flex, List, Space, Tag, Typography } from 'antd';
import { Eye } from 'lucide-react';
import { useMyDocs } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';
import type { KbDoc } from '../model/types';

export function MyArticlesPage() {
  const navigate = useNavigate();
  const mine = useMyDocs();

  const docs = mine.data?.items ?? [];
  const company = docs.filter((d) => d.space_type !== 'personal');
  const personal = docs.filter((d) => d.space_type === 'personal');

  return (
    <div
      data-testid="kb-my"
      style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: '16px 24px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <StateView
        state={mine.isPending ? 'loading' : mine.isError ? 'error' : docs.length === 0 ? 'empty' : 'ok'}
        skeleton={<SkeletonList count={6} />}
        error={mine.error}
        onRetry={() => void mine.refetch()}
        emptyText="还没有文章——让 AI 帮你把会话结论沉淀进知识库"
      >
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <Section title="公司知识库" docs={company} badge="company" navigate={navigate} />
          <Section title="我的文章" docs={personal} badge="personal" navigate={navigate} />
        </Space>
      </StateView>
    </div>
  );
}

function Section(props: {
  title: string;
  docs: KbDoc[];
  badge: 'company' | 'personal';
  navigate: (to: string) => void;
}) {
  if (props.docs.length === 0) return null;
  return (
    <Card
      size="small"
      style={{ borderRadius: 10 }}
      title={
        <Space size={8}>
          {props.badge === 'company' ? <Tag style={{ marginInlineEnd: 0 }}>公司</Tag> : <Tag color="purple" style={{ marginInlineEnd: 0 }}>个人</Tag>}
          {props.title}
        </Space>
      }
      extra={
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {props.docs.length} 篇
        </Typography.Text>
      }
    >
      <List
        dataSource={props.docs}
        rowKey="id"
        renderItem={(d) => (
          <List.Item style={{ padding: '10px 14px', cursor: 'pointer' }} onClick={() => props.navigate(`/kb/d/${d.id}`)}>
            <Flex justify="space-between" align="center" gap={12} style={{ width: '100%', minWidth: 0 }}>
              <Typography.Text ellipsis style={{ minWidth: 0 }}>
                {d.title}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                <Eye size={12} style={{ verticalAlign: -1 }} /> {d.view_count ?? 0} · {formatListTime(d.updated_at)}
              </Typography.Text>
            </Flex>
          </List.Item>
        )}
      />
    </Card>
  );
}
