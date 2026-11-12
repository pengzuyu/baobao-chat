-- 0037：D24 知识库博客化——两维度收口+浏览量+epoch 重建。
-- 口径（docs/detail/D24-知识库博客化详细设计.md）：
--   * 两维度：company 公司知识库（全租户唯一，全员可看可投）+ personal 我的笔记
--     （每人一行惰性创建，0009 既有）。「空间」产品概念消失；dept 类型废除——
--     存量 dept 空间的 chunk/node/doc 并入该租户 company 行后删行（owner_id=0
--     系统行；canWrite 对 company 不看 owner）；多余 company 行同样并入 canonical。
--   * 浏览量：kb_doc.view_count 冗余总计 + kb_doc_view 日去重流水（一人一天一篇
--     计 1；作者本人不计——service 层短路，建表不管）。
--   * epoch：kb_chunk.embed_epoch 向量代次（切换嵌入模型渐进重建，检索向量路
--     只命中当前代）+ kb_settings 单行（tenant 主键）记当前代/模型/维度与重建进度。
-- 幂等：ADD/CREATE IF NOT EXISTS + DO 块天然可重放（二跑无 dept 行=空操作）。
-- RLS：新表同 0009 p_tenant 口径；本迁移连接为表 owner（0009 未 FORCE RLS，
-- owner 天然绕过）——DO 块 UPDATE/DELETE 不受策略影响。
ALTER TABLE kb_doc ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS kb_doc_view (
    tenant_id  BIGINT      NOT NULL,
    doc_id     BIGINT      NOT NULL,
    user_id    BIGINT      NOT NULL,
    view_date  DATE        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doc_id, user_id, view_date)
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_view_agg ON kb_doc_view (tenant_id, doc_id, view_date);

ALTER TABLE kb_chunk ADD COLUMN IF NOT EXISTS embed_epoch INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS kb_settings (
    tenant_id      BIGINT PRIMARY KEY,
    embed_epoch    INT         NOT NULL DEFAULT 1,
    embed_model    TEXT        NOT NULL DEFAULT '',
    embed_dims     INT         NOT NULL DEFAULT 1024,
    rebuild_status TEXT        NOT NULL DEFAULT 'idle',  -- idle|running
    rebuild_done   INT         NOT NULL DEFAULT 0,
    rebuild_total  INT         NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 维度收口（DO 块）：每租户 canonical company 行 + dept/多余 company 并入 ──
DO $do$
DECLARE
    tid   BIGINT;
    canon BIGINT;
    sid   BIGINT;
BEGIN
    FOR tid IN SELECT DISTINCT tenant_id FROM kb_space LOOP
        SELECT MIN(id) INTO canon FROM kb_space
         WHERE tenant_id = tid AND space_type = 'company';
        IF canon IS NULL THEN
            INSERT INTO kb_space (id, tenant_id, space_type, name, owner_id, dept_id,
                                  quota_bytes, used_bytes, settings, status, created_at)
            SELECT COALESCE(MAX(id), 0) + 1, tid, 'company', '公司知识库', 0, NULL,
                   21474836480, 0, '{}', 'active', now()
              FROM kb_space;
            SELECT MIN(id) INTO canon FROM kb_space
             WHERE tenant_id = tid AND space_type = 'company';
        END IF;
        -- 同名冲突预处理：并入方与 canonical 既有同名子目录 → 后缀改名（内容不丢；
        -- 跨空间 parent_id 不同层不冲突，实际仅空间根同级同名会命中）
        UPDATE kb_node n SET name = n.name || '（并入 ' || n.space_id || '）'
         WHERE n.tenant_id = tid
           AND n.space_id IN (SELECT id FROM kb_space
                               WHERE tenant_id = tid
                                 AND (space_type = 'dept' OR (space_type = 'company' AND id <> canon)))
           AND EXISTS (SELECT 1 FROM kb_node c
                        WHERE c.tenant_id = tid AND c.space_id = canon
                          AND COALESCE(c.parent_id, 0) = COALESCE(n.parent_id, 0)
                          AND c.name = n.name AND c.status = 'active');
        FOR sid IN SELECT id FROM kb_space
                    WHERE tenant_id = tid
                      AND (space_type = 'dept' OR (space_type = 'company' AND id <> canon))
        LOOP
            UPDATE kb_chunk SET space_id = canon WHERE space_id = sid;
            UPDATE kb_node  SET space_id = canon WHERE space_id = sid;
            UPDATE kb_doc   SET space_id = canon WHERE space_id = sid;
            UPDATE kb_space SET used_bytes = used_bytes + (SELECT used_bytes FROM kb_space WHERE id = sid)
             WHERE id = canon;
            DELETE FROM kb_space WHERE id = sid;
        END LOOP;
    END LOOP;
END
$do$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_space_company
    ON kb_space (tenant_id) WHERE space_type = 'company';

-- ── RLS（租户隔离兜底，同 0009 口径）──
ALTER TABLE kb_doc_view ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_doc_view;
CREATE POLICY p_tenant ON kb_doc_view
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

ALTER TABLE kb_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON kb_settings;
CREATE POLICY p_tenant ON kb_settings
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
