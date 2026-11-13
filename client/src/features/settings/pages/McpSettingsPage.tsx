/**
 * 设置 · MCP 服务（D26 §7）：用户自配 MCP server（zcode 同款接入面）。
 * - 列表：启停/编辑/删除/测试连接（RT 真实链路回显工具清单）
 * - 编辑器：stdio（command/args/env）与 HTTP（url/headers）双形态；
 *   env/header 逐值「密文」→ 钥匙串（文件空串占位，真值不落盘）
 * - 变量族 D22 子集：${BBW_USER_TOKEN}（仅 HTTP 头；stdio env 置空）/
 *   ${BBW_USER_ID} / ${BBW_USER_NAME}
 * - 新增/修改后需重启会话工具才进模型列表（注册表快照限制，同插件口径）
 */

import { useEffect, useState } from 'react';
import { Pencil, PlugZap, Plus, Save, Server, ShieldAlert, Trash2, Undo2 } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import {
  fetchPersonalMcp,
  isMcpUiAvailable,
  removePersonalMcp,
  setPersonalMcpEnabled,
  testMcpConnection,
  upsertPersonalMcp,
  type McpTestResult,
  type PersonalMcpServer,
} from '../api/mcp';

/** 键值行（env/headers 共用）：key / value / 密文勾选 */
interface KvRow {
  key: string;
  value: string;
  secret: boolean;
}

const emptyKv = (): KvRow => ({ key: '', value: '', secret: false });

const rowsOf = (map: Record<string, string> | undefined, secretKeys: string[] | undefined): KvRow[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value, secret: secretKeys?.includes(key) ?? false }));

export function McpSettingsPage() {
  return (
    <div className="settings-section">
      <h2 className="settings-section__title">MCP 服务</h2>
      <McpServersCard />
    </div>
  );
}

