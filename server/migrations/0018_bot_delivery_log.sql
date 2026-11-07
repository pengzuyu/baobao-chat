-- 0018_bot_delivery_log：Outgoing Webhook 投递记录/死信队列（20 §5）。
-- 按月分区随体量阶段二登记（v0.1 单表）；Redis Stream 重试队列
-- （t:{tid}:bot:retryq）随多实例部署阶段二——v0.1 进程内时间轮询扫描
-- next_retry_at（同 eventbus InMemory 先例口径）。
-- ID 分配 advisory lock 9128。

CREATE TABLE IF NOT EXISTS bot_delivery_log (
    id             BIGINT PRIMARY KEY,
    tenant_id      BIGINT NOT NULL DEFAULT 1,
    bot_id         BIGINT NOT NULL,
    webhook_id     BIGINT NOT NULL,
    event_id       TEXT NOT NULL,               -- 幂等键（UK；接收方去重口径 20 §4.3）
    event_type     TEXT NOT NULL,               -- msg.created（审批/agent 任务完成随后续源）
    payload_digest TEXT NOT NULL,               -- sha256 前 16（不存正文，同 19 篇口径）
    target_url     TEXT NOT NULL,
    attempt        SMALLINT NOT NULL DEFAULT 0, -- 0–3
    next_retry_at  TIMESTAMPTZ,                 -- NULL=立即可投
    status         SMALLINT NOT NULL DEFAULT 1, -- 1 pending 2 sent 3 dead
    response_code  INT,
    error_brief    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_bot_delivery_event UNIQUE (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_delivery_due ON bot_delivery_log (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_bot_delivery_webhook ON bot_delivery_log (webhook_id, created_at DESC);

-- out 方向订阅配置列（20 §4.3 targets 语义分裂：in=conv 集 jsonb 数组、
-- out=事件订阅对象——独立列避免同列双语义）
ALTER TABLE bot_webhook ADD COLUMN IF NOT EXISTS out_targets JSONB;
ALTER TABLE bot_webhook ADD COLUMN IF NOT EXISTS callback_url TEXT;
