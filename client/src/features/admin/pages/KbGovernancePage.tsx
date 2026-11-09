/**
 * KB 治理（D10 PAD-10 / D07 敏感治理）：全量空间总览（治理视角绕过用户
 * 可见性——personal 空间全列）。D8：空间停用/启用/删除写操作（停用即刻
 * 生效于检索/浏览）；OQ-D10 deny 语义 v0.1 落点=停用过滤+检索合规提示
 * （"部分结果被策略隐藏"，KbPage 黄条）；敏感词治理在「策略」页。
 */

import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { deleteKBSpace, fetchKBSpaces, setKBSpaceStatus, type KBSpaceRow } from '../api/admin';
import { formatBytes } from '../../../shared/utils/format';

const TYPE_LABEL: Record<KBSpaceRow['type'], string> = {
  company: '公司',
  dept: '部门',
  personal: '个人',
};

export function KbGovernancePage() {
  const [rows, setRows] = useState<KBSpaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opError, setOpError] = useState('');

  const reload = () => {
    fetchKBSpaces()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  };
  useEffect(reload, []);

  const doArchive = (r: KBSpaceRow, archived: boolean) => {
    if (archived && !window.confirm(`停用「${r.name}」？停用后全员检索/浏览即刻不可见（可再启用）`)) return;
    setBusyId(r.id);
    setOpError('');
    void setKBSpaceStatus(r.id, archived)
      .then(reload)
      .catch((e: unknown) => setOpError(e instanceof Error ? e.message : '操作失败'))
      .finally(() => setBusyId(null));
  };

  const doDelete = (r: KBSpaceRow) => {
    if (r.type === 'personal') {
      setOpError('个人空间不可删除（7010）');
      return;
    }
    if (!window.confirm(`删除「${r.name}」？将级联删除空间内全部目录/文档/分块（不可恢复）`)) return;
    setBusyId(r.id);
    setOpError('');
    void deleteKBSpace(r.id)
      .then(reload)
      .catch((e: unknown) => setOpError(e instanceof Error ? e.message : '删除失败'))
      .finally(() => setBusyId(null));
  };

  const totalDocs = (rows ?? []).reduce((n, r) => n + r.doc_count, 0);
  const totalUsed = (rows ?? []).reduce((n, r) => n + r.used_bytes, 0);

  return (
    <div className="admin-page__section" data-testid="admin-kb">
      <div className="admin-page__head">
        <h2>知识库治理</h2>
        {rows ? (
          <span className="admin-import__hint">
            {rows.length} 空间 · {totalDocs} 文档 · {formatBytes(totalUsed)}
          </span>
        ) : null}
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}
      {opError ? <div className="admin-page__error" data-testid="kb-govern-error">{opError}</div> : null}
      {rows === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="admin-page__empty">暂无空间</div>
      ) : (
        <table className="admin-table" data-testid="kb-spaces-table">
          <thead>
            <tr>
              <th>空间</th>
              <th>类型</th>
              <th>Owner</th>
              <th>文档数</th>
              <th>用量</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="admin-role__name">
                    <Database size={13} /> {r.name}
                  </span>
                </td>
                <td>
                  <span className={`tag${r.type === 'company' ? ' tag--builtin' : ''}`}>{TYPE_LABEL[r.type]}</span>
                </td>
                <td>
                  {r.owner_name || '—'}
                  <div className="admin-role__desc">{r.owner_id}</div>
                </td>
                <td>{r.doc_count}</td>
                <td>
                  {formatBytes(r.used_bytes)}
                  {r.quota_bytes > 0 ? <span className="admin-role__desc"> / {formatBytes(r.quota_bytes)}</span> : null}
                </td>
                <td>
                  <span className={`tag${r.status === 'archived' ? ' tag--danger' : ' tag--builtin'}`}>
                    {r.status === 'archived' ? '已停用' : '启用'}
                  </span>
                </td>
                <td>
                  <button type="button" className="admin-link-btn" disabled={busyId === r.id} data-testid={`kb-archive-btn-${r.id}`} onClick={() => doArchive(r, r.status !== 'archived')}>
                    {r.status === 'archived' ? '启用' : '停用'}
                  </button>
                  <button type="button" className="admin-link-btn admin-link-btn--danger" disabled={busyId === r.id} data-testid={`kb-delete-btn-${r.id}`} onClick={() => doDelete(r)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
