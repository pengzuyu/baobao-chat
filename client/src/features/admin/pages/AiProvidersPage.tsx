/**
 * AI 供应商治理（0023 表驱动多供应商，路由 /admin/ai-providers）：
 * - 供应商（公司级）CRUD：名称/BaseURL/密钥（服务端 KMS 加密落库，回显仅掩码）/
 *   模型清单（探活从上游 /models 拉取 + 手动补充）——新增/编辑走右侧抽屉
 * - 默认模型路由：fast/strong 必配主备 + embed/rerank 可选档（D24 N3a；priority 逐候选降级，全尽 8051）
 * - 六态：列表独立 loading/empty/error/forbidden/offline；行操作失败不认领 → 全局 toast 兜底
 * 蓝图：19 篇 §3.1/§3.3/§6.5 v0.1 子集。
 */

import { useMemo, useState } from 'react';
import { Alert, Drawer, Form, Input, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlugZap, Plus, Save, Trash2 } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { StateView, type ViewStateOrOk } from '../../../shared/ui/StateView';
import { useConnectionStore } from '../../../shared/store/connection';
import { probeAIProvider, probeAIProviderRaw } from '../api/admin';
import { useAIProviders, useAIRoutes, useDeleteAIProvider, usePutAIRoutes, useSaveAIProvider } from '../api/hooks';
import { ProviderModelsEditor } from '../components/ProviderModelsEditor';
import { PROVIDER_PRESETS, presetKeyOfBaseUrl, type AIProvider } from '../model/types';

export function AiProvidersPage() {
  return (
    <div className="admin-policies">
      <header className="admin-page__header">
        <h2 className="admin-page__title">AI 供应商</h2>
        <span className="admin-page__meta">公司级统一接入 · 默认模型主备路由 · 密钥服务端加密（19 篇 §6.5 v0.1）</span>
      </header>
      <ProvidersPanel />
      <RoutesPanel />
    </div>
  );
}

/* ── 供应商面板 ── */

interface FormState {
  id: string; // 空=新建
  vendor: string; // 厂商预设 key（zhipu/deepseek/custom）
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[]; // 选中的模型 id 集（有序按加入序）
  candidates: string[]; // 探测到的上游模型
}

const emptyForm: FormState = { id: '', vendor: 'zhipu', name: '智谱开放平台', baseUrl: PROVIDER_PRESETS[0].baseUrl, apiKey: '', models: [], candidates: [] };

