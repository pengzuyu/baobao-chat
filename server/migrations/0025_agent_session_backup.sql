-- 0025：agent_session_backup Agent 会话云端备份索引（08 篇 §5.2，OQ-B09 拍板：
-- 口令派生+恢复码，端侧加密零知识——服务端只存密文与密钥 envelope，不可读明文）。
-- v0.1 取舍登记（相对 08 篇对象在 MinIO 的设计）：
--   * 事件密文 v0.1 存本地盘 DATA_DIR/agent-backup/{tenant}/{user}/{id}.bin
--     （对象存储/预签名上传随 file 域对象化阶段二一并切换）；
--   * key_envelope 为端侧生成的密钥信封 JSON（wrapped DEK ×2：口令/恢复码各一），
--     随索引行存储以支持跨设备恢复（08 篇表未列此列，属端侧加密方案落地新增）；
--   * idempotency_key 支撑创建幂等（08 篇 §6.3 Idempotency-Key）。
CREATE TABLE IF NOT EXISTS agent_session_backup (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL,
    user_id         BIGINT      NOT NULL,
    local_session_id TEXT       NOT NULL,          -- 端侧会话标识（备份对象锚点）
    title           TEXT        NOT NULL DEFAULT '',
    enc_alg         TEXT        NOT NULL,          -- 端侧声明（如 AES-256-GCM）
    key_envelope    TEXT        NOT NULL,          -- 密钥信封 JSON（零知识：服务端不可解）
    size            BIGINT      NOT NULL,          -- 密文字节数
    idempotency_key TEXT,                          -- 创建幂等（同用户同 key 去重）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等去重（同用户同 key 唯一；NULL 不参与）
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_backup_idem
    ON agent_session_backup (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
-- 我的备份列表（created_at 倒序）
CREATE INDEX IF NOT EXISTS idx_agent_backup_user
    ON agent_session_backup (tenant_id, user_id, created_at DESC);

ALTER TABLE agent_session_backup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON agent_session_backup;
CREATE POLICY p_tenant ON agent_session_backup
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
