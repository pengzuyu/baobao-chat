/**
 * 维度浏览页（D24）：/kb/s/:spaceId——目录（专栏）面包屑逐层进入 + 文章列表。
 * 旧 KbPage 的空间浏览区重写：去上传/去授权/去摄入任务面板（页面无写入 UI 拍板），
 * 加浏览量列；目录树以路径栈手风琴实现（逐层 fetchNodes 懒加载——接通现状 UI 未接的 parent_id）。
 * D26-O1 补充轮：面包屑→antd Breadcrumb、目录卡→Card、文章列表→List、
 * 新建目录→Space.Compact+Input/Button（kb-browse-page 族自研样式退役，布局内联+token）。
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Breadcrumb, Card, Flex, Input, List, Space, Typography, theme } from 'antd';
import { ChevronRight, Eye, Folder, RotateCcw } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useCreateDir, useNodes, useSpaces } from '../api/hooks';
import { StateView } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { formatListTime } from '../../../shared/utils/time';

interface DirCrumb {
  id: string;
  name: string;
}

export function SpaceBrowsePage() {
  const { token } = theme.useToken();
  const { spaceId = '' } = useParams();
  const navigate = useNavigate();
  const spaces = useSpaces('all');
  const space = spaces.data?.find((s) => s.id === spaceId);
  const spaceName = space ? (space.space_type === 'personal' ? '我的文章' : space.name) : '知识库';

  const [dirStack, setDirStack] = useState<DirCrumb[]>([]);
  const parentId = dirStack.length > 0 ? dirStack[dirStack.length - 1].id : '';
  const nodes = useNodes(spaceId, parentId);
  const createDir = useCreateDir(spaceId, parentId);

  const [newDir, setNewDir] = useState('');
  const [dirErr, setDirErr] = useState('');
  const [creating, setCreating] = useState(false);

  const submitDir = async () => {
    const name = newDir.trim();
    if (!name) return;
    setDirErr('');
    setCreating(true);
    try {
      const n = await createDir.mutateAsync(name);
      setDirStack((s) => [...s, { id: n.id, name: n.name }]);
      setNewDir('');
    } catch (e) {
      setDirErr(errText(e)); // 7014 同名内联提示
    } finally {
      setCreating(false);
    }
  };

  const docs = nodes.data?.docs ?? [];
  const dirs = nodes.data?.dirs ?? [];
  const state: 'loading' | 'error' | 'ok' = spaces.isPending || nodes.isPending
    ? 'loading'
    : spaces.isError || nodes.isError
      ? 'error'
      : 'ok';

  // 面包屑：维度根 + 已进入目录栈（末位=当前层，非链接加粗）
  const crumbItems = [
    dirStack.length === 0
      ? { title: <Typography.Text strong>{spaceName}</Typography.Text> }
      : { title: <Typography.Link onClick={() => setDirStack([])}>{spaceName}</Typography.Link> },
    ...dirStack.map((d, i) =>
      i === dirStack.length - 1
        ? { title: <Typography.Text strong>{d.name}</Typography.Text> }
        : { title: <Typography.Link onClick={() => setDirStack((s) => s.slice(0, i + 1))}>{d.name}</Typography.Link> },
    ),
  ];

  return (
    <div data-testid="kb-browse-page" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '12px 20px 20px', gap: 10 }}>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap">
        <Breadcrumb items={crumbItems} separator={<ChevronRight size={13} />} />
        <Flex align="center" gap={10} wrap="wrap">
          {dirStack.length > 0 ? (
            <Button variant="text" size="small" icon={<RotateCcw size={13} />} onClick={() => setDirStack((s) => s.slice(0, -1))}>
              上一级
            </Button>
          ) : null}
          <Space.Compact>
            <Input
              size="small"
              placeholder="新建专栏目录"
              value={newDir}
              style={{ width: 160 }}
              onChange={(e) => setNewDir(e.target.value)}
              onPressEnter={() => void submitDir()}
            />
            <Button size="small" loading={creating} disabled={!newDir.trim()} onClick={() => void submitDir()}>
              创建
            </Button>
          </Space.Compact>
          {dirErr ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {dirErr}
            </Typography.Text>
          ) : null}
        </Flex>
      </Flex>

      <StateView
        state={state}
        skeleton={<SkeletonList count={6} />}
        error={spaces.error ?? nodes.error}
        onRetry={() => {
          void spaces.refetch();
          void nodes.refetch();
        }}
      >
        <Flex vertical gap={12} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {dirs.length > 0 ? (
            <Flex wrap="wrap" gap={8}>
              {dirs.map((d) => (
                <Card
                  key={d.id}
                  size="small"
                  hoverable
                  style={{ cursor: 'pointer', borderRadius: 10 }}
                  onClick={() => setDirStack((s) => [...s, { id: d.id, name: d.name }])}
                >
                  <Space size={8}>
                    <Folder size={16} style={{ color: token.colorWarning, verticalAlign: -3 }} />
                    <span style={{ fontSize: 13 }}>{d.name}</span>
                    <ChevronRight size={14} style={{ color: token.colorTextQuaternary, verticalAlign: -2 }} />
                  </Space>
                </Card>
              ))}
            </Flex>
          ) : null}

          {docs.length > 0 ? (
            <List
              bordered
              style={{ borderRadius: 10, overflow: 'hidden' }}
              dataSource={docs}
              rowKey="id"
              renderItem={(doc) => (
                <List.Item
                  data-testid="kb-browse-doc"
                  style={{ padding: '10px 14px', cursor: 'pointer' }}
                  onClick={() => navigate(`/kb/d/${doc.id}`)}
                >
                  <Flex justify="space-between" align="center" gap={12} style={{ width: '100%', minWidth: 0 }}>
                    <Typography.Text ellipsis style={{ minWidth: 0 }}>
                      {doc.title}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                      <Eye size={12} style={{ verticalAlign: -1 }} /> {doc.view_count ?? 0} · {formatListTime(doc.updated_at)}
                    </Typography.Text>
                  </Flex>
                </List.Item>
              )}
            />
          ) : dirs.length === 0 ? (
            <StateView
              state="empty"
              emptyText={dirStack.length > 0 ? '目录为空' : '还没有文章——让 AI 把会话结论沉淀进知识库'}
            />
          ) : null}
        </Flex>
      </StateView>
    </div>
  );
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('7014')) return '同级已有同名目录';
  return msg;
}
