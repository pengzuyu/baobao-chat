/**
 * KB 治理（D10 PAD-10 / D07 敏感治理）：全量空间总览（治理视角绕过用户
 * 可见性——personal 空间全列）。空间停用/删除与 deny 检索合规提示随
 * D07 阶段二（OQ-D10）登记；敏感词治理在「策略」页。
 */

import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { fetchKBSpaces, type KBSpaceRow } from '../api/admin';
import { formatBytes } from '../../../shared/utils/format';

const TYPE_LABEL: Record<KBSpaceRow['type'], string> = {
  company: '公司',
  dept: '部门',
  personal: '个人',
};

export function KbGovernancePage() {
  const [rows, setRows] = useState<KBSpaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchKBSpaces()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  }, []);

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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
