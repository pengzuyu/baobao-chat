/**
 * Agent 治理（D10 PAD-14）：活跃 Agent 用户（网关计量聚合：请求/tokens/
 * 会话数）+ 通道撤销（吊销令牌+踢线）+ 平台总闸 killswitch（紧急停止）。
 * 会话明细在端侧 SQLite（D08）——服务端视角为计量聚合，登记。
 */

import { useCallback, useEffect, useState } from 'react';
import { Power, ShieldOff } from 'lucide-react';
import { ApiError, getErrorText } from '../../../shared/api/http';
import { agentKillswitch, fetchAgentUsers, revokeAgentAccess, type AgentUserRow } from '../api/admin';

export function AgentGovernancePage() {
  const [rows, setRows] = useState<AgentUserRow[] | null>(null);
  const [kill, setKill] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, on] = await Promise.all([fetchAgentUsers(), agentKillswitch()]);
      setRows(list);
      setKill(on);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = async (r: AgentUserRow) => {
    if (!window.confirm(`确认撤销 ${r.name || r.user_id} 的 Agent 通道？其全部令牌吊销并强制下线`)) return;
    setBusy(r.user_id);
    setError(null);
    try {
      await revokeAgentAccess(r.user_id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '撤销失败');
    } finally {
      setBusy(null);
    }
  };

  const toggleKill = async () => {
    const next = !kill;
    if (next && !window.confirm('确认开启 Agent 平台总闸？开启后 OBO 签发即刻拒绝（1013）、网关侧 Agent 请求 503——双点拦截（D9）')) return;
    setBusy('kill');
    setError(null);
    try {
      setKill(await agentKillswitch(next));
    } catch (e) {
      setError(e instanceof ApiError ? getErrorText(e.code) : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-page__section" data-testid="admin-agent">
      <div className="admin-page__head">
        <h2>Agent 治理</h2>
        <button
          type="button"
          className={`btn ${kill ? 'btn--danger' : ''}`}
          disabled={busy === 'kill'}
          onClick={() => void toggleKill()}
          data-testid="agent-killswitch-btn"
        >
          <Power size={14} /> 总闸：{kill ? '已拉起（紧急停止：OBO 签发拒 1013 + 网关 503）' : '运行中'}
        </button>
      </div>
      {error ? <div className="admin-page__error">{error}</div> : null}

      {rows === null ? (
        <div className="admin-page__empty">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="admin-page__empty">暂无活跃 Agent 用量（计量窗内无请求）</div>
      ) : (
        <table className="admin-table" data-testid="agent-users-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>请求</th>
              <th>Tokens</th>
              <th>活跃会话</th>
              <th>最近活跃</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td>
                  {r.name || '—'}
                  <div className="admin-role__desc">{r.user_id}</div>
                </td>
                <td>{r.requests}</td>
                <td>{r.tokens.toLocaleString()}</td>
                <td>{r.sessions}</td>
                <td>{r.last_hour ? new Date(r.last_hour).toLocaleString() : '—'}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busy === r.user_id}
                    onClick={() => void revoke(r)}
                  >
                    <ShieldOff size={12} /> 撤销通道
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
