/**
 * 设置 · Agent（D01 §4.2 / D08 + 0023 多供应商）：
 * - 默认模型：跟随公司默认（fast/strong 档位）或指定供应商+模型（公司级或我的 BYOK，
 *   发起会话时客户端解析为 p:<providerId>:<model> 直达引用）
 * - 我的供应商：个人 BYOK CRUD（≤5 个；密钥服务端加密落库，仅本人可用）
 * - 权限模式/紧急停止为 D08 既定约定（骨架）；三级记忆管理入口在 /agent/memory 实现后开放
 * D26-O3：卡片壳→Card、行→List.Item、BYOK 表→Table、表单控件→Input/Select（settings-、admin-、bbc- 系自研类退役）。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Card, Input, List, Select, Space, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Pencil, PlugZap, Plus, Save, Trash2, Undo2, Zap } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import {
  createMyProvider,
  deleteMyProvider,
  fetchMeSettings,
  fetchMyProviders,
  fetchSharedProviders,
  patchAIDefault,
  probeMyProvider,
  probeMyProviderRaw,
  updateMyProvider,
  type AIDefaultSetting,
} from '../api/ai';
import { PROVIDER_PRESETS, presetKeyOfBaseUrl, type AIProvider } from '../../admin/model/types';
import { ProviderModelsEditor } from '../../admin/components/ProviderModelsEditor';
import { CloudBackupCard } from '../components/CloudBackupCard';
import { ExtAgentCard } from '../components/ExtAgentCard';

/** 设置行统一渲染：名称（可带图标）+ 描述 + 右侧控件 */
function SettingRow({ name, desc, control }: { name: ReactNode; desc: ReactNode; control: ReactNode }) {
  return (
    <List.Item actions={[control]}>
      <div>
        <div>{name}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {desc}
        </Typography.Text>
      </div>
    </List.Item>
  );
}

export function AgentSettingsPage() {
  const { token } = theme.useToken();
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        Agent
      </Typography.Title>

      <DefaultModelCard />
      <MyProvidersCard />
      <ExtAgentCard />
      <CloudBackupCard />

      <Card size="small">
        <List size="small">
          <SettingRow
            name={
              <Space size={6}>
                <Zap size={14} style={{ color: token.colorWarning }} /> 紧急停止
              </Space>
            }
            desc="全局快捷键立即中止所有 Agent 任务（D08 紧急停止）"
            control={<Typography.Text keyboard>⌘ ⇧ .</Typography.Text>}
          />
        </List>
      </Card>

      <Card size="small" title="三级记忆管理">
        <Typography.Text type="secondary">
          会话记忆 / 长期偏好 / 企业知识的查看与清除，入口在 /agent/memory（D08）实现后开放
        </Typography.Text>
      </Card>
    </Space>
  );
}

/* ── 默认模型卡片 ── */

