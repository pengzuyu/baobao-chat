/**
 * 设置 · Agent（D01 §4.2 / D08 + 0023 多供应商）：
 * - 默认模型：跟随公司默认（fast/strong 档位）或指定供应商+模型（公司级或我的 BYOK，
 *   发起会话时客户端解析为 p:<providerId>:<model> 直达引用）
 * - 我的供应商：个人 BYOK CRUD（≤5 个；密钥服务端加密落库，仅本人可用）
 * - 权限模式/紧急停止为 D08 既定约定（骨架）；三级记忆管理入口在 /agent/memory 实现后开放
 */

import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { PlugZap, Plus, Trash2, Zap } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import {
  createMyProvider,
  deleteMyProvider,
  fetchMeSettings,
  fetchMyProviders,
  fetchSharedProviders,
  patchAIDefault,
  probeMyProviderRaw,
  type AIDefaultSetting,
} from '../api/ai';
import type { AIProvider } from '../../admin/model/types';

export function AgentSettingsPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Agent</h2>

      <DefaultModelCard />
      <MyProvidersCard />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">
              <Zap size={14} className="settings-row__danger-icon" /> 紧急停止
            </div>
            <div className="settings-row__desc">全局快捷键立即中止所有 Agent 任务（D08 紧急停止）</div>
          </div>
          <kbd className="settings-row__kbd">⌘ ⇧ .</kbd>
        </div>
      </div>

      <div className="settings-card settings-card--static">
        <div className="settings-card__head">
          <div className="settings-card__name">三级记忆管理</div>
        </div>
        <div className="settings-card__desc">会话记忆 / 长期偏好 / 企业知识的查看与清除，入口在 /agent/memory（D08）实现后开放</div>
      </div>
    </div>
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

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await patchAIDefault(mode === 'org' ? { mode: 'org' } : { mode: 'provider', providerId: provId, model });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? getErrorText(err.code) : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card" data-testid="agent-default-model">
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__name">默认模型</div>
          <div className="settings-row__desc">新会话使用的模型；未指定时跟随公司默认（快/强档位自动路由）</div>
        </div>
        <Select
          size="small"
          style={{ width: 170 }}
          loading={!loaded}
          value={mode}
          onChange={(v) => {
            setMode(v);
            setSaved(false);
            if (v === 'provider' && !provId) {
              const first = all[0];
              if (first) setProvId(first.id);
            }
          }}
          options={[
            { value: 'org', label: '跟随公司默认' },
            { value: 'provider', label: '指定供应商与模型' },
          ]}
        />
      </div>
      {mode === 'provider' ? (
        <div className="settings-row">
          <div className="settings-row__text">
            <div className="settings-row__name">供应商 / 模型</div>
            <div className="settings-row__desc">公司统一接入或「我的供应商」；会话内可临时切换</div>
          </div>
          <Select
            size="small"
            style={{ width: 170, marginRight: 8 }}
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
            }}
            disabled={!provId}
            options={models.map((m) => ({ value: m.id, label: m.label ? `${m.label}（${m.id}）` : m.id }))}
          />
        </div>
      ) : null}
      <div className="settings-row">
        {error ? <span className="settings-form-error">{error}</span> : saved ? <span className="settings-row__desc">已保存</span> : null}
        <Button onClick={() => void save()} loading={saving} disabled={mode === 'provider' && (!provId || !model)}>
          保存
        </Button>
      </div>
    </div>
  );
}

/* ── 我的供应商卡片（BYOK） ── */

function MyProvidersCard() {
  const [mine, setMine] = useState<AIProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
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

  const probe = async () => {
    if (!baseUrl.trim()) {
      setError('先填 Base URL');
      return;
    }
    setProbing(true);
    setError('');
    try {
      const list = await probeMyProviderRaw(baseUrl.trim(), apiKey.trim());
      if (list.length === 0) setError('上游未返回模型清单');
      setCandidates(list);
    } catch (err) {
      setError(err instanceof ApiError ? getErrorText(err.code) : '探活失败');
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    const n = name.trim();
    const b = baseUrl.trim().replace(/\/+$/, '');
    if (!n || !b || models.length === 0) {
      setError('名称/Base URL/模型清单均必填（模型可「测试连通」拉取）');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await createMyProvider({ name: n, kind: 'openai_compatible', baseUrl: b, apiKey: apiKey.trim() || undefined, models: models.map((id) => ({ id })) });
      setName('');
      setBaseUrl('');
      setApiKey('');
      setCandidates([]);
      setModels([]);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? getErrorText(err.code) : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setError('');
    try {
      await deleteMyProvider(id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? getErrorText(err.code) : '删除失败');
    }
  };

  return (
    <div className="settings-card" data-testid="agent-my-providers">
      <div className="settings-card__head">
        <div className="settings-card__name">我的供应商</div>
        <div className="settings-card__desc">自带 API Key 的个人模型接入（≤5 个；仅自己可用，密钥服务端加密）</div>
      </div>
      {loaded ? (
        mine.length > 0 ? (
          <table className="admin-table" style={{ marginBottom: 10 }}>
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>模型</th>
                <th>密钥</th>
                <th style={{ width: 80 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="admin-mono">{p.baseUrl}</td>
                  <td>{p.models.map((m) => m.id).join('、')}</td>
                  <td className="admin-mono">{p.keyMask || '—'}</td>
                  <td>
                    <Button variant="danger" onClick={() => void remove(p.id)}>
                      <Trash2 size={13} /> 删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="settings-row__desc" style={{ marginBottom: 10 }}>
            尚未添加个人供应商——在下方录入（如 DeepSeek/Qwen/智谱的个人 Key）
          </div>
        )
      ) : null}
      <div className="admin-word-form">
        <input className="bbw-input" style={{ width: 140 }} value={name} placeholder="名称（如 我的DeepSeek）" onChange={(e) => setName(e.target.value)} />
        <input className="bbw-input" style={{ width: 230 }} value={baseUrl} placeholder="Base URL（https://…/v1）" onChange={(e) => setBaseUrl(e.target.value)} />
        <input className="bbw-input" style={{ width: 190 }} type="password" value={apiKey} placeholder="API Key" onChange={(e) => setApiKey(e.target.value)} />
        <Button variant="secondary" onClick={() => void probe()} loading={probing}>
          <PlugZap size={13} /> 测试连通
        </Button>
        <Button onClick={() => void submit()} loading={saving}>
          <Plus size={13} /> 添加
        </Button>
      </div>
      {candidates.length > 0 ? (
        <div className="admin-provider-models">
          {candidates.map((m) => (
            <button
              key={m}
              type="button"
              className={`admin-chip${models.includes(m) ? ' admin-chip--active' : ''}`}
              onClick={() => setModels((arr) => (arr.includes(m) ? arr.filter((x) => x !== m) : [...arr, m]))}
            >
              {m}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <div className="admin-error-bar">{error}</div> : null}
    </div>
  );
}
