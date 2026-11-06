-- 001_init：初始 schema（D11 §11 全表 DDL 逐表照建，唯一权威，只增不改）
-- 数据目录：客户端 agent/ 子目录；WAL 模式；busy_timeout=5000
-- （journal_mode / busy_timeout / foreign_keys 由 lib.rs open() 统一设置）
CREATE TABLE agent_workspace (
  id             TEXT PRIMARY KEY,             -- ws-<ulid>
  path           TEXT NOT NULL UNIQUE,         -- realpath
  name           TEXT NOT NULL,
  is_repo        INTEGER NOT NULL DEFAULT 0,   -- git 探测
  trusted        INTEGER NOT NULL DEFAULT 0,   -- 信任确认（08 §4.4）
  extra_dirs     TEXT,                         -- JSON: 例外目录[]
  last_opened_at INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE agent_session (
  id            TEXT PRIMARY KEY,              -- sess-<ulid>
  workspace_id  TEXT REFERENCES agent_workspace(id),
  title         TEXT NOT NULL DEFAULT '新会话',
  form          TEXT NOT NULL DEFAULT 'workbench' CHECK(form IN('embedded','workbench')),
  mode          TEXT NOT NULL DEFAULT 'ask' CHECK(mode IN('ask','auto-edit','full-auto')),
  backend       TEXT,                          -- 委派后端 zcode|claude|generic|builtin（17 篇增列）
  model_policy  TEXT NOT NULL DEFAULT 'auto' CHECK(model_policy IN('fast','strong','auto')),
  status        TEXT NOT NULL DEFAULT 'idle',  -- §3 状态机枚举
  share_enabled INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  summary       TEXT
);
CREATE INDEX idx_session_status ON agent_session(status, updated_at DESC);

CREATE TABLE agent_event (                     -- 事件镜像 WAL（§9.1）
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES agent_session(id),
  seq         INTEGER NOT NULL,                -- 会话内单调
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,                   -- JSON
  created_at  INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_event_session ON agent_event(session_id, seq);

CREATE TABLE agent_checkpoint (
  id             TEXT PRIMARY KEY,             -- cp-<ulid>
  session_id     TEXT NOT NULL REFERENCES agent_session(id),
  git_ref        TEXT,                         -- refs/bbw-agent/{session}/cp-{n}
  untracked      TEXT,                         -- JSON: 未跟踪文件清单
  files_changed  TEXT NOT NULL,                -- JSON: [{path,add,del}]
  reason         TEXT NOT NULL CHECK(reason IN('pre-edit','pre-command','manual','delegate','pre-restore')),
  last_event_seq INTEGER NOT NULL,             -- 重放起点（§9.2）
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_cp_session ON agent_checkpoint(session_id, created_at DESC);

CREATE TABLE agent_context (                   -- 上下文持久化（压缩态）
  session_id      TEXT PRIMARY KEY REFERENCES agent_session(id),
  history         TEXT NOT NULL,               -- JSON: 近 N 轮
  archive_summary TEXT,                        -- JSON: 归档摘要段
  key_file_map    TEXT,                        -- JSON: path→{usage,lines}
  token_usage     TEXT NOT NULL,               -- JSON: {in,out,by_model}
  updated_at      INTEGER NOT NULL
);

CREATE TABLE agent_tool_grant (                -- 三级记忆（09 §4.2）
  id          TEXT PRIMARY KEY,
  session_id  TEXT,                            -- scope=session 时归属会话
  tool        TEXT NOT NULL,
  pattern     TEXT NOT NULL,                   -- 命令前缀/路径通配/域名
  scope       TEXT NOT NULL CHECK(scope IN('once','session','permanent')),
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,                         -- once=立即；session=会话结束
  source_card TEXT                             -- 审批卡摘要（PAG-11 展示）
);
CREATE INDEX idx_grant_tool ON agent_tool_grant(tool, scope);
-- permanent 同步镜像至文件 agent/allow.json（09 §4.2，不上云）

CREATE TABLE agent_audit_meta (                -- 审计 JSONL 索引与链头
  session_id  TEXT PRIMARY KEY REFERENCES agent_session(id),
  file_path   TEXT NOT NULL,                   -- agent/audit/{session}.jsonl
  events      INTEGER NOT NULL DEFAULT 0,
  first_ts    INTEGER, last_ts INTEGER,
  chain_head  TEXT NOT NULL,                   -- 哈希链头（锚定上报）
  anchored_at INTEGER,
  report_mode TEXT NOT NULL DEFAULT 'metadata' CHECK(report_mode IN('off','metadata','full'))
);

CREATE TABLE agent_sandbox_violation (         -- 被阻止操作（09 §5.1）
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_session(id),
  kind       TEXT NOT NULL CHECK(kind IN('path','network','resource','rule','danger-cmd')),
  detail     TEXT NOT NULL,                    -- 打码后
  code       INTEGER NOT NULL,                 -- 8020-8026
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_violation_session ON agent_sandbox_violation(session_id, ts DESC);

CREATE TABLE coding_backend (                  -- 17 §7
  id           TEXT PRIMARY KEY,               -- 类型即 id（zcode/claude/generic:bin/builtin）
  type         TEXT NOT NULL,
  path         TEXT,
  version      TEXT,
  capabilities TEXT NOT NULL,                  -- JSON: {edit,command,resume,smoke_ms}
  enabled      INTEGER NOT NULL DEFAULT 1,     -- 租户策略禁用→0（8032）
  is_default   INTEGER NOT NULL DEFAULT 0,
  detected_at  INTEGER NOT NULL
);

CREATE TABLE delegate_task (                   -- 17 §7
  id                TEXT PRIMARY KEY,          -- dt-<ulid>
  parent_session_id TEXT NOT NULL REFERENCES agent_session(id),
  backend_type      TEXT NOT NULL,
  task_brief        TEXT NOT NULL,             -- JSON TaskBrief
  status            TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN
                    ('preparing','running','completed','failed','cancelled',
                     'reviewing','accepted','rejected_restored')),
  child_session_ref TEXT,                      -- --resume 等续接句柄
  exit_code         INTEGER,
  result_summary    TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER
);
CREATE INDEX idx_delegate_parent ON delegate_task(parent_session_id, created_at DESC);
-- D08 的 agent_approval_cache（宿主侧 UI 缓存表）不属 Runtime 库，DDL 见 D08 §6.1
