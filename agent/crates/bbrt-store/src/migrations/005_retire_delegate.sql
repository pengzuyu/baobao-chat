-- 005：委派域退役（2026-11-18）——外部 CLI 编码代理（claude/zcode/generic）
-- 整域移除，零兼容硬切（K8s 环境 2026-11-17 已清库，数据可弃）：
-- - DROP delegate_task（001 建表后从未接线）、coding_backend（唯一消费方=
--   委派 health 探测 upsert，随域移除）；
-- - agent_run 去 kind='delegate' 与 child_session_ref 列（委派 --resume 句柄
--   专用）——SQLite CHECK 不能原位改，重建表法（同 004）；存量 delegate 行清洗；
-- - agent_session 去 backend 列（委派徽标专用，恒空；SQLite ≥3.35 DROP COLUMN）。
DROP TABLE IF EXISTS delegate_task;
DROP TABLE IF EXISTS coding_backend;

CREATE TABLE agent_run_new (
  id                TEXT PRIMARY KEY,             -- 任务 id（agent-/terminal- 前缀 + 32 hex；存量 r-* 不迁移）
  session_id        TEXT NOT NULL REFERENCES agent_session(id),
  root_session_id   TEXT NOT NULL,                -- 调用链根会话（顶层 run=父会话）
  parent_run_id     TEXT NOT NULL DEFAULT '',     -- 父 run（team 成员 expert run=team run）
  parent_call_id    TEXT NOT NULL DEFAULT '',     -- 触发 run 的工具调用 id
  kind              TEXT NOT NULL CHECK(kind IN('probe','expert','team','terminal')),
  def_ref           TEXT NOT NULL DEFAULT '',     -- builtin.probe / {expertId}@{ver} / team:{topology} / shell
  status            TEXT NOT NULL CHECK(status IN('running','done','failed','cancelled','interrupted')),
  eta_hint_ms       INTEGER NOT NULL DEFAULT 0,   -- 预估耗时（P1-6 滚动统计）
  eta_actual_ms     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '',     -- 结果摘要截断快照（terminal=exit+输出尾部）
  actor             TEXT NOT NULL DEFAULT '',     -- OBO subject 快照（鉴权审计）
  created_at        INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
INSERT INTO agent_run_new (id, session_id, root_session_id, parent_run_id, parent_call_id,
                           kind, def_ref, status, eta_hint_ms, eta_actual_ms, summary,
                           actor, created_at, started_at, ended_at)
  SELECT id, session_id, root_session_id, parent_run_id, parent_call_id,
         kind, def_ref, status, eta_hint_ms, eta_actual_ms, summary,
         actor, created_at, started_at, ended_at
  FROM agent_run WHERE kind != 'delegate';
DROP TABLE agent_run;
ALTER TABLE agent_run_new RENAME TO agent_run;
CREATE INDEX idx_run_session ON agent_run(session_id, created_at);
CREATE INDEX idx_run_root ON agent_run(root_session_id);

ALTER TABLE agent_session DROP COLUMN backend;