function McpServersCard() {
  const [list, setList] = useState<PersonalMcpServer[] | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busyName, setBusyName] = useState('');
  const [results, setResults] = useState<Record<string, McpTestResult>>({});
  const [editing, setEditing] = useState<PersonalMcpServer | null>(null); // null=列表态；对象=编辑该条（name 禁改）

  const reload = async () => {
    try {
      setList(await fetchPersonalMcp());
    } catch {
      setList([]);
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const doTest = (name: string) => {
    setBusyName(name);
    setError('');
    void testMcpConnection(name)
      .then((r) => setResults((prev) => ({ ...prev, [name]: r })))
      .catch((err) => setError(`测试失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusyName(''));
  };

  const doToggle = (s: PersonalMcpServer, enabled: boolean) => {
    setBusyName(s.name);
    setError('');
    void setPersonalMcpEnabled(s.name, enabled)
      .then(() => {
        setNotice(`${s.name} 已${enabled ? '启用' : '禁用'}`);
        return reload();
      })
      .catch((err) => setError(`操作失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusyName(''));
  };

  const doRemove = (s: PersonalMcpServer) => {
    if (!window.confirm(`删除 ${s.name}？本地配置与钥匙串密文将一并清除`)) return;
    setBusyName(s.name);
    setError('');
    void removePersonalMcp(s.name)
      .then(() => {
        setNotice(`${s.name} 已删除`);
        if (editing?.name === s.name) setEditing(null);
        return reload();
      })
      .catch((err) => setError(`删除失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusyName(''));
  };

  return (
    <div className="settings-card" data-testid="settings-mcp">
      <div className="settings-card__head">
        <div className="settings-card__name">
          <Server size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> 个人 MCP 服务
        </div>
        <div className="settings-card__desc">
          自配 MCP server 接入 Agent（仅本人生效）：stdio 本地命令或 HTTP(S) 端点，工具以 mcp.名称.* 进入会话。
          变量：{'${BBW_USER_TOKEN}'}（仅 HTTP 头，stdio 环境变量置空）/ {'${BBW_USER_ID}'} / {'${BBW_USER_NAME}'}。
          新增或修改后需重启会话，工具才会进入模型工具列表（与插件同口径）。
        </div>
      </div>

      {isMcpUiAvailable() ? null : (
        <div className="settings-row__desc" style={{ marginBottom: 8 }}>
          当前为 Web 预览环境——个人 MCP 配置仅桌面端可用
        </div>
      )}

      {list === null ? null : list.length > 0 ? (
        <table className="admin-table" style={{ marginBottom: 10 }}>
          <thead>
            <tr>
              <th>名称</th>
              <th>形态</th>
              <th>端点 / 命令</th>
              <th>状态</th>
              <th style={{ width: 260 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const r = results[s.name];
              return (
                <tr key={s.name}>
                  <td>
                    <span className="admin-mono">{s.name}</span>
                    {s.usesIdentity ? (
                      <span className="settings-row__desc" style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#b45309' }}>
                        <ShieldAlert size={12} /> 将以你的身份调用
                      </span>
                    ) : null}
                    {s.note ? <span className="settings-row__desc">{s.note}</span> : null}
                  </td>
                  <td>{s.kind === 'stdio' ? 'stdio' : s.url?.startsWith('https://') ? 'HTTPS' : 'HTTP'}</td>
                  <td className="admin-mono">{s.kind === 'stdio' ? s.command : s.url}</td>
                  <td>{s.enabled ? '已启用' : '已禁用'}</td>
                  <td>
                    <Button variant="secondary" onClick={() => doTest(s.name)} loading={busyName === s.name}>
                      <PlugZap size={13} /> 测试
                    </Button>{' '}
                    <Button variant="secondary" onClick={() => doToggle(s, !s.enabled)}>
                      {s.enabled ? '禁用' : '启用'}
                    </Button>{' '}
                    <Button variant="secondary" onClick={() => setEditing(s)}>
                      <Pencil size={12} /> 编辑
                    </Button>{' '}
                    <Button variant="danger" onClick={() => doRemove(s)}>
                      <Trash2 size={13} /> 删除
                    </Button>
                    {r ? (
                      <div className="settings-row__desc" style={{ marginTop: 4 }}>
                        {r.ok ? (
                          <>✅ 连接成功（{r.tools.length} 个工具{r.tools.length ? `：${r.tools.slice(0, 5).join('、')}${r.tools.length > 5 ? ' …' : ''}` : ''}）</>
                        ) : (
                          <>❌ {r.error ?? '连接失败'}</>
                        )}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="settings-row__desc" style={{ marginBottom: 10 }}>
          尚未登记个人 MCP server——在下方添加（如内网工具网关、公网 https MCP 服务或本机 stdio 命令）
        </div>
      )}

      {editing ? <McpEditForm initial={editing} onDone={() => { setEditing(null); void reload(); }} onCancel={() => setEditing(null)} /> : <McpAddEntry onAdd={(s) => setEditing(s)} />}

      {notice ? (
        <div className="settings-row__desc" style={{ marginTop: 6 }}>
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="admin-error-bar" style={{ marginTop: 6 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** 列表态的「添加」入口（点开编辑器） */
function McpAddEntry({ onAdd }: { onAdd: (s: PersonalMcpServer) => void }) {
  return (
    <Button variant="secondary" onClick={() => onAdd({ name: '', enabled: true, kind: 'http', url: '' })}>
      <Plus size={13} /> 添加 MCP server
    </Button>
  );
}

/** 编辑器：新增（initial.name 空）/编辑（name 禁改）。密文值留空=保持旧值 */
function McpEditForm({ initial, onDone, onCancel }: { initial: PersonalMcpServer; onDone: () => void; onCancel: () => void }) {
  const isEdit = initial.name !== '';
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState<'stdio' | 'http'>(initial.kind);
  const [note, setNote] = useState(initial.note ?? '');
  const [command, setCommand] = useState(initial.command ?? '');
  const [argsText, setArgsText] = useState((initial.args ?? []).join('\n'));
  const [url, setUrl] = useState(initial.url ?? '');
  const [envRows, setEnvRows] = useState<KvRow[]>(rowsOf(initial.env, initial.secretKeys));
  const [headerRows, setHeaderRows] = useState<KvRow[]>(rowsOf(initial.headers, initial.secretKeys));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const rows = kind === 'stdio' ? envRows : headerRows;
  const setRows = kind === 'stdio' ? setEnvRows : setHeaderRows;

  const patchRow = (i: number, patch: Partial<KvRow>) => {
    setRows((arr) => arr.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const submit = async () => {
    const n = name.trim();
    if (!n) {
      setError('名称必填（字母数字开头，字母数字/_/-，≤64；corp 保留）');
      return;
    }
    if (kind === 'stdio' && !command.trim()) {
      setError('stdio 形态缺少 command');
      return;
    }
    if (kind === 'http' && !(url.trim().startsWith('http://') || url.trim().startsWith('https://'))) {
      setError('HTTP 形态 url 须为 http(s)://…');
      return;
    }
    const kv: Record<string, string> = {};
    const secretKeys: string[] = [];
    const secretValues: Record<string, string> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue; // 空行忽略
      if (k in kv) {
        setError(`键名重复：${k}`);
        return;
      }
      kv[k] = r.secret ? '' : r.value; // 密文=空串占位（真值走 secretValues/钥匙串）
      if (r.secret) {
        secretKeys.push(k);
        secretValues[k] = r.value; // 空=保持旧值（壳侧不覆盖）
      }
    }
    setSaving(true);
    setError('');
    try {
      await upsertPersonalMcp(
        {
          name: n,
          enabled: initial.enabled,
          kind,
          command: kind === 'stdio' ? command.trim() : undefined,
          args: kind === 'stdio' ? argsText.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
          env: kind === 'stdio' ? kv : undefined,
          url: kind === 'http' ? url.trim() : undefined,
          headers: kind === 'http' ? kv : undefined,
          secretKeys,
          note: note.trim() || undefined,
        },
        secretValues,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-word-form" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="bbw-input" style={{ width: 150 }} value={name} placeholder="名称（mcp.名称.*）" disabled={isEdit} onChange={(e) => setName(e.target.value)} title={isEdit ? '名称为身份键，编辑不可改（删除后重建）' : undefined} />
        <select className="bbw-input" style={{ width: 110 }} value={kind} onChange={(e) => setKind(e.target.value as 'stdio' | 'http')}>
          <option value="http">HTTP(S)</option>
          <option value="stdio">stdio</option>
        </select>
        <input className="bbw-input" style={{ width: 200 }} value={note} placeholder="备注（可选）" onChange={(e) => setNote(e.target.value)} />
      </div>
      {kind === 'http' ? (
        <input className="bbw-input" style={{ width: 420 }} value={url} placeholder="https://mcp.example.com/mcp（或内网 http://…）" onChange={(e) => setUrl(e.target.value)} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="bbw-input" style={{ width: 200 }} value={command} placeholder="命令（如 node / npx -y …）" onChange={(e) => setCommand(e.target.value)} />
            <textarea className="bbw-input" style={{ width: 420, height: 44, resize: 'vertical' }} value={argsText} placeholder={'参数（每行一个，支持绝对路径）'} onChange={(e) => setArgsText(e.target.value)} />
          </div>
        </>
      )}
      <div className="settings-row__desc">
        {kind === 'http' ? '请求头（鉴权如 Authorization / X-Api-Key；值支持 ${BBW_USER_TOKEN} 动态注入）' : '环境变量（值支持 ${BBW_USER_ID}/${BBW_USER_NAME}；TOKEN 不进子进程环境——HTTP-only）'}——勾选「密文」的值存钥匙串不落盘，留空=保持旧值
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="bbw-input" style={{ width: 170 }} value={r.key} placeholder="键名" onChange={(e) => patchRow(i, { key: e.target.value })} />
          <input
            className="bbw-input"
            style={{ width: 300 }}
            type={r.secret ? 'password' : 'text'}
            value={r.value}
            placeholder={r.secret && isEdit && r.value === '' ? '已存密文（不改则留空）' : '值'}
            onChange={(e) => patchRow(i, { value: e.target.value })}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-2, #666)' }}>
            <input type="checkbox" checked={r.secret} onChange={(e) => patchRow(i, { secret: e.target.checked })} /> 密文
          </label>
          <Button variant="secondary" onClick={() => setRows((arr) => arr.filter((_, idx) => idx !== i))}>
            <Trash2 size={12} />
          </Button>
        </div>
      ))}
      <div>
        <Button variant="secondary" onClick={() => setRows((arr) => [...arr, emptyKv()])}>
          <Plus size={12} /> 加一行
        </Button>{' '}
        <Button onClick={() => void submit()} loading={saving}>
          {isEdit ? <Save size={13} /> : <Plus size={13} />} {isEdit ? '保存修改' : '添加'}
        </Button>{' '}
        <Button variant="secondary" onClick={onCancel}>
          <Undo2 size={13} /> 取消
        </Button>
      </div>
      {error ? <div className="settings-form-error">{error}</div> : null}
    </div>
  );
}
