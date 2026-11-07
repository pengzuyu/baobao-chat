-- 0011：doc_file / doc_version 文档中心域两表（D05 阶段一务实版，
-- docs/06 §5 / docs/detail/D05 §6.1）。
-- v0.1 取舍登记（相对 06/D05 九表全量口径，逐条）：
--   * 九表裁二：doc_file / doc_version 落地；doc_folder（K1 文件夹树）、doc_permission
--     （ACL 投影）、doc_session（WOPI 会话）、doc_share（分享链接落库）、doc_template
--     （模板库）、doc_trash（回收站事件表）、doc_access_req（权限申请）不建——
--     阶段一纯 markdown 文档无 WOPI/协作会话；scope 恒 personal 即全量 owner 私有，
--     ACL/权限申请流阶段二；分享为一次性 share_id 占位（不落库，阶段二建 doc_share）；
--     回收站以 doc_file.status=2 + purge_at 承载（事件表 doc_trash 阶段二随审计补）。
--   * doc_file 简化：title（无扩展名——markdown 原生文档唯一格式）；folder_id=0 表根
--     （0=根）直挂（无 doc_folder 表，建列供阶段二回填）；scope 建列恒 'personal'
--     （space 域/共享阶段二）；status 用 int 1 正常 / 2 回收站（06 篇 active|trashed 的
--     数值化，与 message.status 口径一致）；current_version 为 int 版本号（doc_version
--     FK 形态 current_version_id 简化，避免双写指针）；content_md 冗余当前正文
--     （v0.1 无 MinIO 对象层，正文直接落库——阶段二 doc_version.storage_key 对象化时
--     该列退化为工作副本索引）。
--   * doc_version 简化：snapshot_type 三态 create|manual|restore（06 篇五态
--     auto|close|manual|restore|import 中 auto/close 依赖 WOPI 会话心跳、import 依赖
--     聊天文件导入，均阶段二）；无 storage_key/sha256/size（无对象存储）；UK(doc,version)
--     保证版本号唯一。tenant_id 追加为 RLS 载体（任务书列集未列，RLS 租户隔离必需）。
--   * 版本对象不可变：restore = 读目标版本正文复制为新版本（06 §4.5"绝不覆盖既有版本"），
--     由服务层事务保证；DB 层不加防 UPDATE 约束（阶段二随审计补触发器，登记）。
-- 幂等：IF NOT EXISTS 可安全重放（版本记录丢失场景兜底）。
-- ID 分配 advisory lock 9116/9117（internal/doc/repo/postgres.go；
-- org 9101 · message 9102-9108 · file 9109 · kb 9110-9113 · admin 9114-9115 已占）。

-- ── 文档主表（元数据 + 当前正文冗余；回收站态就地承载）──
CREATE TABLE IF NOT EXISTS doc_file (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL,
    owner_id        BIGINT      NOT NULL,             -- v0.1 全 owner 私有（ACL 阶段二）
    title           TEXT        NOT NULL,             -- markdown 原生文档（无扩展名）
    folder_id       BIGINT      NOT NULL DEFAULT 0,   -- 0=根（doc_folder 表阶段二）
    scope           TEXT        NOT NULL DEFAULT 'personal',  -- v0.1 恒 personal（space 阶段二）
    status          INT         NOT NULL DEFAULT 1,   -- 1 正常 / 2 回收站
    purge_at        TIMESTAMPTZ,                      -- 回收站到期时间（status=2 时置 now()+保留期）
    current_version INT         NOT NULL DEFAULT 1,   -- 当前版本号（=doc_version.version）
    content_md      TEXT        NOT NULL DEFAULT '',  -- 当前正文冗余（详情直读，免联表）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_file_owner
    ON doc_file (tenant_id, owner_id, status, updated_at DESC);
-- 同 owner 活跃文档同名判定（6015 重命名/恢复冲突；非唯一索引——软删的同名行不挡路，
-- 由服务层 WHERE status=1 判定）
CREATE INDEX IF NOT EXISTS idx_doc_file_title
    ON doc_file (tenant_id, owner_id, title);

-- ── 版本表（不可变版本对象；UK(doc,version)）──
CREATE TABLE IF NOT EXISTS doc_version (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL,               -- RLS 载体
    doc_id        BIGINT      NOT NULL,
    version       INT         NOT NULL,               -- 文档内自 1 递增
    editor_id     BIGINT      NOT NULL,
    snapshot_type TEXT        NOT NULL,               -- create|manual|restore（auto/close/import 阶段二）
    content_md    TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_doc_version_doc
    ON doc_version (tenant_id, doc_id, version DESC);

-- ── RLS（租户隔离兜底，同 kb 域口径；会话级 app.tenant 由连接池 SET）──
ALTER TABLE doc_file ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON doc_file;
CREATE POLICY p_tenant ON doc_file
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

ALTER TABLE doc_version ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON doc_version;
CREATE POLICY p_tenant ON doc_version
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
