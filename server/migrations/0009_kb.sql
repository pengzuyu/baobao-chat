-- 0009：kb_* 知识库域四表（D07 阶段一务实版，docs/11 §5 / docs/detail/D07 §6.1）。
-- v0.1 取舍登记（相对七表全量口径，逐条）：
--   * 七表裁四：kb_space / kb_node / kb_doc / kb_chunk 落地；kb_acl 授权投影、
--     kb_ingest_job 任务表、kb_query_log 审计日志不建——摄入 v0.1 为同步版（无任务行，
--     >5s 场景阶段二换 job 表）；授权走空间 owner + 空间类型判定（部门树 ACL 阶段二）；
--     查询日志随阶段二审计补齐。
--   * kb_node 仅承载目录（node_type 恒 'dir'）：kb_doc.node_id 直接挂目录，省去 D07
--     dir/doc 双型树与物化路径双写；path 列保留（'/3001/41/' 形态）供阶段二回填。
--   * kb_doc 为 kb_doc_meta 简化：status 三态 processing|ready|failed（管线五态细分
--     随阶段二 job 表）；content 冗余原文（text/markdown 来源的重摄入依据——D07 走
--     source_ref+MinIO 回读，v0.1 无 LibreOffice 解析器，直接存清洗前文本）；
--     sensitive/page_count/source_sha256 建列从简（敏感标记阶段二）。
--   * kb_chunk 不建 fts tsvector（zhparser 未部署）→ 关键词检索 ILIKE 兜底（11 §7.4
--     降级口径）；acl_tags 权限快照省略——检索按空间可见性前置过滤（v0.1：personal
--     仅本人 + company 全员可读，dept 空间仅治理者，阶段二接部门树）。
--   * embedding 列双轨：镜像 pgvector 可用 → vector(1024)（余弦 <=> + HNSW 索引，
--     11 §4.3 A 路真实排序）；不可用 → float8[] 降级（服务端内存余弦 + ILIKE 兜底，
--     启动日志登记降级）。
--   * 目录层数 ≤10：服务层校验（parent 链深推），DB CHECK 留阶段二随 path 回填。
-- 幂等：IF NOT EXISTS 可安全重放（版本记录丢失场景兜底）。
DO $do$
BEGIN
    -- pgvector 可用即装（已装为 no-op；镜像未携带时走 float8[] 降级）
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        CREATE EXTENSION IF NOT EXISTS vector;
    END IF;
END
$do$;

