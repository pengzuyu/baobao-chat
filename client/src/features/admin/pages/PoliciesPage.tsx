/**
 * PAD-09 策略中心（D10 阶段一务实版，路由 /admin/policies）两 tab：
 * - Agent 工具策略：行级编辑（D7：agent_tool_policy upsert/删行回落默认）+ 合成快照 JSON
 * - 敏感词库：分页列表 + 新增（word/category）+ 删除；写后消息域 3005 即时生效
 * - 六态：两 tab 独立 loading/empty/error；offline 只读（禁写）；forbidden 2003；
 *   degraded（新增冲突 9001 等写失败行内提示）
 * D26-O2：Tabs/Switch/Input/Table/Tag/Alert 化；补充轮：策略行→List、面板→Card（admin-policy/admin-panel 退役）。
 */

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Flex, Input, List, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Bot, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiError, errText as apiErrText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonBlock, SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { useAddWord, useAgentPolicy, useDeleteWord, useWords } from '../api/hooks';
import { deleteAgentToolPolicy, updateAgentToolPolicy } from '../api/admin';

export function PoliciesPage() {
  return (
    <div>
      <Flex align="center" gap={8} style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          策略中心
        </Typography.Title>
        <Typography.Text type="secondary">Agent 域只读快照 · 敏感词库读写（写后即时生效）</Typography.Text>
      </Flex>
      <Tabs
        defaultActiveKey="agent"
        items={[
          {
            key: 'agent',
            label: (
              <span>
                <Bot size={14} /> Agent 工具策略
              </span>
            ),
            children: <AgentPolicyPanel />,
          },
          {
            key: 'words',
            label: (
              <span>
                <ShieldAlert size={14} /> 敏感词库
              </span>
            ),
            children: <WordsPanel />,
          },
        ]}
      />
    </div>
  );
}

/** 默认内置工具集（09 §5.2 defaultAgentPolicy 口径；编辑器首屏四行） */
const BUILTIN_SUBJECTS: Array<{ subject: string; label: string; defAllowed: boolean }> = [
  { subject: 'fs_read', label: '文件读取（fs_read）', defAllowed: true },
  { subject: 'fs_write', label: '文件写入（fs_write）', defAllowed: true },
  { subject: 'shell_exec', label: '命令执行（shell_exec）', defAllowed: false },
  { subject: 'http_fetch', label: '外网请求（http_fetch）', defAllowed: false },
];

/** Agent 工具策略面板（D7：行级编辑 + 快照 JSON） */
function AgentPolicyPanel() {
  const query = useAgentPolicy();
  const connStatus = useConnectionStore((s) => s.status);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [errText, setErrText] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const [showJson, setShowJson] = useState(false);

  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : connStatus === 'offline'
        ? 'offline'
        : 'ok';

  const rows = query.data?.rows ?? [];
  const rowOf = (subject: string) => rows.find((r) => r.subject === subject);
  const extraRows = rows.filter((r) => !BUILTIN_SUBJECTS.some((b) => b.subject === r.subject));

  const apply = (p: Promise<unknown>, key: string) => {
    setBusy(key);
    setErrText('');
    void p
      .then(() => qc.invalidateQueries({ queryKey: ['admin', 'policy', 'agent'] }))
      .catch((e) => setErrText(apiErrText(e, '操作失败')))
      .finally(() => setBusy(null));
  };

  const toggle = (subject: string, defAllowed: boolean) => {
    const cur = rowOf(subject);
    const next = cur ? !cur.allowed : !defAllowed; // 无行=默认态 → 切为反向（落表）
    apply(updateAgentToolPolicy({ subject, allowed: next }), subject);
  };

  const addSubject = () => {
    const s = newSubject.trim();
    if (!s) return;
    apply(updateAgentToolPolicy({ subject: s, allowed: true }), s);
    setNewSubject('');
  };

  /** 行统一结构：label + 标注 + Switch + （已覆盖时）恢复默认 */
  const policyItems: Array<{ key: string; label: ReactNode; tag?: ReactNode; switchNode: ReactNode; reset?: boolean }> = [
    ...BUILTIN_SUBJECTS.map((b) => {
      const row = rowOf(b.subject);
      return {
        key: b.subject,
        label: b.label,
        tag: row ? <Tag>已覆盖</Tag> : undefined,
        // 内置四行默认基线不同（fs 默认允许、shell 默认禁用）
        switchNode: (
          <Switch
            checked={row ? row.allowed : b.defAllowed}
            checkedChildren="允许"
            unCheckedChildren="禁用"
            loading={busy === b.subject}
            disabled={connStatus === 'offline'}
            onChange={() => toggle(b.subject, b.defAllowed)}
            data-testid={`admin-policy-toggle-${b.subject}`}
          />
        ),
        reset: !!row,
      };
    }),
    ...extraRows.map((r) => ({
      key: r.subject,
      label: r.subject,
      tag: <Tag>自定义</Tag>,
      switchNode: (
        <Switch
          checked={r.allowed}
          checkedChildren="允许"
          unCheckedChildren="禁用"
          loading={busy === r.subject}
          onChange={() => toggle(r.subject, true)}
          data-testid={`admin-policy-toggle-${r.subject}`}
        />
      ),
      reset: true,
    })),
  ];

  return (
    <StateView
      state={state}
      skeleton={<SkeletonBlock height={320} />}
      emptyText="策略快照为空"
      error={query.error}
      onRetry={() => void query.refetch()}
      forbiddenText="需要 admin:policy:manage 权限"
    >
      <Card
        size="small"
        data-testid="admin-agent-policy-editor"
        title={
          <Space size={8}>
            agent_tool_policy
            <Tag>{query.data?.source === 'table' ? '表数据' : '默认策略'}</Tag>
            <Typography.Text type="secondary">
              version {query.data?.version} · {query.data ? new Date(query.data.updated_at).toLocaleString('zh-CN') : ''}
            </Typography.Text>
          </Space>
        }
        extra={
          <Button variant="secondary" size="small" onClick={() => setShowJson((v) => !v)} data-testid="admin-policy-json-toggle">
            {showJson ? '收起快照 JSON' : '查看快照 JSON'}
          </Button>
        }
      >
        {errText ? <Alert type="error" showIcon message={errText} data-testid="admin-policy-error" style={{ marginBottom: 8 }} /> : null}

        <List
          size="small"
          split
          dataSource={policyItems}
          renderItem={(item) => (
            <List.Item
              data-testid={`admin-policy-row-${item.key}`}
              actions={[
                item.switchNode,
                ...(item.reset
                  ? [
                      <Button
                        key="reset"
                        variant="secondary"
                        size="small"
                        disabled={busy === item.key}
                        onClick={() => apply(deleteAgentToolPolicy(item.key), item.key)}
                        title="删行回落默认"
                      >
                        恢复默认
                      </Button>,
                    ]
                  : []),
              ]}
            >
              <Space size={8}>
                {item.label}
                {item.tag}
              </Space>
            </List.Item>
          )}
        />

        <Space size={8} wrap style={{ marginTop: 12 }}>
          <Input
            placeholder="自定义 subject（如 app:crm:*）"
            style={{ width: 280 }}
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            onPressEnter={addSubject}
            data-testid="admin-policy-new-subject"
          />
          <Button onClick={addSubject} loading={!!newSubject.trim() && busy === newSubject.trim()} data-testid="admin-policy-add-btn">
            添加授权行
          </Button>
        </Space>

        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          判定链（09 §4）：租户策略(本表) → 用户权限点 → 模式×工具矩阵 → 三级记忆 → untrusted 强制确认。
          热更事件 agent.policy.updated 与 bbrt 工具门面下发随 Agent 域阶段二接线。
        </Typography.Paragraph>

        {showJson ? (
          <pre data-testid="admin-agent-policy-json" style={{ margin: '12px 0 0' }}>
            {JSON.stringify(query.data?.policy ?? {}, null, 2)}
          </pre>
        ) : null}
      </Card>
    </StateView>
  );
}

