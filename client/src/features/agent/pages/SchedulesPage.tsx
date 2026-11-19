/**
 * 定时任务页（D35 /agent/schedules）：用户自己的本地 Agent 定时任务。
 * - 三种互斥调度类型：cron（5 字段）/ 一次性 / 每个工作日 HH:mm
 * - 权限模式三档（ask/auto-edit/full-auto）；ask/auto-edit 需要审批时，
 *   任务停在会话里，用户在「历史 → 去审批」打开会话内嵌审批卡处理
 * - 任务/调度/历史全在本地（Tauri 壳），服务端只提供工作日日历的只读同步
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Drawer, Flex, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { listen } from '@tauri-apps/api/event';
import { CalendarClock, Play, RefreshCw } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { AgentSubNav } from '../components/AgentSubNav';
import { getAgentBridge } from '../bridge';
import {
  scheduleAvailable,
  scheduleCancelRun,
  scheduleCreate,
  scheduleDelete,
  scheduleList,
  scheduleRunNow,
  scheduleRuns,
  scheduleSetEnabled,
  scheduleSyncCalendar,
  scheduleUpdate,
  type ScheduleList,
  type ScheduleMode,
  type ScheduleRun,
  type ScheduleSpec,
  type ScheduleTask,
  type ScheduleTaskInput,
} from '../bridge/schedule';

const KIND_OPTIONS = [
  { value: 'cron', label: '周期（cron）' },
  { value: 'once', label: '一次性' },
  { value: 'workday', label: '每个工作日' },
] as const;

const CRON_PRESETS = [
  { value: '0 9 * * *', label: '每天 09:00' },
  { value: '30 9 * * 1-5', label: '工作日 09:30' },
  { value: '0 9 1 * *', label: '每月 1 日 09:00' },
  { value: '*/30 9-18 * * *', label: '工作时间每 30 分钟' },
];

const MODE_OPTIONS: { value: ScheduleMode; label: string; desc: string }[] = [
  { value: 'ask', label: '按需审批', desc: '每个受控操作都等你点允许；无人值守时任务会停在会话里' },
  { value: 'auto-edit', label: '自动编辑', desc: '文件改动/常规命令自动执行；高危操作等你审批' },
  { value: 'full-auto', label: '完全控制', desc: '全部自动执行不弹审批（适合固定确定的任务）' },
];

