/**
 * IM 内嵌 Agent 同步控制器（2026-11-14 隐私裁决改版：默认零落流）：
 * - 旧写路径整体退役——回合开始立即落 running 卡 + 阶段边界 PATCH 扇出，会让
 *   Agent 执行过程（思考/工具/中间输出）对会话全体成员实时可见（D18 威胁模型
 *   自认的「泄洪口」）。现默认问题/过程/回答全程仅本机可见，回合收口后由用户
 *   手动「同步」才把仅结论 agent_card 发进会话（embedded.ts syncRoundToConv）
 * - 本组件职责收敛为三件无头事：
 *   ① 回合收口写入器：turnDoneAt 权威口径（终态 stateChanged 打点，含 interrupt），
 *      done 且有结论 → 入待同步池（IndexedDB 持久，重载不丢；幂等）
 *   ② 重载对账：挂载水合历史后，壳关闭期间跑完的轮（无 turnDoneAt 且会话行
 *      非运行态且本轮已有结论）补打收口 → 写入器随之补入池
 *   ③ 审批/澄清弹框常驻宿主（会话映射存在即挂，不随回合退场——弹框不失宿主）
 * - 实时过程与待同步卡的渲染见 EmbeddedPrivateCards（消息流底部，仅本人可见）
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Radio } from 'antd';
import { useAgentStore, type StreamItem } from '../../agent/store/agent';
import { getAgentBridge } from '../../agent/bridge';
import type { GrantScope } from '../../agent/bridge/types';
import { ClarifyForm, type ClarifySubmit } from '../../agent/components/ClarifyCard';
import { AGENT_LIVE_STATUSES, agentCardClientMsgId, currentRoundItems, roundQuestionOf } from './embedded';
import { usePendingRounds } from './pending';

const EMPTY_STREAM: StreamItem[] = [];

interface Props {
  convId: string;
  sessionId: string;
}

export function EmbeddedAgentSync({ convId, sessionId }: Props) {
  const stream = useAgentStore((s) => s.streams[sessionId] ?? EMPTY_STREAM);
  const session = useAgentStore((s) => s.sessions.find((m) => m.id === sessionId));
  const respondPermission = useAgentStore((s) => s.respondPermission);

  // 最近一条待决审批（Modal 数据源；本组件常驻 → 弹框不会因回合结束失宿主）
  const pendingPerm = useMemo<StreamItem | null>(() => {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const it = stream[i];
      if (it.kind === 'permission' && it.outcome === null) return it;
    }
    return null;
  }, [stream]);

  // 最近一条待决提问（D20；与审批 Modal 并列，clarify 优先渲染）
  const pendingClarify = useMemo<StreamItem | null>(() => {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const it = stream[i];
      if (it.kind === 'clarify' && it.answer === null) return it;
    }
    return null;
  }, [stream]);

  // 回合收口判定（权威，2026-11-11）：最后一条 user 的 turnDoneAt——store 仅在终态
  // stateChanged 打点（回合结束必有终态收口，含 interrupt；中途 streamDone/瞬态
  // idle 不打点）。比盯会话 status 稳：status 瞬态（revive 镜像/ready 迟到）不会误收口
  let lastUser: Extract<StreamItem, { kind: 'user' }> | null = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const it = stream[i];
    if (it.kind === 'user') {
      lastUser = it;
      break;
    }
  }
  const roundClosed = !!lastUser?.turnDoneAt;

  // ── 水合：本进程无流时拉历史（重载后收口判定/待同步对账的数据源） ──
  useEffect(() => {
    void useAgentStore.getState().loadHistoryIfEmpty(sessionId);
  }, [sessionId]);

  // ── 重载对账（2026-11-14 隐私裁决新增）：壳关闭期间跑完的轮补收口 ──
  // 历史水合不带 turnDoneAt（historyToStreamItem 无此字段）且已无直播事件来补打——
  // 会话行非运行态 + 本轮已有结论 = 实际早已收口。补打点后下方写入器随之入池、
  // EmbeddedPrivateCards 的实时卡随之退场（否则永远呈运行中）。运行中会话不碰。
  useEffect(() => {
    if (!session || AGENT_LIVE_STATUSES.has(session.status)) return;
    if (!lastUser || lastUser.turnDoneAt) return;
    const hasConclusion = currentRoundItems(stream).some(
      (it) => it.kind === 'agentText' && !!it.text.trim(),
    );
    if (!hasConclusion) return;
    useAgentStore.getState().stampTurnDoneIfOpen(sessionId);
  }, [stream, session, sessionId, lastUser]);

  // ── 回合收口写入器：done 且有结论 → 待同步池（幂等；失败/中断轮不入池） ──
  useEffect(() => {
    if (!roundClosed) return;
    const items = currentRoundItems(stream);
    let conclusion = '';
    for (const it of items) {
      if (it.kind === 'agentText') conclusion = it.text; // 取本轮最后一段正文
    }
    if (!conclusion.trim()) return;
    const userCount = stream.filter((it) => it.kind === 'user').length;
    // 池内 id 用确定性轮键（幂等去重；落流 client_msg_id 另用带盐 token，勿混）
    void usePendingRounds.getState().add(convId, {
      id: agentCardClientMsgId(sessionId, userCount),
      sessionId,
      round: userCount,
      question: roundQuestionOf(stream),
      conclusionMd: conclusion,
      // 水合历史 user 条目 ts=0（historyToStreamItem 口径）→ 起点退化取收口时刻
      startedAt: lastUser?.ts || lastUser?.turnDoneAt || Date.now(),
      endedAt: lastUser?.turnDoneAt || Date.now(),
    });
  }, [roundClosed, stream, convId, sessionId, lastUser]);

  // ── 审批弹框动作 ──
  const [scope, setScope] = useState<GrantScope>('once');
  const respondClarify = useAgentStore((s) => s.respondClarify);
  const doClarify = (s: ClarifySubmit) => {
    if (pendingClarify && pendingClarify.kind === 'clarify') {
      respondClarify(pendingClarify.request.questionId, s.answers, s.freeText || undefined);
    }
  };
  const doAllow = () => {
    if (pendingPerm && pendingPerm.kind === 'permission') {
      const bridge = getAgentBridge();
      void bridge.respondPermission(pendingPerm.request.requestId, 'allow', scope);
      respondPermission(pendingPerm.request.requestId, 'allow', scope);
    }
  };
  const doDeny = () => {
    if (pendingPerm && pendingPerm.kind === 'permission') {
      const bridge = getAgentBridge();
      void bridge.respondPermission(pendingPerm.request.requestId, 'deny');
      respondPermission(pendingPerm.request.requestId, 'deny');
    }
  };

  return (
    <>
      {/* D20 澄清提问弹框（与审批弹框并列；clarify 优先——提问比审批更常见） */}
      <Modal
        open={!!pendingClarify}
        title="Agent 有问题问你"
        footer={null}
        destroyOnClose
        width={520}
      >
        {pendingClarify && pendingClarify.kind === 'clarify' ? (
          <ClarifyForm
            question={pendingClarify.request.question}
            header={pendingClarify.request.header}
            options={pendingClarify.request.options}
            multiSelect={pendingClarify.request.multiSelect}
            onSubmit={doClarify}
          />
        ) : null}
      </Modal>
      <Modal
        open={!!pendingPerm}
        title="Agent 请求批准工具调用"
        okText="允许"
        cancelText="拒绝"
        onOk={doAllow}
        onCancel={doDeny}
        destroyOnClose
        width={520}
      >
        {pendingPerm && pendingPerm.kind === 'permission' ? (
          <div className="agc-perm">
            <div className="agc-perm__tool">
              <code>{pendingPerm.request.tool}</code>
              <span className={`tag${pendingPerm.request.risk === 'high' ? ' tag--danger' : ''}`}>{pendingPerm.request.risk}</span>
            </div>
            {pendingPerm.request.reason ? <div className="agc-perm__reason">{pendingPerm.request.reason}</div> : null}
            {previewText(pendingPerm.request.preview) ? <pre className="agc-perm__preview">{previewText(pendingPerm.request.preview)}</pre> : null}
            <div className="agc-perm__scope">
              <span>记忆范围：</span>
              {/* 选项按 Runtime 下发 options 过滤（高危不含 permanent——bbrt 侧只授
                  once/session，硬编三档会发出无效 scope） */}
              <Radio.Group size="small" value={scope} onChange={(e) => setScope(e.target.value as GrantScope)}>
                {(pendingPerm.request.options?.length ? pendingPerm.request.options : (['once', 'session'] as GrantScope[])).map((o) => (
                  <Radio.Button key={o} value={o}>{o === 'once' ? '本次' : o === 'session' ? '本会话' : '永久'}</Radio.Button>
                ))}
              </Radio.Group>
            </div>
            <div className="agc-perm__hint">120 秒未决策将自动拒绝</div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/** 审批预览 → 文本（command/diff/obo 三形态一行化） */
function previewText(p: { kind: string } | undefined): string {
  if (!p) return '';
  const o = p as Record<string, unknown>;
  switch (p.kind) {
    case 'command':
      // cwd/dangerFlags bbrt 侧可缺省（真机 payload 实测只有 kind+command）
      return `$ ${String(o.command)}${o.cwd ? `  (${String(o.cwd)})` : ''}${(o.dangerFlags as string[])?.length ? `\n⚠ ${((o.dangerFlags as string[]).join(', '))}` : ''}`;
    case 'diff':
      return `文件 ${String(o.file)}  +${String(o.addLines)}/-${String(o.delLines)}`;
    case 'obo':
      return `OBO ${String(o.target)}  scopes: ${(o.scopes as string[])?.join(', ')}`;
    default:
      return JSON.stringify(p);
  }
}
