/**
 * AI 供应商治理（0023 表驱动多供应商，路由 /admin/ai-providers）：
 * - 供应商（公司级）CRUD：名称/BaseURL/密钥（服务端 KMS 加密落库，回显仅掩码）/
 *   模型清单（探活从上游 /models 拉取 + 手动补充）——新增/编辑走右侧抽屉
 * - 默认模型路由：fast/strong 各配主备（priority 逐候选降级，全尽 8051）
 * - 六态：列表独立 loading/empty/error/forbidden/offline；行操作失败不认领 → 全局 toast 兜底
 * 蓝图：19 篇 §3.1/§3.3/§6.5 v0.1 子集。
 */

import { useMemo, useState } from 'react';
import { Drawer } from 'antd';
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
          <table className="admin-table" data-testid="ai-providers-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>ID</th>
                <th>名称</th>
                <th>Base URL</th>
                <th>模型</th>
                <th>密钥</th>
                <th style={{ width: 70 }}>状态</th>
                <th style={{ width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} data-testid={`ai-provider-${p.id}`}>
                  <td className="admin-mono">{p.id}</td>
                  <td>{p.name}</td>
                  <td className="admin-mono">{p.baseUrl}</td>
                  <td>
                    {p.models.map((m) => (
                      <span key={m.id} className="admin-tag" style={{ marginRight: 4 }}>
                        {m.id}
                      </span>
                    ))}
                  </td>
                  <td className="admin-mono">{p.keyMask || '—'}</td>
                  <td>
                    <span className={`admin-status${p.status === 1 ? ' admin-status--ok' : ''}`}>{p.status === 1 ? '启用' : '停用'}</span>
                  </td>
                  <td>
                    <Button variant="secondary" onClick={() => edit(p)}>
                      编辑
                    </Button>{' '}
                    <Button variant="secondary" loading={save.isPending && save.variables?.id === p.id} onClick={() => toggleStatus(p)}>
                      {p.status === 1 ? '停用' : '启用'}
                    </Button>{' '}
                    <Button variant="danger" loading={del.isPending && del.variables === p.id} onClick={() => remove(p)}>
                      <Trash2 size={12} /> 删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <div className="ai-prov-form__footer">
            <Button onClick={submit} loading={save.isPending} data-testid="ai-prov-save">
              <Save size={13} /> {form.id ? '保存修改' : '创建'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        }
      >
        <div className="ai-prov-form">
          <label htmlFor="ai-prov-vendor">厂商预设（自动填名称与 Base URL，可改）</label>
          <select id="ai-prov-vendor" className="bbw-input" value={form.vendor} onChange={(e) => pickVendor(e.target.value)} data-testid="ai-prov-vendor">
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <label htmlFor="ai-prov-name">名称</label>
          <input id="ai-prov-name" className="bbw-input" value={form.name} placeholder="名称（随厂商自动填）" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-testid="ai-prov-name" />
          <label htmlFor="ai-prov-base">Base URL（OpenAI 兼容根地址）</label>
          <input id="ai-prov-base" className="bbw-input" value={form.baseUrl} placeholder={form.vendor === 'custom' ? 'https://…/v1' : '随厂商自动填，可改'} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} data-testid="ai-prov-base" />
          <label htmlFor="ai-prov-key">API Key（内网无鉴权上游可留空）</label>
          <input
            id="ai-prov-key"
            className="bbw-input"
            type="password"
            value={form.apiKey}
            placeholder={form.id && !editingKey ? '密钥已保存（不改则留空）' : 'API Key'}
            onChange={(e) => {
              setEditingKey(true);
              setForm((f) => ({ ...f, apiKey: e.target.value }));
            }}
            data-testid="ai-prov-key"
          />
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
          <label>模型清单（探测点选或手动输入——上游清单常不全，如智谱免费 Flash 系须手填）</label>
          <ProviderModelsEditor
            models={form.models}
            candidates={form.candidates}
            onToggle={toggleModel}
            onAdd={(id) => setForm((f) => ({ ...f, models: [...f.models, id] }))}
            testId="ai-prov-models"
          />
          {formError ? (
            <div className="admin-error-bar" data-testid="ai-prov-error">
              {formError}
            </div>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}

/* ── 默认路由面板（fast/strong 主备） ── */

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
    const draft = (tier: 'fast' | 'strong'): TierDraft => {
      const cands = byTier.get(tier) ?? [];
      const [main, backup] = cands;
      return {
        mainProv: main?.providerId ?? '',
        mainModel: main?.model ?? '',
        backupProv: backup?.providerId ?? '',
        backupModel: backup?.model ?? '',
      };
    };
    return { fast: draft('fast'), strong: draft('strong') };
  }, [routesQuery.data]);

  const [draft, setDraft] = useState(initial);
  // 路由数据后到时同步一次（staleTime 内不再覆盖用户编辑——简单起见以首次到位为准）
  const [applied, setApplied] = useState(false);
  if (!applied && routesQuery.data !== undefined) {
    setDraft(initial);
    setApplied(true);
  }

  const modelsOf = (provId: string) => enabled.find((p) => p.id === provId)?.models ?? [];

  const setTier = (tier: 'fast' | 'strong', patch: Partial<TierDraft>) => {
    setDraft((d) => ({ ...d, [tier]: { ...d[tier], ...patch } }));
    setError('');
  };

  const submit = () => {
    const items = (['fast', 'strong'] as const)
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

  const tierRow = (tier: 'fast' | 'strong', label: string, desc: string) => {
    const d = draft[tier];
    return (
      <tr key={tier}>
        <td>
          <span className="admin-tag">{tier}</span>
        </td>
        <td>
          <div className="admin-page__meta" style={{ marginBottom: 2 }}>
            {label}
          </div>
          <div className="admin-panel__note" style={{ marginBottom: 4 }}>
            {desc}
          </div>
          <select className="bbw-input" style={{ width: 170 }} value={d.mainProv} onChange={(e) => setTier(tier, { mainProv: e.target.value, mainModel: '' })}>
            <option value="">选择供应商…</option>
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>{' '}
          <select className="bbw-input" style={{ width: 160 }} value={d.mainModel} onChange={(e) => setTier(tier, { mainModel: e.target.value })}>
            <option value="">选择模型…</option>
            {modelsOf(d.mainProv).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ? `${m.label}（${m.id}）` : m.id}
              </option>
            ))}
          </select>
        </td>
        <td>
          <select className="bbw-input" style={{ width: 170 }} value={d.backupProv} onChange={(e) => setTier(tier, { backupProv: e.target.value, backupModel: '' })}>
            <option value="">（可选）备用供应商…</option>
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>{' '}
          <select className="bbw-input" style={{ width: 160 }} value={d.backupModel} onChange={(e) => setTier(tier, { backupModel: e.target.value })} disabled={!d.backupProv}>
            <option value="">选择模型…</option>
            {modelsOf(d.backupProv).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ? `${m.label}（${m.id}）` : m.id}
              </option>
            ))}
          </select>
        </td>
      </tr>
    );
  };

  return (
    <StateView state={state} skeleton={<SkeletonList count={2} />} emptyText="" error={provQuery.error ?? routesQuery.error} onRetry={() => { void provQuery.refetch(); void routesQuery.refetch(); }}>
      <section className="admin-panel" style={{ marginTop: 16 }}>
        <div className="admin-panel__title">
          默认模型（全员路由）
          <span className="admin-panel__meta">档位别名 bbw-fast/bbw-strong → 此处主选；主选失败自动切备选（§4.4 降级链）</span>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>档位</th>
              <th>主选</th>
              <th>备选</th>
            </tr>
          </thead>
          <tbody>
            {tierRow('fast', '快速档', '轻量任务/工具调用循环')}
            {tierRow('strong', '强力档', '复杂推理/长文写作')}
          </tbody>
        </table>
        {error ? <div className="admin-error-bar">{error}</div> : null}
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
