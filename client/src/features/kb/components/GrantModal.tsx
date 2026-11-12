/**
 * 空间授权管理弹窗（PKB-06 务实版 / D4）：
 * - 授权列表：对象（用户/部门）+ 治理角色（折叠 perm）+ 到期 + 撤销
 * - 添加授权：对象类型 user|dept + 目标 ID + 角色下拉 + 可选有效期（30 天）
 * - 7002 非治理者只读提示；user/dept 检索选择器随通讯录组件阶段二（v0.1 手填 ID，登记）
 */

import { useCallback, useEffect, useState } from 'react';
import { Building2, ShieldCheck, User, X } from 'lucide-react';
import { ApiError, errText as apiErrText } from '../../../shared/api/http';
import { Button } from '../../../shared/ui/Button';
import { SkeletonList } from '../../../shared/ui/Skeleton';
import { addSpaceGrant, fetchSpaceGrants, removeSpaceGrant, type KbGrantRow } from '../api/kb';

const PERM_LABEL: Record<number, string> = {
  1: 'reader（读者）',
  3: 'contributor（贡献者）',
  4: 'owner / admin（治理者）',
};

export function GrantModal(props: { spaceId: string; spaceName: string; onClose: () => void }) {
  const [rows, setRows] = useState<KbGrantRow[] | null>(null);
  const [errText, setErrText] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  // 添加表单
  const [gType, setGType] = useState(1);
  const [target, setTarget] = useState('');
  const [perm, setPerm] = useState(3);
  const [ttlDays, setTtlDays] = useState(0);

  const reload = useCallback(() => {
    setErrText('');
    setForbidden(false);
    fetchSpaceGrants(props.spaceId)
      .then(setRows)
      .catch((e) => {
        setRows([]);
        if (e instanceof ApiError && e.code === 7002) setForbidden(true);
        else setErrText(apiErrText(e, '加载失败'));
      });
  }, [props.spaceId]);

  useEffect(reload, [reload]);

  const add = () => {
    if (!target.trim()) {
      setErrText('请填写目标 ID');
      return;
    }
    setBusy(true);
    setErrText('');
    const req: { grant_type: number; grant_target: string; perm: number; expires_at_ms?: number } = {
      grant_type: gType,
      grant_target: target.trim(),
      perm,
    };
    if (ttlDays > 0) req.expires_at_ms = Date.now() + ttlDays * 86400_000;
    void addSpaceGrant(props.spaceId, req)
      .then(() => {
        setTarget('');
        reload();
      })
      .catch((e) => setErrText(apiErrText(e, '添加失败')))
      .finally(() => setBusy(false));
  };

  const revoke = (id: string) => {
    setBusy(true);
    void removeSpaceGrant(props.spaceId, id)
      .then(reload)
      .catch(() => setErrText('撤销失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="doc-modal-mask" data-testid="kb-grant-modal" onClick={props.onClose}>
      <div className="kb-grant" onClick={(e) => e.stopPropagation()}>
        <div className="kb-grant__head">
          <span className="kb-grant__title">
            <ShieldCheck size={15} /> 授权管理 · {props.spaceName}
          </span>
          <button type="button" className="doc-link-btn" onClick={props.onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        {forbidden ? (
          <div className="kb-grant__hint">仅空间治理者可管理授权（当前只读不可用）</div>
        ) : (
          <div className="kb-grant__form">
            <select value={gType} onChange={(e) => setGType(Number(e.target.value))} aria-label="对象类型">
              <option value={1}>用户</option>
              <option value={2}>部门</option>
            </select>
            <input
              placeholder={gType === 1 ? '用户 ID' : '部门 ID'}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="kb-grant-target"
            />
            <select value={perm} onChange={(e) => setPerm(Number(e.target.value))} aria-label="角色">
              <option value={1}>{PERM_LABEL[1]}</option>
              <option value={3}>{PERM_LABEL[3]}</option>
              <option value={4}>{PERM_LABEL[4]}</option>
            </select>
            <select value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))} aria-label="有效期">
              <option value={0}>永久</option>
              <option value={30}>30 天</option>
            </select>
            <Button onClick={() => add()} loading={busy} data-testid="kb-grant-add">
              添加授权
            </Button>
          </div>
        )}

        {errText ? <div className="doc-inline-error" data-testid="kb-grant-error">{errText}</div> : null}

        <div className="kb-grant__list">
          {rows === null ? (
            <SkeletonList count={3} />
          ) : rows.length === 0 ? (
            <div className="kb-grant__hint">仅空间默认授权（11 §2.1 三级空间基线）</div>
          ) : (
            rows.map((g) => {
              const expired = g.expires_at > 0 && g.expires_at < Date.now();
              return (
                <div key={g.id} className={`kb-grant__row${expired ? ' kb-grant__row--expired' : ''}`} data-testid="kb-grant-row">
                  <span className="kb-grant__who">
                    {g.grant_type === 1 ? <User size={14} /> : <Building2 size={14} />}
                    {g.grant_type === 1 ? '用户' : '部门'} {g.grant_target}
                  </span>
                  <span className="kb-grant__perm">{PERM_LABEL[g.perm] ?? `perm ${g.perm}`}</span>
                  <span className="kb-grant__exp">
                    {expired ? '已过期' : g.expires_at === 0 ? '永久' : `${new Date(g.expires_at).toLocaleDateString('zh-CN')} 到期`}
                  </span>
                  <button type="button" className="doc-link-btn" disabled={busy || forbidden} onClick={() => revoke(g.id)}>
                    撤销
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
