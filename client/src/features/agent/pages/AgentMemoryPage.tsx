/**
 * PAG-11 三级记忆管理页（/agent/memory，D08 §3.11 / D15 §2.1；D19 增作用域）：
 * - 作用域页签：用户记忆（全局）/ 项目记忆（按项目分区选择）
 * - 知识记忆条目列表：标题 / type 徽标 / 钩子摘要 / updated_at / 来源会话
 * - 类型筛选四类：用户偏好 user / 项目事实 project / 工作反馈 feedback / 外部参考 reference
 * - 撤销（删除）即时生效；空态分"全库空"与"该类型无条目"
 * - 六态：loading/empty/error/offline（mock 桥本地无网照常）；forbidden 不适用（本域无独立权限点，准入由 /agent 页面统一）
 * D26-O4：作用域/类型页签→Segmented、项目选择→Select、条目→List（agent-mem-*
 * /agent-filter-* 自研样式退役）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Flex, List, Segmented, Select, Space, Tag, Typography } from 'antd';
import { Trash2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView, type ViewState } from '../../../shared/ui/StateView';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAgentStore } from '../store/agent';
import { MEMORY_TYPE_LABELS } from '../bridge/types';
import type { MemoryType } from '../bridge/types';
import { AgentSubNav } from '../components/AgentSubNav';

type Filter = 'all' | MemoryType;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'user', label: '用户偏好' },
  { value: 'project', label: '项目事实' },
  { value: 'feedback', label: '工作反馈' },
  { value: 'reference', label: '外部参考' },
];

/** 记忆类型徽标色（原 agent-mem-chip--* 四色口径） */
function memChipColor(type: MemoryType): string | undefined {
  if (type === 'user') return 'blue';
  if (type === 'project') return 'green';
  if (type === 'feedback') return 'gold';
  return undefined;
}

function formatDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function AgentMemoryPage() {
  const init = useAgentStore((s) => s.init);
  const memories = useAgentStore((s) => s.memories);
  const loading = useAgentStore((s) => s.memoriesLoading);
  const error = useAgentStore((s) => s.memoriesError);
  const deleteMemory = useAgentStore((s) => s.deleteMemory);
  const forgetMemory = useAgentStore((s) => s.forgetMemory);
  const sessions = useAgentStore((s) => s.sessions);
  // D19 作用域视图（用户记忆 / 项目记忆+项目选择）
  const memoryScope = useAgentStore((s) => s.memoryScope);
  const memoryWorkspacePath = useAgentStore((s) => s.memoryWorkspacePath);
  const loadMemories = useAgentStore((s) => s.loadMemories);
  const workspaces = useAgentStore((s) => s.workspaces);

  const [filter, setFilter] = useState<Filter>('all');

  /** 项目页签缺省选第一个项目（记忆页直达时兜底） */
  useEffect(() => {
    if (memoryScope === 'project' && !memoryWorkspacePath && workspaces.length > 0) {
      void loadMemories('project', workspaces[0].path);
    }
  }, [memoryScope, memoryWorkspacePath, workspaces, loadMemories]);

  // 页面直达也确保装载（工作台可能未访问过；init 内部有 ready 守卫）
  useEffect(() => {
    void init();
  }, [init]);

  const connStatus = useConnectionStore((s) => s.status);
  const degradedText = useConnectionStore((s) => s.degradedText);

  const filtered = useMemo(() => (filter === 'all' ? memories : memories.filter((m) => m.type === filter)), [memories, filter]);

  const state: ViewState | 'ok' = loading
    ? 'loading'
    : error
      ? 'error'
      : memories.length === 0
        ? 'empty'
        : filtered.length === 0
          ? 'empty'
          : degradedText
            ? 'degraded'
            : connStatus === 'offline'
              ? 'offline'
              : 'ok';

  const listNode = (
    <List
      size="small"
      dataSource={filtered}
      renderItem={(m) => {
        const source = sessions.find((s) => s.id === m.sessionId);
        // D23：globalType 携带=公共层 USER.md 条目——chip 用十类标签、撤销走 forget
        const isGlobal = Boolean(m.globalType);
        return (
          <List.Item
            data-memory-name={m.name}
            actions={[
              <Button
                key="revoke"
                variant="secondary"
                size="small"
                icon={<Trash2 size={12} aria-hidden />}
                onClick={() =>
                  isGlobal
                    ? void forgetMemory(m.globalType ?? '', m.title)
                    : void deleteMemory(m.name, memoryScope, memoryWorkspacePath ?? undefined)
                }
                title={isGlobal ? '移除该公共记忆（条目粒度，即时生效）' : '撤销该记忆（删除后即时生效）'}
              >
                撤销
              </Button>,
            ]}
          >
            <div style={{ minWidth: 0 }}>
              <Space size={8} wrap>
                <Tag color={memChipColor(m.type)}>{m.globalType ?? MEMORY_TYPE_LABELS[m.type]}</Tag>
                {(m.scope ?? 'user') === 'project' ? (
                  <Tag color="blue" title={m.workspaceName}>
                    {workspaces.find((w) => (m.workspaceName ?? '').startsWith(`${w.name}-`))?.name ?? m.workspaceName ?? '项目'}
                  </Tag>
                ) : null}
                <Typography.Text strong ellipsis style={{ maxWidth: 420 }}>
                  {m.title}
                </Typography.Text>
              </Space>
              {m.hook && m.hook !== m.title ? (
                <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 13 }}>
                  {m.hook}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {m.updatedAt ? `更新 ${formatDay(m.updatedAt)}` : '公共层（USER.md 压实视图）'}
                {source ? ` · 来源会话「${source.title}」` : m.sessionId ? ` · ${m.sessionId}` : ''}
              </Typography.Text>
            </div>
          </List.Item>
        );
      }}
    />
  );

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <AgentSubNav />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: 860,
          width: '100%',
          margin: '0 auto',
        }}
      >
        <Flex align="flex-start" justify="space-between" gap={16}>
          <div>
            <Typography.Title level={5} style={{ margin: 0 }}>
              记忆管理
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0, fontSize: 13, maxWidth: 560 }}>
              Agent 主动沉淀的知识记忆（D15 主动轨）：会话中学到的用户偏好、项目事实、工作反馈与外部参考；撤销即时生效。
            </Typography.Paragraph>
          </div>
          <Tag style={{ flexShrink: 0 }}>共 {memories.length} 条</Tag>
        </Flex>
        {/* D19 作用域页签：用户记忆 / 项目记忆（+ 项目选择） */}
        <Space size={8} wrap>
          <Segmented
            value={memoryScope}
            onChange={(v) =>
              v === 'project'
                ? void loadMemories('project', memoryWorkspacePath ?? workspaces[0]?.path ?? null)
                : void loadMemories('user', null)
            }
            options={[
              { value: 'user', label: '用户记忆' },
              { value: 'project', label: '项目记忆' },
            ]}
          />
          {memoryScope === 'project' ? (
            <Select
              size="small"
              style={{ width: 200 }}
              placeholder="选择项目"
              aria-label="选择项目"
              value={memoryWorkspacePath || undefined}
              onChange={(v) => void loadMemories('project', v || null)}
              options={workspaces.map((w) => ({ value: w.path, label: w.name }))}
              notFoundContent="还没有登记的项目"
            />
          ) : null}
        </Space>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={FILTERS.map((f) => ({
            value: f.value,
            label: (
              <span>
                {f.label}{' '}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {f.value === 'all' ? memories.length : memories.filter((m) => m.type === f.value).length}
                </Typography.Text>
              </span>
            ),
          }))}
        />
        {state === 'ok' ? (
          listNode
        ) : (
          <StateView
            state={state}
            skeleton={<SkeletonList count={5} />}
            error={new Error(error ?? '记忆加载失败')}
            onRetry={() => void init()}
            emptyText={
              memories.length === 0
                ? memoryScope === 'project'
                  ? '该项目还没有项目记忆：在项目会话中让 Agent 记住约定与教训'
                  : '还没有用户记忆：在日常/任意会话中让 Agent「记住」偏好或事实'
                : `「${FILTERS.find((f) => f.value === filter)?.label}」类型暂无条目`
            }
            offlineText="离线中：记忆为本地数据，可正常查看与撤销"
            degradedText={degradedText ?? undefined}
          >
            {listNode}
          </StateView>
        )}
      </div>
    </div>
  );
}
