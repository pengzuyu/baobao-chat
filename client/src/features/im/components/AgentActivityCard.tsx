/**
 * IM 内嵌 Agent 活动卡（D18 §3.2，发起者视角）：
 * - 订阅 agent store 中该 sessionId 的事件流 → AgentProcessCard 实时渲染
 * - 审批弹框（waiting_permission 时最近一条 pending → antd Modal；120s 超时=拒绝照旧）
 * - 追问输入 / 失败重试 / 转到工作台（F5 文本注入）
 * - 阶段边界 → 落流（首阶段 msg.send agent_card）+ PATCH 更新（D18 §4.2）；
 *   终态最后更新后经 onRetire 退场（消息流内已见终态落流卡）
 * 页面效果对齐 change-my-life agent-web（D18 §3.4）。
 * 注：直接 import agent store（D18 §4.3 口径——store 为全局单例，等价 App 层消费）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Radio, Space } from 'antd';
import { ArrowUpRight, RefreshCw, Send } from 'lucide-react';
import { AgentProcessCard, type AgentCardBody } from '../../../shared/components/AgentProcessCard';
import { useAgentStore, type StreamItem } from '../../agent/store/agent';
import { getAgentBridge } from '../../agent/bridge';
import type { GrantScope } from '../../agent/bridge/types';
import { agentCardClientMsgId, contextInstruction, landAgentCard, patchAgentCard, stagesFromStream, stagesSignature } from '../agent/embedded';

const RUNNING_STATES = new Set(['starting', 'running', 'waiting_permission', 'waiting_review', 'subagent_fanout', 'delegating']);
const TERMINAL_STATES = new Set(['error', 'ended']);

interface Props {
  convId: string;
  sessionId: string;
  /** 活动卡退场（终态落流完成后由 ChatPage 卸载本地卡） */
  onRetire: () => void;
}

