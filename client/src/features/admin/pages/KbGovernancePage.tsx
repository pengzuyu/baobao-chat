/**
 * KB 治理（D10 PAD-10 / D24 两维度版）：维度行总览（公司知识库+个人空间；
 * 授权/敏感标记已随 D24 废除）。D8：停用/启用/删除；**嵌入设置面板**（D24 §5.3）：
 * 当前 epoch/模型/维度/向量重建进度轮询+触发重建（跨维度=清空+ALTER 二次确认；
 * 7017 running/7018 维度不符回显）。
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, Zap } from 'lucide-react';
import { deleteKBSpace, fetchKBEmbedding, fetchKBSpaces, rebuildKBEmbedding, setKBSpaceStatus, type KBEmbeddingSettings, type KBSpaceRow } from '../api/admin';
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
        <>
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
        <EmbeddingPanel />
        </>
      )}
    </div>
  );
}

/** 嵌入设置面板（D24 §5.3）：现状+重建触发+进度轮询 */
function EmbeddingPanel() {
  const emb = useQuery({
    queryKey: ['admin', 'kb', 'embedding'],
    queryFn: fetchKBEmbedding,
    refetchInterval: (q) => (q.state.data?.rebuild_status === 'running' ? 1500 : false),
  });
  const [model, setModel] = useState('');
  const [dims, setDims] = useState('1024');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const st = emb.data;

  const doRebuild = () => {
    const m = (model || st?.embed_model || '').trim();
    const d = parseInt(dims, 10);
    if (!m || !Number.isFinite(d) || d <= 0) {
      setMsg('请填写目标模型与维度');
      return;
    }
    const crossDims = !!st && d !== st.embed_dims;
    if (crossDims && !window.confirm(`目标维度 ${d} ≠ 当前 ${st.embed_dims}：将清空全部向量并重建列（期间检索降级为关键词模式），确认？`)) {
      return;
    }
    if (!crossDims && !window.confirm(`以「${m}」（${d} 维）重建全部向量？过渡期旧向量仍可经关键词路检索到`)) {
      return;
    }
    setBusy(true);
    setMsg('');
    void rebuildKBEmbedding({ model: m, dims: d })
      .then(() => {
        setMsg('重建已启动');
        void emb.refetch();
      })
      .catch((e: unknown) => setMsg(e instanceof Error ? e.message : '重建失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="kb-embed-panel" data-testid="kb-embed-panel">
      <div className="kb-embed-panel__head">
        <Zap size={14} /> 嵌入设置（向量检索）
      </div>
      {emb.isError ? (
        <div className="admin-page__error">{emb.error instanceof Error ? emb.error.message : '加载失败'}</div>
      ) : !st ? (
        <div className="admin-page__empty">加载中…</div>
      ) : (
        <>
          <div className="kb-embed-panel__row">
            <span>当前：第 {st.embed_epoch} 代 · {st.embed_model || '（未登记）'} · {st.embed_dims} 维</span>
            <span className={`tag${st.rebuild_status === 'running' ? ' tag--warn' : ' tag--builtin'}`}>
              {st.rebuild_status === 'running' ? '重建中' : '空闲'}
            </span>
          </div>
          {st.rebuild_status === 'running' ? (
            <div className="kb-embed-panel__progress" data-testid="kb-embed-progress">
              <div className="kb-embed-panel__progress-bar">
                <div
                  className="kb-embed-panel__progress-fill"
                  style={{ width: `${st.rebuild_total > 0 ? Math.round((st.rebuild_done / st.rebuild_total) * 100) : 0}%` }}
                />
              </div>
              <span>{st.rebuild_done}/{st.rebuild_total} 篇</span>
            </div>
          ) : null}
          <div className="kb-embed-panel__form">
            <input className="kb-embed-panel__input" placeholder="目标模型（如 embedding-3）" value={model} onChange={(e) => setModel(e.target.value)} />
            <input className="kb-embed-panel__input kb-embed-panel__input--dims" placeholder="维度" value={dims} onChange={(e) => setDims(e.target.value)} />
            <button type="button" className="admin-link-btn" disabled={busy || st.rebuild_status === 'running'} data-testid="kb-embed-rebuild-btn" onClick={doRebuild}>
              重建向量
            </button>
          </div>
          {msg ? <div className="kb-embed-panel__msg">{msg}</div> : null}
          <div className="kb-embed-panel__hint">
            提示：嵌入/重排上游在「AI 供应商」页配置（路由 bbw-embed/bbw-rerank 档）；切换模型后在此触发重建。
          </div>
        </>
      )}
    </div>
  );
}

// KBEmbeddingSettings 类型重导出标记（rebuildKBEmbedding 响应同构）
export type { KBEmbeddingSettings };
