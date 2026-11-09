-- 0033：bot / bot_subscription 机器人身份与 Outgoing 事件订阅
-- （20 篇 / G8 开放 API 底座 / EXECUTION-PLAN E11）。
-- v0.1 裁剪登记（相对 20 篇全模型）：
--   * Incoming（外部→群发消息 /hook/*）与 @bot 转发随阶段二——本迁移只落
--     Outgoing（群事件 → 外部回调 URL）即 G8"开放 API"的事件外发底座；
--   * 事件类型 v0.1=msg.created（过滤词/@bot 命中扇出）；审批/Agent 任务事件
--     扇出随消费方事件源接入（notify 直调同款模式扩）；
--   * 投递：HMAC-SHA256 签名（X-BBW-Signature: t=<unix>,v1=<hex> 时间戳防重放）
--     + 3 次退避重试（500ms/1s/2s；4xx 不重试）；死信/投递日志表随阶段二。
--   * bot.secret 即开放 API 凭证（G8：Outgoing 框架扩展开放 API 的密钥基座）。
CREATE TABLE IF NOT EXISTS bot (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT      NOT NULL,
    bot_id     TEXT        NOT NULL,           -- b_xxx（展示用短 id）
    name       TEXT        NOT NULL,
    secret     TEXT        NOT NULL,           -- HMAC 密钥（创建时一次性返回明文）
    status     SMALLINT    NOT NULL DEFAULT 1, -- 1 active 2 revoked
    created_by BIGINT      NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_bot UNIQUE (tenant_id, bot_id)
);

CREATE TABLE IF NOT EXISTS bot_subscription (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    bot_row_id   BIGINT      NOT NULL,
    conv_id      BIGINT      NOT NULL,          -- 订阅作用域：单会话（#客服群）
    filter_words TEXT        NOT NULL DEFAULT '[]', -- JSON 数组；空数组=@bot 命中即推（S2）
    target_url   TEXT        NOT NULL,           -- 外部回调（https://…/callback）
    status       SMALLINT    NOT NULL DEFAULT 1,
    created_by   BIGINT      NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_bot_sub UNIQUE (tenant_id, bot_row_id, conv_id, target_url)
);
CREATE INDEX IF NOT EXISTS idx_bot_sub_conv ON bot_subscription (tenant_id, conv_id) WHERE status = 1;

ALTER TABLE bot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON bot;
CREATE POLICY p_tenant ON bot USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE bot_subscription ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON bot_subscription;
CREATE POLICY p_tenant ON bot_subscription
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
