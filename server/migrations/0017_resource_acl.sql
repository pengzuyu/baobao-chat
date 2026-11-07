-- 0017_resource_acl：资源级 ACL（03 篇 §4.4 第三层；D07 KB 空间/D22
-- 共享邮箱/doc 文件夹/file 分享链接统一授权模型）。
-- 判定链"逐层取最大"（显式 user > dept/role > tenant 公开）在
-- internal/org/acl 服务层；短时缓存（Redis t:{tid}:acl:*，60s TTL）
-- 随多实例部署阶段二，v0.1 进程内直查。
-- ID 分配 advisory lock 9127。

CREATE TABLE IF NOT EXISTS resource_acl (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    resource_type TEXT NOT NULL,               -- kb.space | mail.shared | doc.folder | file.share | conv
    resource_id   TEXT NOT NULL,               -- 资源键（域内标识字符串化，跨域统一 TEXT）
    grant_type    SMALLINT NOT NULL,           -- 1 user 2 dept 3 role 4 tenant（租户内公开）
    grant_target  BIGINT NOT NULL DEFAULT 0,   -- user_id/dept_id/role_id；tenant=0
    perm          SMALLINT NOT NULL,           -- 1 viewer 2 commenter 3 editor 4 owner（数值可比取最大）
    granted_by    BIGINT NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ,                 -- NULL=永久
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_resource_acl UNIQUE (tenant_id, resource_type, resource_id, grant_type, grant_target)
);
CREATE INDEX IF NOT EXISTS idx_resource_acl_resource ON resource_acl (tenant_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_resource_acl_target ON resource_acl (tenant_id, grant_type, grant_target);
