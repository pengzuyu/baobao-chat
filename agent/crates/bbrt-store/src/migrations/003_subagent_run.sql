-- 003_subagent_run：子 Agent run 记录模型（D16 §3.1）
-- 三形态（探查/专家/团队/委派）统一审计行：一次调用 = 一条 run +
-- 一段带 run_id 的 agent_event 事件流，可完整重放。
-- 取代 001 的 delegate_task DDL（该表从未接线，DDL 保留待后续清理迁移）。
CREATE TABLE agent_run (
  id                TEXT PRIMARY KEY,             -- r-<seq> 持久发号（跨重启唯一）
  session_id        TEXT NOT NULL REFERENCES agent_session(id),
  root_session_id   TEXT NOT NULL,                -- 调用链根会话（顶层 run=父会话）
  parent_run_id     TEXT NOT NULL DEFAULT '',     -- 父 run（team 成员 expert run=team run）
  parent_call_id    TEXT NOT NULL DEFAULT '',     -- 触发 run 的工具调用 id（委派=call_id）
  kind              TEXT NOT NULL CHECK(kind IN('probe','expert','team','delegate')),
  def_ref           TEXT NOT NULL DEFAULT '',     -- builtin.probe / {expertId}@{ver} / team:{topo} / backend:{type}
  status            TEXT NOT NULL CHECK(status IN('running','done','failed','cancelled','interrupted')),
  eta_hint_ms       INTEGER NOT NULL DEFAULT 0,   -- 预估耗时（P1-6 滚动统计）
  eta_actual_ms     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '',     -- 结果摘要截断快照
  child_session_ref TEXT NOT NULL DEFAULT '',     -- 委派子进程会话句柄（--resume 用）
  actor             TEXT NOT NULL DEFAULT '',     -- OBO subject 快照（鉴权审计）
  created_at        INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX idx_run_session ON agent_run(session_id, created_at);
CREATE INDEX idx_run_root ON agent_run(root_session_id);

ALTER TABLE agent_event ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_event_run ON agent_event(run_id);
