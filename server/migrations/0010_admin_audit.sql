-- 0010：管理审计动作表（D10 阶段一务实版）。
-- 与 12 篇 §5 admin_operation 全量明细账的取舍：阶段一无二次验证票据/审批工单/
-- trace 归因列，落窄表 admin_audit_action（id/tenant_id/operator_id/action/target/
-- detail jsonb/created_at）；operator_roles/second_auth/approval_id/trace_id 等列
-- 随阶段二（哈希链+审批流）补齐——幂等 ALTER 追加列即可，不影响本表语义。
-- 记录范围：本阶段全部管理写操作（用户禁用/启用、敏感词增删）。
CREATE TABLE IF NOT EXISTS admin_audit_action (
    id          BIGINT PRIMARY KEY,              -- advisory lock 9114 + max(id)+1（雪花占位，13 篇 §1）
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    operator_id BIGINT NOT NULL,                 -- 操作人 uid
    action      TEXT NOT NULL,                   -- user.disable / user.enable / policy.sensitive_word.add|delete
    target      TEXT NOT NULL DEFAULT '',        -- 操作对象（如 "user:10001" / "sensitive_word:12"）
    detail      JSONB NOT NULL DEFAULT '{}',     -- 变更摘要（脱敏后）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant_id ON admin_audit_action (tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_operator ON admin_audit_action (operator_id, id DESC);
ALTER TABLE admin_audit_action ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON admin_audit_action;
CREATE POLICY p_tenant ON admin_audit_action USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