-- ── 空间（三级：personal 每人 1 个惰性创建 / dept 阶段二部门挂靠 / company 全员可读）──
CREATE TABLE IF NOT EXISTS kb_space (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    space_type  TEXT        NOT NULL,             -- personal|dept|company
    name        TEXT        NOT NULL,
    owner_id    BIGINT      NOT NULL,             -- 治理者（personal=本人，唯一）
    dept_id     BIGINT,                           -- 部门空间挂靠（阶段二用，可空）
    quota_bytes BIGINT      NOT NULL DEFAULT 5368709120,   -- 配额（personal 默认 5GB，11 §4.5）
    used_bytes  BIGINT      NOT NULL DEFAULT 0,
    settings    JSONB       NOT NULL DEFAULT '{}',  -- 归档策略/默认授权（阶段二）
    status      TEXT        NOT NULL DEFAULT 'active',  -- active|archived（7013）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- personal 每人唯一（惰性创建幂等兜底；11 §2.1）
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_space_personal
    ON kb_space (tenant_id, owner_id) WHERE space_type = 'personal';
CREATE INDEX IF NOT EXISTS idx_kb_space_type ON kb_space (tenant_id, space_type);

-- ── 目录树（≤10 层；文档不入树：kb_doc.node_id 挂靠）──
CREATE TABLE IF NOT EXISTS kb_node (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    space_id    BIGINT      NOT NULL,
    parent_id   BIGINT,                           -- NULL=空间根
    node_type   TEXT        NOT NULL DEFAULT 'dir',  -- v0.1 恒 'dir'（doc 双型树阶段二）
    name        TEXT        NOT NULL,
    path        TEXT        NOT NULL DEFAULT '',   -- 物化路径（阶段二回填）
    sort        INT         NOT NULL DEFAULT 0,
    status      TEXT        NOT NULL DEFAULT 'active',  -- active|archived|deleted
    created_by  BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_node_parent ON kb_node (tenant_id, space_id, parent_id);
-- 同父同名冲突（7014）：COALESCE 把根目录 NULL 归一为 0 参与唯一判定
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_node_sibling
    ON kb_node (tenant_id, space_id, COALESCE(parent_id, 0), name) WHERE status = 'active';

-- ── 文档（kb_doc_meta 简化；status 为摄入管线同步版三态）──
CREATE TABLE IF NOT EXISTS kb_doc (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    space_id    BIGINT      NOT NULL,
    node_id     BIGINT,                           -- 挂靠目录（可空=空间根）
    title       TEXT        NOT NULL,
    source_type TEXT        NOT NULL,             -- text|file|markdown（v0.1 三态）
    source_ref  TEXT,                             -- file 来源=file_id；text/markdown 为空
    ext         TEXT        NOT NULL DEFAULT '',  -- txt|md|markdown
    size        BIGINT      NOT NULL DEFAULT 0,   -- 原文字节数（配额口径）
    status      TEXT        NOT NULL,             -- processing|ready|failed
    error_msg   TEXT,                             -- failed 时的失败原因（重试提示）
    version     INT         NOT NULL DEFAULT 1,   -- 摄入代次（重摄入 +1）
    content     TEXT,                             -- 原文冗余（text/markdown；file 来源为空）
    created_by  BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_space ON kb_doc (tenant_id, space_id, COALESCE(node_id, 0), created_at DESC);
-- jobs 简版列表（按 status 过滤 docs，API-KB-15 降级形态）
CREATE INDEX IF NOT EXISTS idx_kb_doc_status ON kb_doc (tenant_id, space_id, status, updated_at DESC);

-- ── 分块（向量列双轨 + ILIKE 兜底；fts tsvector 不建，登记见文件头）──
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        CREATE TABLE IF NOT EXISTS kb_chunk (
            id           BIGINT PRIMARY KEY,
            tenant_id    BIGINT      NOT NULL,
            doc_id       BIGINT      NOT NULL,
            space_id     BIGINT      NOT NULL,
            seq          INT         NOT NULL,
            heading_path TEXT,                    -- 标题链（引用锚点，' > ' 连接）
            text         TEXT        NOT NULL,
            token_count  INT         NOT NULL DEFAULT 0,  -- 近似 token（rune 数）
            embedding    vector(1024),            -- bge-m3 维度（01 篇冻结）
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, doc_id, seq)
        );
        -- HNSW 余弦近邻（11 §4.3 A 路；量小顺序扫描亦可命中，索引随规模生效）
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_chunk_hnsw ON kb_chunk USING hnsw (embedding vector_cosine_ops)';
    ELSE
        -- 降级轨：float8[] 存同一 1024 维向量，检索由服务端内存余弦 + ILIKE 兜底
        CREATE TABLE IF NOT EXISTS kb_chunk (
            id           BIGINT PRIMARY KEY,
            tenant_id    BIGINT      NOT NULL,
            doc_id       BIGINT      NOT NULL,
            space_id     BIGINT      NOT NULL,
            seq          INT         NOT NULL,
            heading_path TEXT,
            text         TEXT        NOT NULL,
            token_count  INT         NOT NULL DEFAULT 0,
            embedding    DOUBLE PRECISION[],
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, doc_id, seq)
        );
    END IF;
END
$do$;
CREATE INDEX IF NOT EXISTS idx_kb_chunk_space ON kb_chunk (tenant_id, space_id, doc_id);

-- ── RLS（租户隔离兜底，同 file 域口径；会话级 app.tenant 由连接池 SET）──
ALTER TABLE kb_space ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_space;
CREATE POLICY p_tenant ON kb_space
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

ALTER TABLE kb_node ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_node;
CREATE POLICY p_tenant ON kb_node
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

ALTER TABLE kb_doc ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_doc;
CREATE POLICY p_tenant ON kb_doc
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

ALTER TABLE kb_chunk ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_chunk;
CREATE POLICY p_tenant ON kb_chunk
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
