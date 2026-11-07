-- 0012_bot：机器人域（20 篇阶段一务实版）
-- bot 主档 + bot_webhook（Incoming）；bot_delivery_log 随阶段二 Outgoing
-- 投递队列（Redis Stream）落地，本迁移不含。
-- users.type 列 0001 已预埋（1 human 2 bot，20 篇 §3.2 回填）。

CREATE TABLE IF NOT EXISTS bot (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    user_id       BIGINT NOT NULL,             -- 关联 users(type=2)
    dept_id       BIGINT,                      -- 可选挂靠部门
    name          TEXT NOT NULL,
    description   TEXT,
    owner_user_id BIGINT NOT NULL,             -- 创建/负责开发者
    linked_app_id TEXT,                        -- 关联 eco_app（10 篇互链，阶段二）
    status        SMALLINT NOT NULL DEFAULT 2, -- 1 active 2 disabled（建即停用，装凭证后启用）
    settings      JSONB NOT NULL DEFAULT '{}',
    created_by    BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_bot_tenant_user UNIQUE (tenant_id, user_id),
    CONSTRAINT uk_bot_tenant_name UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_bot_tenant_status ON bot (tenant_id, status);

CREATE TABLE IF NOT EXISTS bot_webhook (
    id               BIGINT PRIMARY KEY,
    tenant_id        BIGINT NOT NULL DEFAULT 1,
    bot_id           BIGINT NOT NULL REFERENCES bot(id),
    direction        SMALLINT NOT NULL DEFAULT 1,  -- 1 in 2 out（v0.1 仅 in）
    hook_id          TEXT NOT NULL,                -- in 方向 URL 组成（随机不可枚举）
    callback_url     TEXT,                         -- out 方向（阶段二）
    secret           TEXT NOT NULL,                -- HMAC 密钥（v0.1 明文，KMS 信封加密登记 OQ）
    prev_secret      TEXT,                         -- 轮换宽限 24h 双验签
    prev_expires_at  TIMESTAMPTZ,
    default_conv_id  BIGINT,                       -- 省略 target 时默认会话
    targets          JSONB NOT NULL DEFAULT '[]',  -- in: 授权 conv_id 集合；out: 事件配置（阶段二）
    ip_allowlist     JSONB NOT NULL DEFAULT '[]',  -- CIDR 列表（可选）
    rate_limit       INT NOT NULL DEFAULT 30,      -- msg/min（10–120）
    status           SMALLINT NOT NULL DEFAULT 1,  -- 1 active 2 disabled
    rotated_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_webhook_hook_id UNIQUE (hook_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_tenant_bot ON bot_webhook (tenant_id, bot_id);
