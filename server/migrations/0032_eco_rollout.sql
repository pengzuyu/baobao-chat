-- 0032：eco_rollout 灰度（10 篇 §4.2 / OQ-B13 / EXECUTION-PLAN E2）。
-- 版本级灰度：canary_pct 0-100 确定性放量（uid%100 < pct，无随机抖动——同用户
-- 判定稳定）；whitelist 用户集 100% 豁免（OQ-B13 拍板：白名单=100%，不受 pct 约束）。
-- 语义：未入灰度且未安装 → Catalog 不透出；未入灰度已安装 → 保持当前版（不推
-- 升级，已装=已在放量集）；入灰度 → install/upgrade 照常。Install 服务端同闸。
-- 全量=pct 100（等价无灰度；v0.1 无行=默认全量，兼容 E1 行为）。
CREATE TABLE IF NOT EXISTS eco_rollout (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL,
    app_row_id    BIGINT      NOT NULL,
    version_row_id BIGINT     NOT NULL,
    canary_pct    SMALLINT    NOT NULL DEFAULT 100 CHECK (canary_pct BETWEEN 0 AND 100),
    whitelist     TEXT        NOT NULL DEFAULT '[]', -- JSON 数组 user_id（OQ-B13 豁免集）
    updated_by    BIGINT      NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_rollout UNIQUE (tenant_id, app_row_id)
);
CREATE INDEX IF NOT EXISTS idx_eco_rollout_app ON eco_rollout (tenant_id, app_row_id);

ALTER TABLE eco_rollout ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_rollout;
CREATE POLICY p_tenant ON eco_rollout
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
