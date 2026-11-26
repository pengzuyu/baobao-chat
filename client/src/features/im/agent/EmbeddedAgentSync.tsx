/**
 * IM 内嵌 Agent 同步控制器（2026-11-11 改版：无头化——输入框上方活动卡取消，
 * 回复卡承载全部交互，本组件只负责「写路径」与审批弹框）：
 * - 一轮一卡：流内 user 条目数变化=新回合 → **立即**落本地 running 卡（2026-11-25
 *   本地化拍板：提问与过程卡仅本机可见——不再 msg.send/PATCH 服务端，落 im store
 *   'local' 消息 + KV 轮次记录，对方与群友全程无感知；0 阶段也落——消息流即时出现
 *   反馈，不等首个 LLM 事件；clientMsgId 用 agentCardRoundToken：轮内稳定（重试
 *   幂等）/跨轮跨重启唯一——旧 agc-{sid}-r{N} 确定性键壳重启后撞历史轮号）
 * - 重挂重同步：不再重新落卡，只认领消息流内本会话 running 卡（含 KV 恢复出的）
 *   续 PATCH；无 running 卡的旧轮整段封口（sealedRound——依赖变化不再落卡，新回合
 *   自然解封；见 effect 注）
 * - 阶段边界 PATCH：粗粒度签名+互斥锁（防更新风暴口径不变，不含结论文本长度）；
 *   终态/idle 最后一次 PATCH 收口后静默（新回合自然落新卡）
 * - 审批弹框（antd Modal）：本组件**常驻挂载**（会话映射存在即挂，不随回合退场）
 *   ——修「审批弹框没显示」：旧活动卡 idle 退休卸载后 permissionRequest 无宿主
 * - 流式实时显示由卡 AgentCardMsg 订阅 store 直渲（读路径与写路径解耦，
 *   此前共用粗签名导致文本不随 delta 刷新、「一下子全输出」）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Radio } from 'antd';
import type { AgentCardBody } from '../../../shared/components/AgentProcessCard';
import { useAgentStore, type StreamItem } from '../../agent/store/agent';
import { getAgentBridge } from '../../agent/bridge';
import type { GrantScope } from '../../agent/bridge/types';
import { ClarifyForm, type ClarifySubmit } from '../../agent/components/ClarifyCard';
import { useImStore } from '../store/im';
import { agentCardRoundToken, currentRoundItems, landAgentCard, patchAgentCard, roundQuestionFullOf, roundQuestionOf, stagesFromStream, stagesSignature } from './embedded';

const TERMINAL_STATES = new Set(['error', 'ended']);

const EMPTY_STREAM: StreamItem[] = [];

interface Props {
  convId: string;
  sessionId: string;
}

export function EmbeddedAgentSync({ convId, sessionId }: Props) {
  const stream = useAgentStore((s) => s.streams[sessionId] ?? EMPTY_STREAM);
  const session = useAgentStore((s) => s.sessions.find((m) => m.id === sessionId));
  const respondPermission = useAgentStore((s) => s.respondPermission);

  /** 已落卡回合号（流内 user 条目数）；≠当前值=新回合 → 重置落卡目标 */
  const landedRoundRef = useRef<number | null>(null);
  /** 已落卡轮 token（=卡消息 clientMsgId，PATCH 目标键；新回合落卡/挂载认领两条路赋值） */
  const landedTokenRef = useRef<string | null>(null);
  /** 本回合落流 token（轮内稳定/跨轮唯一；见 embedded.ts agentCardRoundToken） */
  const roundTokenRef = useRef<string | null>(null);
  const lastSigRef = useRef('');
  const retiredRef = useRef(false);
  /** 当前轮已封口（挂载时无 running 卡可认领的旧轮）：不再落流/更新，直到新回合 */
  const sealedRoundRef = useRef(false);
  /** 本回合起点（最后一条 user 的 ts；卡头已用时显示） */
  const roundStartRef = useRef(Date.now());
  const syncLockRef = useRef(false);
  /** 锁占用期间有新同步请求挂起；释放后立即补跑（新回合 0 阶段卡不等流事件） */
  const retrySyncRef = useRef(false);
  /** 最新同步函数（finally 补跑用——effect 闭包会随依赖更新，取最新版） */
  const syncFnRef = useRef<() => void>(() => {});

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

  const terminal = !!session && (TERMINAL_STATES.has(session.status) || session.endedAt != null);
  // failed 判定：会话 error 态（历史口径）或本轮流内含错误条目（8011/8010——RT
  // 错误收口 idle，session.status 不翻 error，须看流内错误卡）
  const failed =
    session?.status === 'error' || currentRoundItems(stream).some((it) => it.kind === 'error');
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

  // ── 落流/更新（写路径；阶段边界节流，读路径实时性由 AgentCardMsg 订阅保证）──
  useEffect(() => {
    const doSync = () => {
    const userCount = stream.filter((it) => it.kind === 'user').length;
    if (userCount === 0) return; // 空流（未提问）不落卡
    if (landedRoundRef.current === null) {
      // 挂载重同步（2026-11-11 口径变更）：不再按确定性键重新落卡——旧口径
      // agc-{sid}-r{N} 的 N 取内存流 user 条数，壳重启后计数归零，重新落卡会与
      // 历史轮撞号。现只认领消息流内本会话仍在 running 的最新卡为 PATCH 目标
      // （含 ChatPage 挂载时 KV 恢复出的本地卡）：自愈「失宿主期间轮次收口、终态
      // PATCH 丢失」卡停 running；无 running 卡（历史轮均已收口，或本轮在工作台
      // 发起本就不落卡）静默等新回合
      landedRoundRef.current = userCount;
      const list = useImStore.getState().messagesByConv[convId] ?? [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m.type !== 'agent_card') continue;
        const b = m.body as AgentCardBody | undefined;
        if (b && b.session_id === sessionId && b.status === 'running') {
          landedTokenRef.current = m.clientMsgId;
          // 回合起点对齐卡身（补终态 PATCH 的用时口径不被挂载时刻覆盖）
          if (typeof b.started_at === 'number') roundStartRef.current = b.started_at;
          break;
        }
      }
      if (!landedTokenRef.current) {
        // 无 running 卡且本轮已收口（roundClosed）→ 历史旧轮封口。2026-11-20 修
        // 「重进聊天页一次多一张重复结果卡」：此前只 return 一次，之后流事件/终态翻转
        // 触发 effect 再跑会走「无目标→落新卡」分支，把旧轮结果重复落流。2026-11-24
        // 修「聊天页提问回复只在工作台展示」（封口误伤在途回合回归）：未收口轮不封口
        // 放行到下方 origin 闸门；WAL 回填的旧轮 turnDoneAt 必打点（终态收口含
        // interrupt），收口旧轮照旧封口防重复落卡
        if (roundClosed) {
          sealedRoundRef.current = true;
          return;
        }
        // 在途回合放行落卡：计时起点对齐本轮 user ts（卡头「已用时」口径不被挂载时刻覆盖）
        if (lastUser) roundStartRef.current = lastUser.ts;
      }
    } else if (landedRoundRef.current !== userCount) {
      // 新回合：唯一 token 落新卡（0 阶段 running 也落）+ 重置落卡目标（一轮一卡）
      const lastUser = [...stream].reverse().find((it) => it.kind === 'user');
      const roundTs = lastUser && lastUser.kind === 'user' ? lastUser.ts : Date.now();
      landedRoundRef.current = userCount;
      landedTokenRef.current = null;
      roundTokenRef.current = agentCardRoundToken(sessionId, userCount, roundTs);
      retiredRef.current = false;
      sealedRoundRef.current = false;
      roundStartRef.current = roundTs;
      lastSigRef.current = '';
    }
    if (syncLockRef.current) {
      // 上一次落流/PATCH 仍在飞：挂起标记，锁释放后立即重跑（修「新回合卡不立即
      // 落」——此前直接 return 且无重试，快速连续对话时 0 阶段卡要等首个模型事件
      // 才补落，用户看到"发了消息没反应"+误读旧卡计时）
      retrySyncRef.current = true;
      return;
    }
    // 回合发起方闸门（2026-11-20 修「工作台回合泄漏进 IM」）：未持有落卡目标时，
    // 只有聊天页发起（origin=im）的回合才落新卡——工作台发起/历史未知回合在此
    // 静默返回。已认领 running 卡（landedTokenRef 有值）不受限，PATCH 照常
    const lastUserItem = [...stream].reverse().find((it) => it.kind === 'user');
    if (!landedTokenRef.current && lastUserItem?.origin !== 'im') return;
    // 旧轮封口（2026-11-20）：挂载时未认领 running 卡的旧回合不落卡——sessions 异步
    // 到达/终态翻转等依赖变化会反复进此段，不封口则每次都重复落卡
    if (sealedRoundRef.current && !landedTokenRef.current) return;
    // 只投影当前轮（最后一条 user 之后）——喂全会话流会让新卡在模型响应前
    // 顶着上一轮的 conclusion（2026-11-11「新卡带旧答案」修复）
    const { stages, sources, rounds } = stagesFromStream(currentRoundItems(stream));
    const status: AgentCardBody['status'] = terminal ? (failed ? 'failed' : 'done') : roundClosed ? 'done' : 'running';
    const sig = `${stagesSignature(stages)}#${status}#${rounds}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    syncLockRef.current = true;
    const body: AgentCardBody = {
      kind: 'embedded_agent',
      session_id: sessionId,
      status,
      // streaming 是 live 投影瞬态旗标（落库即过时——历史卡思考恒折叠），剥除不落
      stages: stages.map((s) => (s.streaming == null ? s : { ...s, streaming: undefined })),
      sources,
      rounds,
      started_at: roundStartRef.current,
      ended_at: status !== 'running' ? Date.now() : undefined,
      question: roundQuestionOf(stream),
    };
    void (async () => {
      try {
        if (!landedTokenRef.current) {
          // 落卡（2026-11-25 本地化）：token 兜底同绑本轮 user ts（正常路径轮 token 已在
          // 新回合分支生成存 ref）；提问全文随卡注册（KV 记录+分享引用数据源）
          landedTokenRef.current = roundTokenRef.current ?? agentCardRoundToken(sessionId, userCount, lastUserItem?.ts ?? Date.now());
          await landAgentCard(convId, landedTokenRef.current, body, roundQuestionFullOf(stream));
        } else if (status !== 'running' && !retiredRef.current) {
          retiredRef.current = true;
          await patchAgentCard(convId, landedTokenRef.current, body);
        } else if (status === 'running') {
          await patchAgentCard(convId, landedTokenRef.current, body);
        }
      } catch {
        lastSigRef.current = ''; // 本地写失败不阻断（IDB 异常下个阶段边界重试）
      } finally {
        syncLockRef.current = false;
        if (retrySyncRef.current) {
          retrySyncRef.current = false;
          syncFnRef.current(); // 释放即补跑（新回合落卡不再等流事件）
        }
      }
    })();
    };
    syncFnRef.current = doSync;
    doSync();
  }, [stream, terminal, failed, roundClosed, convId, sessionId]);

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
            <div className="agc-perm__hint">不会超时，等你处理或中断会话</div>
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
    case 'read':
      return `读取文件 ${String(o.path)}`;
    case 'read-sensitive':
      return `读取敏感文件（密钥/凭据类，仅本次） ${String(o.path)}`;
    case 'obo':
      return `OBO ${String(o.target)}  scopes: ${(o.scopes as string[])?.join(', ')}`;
    default:
      return JSON.stringify(p);
  }
}