const RUN_STATUS: Record<string, { color?: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  waiting_approval: { color: 'warning', text: '等待审批' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  missed: { text: '已跳过' },
  expired: { text: '已过期' },
};

function fmt(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describe(s: ScheduleSpec): string {
  if (s.type === 'cron') return `周期 ${s.expr}`;
  if (s.type === 'once') return `一次性 ${fmt(s.at)}`;
  return `每个工作日 ${s.time}`;
}

function duration(run: ScheduleRun): string {
  if (!run.startedAt) return '—';
  const end = run.finishedAt ?? Date.now();
  const sec = Math.max(0, Math.round((end - run.startedAt) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
}

export function SchedulesPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleTask | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [kind, setKind] = useState<'cron' | 'once' | 'workday'>('cron');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [onceAt, setOnceAt] = useState(toLocalInput(Date.now() + 3600_000));
  const [workdayTime, setWorkdayTime] = useState('09:00');
  const [mode, setMode] = useState<ScheduleMode>('ask');
  const [approval, setApproval] = useState(1800);
  const [modelPolicy, setModelPolicy] = useState<'auto' | 'fast' | 'strong'>('auto');
  const [formError, setFormError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; path: string; name: string }[]>([]);

  const [historyTask, setHistoryTask] = useState<ScheduleTask | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const available = scheduleAvailable();

  const reload = useCallback(async () => {
    if (!available) return;
    try {
      setData(await scheduleList());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [available]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadRuns = useCallback(async (taskId: string) => {
    setRunsLoading(true);
    try {
      setRuns(await scheduleRuns(taskId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunsLoading(false);
    }
  }, []);

  // 壳事件 → 刷新（任务变更/运行状态变化）
  useEffect(() => {
    if (!available) return;
    let un: (() => void) | null = null;
    let disposed = false;
    void listen('schedule://event', () => {
      void reload();
      if (historyTask) void loadRuns(historyTask.id);
    }).then((off) => {
      if (disposed) off();
      else un = off;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [available, reload, loadRuns, historyTask]);

  // 首次进入静默同步日历（今年+明年；App 登录后也会同步，双保险）
  useEffect(() => {
    if (!available) return;
    const y = new Date().getFullYear();
    void Promise.all([scheduleSyncCalendar(y), scheduleSyncCalendar(y + 1)])
      .then(() => reload())
      .catch(() => {});
  }, [available, reload]);

  const openCreate = async () => {
    setEditing(null);
    setName('');
    setPrompt('');
    setWorkspace('');
    setKind('cron');
    setCronExpr('0 9 * * *');
    setOnceAt(toLocalInput(Date.now() + 3600_000));
    setWorkdayTime('09:00');
    setMode('ask');
    setApproval(1800);
    setModelPolicy('auto');
    setFormError(null);
    setDrawerOpen(true);
    try {
      const list = await getAgentBridge().listWorkspaces();
      setWorkspaces(list.map((w) => ({ id: w.id, path: w.path, name: w.name || w.path })));
    } catch {
      setWorkspaces([]);
    }
  };

  const openEdit = async (t: ScheduleTask) => {
    setEditing(t);
    setName(t.name);
    setPrompt(t.prompt);
    setWorkspace(t.workspace);
    setKind(t.schedule.type);
    if (t.schedule.type === 'cron') setCronExpr(t.schedule.expr);
    if (t.schedule.type === 'once') setOnceAt(toLocalInput(t.schedule.at));
    if (t.schedule.type === 'workday') setWorkdayTime(t.schedule.time);
    setMode(t.mode);
    setApproval(t.approvalTimeoutSecs);
    setModelPolicy(t.modelPolicy);
    setFormError(null);
    setDrawerOpen(true);
    try {
      const list = await getAgentBridge().listWorkspaces();
      setWorkspaces(list.map((w) => ({ id: w.id, path: w.path, name: w.name || w.path })));
    } catch {
      setWorkspaces([]);
    }
  };

  const buildInput = (): ScheduleTaskInput | null => {
    if (!name.trim()) {
      setFormError('请填写任务名称');
      return null;
    }
    if (!prompt.trim()) {
      setFormError('请填写提示词');
      return null;
    }
    let schedule: ScheduleSpec;
    if (kind === 'cron') {
      if (!cronExpr.trim()) {
        setFormError('请填写 cron 表达式');
        return null;
      }
      schedule = { type: 'cron', expr: cronExpr.trim() };
    } else if (kind === 'once') {
      const at = new Date(onceAt).getTime();
      if (!onceAt || Number.isNaN(at)) {
        setFormError('请选择一次性执行时间');
        return null;
      }
      if (at <= Date.now()) {
        setFormError('一次性执行时间需晚于当前时间');
        return null;
      }
      schedule = { type: 'once', at };
    } else {
      if (!/^\d{2}:\d{2}$/.test(workdayTime)) {
        setFormError('请选择工作日执行时间');
        return null;
      }
      schedule = { type: 'workday', time: workdayTime };
    }
    return {
      name: name.trim(),
      prompt: prompt.trim(),
      workspace,
      schedule,
      modelPolicy,
      model: null,
      mode,
      approvalTimeoutSecs: approval,
    };
  };

  const doSave = async () => {
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await scheduleUpdate(editing.id, input);
      else await scheduleCreate(input);
      setDrawerOpen(false);
      setNotice(editing ? '任务已更新' : '任务已创建');
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (mode === 'full-auto') {
      Modal.confirm({
        title: '启用「完全控制」模式？',
        content: '该任务的读写与命令会全部自动执行，不再弹审批。仅建议用于固定、确定的任务。',
        okText: '确认创建/保存',
        cancelText: '返回修改',
        onOk: () => void doSave(),
      });
      return;
    }
    void doSave();
  };

  const toggle = async (t: ScheduleTask, enabled: boolean) => {
    setBusy(true);
    try {
      await scheduleSetEnabled(t.id, enabled);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (t: ScheduleTask) => {
    Modal.confirm({
      title: `删除任务「${t.name}」？`,
      content: '任务定义和本地运行历史将一并删除，已创建的会话保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await scheduleDelete(t.id);
          setNotice('任务已删除');
          await reload();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    });
  };

  const runNow = async (t: ScheduleTask) => {
    setBusy(true);
    try {
      await scheduleRunNow(t.id);
      setNotice(`已触发「${t.name}」，去工作台查看会话`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const syncCalendar = async () => {
    setBusy(true);
    setError(null);
    try {
      const y = new Date().getFullYear();
      await scheduleSyncCalendar(y);
      await scheduleSyncCalendar(y + 1);
      setNotice('工作日日历已同步');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (t: ScheduleTask) => {
    setHistoryTask(t);
    await loadRuns(t.id);
  };

  const calendarCurrent = useMemo(
    () => data?.calendar.find((c) => c.year === new Date().getFullYear()),
    [data],
  );

  const columns: ColumnsType<ScheduleTask> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_: unknown, t) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{t.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.workspace || '日常对话'} · {t.mode}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '调度',
      dataIndex: 'schedule',
      render: (_: unknown, t) => <Typography.Text>{describe(t.schedule)}</Typography.Text>,
    },
    {
      title: '下次执行',
      dataIndex: 'nextRunAt',
      width: 170,
      render: (_: unknown, t) => (t.status === 'active' ? fmt(t.nextRunAt) : '—'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (_: unknown, t) => (
        <Switch
          size="small"
          checked={t.status === 'active'}
          disabled={busy || t.status === 'expired'}
          onChange={(v) => void toggle(t, v)}
        />
      ),
    },
    {
      title: '操作',
      width: 300,
      render: (_: unknown, t) => (
        <Space wrap>
          <Button variant="text" size="small" onClick={() => void openEdit(t)}>
            编辑
          </Button>
          <Button variant="text" size="small" onClick={() => void openHistory(t)}>
            历史
          </Button>
          <Button
            variant="text"
            size="small"
            icon={<Play size={13} />}
            disabled={busy}
            onClick={() => void runNow(t)}
          >
            立即执行
          </Button>
          <Button variant="text" size="small" danger onClick={() => remove(t)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const runColumns: ColumnsType<ScheduleRun> = [
    { title: '计划时间', dataIndex: 'plannedAt', width: 170, render: (v: number) => fmt(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => {
        const s = RUN_STATUS[v] ?? { text: v };
        return <Tag color={s.color}>{s.text}</Tag>;
      },
    },
    { title: '耗时', width: 80, render: (_: unknown, r) => duration(r) },
    {
      title: '结果',
      render: (_: unknown, r) => (
        <Typography.Text type={r.status === 'failed' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          {r.error || r.summary || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, r) =>
        r.sessionId ? (
          <Space>
            <Button
              variant="text"
              size="small"
              onClick={() => navigate(`/agent/s/${r.sessionId}`)}
            >
              {r.status === 'waiting_approval' ? '去审批' : '打开会话'}
            </Button>
            {r.status === 'running' || r.status === 'waiting_approval' ? (
              <Button
                variant="text"
                size="small"
                danger
                onClick={async () => {
                  try {
                    await scheduleCancelRun(r.id);
                    if (historyTask) await loadRuns(historyTask.id);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                取消
              </Button>
            ) : null}
          </Space>
        ) : null,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <AgentSubNav />
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }} data-testid="agent-schedules">
        <Flex align="center" gap={8} style={{ marginBottom: 12 }} wrap>
          <CalendarClock size={18} />
          <Typography.Title level={5} style={{ margin: 0 }}>
            定时任务
          </Typography.Title>
          <div style={{ flex: 1 }} />
          <Button variant="secondary" size="small" icon={<RefreshCw size={14} />} onClick={() => void reload()}>
            刷新
          </Button>
          <Button variant="primary" size="small" disabled={!available} onClick={() => void openCreate()}>
            新建任务
          </Button>
        </Flex>

        {!available ? (
          <Alert
            type="info"
            showIcon
            message="定时任务仅在桌面端应用内可用"
            description="浏览器预览不启动本地调度器；请使用 Tauri 桌面端。"
            style={{ marginBottom: 12 }}
          />
        ) : null}
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
        {notice ? <Alert type="success" showIcon message={notice} closable onClose={() => setNotice(null)} style={{ marginBottom: 8 }} /> : null}
        {data && !data.engineRunning ? (
          <Alert
            type="warning"
            showIcon
            message="本机已有另一个实例在运行定时调度"
            description="当前窗口不会重复执行任务；关闭另一实例后重启本应用即可接管。"
            style={{ marginBottom: 8 }}
          />
        ) : null}
        <Flex gap={8} align="center" style={{ marginBottom: 10, fontSize: 12 }}>
          <Typography.Text type={calendarCurrent ? 'secondary' : 'warning'}>
            {calendarCurrent
              ? `工作日日历已同步至 ${fmt(calendarCurrent.fetchedAt)}`
              : '工作日日历未同步：workday 类型按周一~五兜底'}
          </Typography.Text>
          <Button variant="text" size="small" loading={busy} onClick={() => void syncCalendar()}>
            立即同步
          </Button>
        </Flex>

        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data?.tasks ?? []}
          loading={!data && available}
          pagination={false}
          locale={{ emptyText: available ? '还没有定时任务' : '桌面端可用' }}
        />

        <Drawer
          open={drawerOpen}
          width={560}
          title={editing ? `编辑任务：${editing.name}` : '新建定时任务'}
          onClose={() => setDrawerOpen(false)}
          destroyOnClose
          footer={
            <Flex justify="flex-end" gap={8}>
              <Button variant="secondary" onClick={() => setDrawerOpen(false)}>
                取消
              </Button>
              <Button variant="primary" loading={busy} onClick={save}>
                保存
              </Button>
            </Flex>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {formError ? <Alert type="error" showIcon message={formError} /> : null}
            <div>
              <Typography.Text strong>任务名称</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                placeholder="例如：每日待办整理"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Typography.Text strong>提示词</Typography.Text>
              <Input.TextArea
                style={{ marginTop: 4 }}
                autoSize={{ minRows: 5, maxRows: 12 }}
                placeholder="到点后发给 Agent 的指令，例如：把今天的待办整理成清单并发到项目群"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div>
              <Typography.Text strong>工作目录</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={workspace}
                onChange={setWorkspace}
                options={[
                  { value: '', label: '日常对话（无目录）' },
                  ...workspaces.map((w) => ({ value: w.path, label: w.name })),
                ]}
              />
            </div>
            <div>
              <Typography.Text strong>调度类型</Typography.Text>
              <Radio.Group
                style={{ display: 'flex', marginTop: 4 }}
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                options={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                optionType="button"
                buttonStyle="solid"
              />
            </div>
            {kind === 'cron' ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select
                  style={{ width: '100%' }}
                  placeholder="常用模板"
                  options={CRON_PRESETS}
                  value={CRON_PRESETS.some((p) => p.value === cronExpr) ? cronExpr : undefined}
                  onChange={(v) => setCronExpr(v)}
                />
                <Input
                  placeholder="cron 表达式（分 时 日 月 周），例如 0 9 * * 1-5"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                />
              </Space>
            ) : null}
            {kind === 'once' ? (
              <input
                type="datetime-local"
                value={onceAt}
                onChange={(e) => setOnceAt(e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--bbc-border, #d9d9d9)' }}
              />
            ) : null}
            {kind === 'workday' ? (
              <Flex gap={8} align="center">
                <Typography.Text type="secondary">每个工作日的</Typography.Text>
                <input
                  type="time"
                  value={workdayTime}
                  onChange={(e) => setWorkdayTime(e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--bbc-border, #d9d9d9)' }}
                />
              </Flex>
            ) : null}
            <div>
              <Typography.Text strong>执行模式</Typography.Text>
              <Radio.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                {MODE_OPTIONS.map((o) => (
                  <Radio key={o.value} value={o.value}>
                    <Space direction="vertical" size={0}>
                      <Typography.Text>{o.label}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {o.desc}
                      </Typography.Text>
                    </Space>
                  </Radio>
                ))}
              </Radio.Group>
            </div>
            <div>
              <Typography.Text strong>审批等待</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={approval}
                onChange={setApproval}
                options={[
                  { value: 1800, label: '30 分钟（超时视为拒绝）' },
                  { value: 7200, label: '2 小时' },
                  { value: 0, label: '不超时（需手动取消）' },
                ]}
              />
            </div>
            <div>
              <Typography.Text strong>模型档位</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 4 }}
                value={modelPolicy}
                onChange={setModelPolicy}
                options={[
                  { value: 'auto', label: '自动（跟随公司默认）' },
                  { value: 'fast', label: '快（bbc-fast）' },
                  { value: 'strong', label: '强（bbc-strong）' },
                ]}
              />
            </div>
          </Space>
        </Drawer>

        <Modal
          open={historyTask !== null}
          width={860}
          title={historyTask ? `运行历史：${historyTask.name}` : ''}
          onCancel={() => setHistoryTask(null)}
          footer={
            <Flex justify="flex-end">
              <Button variant="secondary" onClick={() => setHistoryTask(null)}>
                关闭
              </Button>
            </Flex>
          }
        >
          <Table
            rowKey="id"
            size="small"
            columns={runColumns}
            dataSource={runs}
            loading={runsLoading}
            pagination={{ pageSize: 10 }}
            locale={{ emptyText: '还没有运行记录' }}
          />
        </Modal>
      </div>
    </div>
  );
}