function ProvidersPanel() {
  const query = useAIProviders();
  const save = useSaveAIProvider();
  const del = useDeleteAIProvider();
  const connStatus = useConnectionStore((s) => s.status);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [open, setOpen] = useState(false); // 新增/编辑抽屉
  const [formError, setFormError] = useState('');
  const [probing, setProbing] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; ms: number; models: number } | null>(null); // 测试连接/探测结果
  const [editingKey, setEditingKey] = useState(false); // 编辑态是否重填密钥

  const items = query.data ?? [];
  const state: ViewStateOrOk = query.isPending
    ? 'loading'
    : query.isError
      ? query.error instanceof ApiError && query.error.code === 2003
        ? 'forbidden'
        : 'error'
      : connStatus === 'offline'
        ? 'offline'
        : 'ok';

  /** 选厂商：预设自动填名称与 Base URL（自定义=清空手填），用户仍可改 */
  const pickVendor = (key: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === key) ?? PROVIDER_PRESETS[2];
    setConnResult(null);
    setForm((f) => ({ ...f, vendor: key, name: preset.name || f.name, baseUrl: preset.baseUrl, candidates: [], models: [] }));
  };

  /** 探测：连通+鉴权验证并拉取上游模型清单填候选（原「测试连接/探测模型」两按钮同一接口，合一） */
  const probe = async () => {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      setFormError('先填 Base URL');
      return;
    }
    setProbing(true);
    setFormError('');
    const startedAt = Date.now();
    try {
      const key = form.id && !editingKey ? '' : form.apiKey.trim(); // 未重填时用服务端已存密钥探测
      const models = form.id && !editingKey
        ? await probeAIProvider(form.id)
        : await probeAIProviderRaw(baseUrl, key);
      setConnResult({ ok: true, ms: Date.now() - startedAt, models: models.length });
      if (models.length === 0) setFormError('上游未返回模型清单（可手动输入模型 ID）');
      setForm((f) => ({ ...f, candidates: models }));
    } catch (err) {
      setConnResult(null);
      // 服务端 message 优先（如「供应商被 fast 档默认路由引用，先调整路由」——
      // 只显码表文案会把删除被拒的真实原因吞成通用「请求参数错误」）
      setFormError(err instanceof ApiError ? err.message || getErrorText(err.code) : '连接失败');
    } finally {
      setProbing(false);
    }
  };

  const toggleModel = (id: string) => {
    setForm((f) => ({
      ...f,
      models: f.models.includes(id) ? f.models.filter((m) => m !== id) : [...f.models, id],
    }));
  };

  const submit = () => {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, '');
    if (!name || !baseUrl) {
      setFormError('名称与 Base URL 必填');
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      setFormError('Base URL 须以 http:// 或 https:// 开头');
      return;
    }
    if (form.models.length === 0) {
      setFormError('至少选择 1 个模型（可「测试连接并拉取模型」或手动输入）');
      return;
    }
    if (!form.id && form.apiKey.trim() === '' ) {
      // 允许无密钥上游（内网 vLLM），不阻断——留空提交
    }
    setFormError('');
    save.mutate(
      {
        id: form.id || undefined,
        input: {
          name,
          kind: 'openai_compatible',
          baseUrl,
          apiKey: form.apiKey.trim() || undefined,
          models: form.models.map((id) => ({ id })),
        },
      },
      {
        onSuccess: () => {
          setForm(emptyForm);
          setEditingKey(false);
          setOpen(false);
        },
        onError: (err) => setFormError(err instanceof ApiError ? err.message : '保存失败'), // 服务端具体报错透传（http.ts 已优先取 message）
      },
    );
  };

  /** 新增：表单复位后开抽屉 */
  const openCreate = () => {
    setForm(emptyForm);
    setEditingKey(false);
    setFormError('');
    setConnResult(null);
    setOpen(true);
  };

  const edit = (p: AIProvider) => {
    setForm({
      id: p.id,
      vendor: presetKeyOfBaseUrl(p.baseUrl),
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: '',
      models: p.models.map((m) => m.id),
      candidates: p.models.map((m) => m.id),
    });
    setEditingKey(false);
    setFormError('');
    setConnResult(null);
    setOpen(true);
  };

  // 行内启停/删除失败不在此认领——ApiError 未认领由全局 toast 兜底（main.tsx），就近可见
  const toggleStatus = (p: AIProvider) => {
    save.mutate({ id: p.id, input: { name: p.name, status: p.status === 1 ? 2 : 1 } });
  };

  const remove = (p: AIProvider) => {
    del.mutate(p.id);
  };

  const columns: ColumnsType<AIProvider> = [
    { title: 'ID', dataIndex: 'id', width: 60, render: (v: string) => <span className="admin-mono">{v}</span> },
    { title: '名称', dataIndex: 'name' },
    { title: 'Base URL', dataIndex: 'baseUrl', render: (v: string) => <span className="admin-mono">{v}</span> },
    {
      title: '模型',
      dataIndex: 'models',
      render: (models: AIProvider['models']) => (
        <>
          {models.map((m) => (
            <Tag key={m.id} style={{ marginInlineEnd: 4 }}>
              {m.id}
            </Tag>
          ))}
        </>
      ),
    },
    { title: '密钥', dataIndex: 'keyMask', render: (v: string) => <span className="admin-mono">{v || '—'}</span> },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: number) => <Tag color={v === 1 ? 'green' : 'default'}>{v === 1 ? '启用' : '停用'}</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 230,
      render: (_, p) => (
        <>
          <Button variant="secondary" size="small" onClick={() => edit(p)}>
            编辑
          </Button>{' '}
          <Button variant="secondary" size="small" loading={save.isPending && save.variables?.id === p.id} onClick={() => toggleStatus(p)}>
            {p.status === 1 ? '停用' : '启用'}
          </Button>{' '}
          <Button variant="danger" size="small" loading={del.isPending && del.variables === p.id} onClick={() => remove(p)}>
            <Trash2 size={12} /> 删除
          </Button>
        </>
      ),
    },
  ];

  return (
    <>
      <section className="admin-panel">
        <div className="admin-panel__title">
          供应商（公司级）
          <span className="admin-panel__meta">OpenAI 兼容（GLM/Qwen/DeepSeek/vLLM）· 密钥 AES-256-GCM 加密落库</span>
          <Button style={{ marginLeft: 'auto' }} onClick={openCreate} data-testid="ai-prov-new">
            <Plus size={13} /> 新增供应商
          </Button>
        </div>
        <StateView
          state={state}
          skeleton={<SkeletonList count={4} />}
          emptyText="尚无供应商：上方选厂商录入首个（推荐先「测试连接并拉取模型」）"
          error={query.error}
          onRetry={() => void query.refetch()}
          forbiddenText="需要 admin:policy:manage 权限"
          offlineText="离线中：供应商只读"
        >
          <Table<AIProvider>
            rowKey="id"
            columns={columns}
            dataSource={items}
            data-testid="ai-providers-table"
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
          />
        </StateView>
      </section>
      {/* 新增/编辑抽屉：字段纵向排布，关闭即复位（destroyOnClose 清手填输入态） */}
      <Drawer
        title={form.id ? `编辑供应商 #${form.id}` : '新增供应商'}
        open={open}
        onClose={() => setOpen(false)}
        width={520}
        destroyOnClose
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={submit} loading={save.isPending} data-testid="ai-prov-save">
              <Save size={13} /> {form.id ? '保存修改' : '创建'}
            </Button>
          </div>
        }
      >
        <Form layout="vertical">
          <Form.Item label="厂商预设（自动填名称与 Base URL，可改）">
            <Select
              value={form.vendor}
              onChange={pickVendor}
              options={PROVIDER_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              data-testid="ai-prov-vendor"
            />
          </Form.Item>
          <Form.Item label="名称">
            <Input value={form.name} placeholder="名称（随厂商自动填）" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="ai-prov-name" />
          </Form.Item>
          <Form.Item label="Base URL（OpenAI 兼容根地址）">
            <Input
              value={form.baseUrl}
              placeholder={form.vendor === 'custom' ? 'https://…/v1' : '随厂商自动填，可改'}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              data-testid="ai-prov-base"
            />
          </Form.Item>
          <Form.Item label="API Key（内网无鉴权上游可留空）">
            <Input.Password
              value={form.apiKey}
              placeholder={form.id && !editingKey ? '密钥已保存（不改则留空）' : 'API Key'}
              onChange={(e) => {
                setEditingKey(true);
                setForm((f) => ({ ...f, apiKey: e.target.value }));
              }}
              data-testid="ai-prov-key"
            />
          </Form.Item>
          <div className="ai-prov-form__probe">
            <Button variant="secondary" onClick={() => void probe()} loading={probing} data-testid="ai-prov-probe">
              <PlugZap size={13} /> 测试连接并拉取模型
            </Button>
            {connResult ? (
              <span className="admin-page__meta" data-testid="ai-prov-conn">
                ✅ 连接成功（{connResult.ms}ms · 上游 {connResult.models} 个模型）
              </span>
            ) : null}
          </div>
          <Form.Item label="模型清单（探测点选或手动输入——上游清单常不全，如智谱免费 Flash 系须手填）">
            <ProviderModelsEditor
              models={form.models}
              candidates={form.candidates}
              onToggle={toggleModel}
              onAdd={(id) => setForm((f) => ({ ...f, models: [...f.models, id] }))}
              testId="ai-prov-models"
            />
          </Form.Item>
          {formError ? <Alert type="error" showIcon message={formError} data-testid="ai-prov-error" /> : null}
        </Form>
      </Drawer>
    </>
  );
}

