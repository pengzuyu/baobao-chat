-- 0031：eco_app / eco_app_version / eco_app_install 生态应用注册与同步
-- （10 篇 §5 / D09 / EXECUTION-PLAN E1）。
-- v0.1 裁剪登记（相对 10 篇全模型）：
--   * C 档双人审批链（review/approved 状态机）随 E2/E3——v0.1 发布=draft→published
--     直发（发布者须 admin:app:publish，审计可追溯）；
--   * 签名链（根密钥→发布证书→ed25519）与 package 包分发随 10 篇 §7 深水——
--     v0.1 应用=manifest 注册制（JSON 清单即应用，无包体下载）；
--   * eco_rollout 灰度随 E2；连接器（app_connector）随 20 篇 webhook 深水。
-- 用户端同步：catalog 差异（新增/升级/撤销）+ 安装记录（agent:app:install）；
-- tools.reload 热加载随宿主命令阶段二（登记）。
CREATE TABLE IF NOT EXISTS eco_app (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL,
    app_id          TEXT        NOT NULL,           -- 命名空间形态（crm.sync / corp.tools）
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'draft', -- draft|published|delisted
    current_version TEXT        NOT NULL DEFAULT '', -- 发布态当前版本号
    created_by      BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_app UNIQUE (tenant_id, app_id)
);

CREATE TABLE IF NOT EXISTS eco_app_version (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    app_row_id   BIGINT      NOT NULL,
    version      TEXT        NOT NULL,
    manifest     TEXT        NOT NULL,              -- AppManifest JSON（工具/技能清单）
    high_risk    BOOLEAN     NOT NULL DEFAULT FALSE,-- 含高危脚本（10 §7.2-7；C 档随 E2/E3）
    status       TEXT        NOT NULL DEFAULT 'draft', -- draft|published|rolled_back
    published_by BIGINT      NOT NULL DEFAULT 0,
    published_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_app_version UNIQUE (tenant_id, app_row_id, version)
);
CREATE INDEX IF NOT EXISTS idx_eco_app_version_app ON eco_app_version (tenant_id, app_row_id);

-- 用户安装态（agent:app:install；同步差异锚点）
CREATE TABLE IF NOT EXISTS eco_app_install (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    app_row_id  BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    version     TEXT        NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_app_install UNIQUE (tenant_id, app_row_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_eco_app_install_user ON eco_app_install (tenant_id, user_id);

ALTER TABLE eco_app ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_app;
CREATE POLICY p_tenant ON eco_app USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE eco_app_version ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_app_version;
CREATE POLICY p_tenant ON eco_app_version USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE eco_app_install ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_app_install;
CREATE POLICY p_tenant ON eco_app_install USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