export function AgentActivityCard({ convId, sessionId, onRetire }: Props) {
  const navigate = useNavigate();
  const stream = useAgentStore((s) => s.streams[sessionId] ?? EMPTY_STREAM);
  const session = useAgentStore((s) => s.sessions.find((m) => m.id === sessionId));
  const sendTextTo = useAgentStore((s) => s.sendTextTo);
  const createSession = useAgentStore((s) => s.createSession);
  const respondPermission = useAgentStore((s) => s.respondPermission);

  const [followUp, setFollowUp] = useState('');
  const startedAtRef = useRef(Date.now());
  const landedMsgRef = useRef<string | null>(null); // 落流 msgId（null=未落流）
  const lastSigRef = useRef('');
  const retiredRef = useRef(false);
  /** 本轮轮序（首落流时按流内 user 条目数定——一轮问答一张卡） */
  const roundRef = useRef(0);
  /** 最近一次事件时间（stream 变化即推进；看门狗判定用） */
  const lastProgressRef = useRef(Date.now());
  const [stalled, setStalled] = useState(false);
  const lastUserTextRef = useRef('');

  // 最近一条待决审批（waiting 弹框数据源）
  const pendingPerm = useMemo<StreamItem | null>(() => {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const it = stream[i];
      if (it.kind === 'permission' && it.outcome === null) return it;
    }
    return null;
  }, [stream]);

  // 用户消息留底（失败重试重发用）+ 事件推进时间戳
  useEffect(() => {
    lastProgressRef.current = Date.now();
    setStalled(false);
    const lastUser = [...stream].reverse().find((it) => it.kind === 'user');
    if (lastUser && lastUser.kind === 'user') lastUserTextRef.current = lastUser.text;
  }, [stream]);

  // 无进展看门狗（2026-11-10 真机卡死事故）：busy 且 120s 无任何事件 → 疑似
  // 卡住提示 + [结束会话] 自愈入口（bbrt 挂起无法靠等待恢复时用户可强制收口）
  const busy = !!session && RUNNING_STATES.has(session.status);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      if (Date.now() - lastProgressRef.current > 120_000) setStalled(true);
    }, 5000);
    return () => clearInterval(t);
  }, [busy]);

  const doForceEnd = () => {
    void getAgentBridge().endSession(sessionId).catch(() => undefined);
    onRetire();
  };

  const { stages, sources, rounds } = useMemo(() => stagesFromStream(stream), [stream]);
  const terminal = !!session && (TERMINAL_STATES.has(session.status) || session.endedAt != null);
  /** 会话存活但当前轮结束（idle/paused）：折叠为摘要条待追问，无运行动画 */
  const idle = !!session && !terminal && !RUNNING_STATES.has(session.status);

  const failed = session?.status === 'error';

  // 阶段边界 → 落流/更新（D18 §4.2；粗粒度签名+互斥锁，终态收口后退场）。
  // 事故教训（2026-11-10 真机）：细粒度签名（含 md 长度）× 无 in-flight 锁 ×
  // Date.now() 幂等键 = 每个流式 token 落一张新卡。现口径：签名只看阶段结构，
  // 落流/更新串行互斥，幂等键会话终身稳定（聚合单卡）。
  const syncLockRef = useRef(false);
  useEffect(() => {
    if (stages.length === 0 || syncLockRef.current) return;
    const sig = `${stagesSignature(stages)}#${terminal ? 'T' : 'R'}#${failed ? 'F' : 'N'}#${idle ? 'I' : 'B'}#${rounds}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    syncLockRef.current = true;
    const body: AgentCardBody = {
      kind: 'embedded_agent',
      session_id: sessionId,
      status: terminal ? (failed ? 'failed' : 'done') : idle ? 'done' : 'running',
      stages,
      sources,
      rounds,
      started_at: startedAtRef.current,
      ended_at: terminal ? Date.now() : idle ? Date.now() : undefined,
    };
    void (async () => {
      try {
        if (!landedMsgRef.current) {
          if (!roundRef.current) roundRef.current = stream.filter((it) => it.kind === 'user').length;
          landedMsgRef.current = await landAgentCard(convId, agentCardClientMsgId(sessionId, roundRef.current), body);
        } else if ((terminal || idle) && !retiredRef.current) {
          retiredRef.current = true;
          await patchAgentCard(landedMsgRef.current, body);
          onRetire(); // 本轮已收口（终态/回答完 idle）：消息流终态卡在场，本地活动卡退场
          return;
        } else if (!terminal && !idle) {
          await patchAgentCard(landedMsgRef.current, body);
        }
      } catch {
        lastSigRef.current = ''; // 落流为辅链路：失败不阻断本地，下个阶段边界重试
      } finally {
        syncLockRef.current = false;
      }
    })();
  }, [stages, sources, rounds, terminal, failed, idle, convId, sessionId, stream, onRetire]);

  // 审批弹框动作
  const [scope, setScope] = useState<GrantScope>('once');
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

  const doFollowUp = () => {
    const text = followUp.trim();
    if (!text) return;
    setFollowUp('');
    void sendTextTo(sessionId, text);
  };

  const doRetry = () => {
    if (lastUserTextRef.current) void sendTextTo(sessionId, lastUserTextRef.current);
  };

  /** F5 转到工作台（D18 §3.5 修订）：新会话不搬运内容——先调 im_history 自读
   * 本会话记录（含此前 Agent 卡片结论）建立上下文，再继续 */
  const doUpgrade = () => {
    void createSession({ mode: 'ask' }).then((meta) => {
      if (!meta) return;
      return sendTextTo(meta.id, contextInstruction(convId));
    }).then(() => navigate(`/agent/s/${useAgentStore.getState().activeSessionId ?? ''}`));
  };

  return (
    <>
      <AgentProcessCard
        live={!terminal}
        idle={idle}
        startedAt={startedAtRef.current}
        body={{ kind: 'embedded_agent', session_id: sessionId, status: terminal ? (failed ? 'failed' : 'done') : 'running', stages, sources, rounds }}
        testId="agent-activity-card"
        actions={
          <Space size={4} wrap>
            {stalled && busy ? (
              <span className="agc-stalled">
                ⚠ 120 秒无进展，疑似卡住
                <button type="button" className="agc-act-btn" onClick={doForceEnd}>
                  结束会话
                </button>
              </span>
            ) : null}
            {failed ? (
              <button type="button" className="agc-act-btn" onClick={doRetry}>
                <RefreshCw size={12} /> 重试
              </button>
            ) : null}
            <button type="button" className="agc-act-btn" onClick={doUpgrade} title="新建工作台会话并携带本卡结论">
              <ArrowUpRight size={12} /> 转到工作台
            </button>
          </Space>
        }
      />
      {/* 追问输入（单行；D18 §3.2——回复追加进同一会话/卡片） */}
      {!terminal ? (
        <div className="agc-followup">
          <input
            className="bbw-input agc-followup__input"
            placeholder="追问…"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) doFollowUp();
            }}
          />
          <button type="button" className="icon-btn" onClick={doFollowUp} title="发送追问">
            <Send size={14} />
          </button>
        </div>
      ) : null}

      {/* 审批弹框（waiting_permission；120s 超时=拒绝由 store 计时器收口） */}
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
              <Radio.Group size="small" value={scope} onChange={(e) => setScope(e.target.value as GrantScope)}>
                <Radio.Button value="once">本次</Radio.Button>
                <Radio.Button value="session">本会话</Radio.Button>
                <Radio.Button value="permanent">永久</Radio.Button>
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
      return `$ ${String(o.command)}  (${String(o.cwd)})${(o.dangerFlags as string[])?.length ? `\n⚠ ${((o.dangerFlags as string[]).join(', '))}` : ''}`;
    case 'diff':
      return `文件 ${String(o.file)}  +${o.addLines}/-${o.delLines}`;
    case 'obo':
      return `OBO ${String(o.target)}  scopes: ${(o.scopes as string[])?.join(', ')}`;
    default:
      return JSON.stringify(p);
  }
}

const EMPTY_STREAM: StreamItem[] = [];
