-- 0036：eco_plugin / eco_plugin_version / eco_plugin_install 插件市场三表
-- （D22 §3 / EXECUTION-PLAN 批次 L1：安装插件即得 Agent 新能力）。
-- 与 eco_skill（0034，manifest 注册制）的差异：插件带包体（zip，bytea ≤10MB）、
-- 多版本线（版本表独立，publish 切 current_version，更新走新版本行）、
-- manifest 列存校验器产出的 JSON 快照（组件统计/权限声明——netAllow/
-- usesIdentity/configKeys 供安装确认页与详情页展示）。
-- v0.1 裁剪登记（相对 D22 全模型）：
--   * 签名/供应链校验阶段二（OQ-2）——信任源=管理员审核发布；
--   * force 策略的自动落 install 行由客户端推发链完成（L2），
--     卸载 force 拒与 skill 同口径；
--   * 个人发布面不做（管理面 adminOnly 单源）。
CREATE TABLE IF NOT EXISTS eco_plugin (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL,
    plugin_id       TEXT        NOT NULL,           -- 命名空间（deploy-helper）
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    category        TEXT        NOT NULL DEFAULT '',
    policy          SMALLINT    NOT NULL DEFAULT 3, -- 1 force 2 recommend 3 optional（同 eco_skill）
    status          TEXT        NOT NULL DEFAULT 'draft', -- draft|published|delisted
    current_version TEXT        NOT NULL DEFAULT '',
    manifest        TEXT        NOT NULL DEFAULT '', -- 当前发布版 manifest JSON 快照
    created_by      BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_plugin UNIQUE (tenant_id, plugin_id)
);

-- 版本线：一版一行（含包体）；列表查询恒不带 package（瘦身），下载走专路径
CREATE TABLE IF NOT EXISTS eco_plugin_version (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT      NOT NULL,
    pkg_id     BIGINT      NOT NULL,
    version    TEXT        NOT NULL,
    notes      TEXT        NOT NULL DEFAULT '',
    manifest   TEXT        NOT NULL DEFAULT '', -- 该版 manifest JSON 快照
    package    BYTEA       NOT NULL,            -- zip 包体（≤10MB，服务端校验）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_plugin_version UNIQUE (pkg_id, version)
);
CREATE INDEX IF NOT EXISTS idx_eco_plugin_version_pkg ON eco_plugin_version (pkg_id);

-- 用户安装态（agent:app:install 同档；v0.1 无灰度）
CREATE TABLE IF NOT EXISTS eco_plugin_install (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    pkg_id       BIGINT      NOT NULL,
    user_id      BIGINT      NOT NULL,
    version      TEXT        NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_plugin_install UNIQUE (tenant_id, pkg_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_eco_plugin_install_user ON eco_plugin_install (tenant_id, user_id);

ALTER TABLE eco_plugin ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_plugin;
CREATE POLICY p_tenant ON eco_plugin USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE eco_plugin_version ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_plugin_version;
CREATE POLICY p_tenant ON eco_plugin_version
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE eco_plugin_install ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_plugin_install;
CREATE POLICY p_tenant ON eco_plugin_install
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
