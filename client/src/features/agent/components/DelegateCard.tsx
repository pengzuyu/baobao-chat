/**
 * 委派卡（D16 类型 3 / P0-4）：四相位状态机——
 * - brief：简报待确认（建议后端 + [确认启动] [取消]；不改稿是主路径，编辑稿随 P1）
 * - running：后台执行中（输出尾窗 ≤50 行 + [取消]；会话可继续对话）
 * - review：delegate.end（exit=0）驱动——摘要/改动文件/检查点/续接句柄 + [采纳并回填] [拒绝]
 * - resolved：终态（已采纳/已拒绝/失败/已取消）
 */

import { useState } from 'react';
import { CheckCircle2, ChevronRight, Loader2, TerminalSquare, XCircle } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useAgentStore } from '../store/agent';
import type { StreamItem } from '../store/agent';

type DelegateItem = Extract<StreamItem, { kind: 'delegate' }>;

export function DelegateCard({ item }: { item: DelegateItem }) {
  const confirmDelegate = useAgentStore((st) => st.confirmDelegate);
  const reviewDelegate = useAgentStore((st) => st.reviewDelegate);
  const cancelDelegate = useAgentStore((st) => st.cancelDelegate);
  const [open, setOpen] = useState(false);

  const failed = item.end !== undefined && item.end.exitCode !== 0;

  const headStatus =
    item.phase === 'brief' ? (
      <span className="tool-card__status tool-card__status--running">待确认</span>
    ) : item.phase === 'running' ? (
      <span className="tool-card__status tool-card__status--running">
        <Loader2 size={12} className="bbw-spin" aria-hidden />
        后台执行中
      </span>
    ) : item.phase === 'review' ? (
      <span className="tool-card__status tool-card__status--running">待审查</span>
    ) : failed ? (
      <span className="tool-card__status tool-card__status--failed">失败 · exit {item.end?.exitCode}</span>
    ) : item.decision === 'accept' ? (
      <span className="tool-card__status tool-card__status--ok">已采纳</span>
    ) : (
      <span className="tool-card__status tool-card__status--failed">{item.decision === 'reject' ? '已拒绝' : '已取消'}</span>
    );

  return (
    <div className={`delegate-card${failed ? ' delegate-card--failed' : ''}`}>
      <button type="button" className="tool-card__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={12} className={`tool-card__chev${open ? ' tool-card__chev--open' : ''}`} aria-hidden />
        <TerminalSquare size={13} className="tool-card__icon" aria-hidden />
        <span className="subagent-card__label">委派</span>
        <span className="delegate-card__backend">{item.backend || '后端待定'}</span>
        <span className="tool-card__status-wrap">{headStatus}</span>
      </button>

      {item.phase === 'brief' ? (
        <div className="delegate-card__actions">
          <span className="delegate-card__hint">Agent 请求委派本机编码智能体执行任务，确认后转后台运行（简报沿用模型产出）</span>
          <div className="delegate-card__btns">
            <Button variant="primary" onClick={() => confirmDelegate(item.runId, item.backend)}>
              确认启动（{item.backend || '默认后端'}）
            </Button>
            <Button variant="secondary" onClick={() => cancelDelegate(item.runId)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {item.phase === 'running' ? (
        <div className="delegate-card__actions">
          <div className="delegate-card__btns">
            <Button variant="secondary" onClick={() => cancelDelegate(item.runId)}>
              取消委派
            </Button>
          </div>
        </div>
      ) : null}

      {item.phase === 'review' && item.end ? (
        <div className="delegate-card__review">
          <div className="tool-card__section">
            <div className="tool-card__section-label">执行摘要</div>
            <div className="tool-card__mono">{item.end.summary || '（无摘要）'}</div>
          </div>
          {item.end.changedFiles.length > 0 ? (
            <div className="tool-card__section">
              <div className="tool-card__section-label">改动文件（{item.end.changedFiles.length}）</div>
              <div className="tool-card__mono delegate-card__files">
                {item.end.changedFiles.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            </div>
          ) : null}
          {(item.end.checkpointId || item.end.childSessionRef) && (
            <div className="delegate-card__meta">
              {item.end.checkpointId ? <span>回滚锚点 {item.end.checkpointId}</span> : null}
              {item.end.childSessionRef ? <span>可续接 {item.end.childSessionRef}</span> : null}
            </div>
          )}
          <div className="delegate-card__btns">
            <Button variant="primary" onClick={() => reviewDelegate(item.runId, true)}>
              采纳并回填
            </Button>
            <Button variant="secondary" onClick={() => reviewDelegate(item.runId, false)}>
              拒绝
            </Button>
          </div>
        </div>
      ) : null}

      {item.phase === 'resolved' ? (
        <div className="delegate-card__resolved">
          {item.decision === 'accept' ? (
            <span className="delegate-card__verdict delegate-card__verdict--ok">
              <CheckCircle2 size={12} aria-hidden />
              结果已回填主对话
            </span>
          ) : failed ? (
            <span className="delegate-card__verdict delegate-card__verdict--fail">
              <XCircle size={12} aria-hidden />
              {item.end?.summary || '委派异常退出'}
            </span>
          ) : (
            <span className="delegate-card__verdict delegate-card__verdict--fail">
              <XCircle size={12} aria-hidden />
              {item.decision === 'reject' ? '结果已拒绝（可用检查点回滚）' : '已取消'}
            </span>
          )}
        </div>
      ) : null}

      {open && item.logs.length > 0 ? (
        <div className="tool-card__body">
          <div className="tool-card__section">
            <div className="tool-card__section-label">后端输出（尾部 {item.logs.length} 行 · run {item.runId}）</div>
            <div className="tool-card__mono delegate-card__logs">
              {item.logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
