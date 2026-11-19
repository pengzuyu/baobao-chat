/**
 * 工作日日历（D35 /admin/calendar）：管理员统一维护租户日历。
 * - 默认规则=周一~五工作日、六日周末；本页只编辑“例外”（节假日/调休上班/手工改的周末）
 * - 12 个月迷你日历（三色 + 名称），点击单日弹面板改类型/名称，支持区间批量、整月快捷、恢复默认
 * - 导入：粘贴/选择 JSON → 差异预览（dryRun）→ 确认；导出：全年合并 JSON
 * 内网口径：服务端不调外网接口，节假日数据由外网机产出 JSON 后 Import。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Dropdown, Flex, Input, Modal, Select, Space, Tag, Typography, theme } from 'antd';
import type { MenuProps } from 'antd';
import { CalendarDays, Download, Ellipsis, Upload } from 'lucide-react';
import { errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import {
  fetchWorkdayYear,
  importWorkday,
  resetWorkdayDays,
  upsertWorkdayDays,
  type WorkdayDay,
  type WorkdayDayInput,
  type WorkdayImportResult,
  type WorkdayType,
} from '../api/workday';

const TYPE_LABEL: Record<WorkdayType, string> = {
  workday: '工作日',
  weekend: '周末',
  holiday: '节假日',
};

const TYPE_OPTIONS = [
  { value: 'workday', label: '工作日（含调休上班）' },
  { value: 'weekend', label: '周末' },
  { value: 'holiday', label: '节假日' },
] as const;

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

/** 默认规则：周六日=周末，其余=工作日（与服务端一致） */
function defaultTypeOf(date: string): WorkdayType {
  const wd = new Date(`${date}T00:00:00`).getDay();
  return wd === 0 || wd === 6 ? 'weekend' : 'workday';
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  for (let t = start; t <= end; t = new Date(t.getTime() + 86_400_000)) {
    out.push(
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    );
  }
  return out;
}

