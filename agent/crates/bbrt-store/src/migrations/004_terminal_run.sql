-- 004_terminal_run：统一后台任务体系——kind 扩 terminal（2026-11-18）
-- run_command background:true 转后台执行也落 agent_run（id 前缀 terminal-），
-- 与子 agent/委派共用一张任务表（task.wait 统一等待、运行面板统一展示）。
-- SQLite CHECK 不能原位改：重建表法（新表 → 搬数据 → DROP → RENAME → 重建索引）。
CREATE TABLE agent_run_new (
  id                TEXT PRIMARY KEY,             -- 任务 id（agent-/worker-/terminal- 前缀 + 32 hex；存量 r-* 不迁移）
  session_id        TEXT NOT NULL REFERENCES agent_session(id),
  root_session_id   TEXT NOT NULL,                -- 调用链根会话（顶层 run=父会话）
  parent_run_id     TEXT NOT NULL DEFAULT '',     -- 父 run（team 成员 expert run=team run）
  parent_call_id    TEXT NOT NULL DEFAULT '',     -- 触发 run 的工具调用 id（委派=call_id）
  kind              TEXT NOT NULL CHECK(kind IN('probe','expert','team','delegate','terminal')),
  def_ref           TEXT NOT NULL DEFAULT '',     -- builtin.probe / {expertId}@{ver} / team:{topo} / backend:{type} / shell
  status            TEXT NOT NULL CHECK(status IN('running','done','failed','cancelled','interrupted')),
  eta_hint_ms       INTEGER NOT NULL DEFAULT 0,   -- 预估耗时（P1-6 滚动统计）
  eta_actual_ms     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '',     -- 结果摘要截断快照（terminal=exit+输出尾部）
  child_session_ref TEXT NOT NULL DEFAULT '',     -- 委派子进程会话句柄（--resume 用）
  actor             TEXT NOT NULL DEFAULT '',     -- OBO subject 快照（鉴权审计）
  created_at        INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
INSERT INTO agent_run_new SELECT * FROM agent_run;
DROP TABLE agent_run;
ALTER TABLE agent_run_new RENAME TO agent_run;
CREATE INDEX idx_run_session ON agent_run(session_id, created_at);
CREATE INDEX idx_run_root ON agent_run(root_session_id);
