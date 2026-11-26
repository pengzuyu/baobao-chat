/**
 * 设置 · MCP 服务（D26 §7）：用户自配 MCP server（zcode 同款接入面）。
 * - 列表：启停/编辑/删除/测试连接（RT 真实链路回显工具清单）
 * - 编辑器：stdio（command/args/env）与 HTTP（url/headers）双形态；
 *   env/header 逐值「密文」→ 钥匙串（文件空串占位，真值不落盘）
 * - 变量族 D22 子集：${BBC_USER_TOKEN}（仅 HTTP 头；stdio env 置空；2026-11-26
 *   头行尾「平台凭证」快捷填入）/${BBC_USER_ID} / ${BBC_USER_NAME}
 * - 新增/修改后需重启会话工具才进模型列表（注册表快照限制，同插件口径）
 * D26-O3：服务表→Table、编辑器控件→Input/TextArea/Select/Checkbox、删除走 Modal.confirm（settings-、admin-、bbc- 系自研类退役）。
 */

import { useEffect, useState } from 'react';
import { Alert, Card, Checkbox, Input, Modal, Select, Space, Table, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { KeyRound, Pencil, PlugZap, Plus, Save, Server, ShieldAlert, Trash2, Undo2 } from 'lucide-react';
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

/** 平台凭证占位（RT 调用层按受众票逐请求动态注入——D38 单票制）；HTTP 头行快捷填充写此值 */
const PLATFORM_TOKEN = '${BBC_USER_TOKEN}';

const rowsOf = (map: Record<string, string> | undefined, secretKeys: string[] | undefined): KvRow[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value, secret: secretKeys?.includes(key) ?? false }));

export function McpSettingsPage() {
  return (
    <div>
      <Typography.Title level={5} style={{ margin: 0, marginBottom: 16 }}>
        MCP 服务
      </Typography.Title>
      <McpServersCard />
    </div>
  );
}