function DefaultModelCard() {
  const [shared, setShared] = useState<AIProvider[]>([]);
  const [mine, setMine] = useState<AIProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'org' | 'provider'>('org');
  const [provId, setProvId] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [sh, my, settings] = await Promise.all([fetchSharedProviders(), fetchMyProviders(), fetchMeSettings()]);
        setShared(sh);
        setMine(my);
        const ai = settings.ai_default as AIDefaultSetting | undefined;
        if (ai?.mode === 'provider' && ai.providerId && ai.model) {
          setMode('provider');
          setProvId(ai.providerId);
          setModel(ai.model);
        }
      } catch {
        /* 六态由各卡片自行提示；此处静默降级为"跟随公司默认" */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const all = [...shared.map((p) => ({ ...p, mine: false })), ...mine.map((p) => ({ ...p, mine: true }))];
  const models = all.find((p) => p.id === provId)?.models ?? [];

  /** 选择即存（无保存按钮）：org 切换即存；provider 需供应商+模型齐备才落库（半截引用会被路由校验拒） */
  const persist = async (next: AIDefaultSetting) => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await patchAIDefault(next);
      setSaved(true);
    } catch (err) {
      setError(errText(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const changeMode = (v: 'org' | 'provider') => {
    setMode(v);
    setSaved(false);
    if (v === 'org') {
      void persist({ mode: 'org' });
      return;
    }
    let pid = provId;
    if (!pid) {
      const first = all[0];
      if (first) {
        pid = first.id;
        setProvId(pid);
      }
    }
    // 已有完整且仍有效的配对才立即存，否则等模型选完
    if (pid && model && all.find((p) => p.id === pid)?.models.some((m) => m.id === model)) {
      void persist({ mode: 'provider', providerId: pid, model });
    }
  };

  const rows: Array<{ key: string; name: ReactNode; desc: ReactNode; control: ReactNode }> = [
    {
      key: 'mode',
      name: '默认模型',
      desc: '新会话使用的模型；未指定时跟随公司默认（快/强档位自动路由），选择后自动保存',
      control: (
        <Select
          size="small"
          style={{ width: 170 }}
          loading={!loaded}
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'org', label: '跟随公司默认' },
            { value: 'provider', label: '指定供应商与模型' },
          ]}
        />
      ),
    },
    ...(mode === 'provider'
      ? [
          {
            key: 'pm',
            name: '供应商 / 模型',
            desc: '公司统一接入或「我的供应商」；会话内可临时切换',
            control: (
              <Space size={8} wrap>
                <Select
                  size="small"
                  style={{ width: 170 }}
                  placeholder="选择供应商"
                  value={provId || undefined}
                  onChange={(v) => {
                    setProvId(v);
                    setModel('');
                    setSaved(false);
                  }}
                  options={all.map((p) => ({ value: p.id, label: `${p.mine ? '我的 · ' : ''}${p.name}` }))}
                />
                <Select
                  size="small"
                  style={{ width: 190 }}
                  placeholder="选择模型"
                  value={model || undefined}
                  onChange={(v) => {
                    setModel(v);
                    setSaved(false);
                    if (provId && v) void persist({ mode: 'provider', providerId: provId, model: v });
                  }}
                  disabled={!provId}
                  options={models.map((m) => ({ value: m.id, label: m.label ? `${m.label}（${m.id}）` : m.id }))}
                />
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card size="small" data-testid="agent-default-model">
      <List
        size="small"
        dataSource={rows}
        renderItem={(row) => <SettingRow key={row.key} name={row.name} desc={row.desc} control={row.control} />}
      />
      {saving ? (
        <Typography.Text type="secondary">保存中…</Typography.Text>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : saved ? (
        <Typography.Text type="secondary">已保存 ✓</Typography.Text>
      ) : mode === 'provider' && (!provId || !model) ? (
        <Typography.Text type="secondary">选好供应商与模型后自动保存</Typography.Text>
      ) : null}
    </Card>
  );
}

/* ── 我的供应商卡片（BYOK） ── */

function MyProvidersCard() {
  const [mine, setMine] = useState<AIProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [vendor, setVendor] = useState('zhipu');
  const [editingId, setEditingId] = useState(''); // 空=新增；有值=编辑该供应商
  const [editingKey, setEditingKey] = useState(false); // 编辑态是否重填密钥
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [connResult, setConnResult] = useState<{ ok: boolean; ms: number; models: number } | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => {
    try {
      setMine(await fetchMyProviders());
    } catch {
      /* 静默：卡片各行已有行内提示 */
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const resetForm = () => {
    setEditingId('');
    setEditingKey(false);
    setVendor('zhipu');
    setName('');
    setBaseUrl('');
    setApiKey('');
    setCandidates([]);
    setModels([]);
    setConnResult(null);
    setError('');
  };

  /** 选厂商：预设自动填名称与 Base URL，清空候选与已选（切换=重来，与 admin 侧一致） */
  const pickVendor = (key: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === key) ?? PROVIDER_PRESETS[2];
    setVendor(key);
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setCandidates([]);
    setModels([]);
    setConnResult(null);
  };

  /** 行内「编辑」：载入表单（密钥占位提示已保存；探测走服务端已存密钥） */
  const edit = (p: AIProvider) => {
    setEditingId(p.id);
    setEditingKey(false);
    setVendor(presetKeyOfBaseUrl(p.baseUrl));
    setName(p.name);
    setBaseUrl(p.baseUrl);
    setApiKey('');
    setModels(p.models.map((m) => m.id));
    setCandidates(p.models.map((m) => m.id));
    setConnResult(null);
    setError('');
  };

  /** 探测：连通验证并拉取上游模型清单（原两按钮同一接口，合一；候选缺项可手动输入）。
   * 编辑态未重填密钥时用服务端已存密钥（probeMyProvider(id)） */
  const probe = async () => {
    if (!baseUrl.trim()) {
      setError('先填 Base URL');
      return;
    }
    setProbing(true);
    setError('');
    const startedAt = Date.now();
    try {
      const list = editingId && !editingKey
        ? await probeMyProvider(editingId)
        : await probeMyProviderRaw(baseUrl.trim(), apiKey.trim());
      setConnResult({ ok: true, ms: Date.now() - startedAt, models: list.length });
      if (list.length === 0) setError('上游未返回模型清单（可手动输入模型 ID）');
      setCandidates(list);
    } catch (err) {
      setConnResult(null);
      setError(errText(err, '连接失败'));
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    const n = name.trim();
    const b = baseUrl.trim().replace(/\/+$/, '');
    if (!n || !b || models.length === 0) {
      setError('名称/Base URL/模型清单均必填（模型可探测拉取或手动输入）');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const input = { name: n, kind: 'openai_compatible' as const, baseUrl: b, apiKey: apiKey.trim() || undefined, models: models.map((id) => ({ id })) };
      if (editingId) await updateMyProvider(editingId, input);
      else await createMyProvider(input);
      resetForm();
      await reload();
    } catch (err) {
      setError(errText(err, editingId ? '保存失败' : '添加失败'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError('');
    try {
      await deleteMyProvider(id);
      if (editingId === id) resetForm();
      await reload();
    } catch (err) {
      setError(errText(err, '删除失败'));
    }
  };

  const columns: ColumnsType<AIProvider> = [
    { title: '名称', dataIndex: 'name' },
    { title: 'Base URL', dataIndex: 'baseUrl', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '模型', dataIndex: 'models', render: (ms: AIProvider['models']) => ms.map((m) => m.id).join('、') },
    { title: '密钥', dataIndex: 'keyMask', render: (v: string) => (v ? <Typography.Text code>{v}</Typography.Text> : '—') },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, p) => (
        <Space size={4}>
          <Button variant="secondary" size="small" onClick={() => edit(p)}>
            <Pencil size={12} /> 编辑
          </Button>
          <Button variant="danger" size="small" onClick={() => void remove(p.id)}>
            <Trash2 size={12} /> 删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card size="small" data-testid="agent-my-providers" title="我的供应商">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        自带 API Key 的个人模型接入（≤5 个；仅自己可用，密钥服务端加密）
      </Typography.Paragraph>
      {loaded ? (
        mine.length > 0 ? (
          <Table<AIProvider> rowKey="id" size="small" columns={columns} dataSource={mine} pagination={false} style={{ marginBottom: 10 }} />
        ) : (
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>
            尚未添加个人供应商——在下方录入（如 DeepSeek/Qwen/智谱的个人 Key）
          </Typography.Text>
        )
      ) : null}
      <Space size={8} wrap style={{ marginBottom: 8 }}>
        <Select
          style={{ width: 150 }}
          value={vendor}
          onChange={pickVendor}
          options={PROVIDER_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
        />
        <Input style={{ width: 130 }} value={name} placeholder="名称（随厂商自动填）" onChange={(e) => setName(e.target.value)} />
        <Input
          style={{ width: 215 }}
          value={baseUrl}
          placeholder={vendor === 'custom' ? 'Base URL（https://…/v1）' : 'Base URL（自动填，可改）'}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input.Password
          style={{ width: 190 }}
          value={apiKey}
          placeholder={editingId && !editingKey ? '密钥已保存（不改则留空）' : 'API Key'}
          onChange={(e) => {
            setEditingKey(true);
            setApiKey(e.target.value);
          }}
        />
        <Button variant="secondary" onClick={() => void probe()} loading={probing}>
          <PlugZap size={13} /> 测试连接并拉取模型
        </Button>
        <Button onClick={() => void submit()} loading={saving}>
          {editingId ? <Save size={13} /> : <Plus size={13} />} {editingId ? '保存修改' : '添加'}
        </Button>
        {editingId ? (
          <Button variant="secondary" onClick={resetForm}>
            <Undo2 size={13} /> 取消
          </Button>
        ) : null}
      </Space>
      {connResult ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 6 }}>
          ✅ 连接成功（{connResult.ms}ms · 上游 {connResult.models} 个模型）
        </Typography.Text>
      ) : null}
      <ProviderModelsEditor
        models={models}
        candidates={candidates}
        onToggle={(id) => setModels((arr) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]))}
        onAdd={(id) => setModels((arr) => (arr.includes(id) ? arr : [...arr, id]))}
      />
      {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} /> : null}
    </Card>
  );
}
