/**
 * 管理端·技能包管理（D09 PEC-04 务实版 / E4）：发布（skill_id+YAML 清单+三档
 * 策略）/ 更新（版本 bump+manifest 覆盖）/ 下架。多版本线与回滚 C 档随 E3；
 * admin:skill:publish 字典入册后路由守卫收紧（登记）。
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Plus, Sparkles, Upload } from 'lucide-react';
import { ApiError, getErrorText, http } from '../../../shared/api/http';
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
  // 更新行
  const [editRow, setEditRow] = useState<string | null>(null);
  const [editVer, setEditVer] = useState('');

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: SkillRow[] }>('/admin/eco/skills')
      .then((d) => setSkills(d.items ?? []))
      .catch((e) => {
        setSkills([]);
        setError(e instanceof ApiError ? getErrorText(e.code) : '加载失败');
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
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '发布失败'))
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
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '更新失败'))
      .finally(() => setBusy(false));
  };

  const delist = (s: SkillRow) => {
    if (!window.confirm(`下架「${s.name}」？已装用户技能保留本地、catalog 不再可见`)) return;
    setBusy(true);
    void http
      .post(`/admin/eco/skills/${encodeURIComponent(s.id)}/delist`, {})
      .then(reload)
      .catch((e) => setError(e instanceof ApiError ? getErrorText(e.code) : '下架失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="admin-page__section" data-testid="admin-skills">
      <div className="admin-page__head">
        <h2>技能包</h2>
        <Button onClick={() => setPubOpen((v) => !v)} data-testid="skill-pub-btn">
          <Plus size={14} /> 发布技能包
        </Button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {pubOpen ? (
        <div className="eco-reg">
          <div className="eco-reg__row">
            <input placeholder="skill_id（如 corp.skills/weekly）" value={skillID} onChange={(e) => setSkillID(e.target.value)} data-testid="skill-id-input" />
            <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="版本（x.y.z）" value={version} onChange={(e) => setVersion(e.target.value)} />
            <select value={policy} onChange={(e) => setPolicy(Number(e.target.value))} data-testid="skill-policy-select" title="三档策略：force 强制装不可卸 / recommend 建议装 / optional 自愿">
              <option value={1}>强制（force）</option>
              <option value={2}>推荐（recommend）</option>
              <option value={3}>可选（optional）</option>
            </select>
          </div>
          <input className="eco-reg__desc" placeholder="描述（可选）" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <textarea
            placeholder="YAML 清单（技能/命令/agent 定义）"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            rows={6}
            data-testid="skill-manifest-input"
          />
          <Button loading={busy} disabled={!skillID.trim() || !name.trim()} onClick={publish} data-testid="skill-pub-submit">
            发布（即刻上架）
          </Button>
        </div>
      ) : null}

      {skills === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="admin-page__empty">暂无技能包</div>
      ) : (
        <table className="admin-table" data-testid="skills-table">
          <thead>
            <tr>
              <th>技能包</th>
              <th>skill_id</th>
              <th>策略</th>
              <th>状态</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <Fragment key={s.id}>
                <tr>
                  <td>
                    <span className="admin-role__name">
                      <Sparkles size={13} /> {s.name}
                    </span>
                    {s.description ? <div className="admin-role__desc">{s.description}</div> : null}
                  </td>
                  <td>{s.skill_id}</td>
                  <td>{POLICY_LABEL[s.policy] ?? s.policy}</td>
                  <td>
                    <span className={`tag${s.status === 'published' ? ' tag--builtin' : s.status === 'delisted' ? ' tag--danger' : ''}`}>
                      {s.status === 'published' ? '已上架' : s.status === 'delisted' ? '已下架' : '草稿'}
                    </span>
                  </td>
                  <td>v{s.current_version || '—'}</td>
                  <td>
                    <button type="button" className="admin-link-btn" onClick={() => setEditRow(editRow === s.id ? null : s.id)} data-testid={`skill-edit-${s.id}`}>
                      更新
                    </button>
                    {s.status !== 'delisted' ? (
                      <button type="button" className="admin-link-btn admin-link-btn--danger" disabled={busy} onClick={() => delist(s)}>
                        下架
                      </button>
                    ) : null}
                  </td>
                </tr>
                {editRow === s.id ? (
                  <tr className="eco-versions-row">
                    <td colSpan={6}>
                      <div className="eco-versions__add">
                        <input placeholder="新版本号（x.y.z）" value={editVer} onChange={(e) => setEditVer(e.target.value)} data-testid={`skill-newver-${s.id}`} />
                        <Button loading={busy} disabled={!editVer.trim()} onClick={() => update(s.id)}>
                          <Upload size={12} /> 覆盖 manifest 并升版
                        </Button>
                        <span className="admin-role__desc">manifest 用上方发布框当前内容（改后点更新）</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