function McpServersCard() {
  const { token } = theme.useToken();
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
    Modal.confirm({
      title: `删除 MCP 服务「${s.name}」？`,
      content: '本地配置与钥匙串密文将一并清除',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setError('');
        try {
          await removePersonalMcp(s.name);
          setNotice(`${s.name} 已删除`);
          if (editing?.name === s.name) setEditing(null);
          await reload();
        } catch (err) {
          setError(`删除失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  };

  const columns: ColumnsType<PersonalMcpServer> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (_, s) => (
        <div>
          <Typography.Text code>{s.name}</Typography.Text>
          {s.usesIdentity ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: token.colorWarning, fontSize: 12 }}>
              <ShieldAlert size={12} /> 将以你的身份调用
            </span>
          ) : null}
          {s.note ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {s.note}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '形态',
      key: 'kind',
      width: 80,
      render: (_, s) => (s.kind === 'stdio' ? 'stdio' : s.url?.startsWith('https://') ? 'HTTPS' : 'HTTP'),
    },
    {
      title: '端点 / 命令',
      key: 'endpoint',
      render: (_, s) => <Typography.Text code>{s.kind === 'stdio' ? s.command : s.url}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '已启用' : '已禁用'}</Tag>,
    },
    {
      title: '操作',
      key: 'ops',
      width: 300,
      render: (_, s) => {
        const r = results[s.name];
        return (
          <div>
            <Space size={4} wrap>
              <Button variant="secondary" size="small" onClick={() => doTest(s.name)} loading={busyName === s.name}>
                <PlugZap size={12} /> 测试
              </Button>
              <Button variant="secondary" size="small" onClick={() => doToggle(s, !s.enabled)}>
                {s.enabled ? '禁用' : '启用'}
              </Button>
              <Button variant="secondary" size="small" onClick={() => setEditing(s)}>
                <Pencil size={12} /> 编辑
              </Button>
              <Button variant="danger" size="small" onClick={() => doRemove(s)}>
                <Trash2 size={12} /> 删除
              </Button>
            </Space>
            {r ? (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                {r.ok ? (
                  <>✅ 连接成功（{r.tools.length} 个工具{r.tools.length ? `：${r.tools.slice(0, 5).join('、')}${r.tools.length > 5 ? ' …' : ''}` : ''}）</>
                ) : (
                  <>❌ {r.error ?? '连接失败'}</>
                )}
              </Typography.Text>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <Card size="small" data-testid="settings-mcp" title={<Space size={6}><Server size={14} /> 个人 MCP 服务</Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        自配 MCP server 接入 Agent（仅本人生效）：stdio 本地命令或 HTTP(S) 端点，工具以 mcp.名称.* 进入会话。
        变量：{'${BBC_USER_TOKEN}'}（仅 HTTP 头，stdio 环境变量置空）/ {'${BBC_USER_ID}'} / {'${BBC_USER_NAME}'}。
        新增或修改后需重启会话，工具才会进入模型工具列表（与插件同口径）。
      </Typography.Paragraph>

      {isMcpUiAvailable() ? null : (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          当前为 Web 预览环境——个人 MCP 配置仅桌面端可用
        </Typography.Text>
      )}

      {list === null ? null : list.length > 0 ? (
        <Table<PersonalMcpServer> rowKey="name" size="small" columns={columns} dataSource={list} pagination={false} style={{ marginBottom: 10 }} />
      ) : (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>
          尚未登记个人 MCP server——在下方添加（如内网工具网关、公网 https MCP 服务或本机 stdio 命令）
        </Typography.Text>
      )}

      {editing ? <McpEditForm initial={editing} onDone={() => { setEditing(null); void reload(); }} onCancel={() => setEditing(null)} /> : <McpAddEntry onAdd={(s) => setEditing(s)} />}

      {notice ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
          {notice}
        </Typography.Text>
      ) : null}
      {error ? <Alert type="error" showIcon message={error} style={{ marginTop: 6 }} /> : null}
    </Card>
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
  // D38：统一身份（HTTP 形态可选——以我的身份调用，宿主自动注入 agent 票，无需任何 key）
  const [useIdentity, setUseIdentity] = useState(initial['x-bbc-auth']?.type === 'obo');
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
          'x-bbc-auth':
            kind === 'http' && useIdentity ? { type: 'obo' as const } : undefined,
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
    <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 4 }}>
      <Space size={8} wrap>
        <Input
          style={{ width: 150 }}
          value={name}
          placeholder="名称（mcp.名称.*）"
          disabled={isEdit}
          onChange={(e) => setName(e.target.value)}
          title={isEdit ? '名称为身份键，编辑不可改（删除后重建）' : undefined}
        />
        <Select
          style={{ width: 110 }}
          value={kind}
          onChange={(v) => setKind(v as 'stdio' | 'http')}
          options={[
            { value: 'http', label: 'HTTP(S)' },
            { value: 'stdio', label: 'stdio' },
          ]}
        />
        <Input style={{ width: 200 }} value={note} placeholder="备注（可选）" onChange={(e) => setNote(e.target.value)} />
      </Space>
      {kind === 'http' ? (
        <>
          <Input style={{ width: 420 }} value={url} placeholder="https://mcp.example.com/mcp（或内网 http://…）" onChange={(e) => setUrl(e.target.value)} />
          <Checkbox checked={useIdentity} onChange={(e) => setUseIdentity(e.target.checked)}>
            以我的身份调用（统一认证——自动注入登录凭证，应用无需发放任何 key/token）
          </Checkbox>
        </>
      ) : (
        <Space size={8} wrap>
          <Input style={{ width: 200 }} value={command} placeholder="命令（如 node / npx -y …）" onChange={(e) => setCommand(e.target.value)} />
          <Input.TextArea
            style={{ width: 420 }}
            autoSize={{ minRows: 2, maxRows: 6 }}
            value={argsText}
            placeholder={'参数（每行一个，支持绝对路径）'}
            onChange={(e) => setArgsText(e.target.value)}
          />
        </Space>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {kind === 'http'
          ? '请求头（外部系统自带鉴权如 Authorization / X-Api-Key）：点行尾「平台凭证」快捷填入 ${BBC_USER_TOKEN}——调用时自动注入平台签发的身份票据（仅平台生态内服务可验证；第三方系统请粘贴其签发的 token）；免配置自动 Bearer 优先勾上方「以我的身份调用」；${CONFIG:key} 引插件/个人密钥'
          : '环境变量（值支持 ${BBC_USER_ID}/${BBC_USER_NAME}；TOKEN 不进子进程环境——stdio 无需任何令牌）'}
        ——勾选「密文」的值存钥匙串不落盘，留空=保持旧值
      </Typography.Text>
      {rows.map((r, i) => (
        <Space key={i} size={8} align="center" wrap={false}>
          <Input style={{ width: 170 }} value={r.key} placeholder="键名" onChange={(e) => patchRow(i, { key: e.target.value })} />
          <Input
            style={{ width: 300 }}
            type={r.secret ? 'password' : 'text'}
            value={r.value}
            placeholder={r.secret && isEdit && r.value === '' ? '已存密文（不改则留空）' : '值'}
            onChange={(e) => patchRow(i, { value: e.target.value })}
            addonAfter={
              kind === 'http' ? (
                <Button
                  variant="text"
                  size="small"
                  icon={<KeyRound size={12} aria-hidden />}
                  title="填入平台凭证——调用时自动注入平台签发的身份票据（仅平台生态内服务可验证）"
                  onClick={() => patchRow(i, { value: PLATFORM_TOKEN })}
                >
                  平台凭证
                </Button>
              ) : undefined
            }
          />
          <Checkbox checked={r.secret} onChange={(e) => patchRow(i, { secret: e.target.checked })}>
            密文
          </Checkbox>
          <Button variant="secondary" size="small" icon={<Trash2 size={12} />} onClick={() => setRows((arr) => arr.filter((_, idx) => idx !== i))} />
        </Space>
      ))}
      <Space size={8} wrap>
        <Button variant="secondary" onClick={() => setRows((arr) => [...arr, emptyKv()])}>
          <Plus size={12} /> 加一行
        </Button>
        <Button onClick={() => void submit()} loading={saving}>
          {isEdit ? <Save size={13} /> : <Plus size={13} />} {isEdit ? '保存修改' : '添加'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          <Undo2 size={13} /> 取消
        </Button>
      </Space>
      {error ? <Alert type="error" showIcon message={error} /> : null}
    </Space>
  );
}
