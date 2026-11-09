-- 0026：doc_folder 文件夹树（D05 K1 冻结结构 / EXECUTION-PLAN D1）。
-- scope 根（mine|dept|company）+ 用户自建两级结构支撑移动与继承链可视化；
-- v0.1 落地 scope='mine'（个人树，owner 私有）；dept/company 结构就绪待 ACL/space
-- 阶段二（doc_file.scope 现恒 personal，与 mine 视图等价）。
-- doc_file.folder_id 已建列（0011，0=scope 根直挂），本迁移补索引与外键清理路径
-- （文件夹删除=service 层校验空文件夹，不做 ON DELETE 级联——防误删整树）。
CREATE TABLE IF NOT EXISTS doc_folder (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT      NOT NULL,
    scope      TEXT        NOT NULL DEFAULT 'mine',   -- mine|dept|company（v0.1 恒 mine）
    dept_id    BIGINT,                                -- dept scope 挂靠部门（阶段二）
    parent_id  BIGINT      NOT NULL DEFAULT 0,        -- 0=scope 根下
    name       TEXT        NOT NULL,
    owner_id   BIGINT      NOT NULL,                  -- mine=本人
    status     TEXT        NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 父节点子树查询（左树懒加载）
CREATE INDEX IF NOT EXISTS idx_doc_folder_parent
    ON doc_folder (tenant_id, parent_id);
-- 同父同名唯一（RenameFolder/InsertFolder 23505→ErrDupTitle 映射依据）
CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_folder_name
    ON doc_folder (tenant_id, owner_id, parent_id, name) WHERE status = 'active';
-- 我的文件夹列表（名称序）
CREATE INDEX IF NOT EXISTS idx_doc_folder_owner
    ON doc_folder (tenant_id, owner_id, scope);

ALTER TABLE doc_folder ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON doc_folder;
CREATE POLICY p_tenant ON doc_folder
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

-- 文件按文件夹过滤（DocCenterPage 左树选中节点列文件）
CREATE INDEX IF NOT EXISTS idx_doc_file_folder
    ON doc_file (tenant_id, owner_id, folder_id) WHERE status = 1;
