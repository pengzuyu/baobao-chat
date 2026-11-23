/**
 * 开发者诊断面板（2026-11-23 开发者模式）：
 * - 错误/网络/事件/环境四视图，数据源 shared/log/devlog 环形缓冲（useSyncExternalStore）；
 * - ⌘⇧D / Ctrl+Shift+D 全局开关（App.tsx 热键）——生产包无 devtools 时的现场排查入口；
 * - 导出/清空/打开 WebView 调试台（Rust open_devtools）均为用户主动动作，零落流红线不动。
 * D26：全 antd 组件 + theme token；级别色走 antd Tag 预设（白名单）。
 */

import { useSyncExternalStore, useState, type CSSProperties } from 'react';
import { Badge, Drawer, Flex, Tabs, Tag, Typography, message, theme } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import pkg from '../../../package.json';
import { resolveWsBase } from '../api/ws';
import { Button } from './Button';
import {
  buildDevLogExport,
  clearDevLog,
  getDevLogEntries,
  getDevPanelOpen,
  setDevPanelOpen,
  subscribeDevLog,
  subscribeDevPanel,
  type DevLogEntry,
  type DevLogLevel,
} from '../log/devlog';

/** 级别 → antd Tag 预设色名（D27 白名单：Tag 预设色允许） */
const LEVEL_COLOR: Record<DevLogLevel, string> = { error: 'error', warn: 'warning', info: 'default' };

function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 单条导出/复制文案（message + stack + data 三段） */
function entryDetailText(entry: DevLogEntry): string {
  const lines = [`[${entry.level}] [${entry.source}] ${entry.message}`];
  if (entry.stack) lines.push(entry.stack);
  if (entry.data) lines.push(JSON.stringify(entry.data, null, 2));
  return lines.join('\n');
}

/** 单条日志行：时间 + 级别 Tag + 摘要；点击展开 stack/data 与复制按钮 */
function LogRow({ entry }: { entry: DevLogEntry }) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(entry.stack || entry.data);
  const mono: CSSProperties = {
    fontFamily: 'var(--bbc-font-mono)',
    fontSize: token.fontSizeSM,
    margin: 0,
    marginTop: 6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  };
  return (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <Flex
        gap={8}
        align="flex-start"
        style={{ cursor: expandable ? 'pointer' : 'default' }}
        onClick={() => (expandable ? setExpanded(!expanded) : undefined)}
      >
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {formatTs(entry.ts)}
        </Typography.Text>
        <Tag color={LEVEL_COLOR[entry.level]} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
          {entry.level}
        </Tag>
        <Typography.Text style={{ fontSize: token.fontSizeSM, wordBreak: 'break-word', flex: 1 }}>
          {entry.message}
        </Typography.Text>
      </Flex>
      {expanded ? (
        <div style={{ marginTop: 6 }}>
          <Button
            variant="text"
            size="small"
            onClick={() => void navigator.clipboard?.writeText(entryDetailText(entry))}
          >
            复制详情
          </Button>
          {entry.stack ? <pre style={mono}>{entry.stack}</pre> : null}
          {entry.data ? <pre style={mono}>{JSON.stringify(entry.data, null, 2)}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 日志列表（倒序：最新在最上） */
function LogList({ entries, emptyText }: { entries: readonly DevLogEntry[]; emptyText: string }) {
  const { token } = theme.useToken();
  if (entries.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, padding: '12px 0', display: 'block' }}>
        {emptyText}
      </Typography.Text>
    );
  }
  return (
    <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
      {[...entries].reverse().map((e) => (
        <LogRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

/** 环境 Tab：版本/构建模式/端点/UA + 主动操作（调试台/导出/清空） */
function EnvTab({ totalCount }: { totalCount: number }) {
  const { token } = theme.useToken();
  const [messageApi, contextHolder] = message.useMessage();
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const rows: Array<[string, string]> = [
    ['客户端版本', `v${pkg.version}`],
    ['构建模式', import.meta.env.DEV ? 'dev（开发）' : 'prod（生产）'],
    ['API 地址', String(import.meta.env.VITE_API_BASE ?? 'http://localhost:8080/api/v1（默认）')],
    ['WS 地址', resolveWsBase()],
    ['User-Agent', navigator.userAgent],
    ['日志条数', `${totalCount} / 500`],
  ];

  const openDevtools = async (): Promise<void> => {
    try {
      await invoke('open_devtools');
    } catch (e) {
      void messageApi.error(`打开 WebView 调试台失败：${String(e)}`);
    }
  };

  const exportLogs = (): void => {
    // 环境行并进导出包（字段名转 snake，与日志条目口径一致）
    const env: Record<string, unknown> = Object.fromEntries(rows.map(([k, v]) => [k, v]));
    const blob = new Blob([buildDevLogExport(env)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bbc-devlog-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    void messageApi.success('日志已导出');
  };

  return (
    <Flex vertical gap={12}>
      {contextHolder}
      {rows.map(([k, v]) => (
        <Flex key={k} justify="space-between" align="flex-start" gap={16}>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, flexShrink: 0 }}>
            {k}
          </Typography.Text>
          <Typography.Text style={{ fontSize: token.fontSizeSM, textAlign: 'right', wordBreak: 'break-all' }}>
            {v}
          </Typography.Text>
        </Flex>
      ))}
      <Flex gap={8} wrap="wrap" style={{ marginTop: 4 }}>
        {isTauri ? (
          <Button variant="secondary" size="small" onClick={() => void openDevtools()}>
            打开 WebView 调试台
          </Button>
        ) : null}
        <Button variant="secondary" size="small" onClick={exportLogs}>
          导出日志 JSON
        </Button>
        <Button variant="secondary" size="small" danger onClick={clearDevLog}>
          清空日志
        </Button>
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        日志仅存内存（重启即清）；导出文件含环境信息与全部条目，发给开发者即可离线排查。
        浏览器形态请直接用 F12 调试台。
      </Typography.Text>
    </Flex>
  );
}

function DevPanelBody() {
  const entries = useSyncExternalStore(subscribeDevLog, getDevLogEntries);
  const errors = entries.filter((e) => e.level !== 'info');
  const httpLogs = entries.filter((e) => e.source === 'http');
  const wsLogs = entries.filter((e) => e.source === 'ws');
  return (
    <Tabs
      size="small"
      items={[
        {
          key: 'errors',
          label: (
            <span>
              错误 <Badge count={errors.length} size="small" style={{ marginLeft: 2 }} />
            </span>
          ),
          children: <LogList entries={errors} emptyText="暂无错误或警告" />,
        },
        { key: 'http', label: `网络 ${httpLogs.length}`, children: <LogList entries={httpLogs} emptyText="暂无请求记录" /> },
        { key: 'ws', label: `事件 ${wsLogs.length}`, children: <LogList entries={wsLogs} emptyText="暂无连接事件" /> },
        { key: 'env', label: '环境', children: <EnvTab totalCount={entries.length} /> },
      ]}
    />
  );
}

/** 全局开发者面板（App 根部装配一次；destroyOnClose 关闭即释放订阅渲染） */
export function DevPanel() {
  const open = useSyncExternalStore(subscribeDevPanel, getDevPanelOpen);
  return (
    <Drawer
      title="开发者面板"
      placement="right"
      width={560}
      open={open}
      onClose={() => setDevPanelOpen(false)}
      destroyOnClose
      styles={{ body: { paddingTop: 4 } }}
    >
      {open ? <DevPanelBody /> : null}
    </Drawer>
  );
}
