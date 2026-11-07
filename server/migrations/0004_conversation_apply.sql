-- 0004：conversation_apply 入群申请表（D03 §6.1；04 篇 §4.5.2 审批入群）。
-- 说明：任务基线曾按「0001 已含全部表」推进，实际核对 0001 仅含 group_setting，
-- conversation_apply 缺失——补齐最小迁移，幂等写法可安全重放。
-- 同群同人待审唯一：部分唯一索引（status=1 行冲突即拒绝重复申请）。
CREATE TABLE IF NOT EXISTS conversation_apply (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    conv_id    BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    status     SMALLINT NOT NULL DEFAULT 1,        -- 1 待审 2 通过 3 拒绝 4 过期(7d)
    handled_by BIGINT,
    handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_apply_pending
    ON conversation_apply (conv_id, user_id) WHERE status = 1;
CREATE INDEX IF NOT EXISTS idx_apply_conv ON conversation_apply (conv_id, status);

ALTER TABLE conversation_apply ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON conversation_apply;
CREATE POLICY p_tenant ON conversation_apply
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
