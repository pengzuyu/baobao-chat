/**
 * 技能市场 tab（D09 PEC-07 / E4）：catalog 卡流——三档策略徽标（force 强制
 * recommend 建议 optional 自选）+ 安装态 + 安装/升级/卸载（force 卸载按钮隐藏
 * ——服务端同样拒）。tools.reload 热加载随宿主命令阶段二（登记）。
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Lock, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { Empty } from '../../../shared/ui/Empty';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { http } from '../../../shared/api/http';
import { ApiError } from '../../../shared/api/http';

interface SkillEntry {
  id: string;
  skill_id: string;
  name: string;
  description: string;
  policy: number;
  status: string;
  current_version: string;
  installed: boolean;
  version?: string;
}

const POLICY_META: Record<number, { label: string; tone: string; icon: typeof Sparkles }> = {
  1: { label: '强制', tone: 'danger', icon: Lock },
  2: { label: '推荐', tone: 'warn', icon: Sparkles },
  3: { label: '可选', tone: 'muted', icon: Sparkles },
};

export function SkillTab() {
  const [entries, setEntries] = useState<SkillEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError('');
    http
      .get<{ items: SkillEntry[] }>('/eco/skills/catalog')
      .then((d) => setEntries(d.items ?? []))
      .catch(() => {
        setEntries([]);
        setError('技能目录加载失败');
      });
  }, []);
  useEffect(reload, [reload]);

  const install = (id: string) => {
    setBusyId(id);
    void http
      .post(`/eco/skills/${encodeURIComponent(id)}/install`, {})
      .then(reload)
      .catch((e) => setError(e instanceof ApiError ? '安装失败' : '安装失败'))
      .finally(() => setBusyId(null));
  };

  const uninstall = (id: string) => {
    setBusyId(id);
    void http
      .delete(`/eco/skills/${encodeURIComponent(id)}/install`)
      .then(reload)
      .catch(() => setError('卸载失败（强制技能不可卸）'))
      .finally(() => setBusyId(null));
  };

  return (
    <div data-testid="skill-tab">
      {error ? <div className="eco-store__error">{error}</div> : null}
      {entries === null ? (
        <SkeletonList count={4} />
      ) : entries.length === 0 ? (
        <Empty text="暂无已上架技能包（管理员可在管理端「技能包」发布）" />
      ) : (
        <div className="eco-store__grid">
          {entries.map((e) => {
            const meta = POLICY_META[e.policy] ?? POLICY_META[3];
            const upgraded = e.installed && e.version !== e.current_version;
            return (
              <div key={e.id} className={`eco-card eco-card--${meta.tone}`} data-testid="skill-card">
                <div className="eco-card__head">
                  <b>{e.name}</b>
                  <span className={`tag${meta.tone === 'muted' ? ' tag--builtin' : meta.tone === 'danger' ? ' tag--danger' : ''}`}>{meta.label}</span>
                </div>
                <div className="eco-card__meta">
                  {e.skill_id} · v{e.current_version}
                  {e.installed ? `（本地 v${e.version ?? e.current_version}）` : ''}
                </div>
                {e.description ? <p className="eco-card__desc">{e.description}</p> : null}
                <div className="eco-card__ops">
                  {!e.installed || upgraded ? (
                    <Button loading={busyId === e.id} onClick={() => install(e.id)} data-testid={`skill-install-${e.id}`}>
                      {upgraded ? <RotateCcw size={12} /> : <Download size={12} />}
                      {upgraded ? '升级' : '安装'}
                    </Button>
                  ) : (
                    <span className="eco-card__meta">
                      <CheckCircle2 size={12} /> 已安装
                    </span>
                  )}
                  {e.installed && e.policy !== 1 ? (
                    <Button variant="secondary" disabled={busyId === e.id} onClick={() => uninstall(e.id)}>
                      卸载
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