/* ── 默认路由面板（fast/strong 必配 + embed/rerank 可选档） ── */

type Tier = 'fast' | 'strong' | 'embed' | 'rerank';

interface TierDraft {
  mainProv: string;
  mainModel: string;
  backupProv: string;
  backupModel: string;
}

function RoutesPanel() {
  const provQuery = useAIProviders();
  const routesQuery = useAIRoutes();
  const put = usePutAIRoutes();
  const [error, setError] = useState('');

  const enabled = useMemo(() => (provQuery.data ?? []).filter((p) => p.status === 1), [provQuery.data]);

  const initial = useMemo(() => {
    const byTier = new Map((routesQuery.data ?? []).map((r) => [r.tier, r.candidates] as const));
    const draft = (tier: Tier): TierDraft => {
      const cands = byTier.get(tier) ?? [];
      const [main, backup] = cands;
      return {
        mainProv: main?.providerId ?? '',
        mainModel: main?.model ?? '',
        backupProv: backup?.providerId ?? '',
        backupModel: backup?.model ?? '',
      };
    };
    return { fast: draft('fast'), strong: draft('strong'), embed: draft('embed'), rerank: draft('rerank') };
  }, [routesQuery.data]);

  const [draft, setDraft] = useState(initial);
  // 路由数据后到时同步一次（staleTime 内不再覆盖用户编辑——简单起见以首次到位为准）
  const [applied, setApplied] = useState(false);
  if (!applied && routesQuery.data !== undefined) {
    setDraft(initial);
    setApplied(true);
  }

  const modelsOf = (provId: string) => enabled.find((p) => p.id === provId)?.models ?? [];

  const setTier = (tier: Tier, patch: Partial<TierDraft>) => {
    setDraft((d) => ({ ...d, [tier]: { ...d[tier], ...patch } }));
    setError('');
  };

  const submit = () => {
    // 可选档主选半截（选了供应商没选模型/反之）直接拦——静默丢弃会让用户误以为已生效
    for (const tier of ['embed', 'rerank'] as const) {
      const d = draft[tier];
      if ((d.mainProv || d.mainModel) && !(d.mainProv && d.mainModel)) {
        setError(`${tier} 档主选须供应商与模型同选（同空=沿用现有配置）`);
        return;
      }
    }
    const items = (['fast', 'strong', 'embed', 'rerank'] as const)
      .map((tier) => {
        const d = draft[tier];
        const candidates = [];
        if (d.mainProv && d.mainModel) candidates.push({ providerId: d.mainProv, model: d.mainModel, priority: 1 });
        if (d.backupProv && d.backupModel) candidates.push({ providerId: d.backupProv, model: d.backupModel, priority: 2 });
        return { tier, candidates };
      })
      .filter((r) => r.candidates.length > 0);
    if (!items.some((r) => r.tier === 'fast') || !items.some((r) => r.tier === 'strong')) {
      setError('fast 与 strong 都需配置主选模型');
      return;
    }
    setError('');
    put.mutate(items, { onError: (err) => setError(err instanceof ApiError ? err.message || getErrorText(err.code) : '保存失败') });
  };

  const state: ViewStateOrOk = provQuery.isPending || routesQuery.isPending ? 'loading' : provQuery.isError || routesQuery.isError ? 'error' : 'ok';

  const provOptions = enabled.map((p) => ({ value: p.id, label: p.name }));
  const modelOptions = (provId: string) =>
    modelsOf(provId).map((m) => ({ value: m.id, label: m.label ? `${m.label}（${m.id}）` : m.id }));

  const TIERS: Array<{ tier: Tier; label: string; desc: string }> = [
    { tier: 'fast', label: '快速档', desc: '轻量任务/工具调用循环' },
    { tier: 'strong', label: '强力档', desc: '复杂推理/长文写作' },
    { tier: 'embed', label: '嵌入档', desc: '知识库向量化（bbw-embed；可选，未配走 mock 兜底向量）' },
    { tier: 'rerank', label: '重排档', desc: '知识库检索重排（bbw-rerank；可选，未配走词面重排兜底）' },
  ];

  const routesColumns: ColumnsType<(typeof TIERS)[number]> = [
    {
      title: '档位',
      dataIndex: 'tier',
      width: 90,
      render: (tier: string) => <Tag>{tier}</Tag>,
    },
    {
      title: '主选',
      key: 'main',
      render: (_, t) => {
        const d = draft[t.tier];
        return (
          <div>
            <div className="admin-page__meta" style={{ marginBottom: 2 }}>
              {t.label}
            </div>
            <div className="admin-panel__note" style={{ marginBottom: 4 }}>
              {t.desc}
            </div>
            <Select
              style={{ width: 180 }}
              placeholder="选择供应商…"
              value={d.mainProv || undefined}
              onChange={(v) => setTier(t.tier, { mainProv: v, mainModel: '' })}
              options={provOptions}
              allowClear
            />{' '}
            <Select
              style={{ width: 200 }}
              placeholder="选择模型…"
              value={d.mainModel || undefined}
              onChange={(v) => setTier(t.tier, { mainModel: v ?? '' })}
              options={modelOptions(d.mainProv)}
              allowClear
            />
          </div>
        );
      },
    },
    {
      title: '备选',
      key: 'backup',
      render: (_, t) => {
        const d = draft[t.tier];
        return (
          <>
            <Select
              style={{ width: 180 }}
              placeholder="（可选）备用供应商…"
              value={d.backupProv || undefined}
              onChange={(v) => setTier(t.tier, { backupProv: v ?? '', backupModel: '' })}
              options={provOptions}
              allowClear
            />{' '}
            <Select
              style={{ width: 200 }}
              placeholder="选择模型…"
              value={d.backupModel || undefined}
              onChange={(v) => setTier(t.tier, { backupModel: v ?? '' })}
              options={modelOptions(d.backupProv)}
              disabled={!d.backupProv}
            />
          </>
        );
      },
    },
  ];

  return (
    <StateView state={state} skeleton={<SkeletonList count={2} />} emptyText="" error={provQuery.error ?? routesQuery.error} onRetry={() => { void provQuery.refetch(); void routesQuery.refetch(); }}>
      <section className="admin-panel" style={{ marginTop: 16 }}>
        <div className="admin-panel__title">
          默认模型（全员路由）
          <span className="admin-panel__meta">档位别名 bbw-fast/bbw-strong/bbw-embed/bbw-rerank → 此处主选；主选失败自动切备选（§4.4 降级链）；embed/rerank 可选——留空=沿用现有配置/内置兜底</span>
        </div>
        <Table
          rowKey="tier"
          columns={routesColumns}
          dataSource={TIERS}
          pagination={false}
          size="middle"
        />
        {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} /> : null}
        <div className="admin-loadmore" style={{ marginTop: 8 }}>
          <Button onClick={submit} loading={put.isPending} data-testid="ai-routes-save">
            <Save size={13} /> 保存默认路由
          </Button>
          {put.isSuccess && !error ? <span className="admin-page__meta" style={{ marginLeft: 10 }}>已保存（版本化生效）</span> : null}
        </div>
      </section>
    </StateView>
  );
}
