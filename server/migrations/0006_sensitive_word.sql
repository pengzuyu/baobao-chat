-- 0006：敏感词租户词库（04 篇 §4.5/§7.3；D03 §6.1 原设计表——0001 漏建，补齐幂等）。
-- 用途：Send/Edit 内容策略（mode=1 拦截 3005；2 替换；3 审计）与搜索打标；热更通道=admin 策略域（阶段二）。
CREATE TABLE IF NOT EXISTS sensitive_word (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    word        TEXT NOT NULL,
    mode        SMALLINT NOT NULL DEFAULT 1 CHECK (mode IN (1,2,3)), -- 1拦截 2替换 3审计
    category    TEXT,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_by  BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, word)
);
CREATE INDEX IF NOT EXISTS idx_sensitive_word_tenant ON sensitive_word (tenant_id, enabled);
ALTER TABLE sensitive_word ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant ON sensitive_word USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
