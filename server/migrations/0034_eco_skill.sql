-- 0034：eco_skill / eco_skill_install 技能包与安装态
-- （10 篇 §5/§6 / D09 / EXECUTION-PLAN E4：技能市场租户内）。
-- v0.1 裁剪登记（相对 10 篇全模型）：
--   * 技能包=manifest 注册制（YAML 清单：技能/命令/agent 定义原文存行；无包体
--     下载与签名链——同 E1 app 口径）；
--   * 版本=单列覆盖式（更新=manifest 覆盖+version bump；多版本线/回滚随 E3 审批链）；
--   * 三档策略 force/recommend/optional（10 §4.5）：全员 catalog 可见；
--     optional=用户自装自卸；recommend=可装可卸（提示建议）；force=强制装、
--     卸载服务端拒（v0.1 强制安装的自动落 install 行由管理员发布时批量生成，
--     随阶段二定时任务——登记：force 行为=卸载拒+文案明示）；
--   * 高危脚本技能（policy 审核 C 档）随 E3；安装态 tools.reload 随宿主命令阶段二。
CREATE TABLE IF NOT EXISTS eco_skill (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL,
    skill_id        TEXT        NOT NULL,           -- 命名空间（corp.skills/report）
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    policy          SMALLINT    NOT NULL DEFAULT 2, -- 1 force 2 recommend 3 optional（10 §4.5）
    status          TEXT        NOT NULL DEFAULT 'draft', -- draft|published|delisted
    current_version TEXT        NOT NULL DEFAULT '',
    manifest        TEXT        NOT NULL,           -- YAML 清单原文（技能/命令/agent 定义）
    created_by      BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_skill UNIQUE (tenant_id, skill_id)
);

-- 用户安装态（agent:app:install 同档权限；技能 v0.1 无灰度——全员可见）
CREATE TABLE IF NOT EXISTS eco_skill_install (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    skill_row_id BIGINT      NOT NULL,
    user_id      BIGINT      NOT NULL,
    version      TEXT        NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_eco_skill_install UNIQUE (tenant_id, skill_row_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_eco_skill_install_user ON eco_skill_install (tenant_id, user_id);

ALTER TABLE eco_skill ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_skill;
CREATE POLICY p_tenant ON eco_skill USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
ALTER TABLE eco_skill_install ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON eco_skill_install;
CREATE POLICY p_tenant ON eco_skill_install
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
