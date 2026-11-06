-- 0003：AI 网关域三表（docs/19 §5；回填 13 篇 §3.9）。
-- v0.1 口径：路由表/供应商以服务内默认+环境变量装配为主，表先行落库供管理台(D10 PAD-09)与对账消费。

-- 供应商登记（平台级 tenant_id 可空）
CREATE TABLE IF NOT EXISTS ai_provider (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT,                       -- NULL=平台级登记
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('openai_compatible','vllm','bge_embed','bge_reranker','mock')),
    endpoints    JSONB NOT NULL DEFAULT '[]',  -- [{url, weight}]；出站白名单以此为准
    api_key_ref  TEXT,                         -- kms://ai/{id}/key（明文永不落库）
    health       JSONB NOT NULL DEFAULT '{}',  -- status/open_at/half_open_at/fails/last_probe_ms
    quota        JSONB NOT NULL DEFAULT '{}',  -- 供应商侧日请求/token 保护
    pricing      JSONB NOT NULL DEFAULT '{}',  -- {input_per_1k, output_per_1k}
    status       SMALLINT NOT NULL DEFAULT 1,  -- 1 enabled 2 disabled
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_kind ON ai_provider (kind, status);

-- 版本化路由表（默认/租户覆盖/草稿三形态）
CREATE TABLE IF NOT EXISTS ai_route_rule (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT,                       -- NULL=默认表
    version      INT NOT NULL,
    tier         TEXT NOT NULL CHECK (tier IN ('fast','strong','embed','rerank')),
    candidates   JSONB NOT NULL DEFAULT '[]',  -- [{provider_id, weight, priority}]
    overrides    JSONB NOT NULL DEFAULT '{}',  -- 超时/重试/private_only
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
    created_by   BIGINT NOT NULL,
    approved_by  BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_route_active ON ai_route_rule (tenant_id, tier, version)
    WHERE status = 'active';

-- 计量小时聚合（按月分区模板见 13 篇；v0.1 先落单表，量级起来再分区）
CREATE TABLE IF NOT EXISTS ai_usage_hourly (
    id                BIGINT PRIMARY KEY,
    tenant_id         BIGINT NOT NULL,
    hour_bucket       TIMESTAMPTZ NOT NULL,
    user_id           BIGINT NOT NULL DEFAULT 0,   -- 服务调用存 0+svc 维度进 scene 注记
    svc_subject       TEXT NOT NULL DEFAULT '',    -- svc:kb 等；用户调用为空
    session_id        TEXT NOT NULL DEFAULT '',    -- X-BBW-Agent-Session；非会话调用空
    scene             TEXT NOT NULL,               -- chat/embed/rerank/delegate/expert
    tier              TEXT NOT NULL,
    provider_id       BIGINT NOT NULL,
    requests          BIGINT NOT NULL DEFAULT 0,
    prompt_tokens     BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens      BIGINT NOT NULL DEFAULT 0,
    errors            BIGINT NOT NULL DEFAULT 0,
    degraded_count    BIGINT NOT NULL DEFAULT 0,
    est_cost          NUMERIC(14,6) NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_usage_hourly
    ON ai_usage_hourly (tenant_id, hour_bucket, user_id, svc_subject, session_id, scene, tier, provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_time ON ai_usage_hourly (tenant_id, hour_bucket DESC);