function monthDates(year: number, month: number): string[] {
  const days = new Date(year, month, 0).getDate(); // month: 1-12
  return Array.from(
    { length: days },
    (_, i) => `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
  );
}

export function CalendarPage() {
  const { token } = theme.useToken();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [days, setDays] = useState<WorkdayDay[] | null>(null);
  /** 未保存编辑：date → 新值；null=恢复默认 */
  const [pending, setPending] = useState<Map<string, WorkdayDay | null>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [editDate, setEditDate] = useState<string | null>(null);
  const [editType, setEditType] = useState<WorkdayType>('workday');
  const [editName, setEditName] = useState('');

  const [batchOpen, setBatchOpen] = useState(false);
  const [batchFrom, setBatchFrom] = useState('');
  const [batchTo, setBatchTo] = useState('');
  const [batchType, setBatchType] = useState<WorkdayType>('holiday');

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [preview, setPreview] = useState<WorkdayImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = useCallback(async (y: number) => {
    setError(null);
    try {
      const res = await fetchWorkdayYear(y);
      setDays(res.days);
      setPending(new Map());
    } catch (e) {
      setError(errText(e, '日历加载失败'));
      setDays(null);
    }
  }, []);

  useEffect(() => {
    void reload(year);
  }, [reload, year]);

  // 合并未保存编辑后的视图
  const view = useMemo(() => {
    if (!days) return null;
    return days.map((d) => {
      if (!pending.has(d.date)) return d;
      const p = pending.get(d.date);
      if (p === undefined) return d;
      if (p === null) return { date: d.date, type: defaultTypeOf(d.date), name: '', source: 'default' as const };
      return { date: p.date, type: p.type, name: p.name, source: 'manual' as const };
    });
  }, [days, pending]);

  const byMonth = useMemo(() => {
    const map = new Map<string, WorkdayDay[]>();
    for (const d of view ?? []) {
      const ym = d.date.slice(0, 7);
      const arr = map.get(ym);
      if (arr) arr.push(d);
      else map.set(ym, [d]);
    }
    return map;
  }, [view]);

  const stats = useMemo(() => {
    const s = { workday: 0, weekend: 0, holiday: 0 };
    for (const d of view ?? []) s[d.type]++;
    return s;
  }, [view]);

  const patchDay = (date: string, next: WorkdayDay | null) => {
    setPending((prev) => {
      const m = new Map(prev);
      m.set(date, next);
      return m;
    });
    setOk(null);
  };

  const openEdit = (d: WorkdayDay) => {
    setEditDate(d.date);
    setEditType(d.type);
    setEditName(d.name);
  };

  const saveEdit = () => {
    if (!editDate) return;
    patchDay(editDate, { date: editDate, type: editType, name: editName.trim(), source: 'manual' });
    setEditDate(null);
  };

  const resetEdit = () => {
    if (!editDate) return;
    patchDay(editDate, null);
    setEditDate(null);
  };

  const applyBatch = (dates: string[], type: WorkdayType | 'reset') => {
    setPending((prev) => {
      const m = new Map(prev);
      for (const date of dates) {
        m.set(date, type === 'reset' ? null : { date, type, name: '', source: 'manual' });
      }
      return m;
    });
    setOk(null);
  };

  const submitBatch = () => {
    if (!batchFrom || !batchTo || batchFrom > batchTo) {
      setError('请选择合法日期区间');
      return;
    }
    applyBatch(dateRange(batchFrom, batchTo), batchType);
    setBatchOpen(false);
  };

  const save = async () => {
    if (pending.size === 0) return;
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      const upserts: WorkdayDayInput[] = [];
      const resets: string[] = [];
      pending.forEach((v, date) => {
        if (v === null) resets.push(date);
        else upserts.push({ date, type: v.type, name: v.name });
      });
      if (upserts.length > 0) await upsertWorkdayDays(year, upserts);
      if (resets.length > 0) await resetWorkdayDays(year, resets);
      await reload(year);
      setOk(`已保存（设置 ${upserts.length} 天，恢复默认 ${resets.length} 天）`);
    } catch (e) {
      setError(errText(e, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const monthMenu = (): MenuProps['items'] => [
    { key: 'workday', label: '整月设为工作日' },
    { key: 'weekend', label: '整月设为周末' },
    { key: 'holiday', label: '整月设为节假日' },
    { type: 'divider' },
    { key: 'reset', label: '整月恢复默认' },
  ];

  const onMonthMenu = (month: number, key: string) => {
    const dates = monthDates(year, month);
    applyBatch(dates, key === 'reset' ? 'reset' : (key as WorkdayType));
  };

  const exportJson = () => {
    if (!view) return;
    const payload = {
      version: 1,
      year,
      region: 'CN',
      days: view.map((d) => ({ date: d.date, type: d.type, name: d.name })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workday-calendar-${year}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseImport = (): WorkdayDayInput[] | null => {
    try {
      const raw = JSON.parse(importText) as unknown;
      const list = Array.isArray(raw)
        ? raw
        : (raw as { days?: unknown }).days;
      if (!Array.isArray(list)) throw new Error('缺少 days 数组');
      return list.map((x) => {
        const r = x as { date?: string; type?: string; name?: string };
        if (!r.date || !r.type) throw new Error('条目缺 date/type');
        if (!['workday', 'weekend', 'holiday'].includes(r.type)) throw new Error(`类型非法: ${r.type}`);
        return { date: r.date, type: r.type as WorkdayType, name: r.name ?? '' };
      });
    } catch (e) {
      setError(e instanceof Error ? `JSON 解析失败：${e.message}` : 'JSON 解析失败');
      return null;
    }
  };

  const runPreview = async () => {
    const list = parseImport();
    if (!list) return;
    setImporting(true);
    setError(null);
    setPreview(null);
    try {
      const res = await importWorkday(year, importMode, list, true);
      setPreview(res);
    } catch (e) {
      setError(errText(e, '预览失败'));
    } finally {
      setImporting(false);
    }
  };

  const runImport = async () => {
    const list = parseImport();
    if (!list) return;
    setImporting(true);
    setError(null);
    try {
      await importWorkday(year, importMode, list, false);
      setImportOpen(false);
      setImportText('');
      setPreview(null);
      await reload(year);
      setOk('导入完成');
    } catch (e) {
      setError(errText(e, '导入失败'));
    } finally {
      setImporting(false);
    }
  };

  const pickFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
  };

  const cellBg = (d: WorkdayDay): string => {
    const override = d.source !== 'default';
    if (d.type === 'holiday') return token.colorErrorBg;
    if (d.type === 'weekend') return override ? token.colorFillSecondary : token.colorFillTertiary;
    return override ? token.colorPrimaryBg : 'transparent';
  };

  const cellBorder = (d: WorkdayDay): string => {
    if (d.source === 'default') return 'transparent';
    if (d.type === 'holiday') return token.colorErrorBorder;
    if (d.type === 'weekend') return token.colorBorder;
    return token.colorPrimaryBorder;
  };

  return (
    <div data-testid="admin-calendar">
      <Flex align="center" gap={8} style={{ marginBottom: 12 }} wrap>
        <CalendarDays size={18} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          工作日日历
        </Typography.Title>
        <Select
          size="small"
          style={{ width: 110 }}
          value={year}
          onChange={(y) => setYear(y)}
          options={Array.from({ length: 5 }, (_, i) => thisYear - 2 + i).map((y) => ({
            value: y,
            label: `${y} 年`,
          }))}
        />
        <div style={{ flex: 1 }} />
        <Space>
          <Button variant="secondary" size="small" onClick={() => setBatchOpen(true)}>
            区间批量
          </Button>
          <Button variant="secondary" size="small" icon={<Upload size={14} />} onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Button variant="secondary" size="small" icon={<Download size={14} />} onClick={exportJson} disabled={!view}>
            导出
          </Button>
          <Button variant="primary" size="small" loading={saving} disabled={pending.size === 0} onClick={() => void save()}>
            保存{pending.size > 0 ? `（${pending.size}）` : ''}
          </Button>
        </Space>
      </Flex>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}
      {ok ? <Alert type="success" showIcon message={ok} style={{ marginBottom: 8 }} /> : null}

      <Flex gap={12} wrap style={{ marginBottom: 10, color: token.colorTextSecondary, fontSize: 12 }}>
        <span>
          <Tag color="blue">工作日</Tag> 默认周一~周五；调休上班也记工作日
        </span>
        <span>
          <Tag>周末</Tag> 默认周六/周日
        </span>
        <span>
          <Tag color="red">节假日</Tag>
        </span>
        <span>浅色=默认规则，描边=管理员已设置</span>
        <span style={{ flex: 1 }} />
        <span>
          今年：工作日 {stats.workday} 天 · 周末 {stats.weekend} 天 · 节假日 {stats.holiday} 天
        </span>
      </Flex>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
          gap: 12,
        }}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
          const ym = `${year}-${String(month).padStart(2, '0')}`;
          const list = byMonth.get(ym) ?? monthDates(year, month).map((date) => ({
            date,
            type: defaultTypeOf(date),
            name: '',
            source: 'default' as const,
          }));
          const firstWd = (new Date(`${ym}-01T00:00:00`).getDay() + 6) % 7; // 周一=0
          return (
            <div
              key={ym}
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 8,
                padding: 8,
                background: token.colorBgContainer,
              }}
            >
              <Flex align="center" justify="space-between" style={{ marginBottom: 6 }}>
                <Typography.Text strong>{month} 月</Typography.Text>
                <Dropdown menu={{ items: monthMenu(), onClick: ({ key }) => onMonthMenu(month, key) }}>
                  <Button variant="text" size="small" icon={<Ellipsis size={14} />} />
                </Dropdown>
              </Flex>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
                {WEEK_LABEL.map((w) => (
                  <span key={w} style={{ fontSize: 10, color: token.colorTextTertiary }}>
                    {w}
                  </span>
                ))}
                {Array.from({ length: firstWd }, (_, i) => (
                  <span key={`b${i}`} />
                ))}
                {list.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    title={`${d.date} ${TYPE_LABEL[d.type]}${d.name ? ` ${d.name}` : ''}${
                      d.source === 'default' ? '（默认）' : '（已设置）'
                    }`}
                    onClick={() => openEdit(d)}
                    style={{
                      border: 'none',
                      background: cellBg(d),
                      boxShadow: `inset 0 0 0 1px ${cellBorder(d)}`,
                      borderRadius: 4,
                      padding: '2px 1px',
                      cursor: 'pointer',
                      minHeight: 32,
                      color: d.type === 'holiday' ? token.colorErrorText : token.colorText,
                      lineHeight: 1.1,
                    }}
                  >
                    <div style={{ fontSize: 12 }}>{Number(d.date.slice(8))}</div>
                    {d.name ? (
                      <div
                        style={{
                          fontSize: 9,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: token.colorTextSecondary,
                        }}
                      >
                        {d.name}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={editDate !== null}
        title={editDate ? `编辑 ${editDate}` : ''}
        onCancel={() => setEditDate(null)}
        footer={
          <Flex gap={8} justify="flex-end">
            <Button variant="secondary" onClick={resetEdit}>
              恢复默认
            </Button>
            <Button variant="secondary" onClick={() => setEditDate(null)}>
              取消
            </Button>
            <Button variant="primary" onClick={saveEdit}>
              确定
            </Button>
          </Flex>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            value={editType}
            onChange={(v) => setEditType(v)}
            options={TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <Input
            placeholder="名称（可选，如：国庆节 / 调休上班）"
            maxLength={40}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        open={batchOpen}
        title="区间批量设置"
        onCancel={() => setBatchOpen(false)}
        footer={
          <Flex gap={8} justify="flex-end">
            <Button variant="secondary" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={submitBatch}>
              应用
            </Button>
          </Flex>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Flex gap={8}>
            <input
              type="date"
              value={batchFrom}
              min={`${year}-01-01`}
              max={`${year}-12-31`}
              onChange={(e) => setBatchFrom(e.target.value)}
              style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: `1px solid ${token.colorBorder}` }}
            />
            <span style={{ alignSelf: 'center' }}>至</span>
            <input
              type="date"
              value={batchTo}
              min={`${year}-01-01`}
              max={`${year}-12-31`}
              onChange={(e) => setBatchTo(e.target.value)}
              style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: `1px solid ${token.colorBorder}` }}
            />
          </Flex>
          <Select
            style={{ width: '100%' }}
            value={batchType}
            onChange={(v) => setBatchType(v)}
            options={TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            应用后点顶部「保存」生效。
          </Typography.Text>
        </Space>
      </Modal>

      <Modal
        open={importOpen}
        title={`导入 ${year} 年日历 JSON`}
        width={720}
        onCancel={() => {
          setImportOpen(false);
          setPreview(null);
        }}
        footer={
          <Flex gap={8} justify="flex-end">
            <Button variant="secondary" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button variant="secondary" loading={importing} onClick={() => void runPreview()}>
              预览差异
            </Button>
            <Button variant="primary" loading={importing} disabled={!preview} onClick={() => void runImport()}>
              确认导入
            </Button>
          </Flex>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Flex gap={8} align="center" wrap>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <Select
              style={{ width: 160 }}
              value={importMode}
              onChange={(v) => {
                setImportMode(v);
                setPreview(null);
              }}
              options={[
                { value: 'merge', label: '合并（保留其它设置）' },
                { value: 'replace', label: '替换（其余回默认）' },
              ]}
            />
          </Flex>
          <Input.TextArea
            autoSize={{ minRows: 10, maxRows: 18 }}
            placeholder='粘贴 JSON：{"version":1,"year":2026,"days":[{"date":"2026-10-01","type":"holiday","name":"国庆节"}]}'
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setPreview(null);
            }}
          />
          {preview ? (
            <Alert
              type="info"
              showIcon
              message={`差异预览：新增 ${preview.added} · 变更 ${preview.changed} · 移除 ${preview.removed} · 不变 ${preview.unchanged}`}
              description={
                <div style={{ maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
                  {preview.changes.slice(0, 30).map((c) => (
                    <div key={c.date}>
                      {c.date}：{c.action} {c.oldType ? `${TYPE_LABEL[c.oldType]}→` : ''}
                      {c.newType ? TYPE_LABEL[c.newType] : ''} {c.newName || ''}
                    </div>
                  ))}
                  {preview.changes.length === 0 ? <div>无差异</div> : null}
                </div>
              }
            />
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            导入只写“例外日”；省略的日期按默认规则（周一~五工作日）。内网部署请在外网机生成 JSON 后带回。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  );
}