/** 敏感词库面板（CRUD） */
function WordsPanel() {
  const query = useWords();
  const add = useAddWord();
  const del = useDeleteWord();
  const connStatus = useConnectionStore((s) => s.status);

  const [word, setWord] = useState('');
  const [category, setCategory] = useState('');
  const [formError, setFormError] = useState('');

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : items.length === 0
        ? 'empty'
        : connStatus === 'offline'
          ? 'offline'
          : 'ok';

  const submit = () => {
    const w = word.trim();
    if (!w) {
      setFormError('敏感词不能为空');
      return;
    }
    setFormError('');
    add.mutate(
      { word: w, category: category.trim() || undefined },
      {
        onSuccess: () => setWord(''),
        onError: (err) => setFormError(apiErrText(err, '新增失败')),
      },
    );
  };

  const columns: ColumnsType<(typeof items)[number]> = [
    { title: '词', dataIndex: 'word', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '分类', dataIndex: 'category', render: (v: string) => v || '—' },
    { title: '模式', dataIndex: 'mode', width: 90, render: (v: number) => (v === 1 ? '拦截' : v === 2 ? '替换' : '审计') },
    { title: '添加时间', dataIndex: 'created_at', width: 180, render: (v: number) => new Date(v).toLocaleString('zh-CN') },
    {
      title: '操作',
      key: 'ops',
      width: 100,
      render: (_, w) => (
        <Button variant="danger" size="small" loading={del.isPending && del.variables === w.id} onClick={() => del.mutate(w.id)}>
          <Trash2 size={13} /> 删除
        </Button>
      ),
    },
  ];

  return (
    <>
      {/* 新增表单恒渲染（空库时也能加首词——不随列表六态隐藏） */}
      <Space size={8} wrap style={{ marginBottom: 8 }}>
        <Input
          placeholder="新增敏感词（≤64 字，Enter 提交）"
          style={{ width: 240 }}
          value={word}
          onChange={(e) => setWord(e.target.value)}
          onPressEnter={submit}
          data-testid="admin-word-input"
        />
        <Input placeholder="分类（可选）" style={{ width: 160 }} value={category} onChange={(e) => setCategory(e.target.value)} />
        <Button onClick={submit} loading={add.isPending}>
          <Plus size={13} /> 新增
        </Button>
      </Space>
      {formError ? (
        <Alert type="error" showIcon message={formError} data-testid="admin-word-error" style={{ marginBottom: 8 }} />
      ) : null}
      <StateView
        state={state}
        skeleton={<SkeletonList count={6} />}
        emptyText="词库为空（上方输入新增首词）"
        error={query.error}
        onRetry={() => void query.refetch()}
        forbiddenText="需要 admin:policy:manage 权限"
        offlineText="离线中：词库只读，新增/删除暂不可用"
      >
        <Card size="small" title={<Space size={8}>敏感词库<Typography.Text type="secondary">共 {query.data?.pages[0]?.total ?? 0} 条 · mode=拦截（3005）· 写后消息域即时生效</Typography.Text></Space>}>
          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            data-testid="admin-words-table"
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
          />
          {lastPage?.has_more && lastPage.next_cursor ? (
            <Flex justify="center" style={{ marginTop: 8 }}>
              <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                加载更多
              </Button>
            </Flex>
          ) : null}
        </Card>
      </StateView>
    </>
  );
}
