/**
 * 管理端·技能包管理（D09 PEC-04 务实版 / E4）：发布（skill_id+YAML 清单+三档
 * 策略）/ 更新（版本 bump+manifest 覆盖）/ 下架。多版本线与回滚 C 档随 E3；
 * admin:skill:publish 字典入册后路由守卫收紧（登记）。
 * D26-O2：Table（expandable 升版行）/Input/Select/TextArea/Modal.confirm 化。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Input, Modal, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Plus, Sparkles, Upload } from 'lucide-react';
import { http, errText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';

interface SkillRow {
  id: string;
  skill_id: string;
  name: string;
  description: string;
  policy: number;
  status: string;
  current_version: string;
}

const POLICY_LABEL: Record<number, string> = { 1: '强制（force）', 2: '推荐（recommend）', 3: '可选（optional）' };

const BLANK_MANIFEST = 'skills:\n  - name: demo-skill\n    description: 演示技能\n';

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pubOpen, setPubOpen] = useState(false);
  const [skillID, setSkillID] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [policy, setPolicy] = useState(3);
  const [version, setVersion] = useState('1.0.0');
  const [manifest, setManifest] = useState(BLANK_MANIFEST);
  // 更新行（Table expandable）
  const [editRow, setEditRow] = useState<string | null>(null);
  const [editVer, setEditVer] = useState('');

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: SkillRow[] }>('/admin/eco/skills')
      .then((d) => setSkills(d.items ?? []))
      .catch((e) => {
        setSkills([]);
        setError(errText(e, '加载失败'));
      });
  }, []);
  useEffect(reload, [reload]);

  const publish = () => {
    setBusy(true);
    void http
      .post('/admin/eco/skills', {
        skill_id: skillID.trim(), name: name.trim(), description: desc.trim(),
        policy, version: version.trim(), manifest,
      })
      .then(() => {
        setPubOpen(false);
        setSkillID('');
        setName('');
        setDesc('');
        setVersion('1.0.0');
        reload();
      })
      .catch((e) => setError(errText(e, '发布失败')))
      .finally(() => setBusy(false));
  };

  const update = (id: string) => {
    if (!editVer.trim()) return;
    setBusy(true);
    void http
      .patch(`/admin/eco/skills/${encodeURIComponent(id)}`, { version: editVer.trim(), manifest })
      .then(() => {
        setEditRow(null);
        setEditVer('');
        reload();
      })
      .catch((e) => setError(errText(e, '更新失败')))
      .finally(() => setBusy(false));
  };

  const delist = (s: SkillRow) => {
    Modal.confirm({
      title: `下架「${s.name}」？`,
      content: '已装用户技能保留本地、catalog 不再可见',
      okText: '下架',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () =>
        http
          .post(`/admin/eco/skills/${encodeURIComponent(s.id)}/delist`, {})
          .then(reload)
          .catch((e) => {
            setError(errText(e, '下架失败'));
            throw e;
          }),
    });
  };

  const columns: ColumnsType<SkillRow> = [
    {
      title: '技能包',
      dataIndex: 'name',
      render: (_, s) => (
        <div>
          <span className="admin-role__name">
            <Sparkles size={13} /> {s.name}
          </span>
          {s.description ? <div className="admin-role__desc">{s.description}</div> : null}
        </div>
      ),
    },
    { title: 'skill_id', dataIndex: 'skill_id' },
    {
      title: '策略',
      dataIndex: 'policy',
      width: 130,
      render: (v: number) => POLICY_LABEL[v] ?? v,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag color={v === 'published' ? 'geekblue' : v === 'delisted' ? 'red' : 'default'}>
          {v === 'published' ? '已上架' : v === 'delisted' ? '已下架' : '草稿'}
        </Tag>
      ),
    },
    { title: '版本', dataIndex: 'current_version', width: 90, render: (v: string) => `v${v || '—'}` },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_, s) => (
        <>
          <Button
            variant="text"
            size="small"
            onClick={() => {
              setEditRow(editRow === s.id ? null : s.id);
              setEditVer('');
            }}
            data-testid={`skill-edit-${s.id}`}
          >
            更新
          </Button>
          {s.status !== 'delisted' ? (
            <Button variant="danger" size="small" disabled={busy} onClick={() => delist(s)}>
              下架
            </Button>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div className="admin-page__section" data-testid="admin-skills">
      <div className="admin-page__head">
        <h2>技能包</h2>
        <Button onClick={() => setPubOpen((v) => !v)} data-testid="skill-pub-btn">
          <Plus size={14} /> 发布技能包
        </Button>
      </div>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} /> : null}

      {pubOpen ? (
        <div className="eco-reg" style={{ marginBottom: 12 }}>
          <div className="eco-reg__row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Input placeholder="skill_id（如 corp.skills/weekly）" style={{ width: 240 }} value={skillID} onChange={(e) => setSkillID(e.target.value)} data-testid="skill-id-input" />
            <Input placeholder="名称" style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="版本（x.y.z）" style={{ width: 140 }} value={version} onChange={(e) => setVersion(e.target.value)} />
            <Select
              style={{ width: 160 }}
              value={policy}
              onChange={setPolicy}
              data-testid="skill-policy-select"
              title="三档策略：force 强制装不可卸 / recommend 建议装 / optional 自愿"
              options={[
                { value: 1, label: '强制（force）' },
                { value: 2, label: '推荐（recommend）' },
                { value: 3, label: '可选（optional）' },
              ]}
            />
          </div>
          <Input placeholder="描述（可选）" style={{ marginTop: 8 }} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <Input.TextArea
            style={{ marginTop: 8 }}
            placeholder="YAML 清单（技能/命令/agent 定义）"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 14 }}
            data-testid="skill-manifest-input"
          />
          <div style={{ marginTop: 8 }}>
            <Button loading={busy} disabled={!skillID.trim() || !name.trim()} onClick={publish} data-testid="skill-pub-submit">
              发布（即刻上架）
            </Button>
          </div>
        </div>
      ) : null}

      {skills === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="admin-page__empty">暂无技能包</div>
      ) : (
        <Table<SkillRow>
          rowKey="id"
          columns={columns}
          dataSource={skills}
          data-testid="skills-table"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          expandable={{
            expandedRowKeys: editRow ? [editRow] : [],
            onExpand: (expanded, s) => {
              setEditRow(expanded ? s.id : null);
              setEditVer('');
            },
            expandedRowRender: (s) => (
              <div className="eco-versions__add" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Input
                  placeholder="新版本号（x.y.z）"
                  style={{ width: 200 }}
                  value={editVer}
                  onChange={(e) => setEditVer(e.target.value)}
                  data-testid={`skill-newver-${s.id}`}
                />
                <Button loading={busy} disabled={!editVer.trim()} onClick={() => update(s.id)}>
                  <Upload size={12} /> 覆盖 manifest 并升版
                </Button>
                <span className="admin-role__desc">manifest 用上方发布框当前内容（改后点更新）</span>
              </div>
            ),
          }}
        />
      )}
    </div>
  );
}
