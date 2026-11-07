-- 0020_eco_expert：生态域首建——专家定义包分发（D14 §5 复用 10 篇通道的
-- 阶段一务实版）。
-- 阶段一裁剪登记：签名链（ed25519）/安全审查/审批/灰度（eco_rollout
-- scope/canary）随 10 篇完整通道阶段二——内网单租户 v0.1 直发；
-- apps/skills 分发对象（10 篇 eco_app/skill 包）随后续批次同表扩展
-- 或分表（届时评估）；下载只读端点内网公开口径（发布/删除走 authed）。
-- ID 分配 advisory lock 9131。

CREATE TABLE IF NOT EXISTS eco_expert (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    expert_id    TEXT NOT NULL,               -- corp./dept./usr.{uid}. 前缀（D14 §2；个人库前缀校验在服务层）
    version      TEXT NOT NULL DEFAULT '1.0.0',
    display      TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',    -- 列表摘要（persona 首行截断，服务层提取）
    source       SMALLINT NOT NULL DEFAULT 2, -- 1 company（管理发布）2 personal（用户自建）
    owner_user_id BIGINT NOT NULL DEFAULT 0,  -- personal 归属（company=0）
    manifest     TEXT NOT NULL,               -- 定义包原文（YAML；深度校验由 Agent 侧 parse_manifest 兜底）
    status       SMALLINT NOT NULL DEFAULT 1, -- 1 draft 2 published 3 unpublished
    created_by   BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_expert UNIQUE (tenant_id, expert_id)
);
CREATE INDEX IF NOT EXISTS idx_eco_expert_scope ON eco_expert (tenant_id, source, status);
