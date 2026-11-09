-- 0028：agent_tool_policy 租户工具策略（09 篇 §5.2 行级模型 / EXECUTION-PLAN D7：
-- admin 策略页只读快照 → 可编辑）。行级 subject（工具名/命名空间）粒度，
-- 快照合成=default 策略 + 行覆盖（AgentPolicy() source 切 "table"）。
-- 生效链路（agent.policy.updated 事件 → bbrt 工具门面热更）随 Agent 域阶段二接线；
-- v0.1 本表先落存储与管理面，09 §4 判定链①读点即此表。
-- subject 语义：builtin 工具名（fs_read/fs_write/shell_exec/http_fetch）或
-- app:{namespace}:{tool} 命名空间形态；risk_override 空对象=不覆盖矩阵默认。
CREATE TABLE IF NOT EXISTS agent_tool_policy (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL,
    subject       TEXT        NOT NULL,   -- 工具名 / 命名空间（app:ns:*）
    allowed       BOOLEAN     NOT NULL DEFAULT TRUE,
    risk_override TEXT        NOT NULL DEFAULT '{}', -- JSON：{"run_command":"auto"} 形态（空=矩阵默认）
    config        TEXT        NOT NULL DEFAULT '{}', -- JSON：工具级扩展配置（白名单前缀等）
    updated_by    BIGINT      NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_agent_tool_policy UNIQUE (tenant_id, subject)
);

ALTER TABLE agent_tool_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON agent_tool_policy;
CREATE POLICY p_tenant ON agent_tool_policy
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
