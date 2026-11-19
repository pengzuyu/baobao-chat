-- 006：会诊/协作图（team）退役（2026-11-19）——Team Graph 编排整域移除，
-- 保留通用子 agent（probe）与专家（expert）：
-- - kind 收窄为 probe/expert/terminal（SQLite CHECK 不能原位改，重建表法同 004/005）；
-- - 存量 team 行清洗（团队编排汇总行；成员 expert 行保留，其 parent_run_id
--   指向已删 team 行——无外键，悬空可接受）；
-- - def_ref 去 team:{topology} 语义（注释口径）。
CREATE TABLE agent_run_new (
  id                TEXT PRIMARY KEY,             -- 任务 id（agent-/terminal- 前缀 + 32 hex；存量 r-* 不迁移）
  session_id        TEXT NOT NULL REFERENCES agent_session(id),
  root_session_id   TEXT NOT NULL,                -- 调用链根会话（顶层 run=父会话）
  parent_run_id     TEXT NOT NULL DEFAULT '',     -- 父 run（嵌套子任务用；顶层恒空）
  parent_call_id    TEXT NOT NULL DEFAULT '',     -- 触发 run 的工具调用 id
  kind              TEXT NOT NULL CHECK(kind IN('probe','expert','terminal')),
  def_ref           TEXT NOT NULL DEFAULT '',     -- builtin.probe / {expertId}@{ver} / shell
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
  FROM agent_run WHERE kind != 'team';
DROP TABLE agent_run;
ALTER TABLE agent_run_new RENAME TO agent_run;
CREATE INDEX idx_run_session ON agent_run(session_id, created_at);
CREATE INDEX idx_run_root ON agent_run(root_session_id);