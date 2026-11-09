-- 0023：多供应商接入（管理员统一接入 + 默认路由 + 个人 BYOK）。
-- 激活 0003 先行落库的 ai_provider/ai_route_rule（v0.1 口径由「环境变量装配」升级为表驱动）：
--   ai_provider    +owner_user_id（NULL=公司级，非 NULL=个人 BYOK）+models（可用模型清单）
--   ai_route_rule  candidates 约定扩展为 [{provider_id, model, priority}]（model=该候选上游具体
--                  模型名；主备降级=多候选按 priority 逐个尝试，§4.4）
--   users          +settings JSONB（通用个人设置；首个消费者 ai_default 默认模型选择）
-- 密钥存储：api_key_ref = kms:v1:<b64(nonce|ct)>（AES-256-GCM，主密钥 BBW_KMS_MASTER_KEY
-- 环境注入；明文永不落库——19 篇 §1.2-2 嵌入式 KMS 落地形态）。

ALTER TABLE ai_provider
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT,          -- NULL=公司级（管理员建）；非 NULL=个人 BYOK
    ADD COLUMN IF NOT EXISTS models JSONB NOT NULL DEFAULT '[]'; -- [{id,label}] 可用模型清单（p: 引用校验源）

-- 同租户内（公司级/个人域各自）名称不重复
CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_provider_owner_name
    ON ai_provider (tenant_id, COALESCE(owner_user_id, 0), lower(name));

-- 个人 BYOK 上限在 service 层校验（≤5/人），不加库约束（阈值属策略）

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'; -- 个人设置（ai_default 等；PATCH 合并语义）
