-- ============================================================================
-- BaobaoWork 0022_sticker：自定义表情包（用户拍板"完整自定义表情包"）
-- 模型：sticker_set（个人集 owner_id 非空 / 租户公共集 owner_id NULL，admin 上架）
--      + sticker（集内条目，图片经 file 域 /files/upload 得 file_id 引用）
-- 发送：msg type=sticker（body {file_id,width,height,sticker_id}，服务端校验可见性）
-- RLS：13 篇 §1 公共规范（tenant_id + p_tenant 策略）
-- ============================================================================

BEGIN;

CREATE TABLE sticker_set (
    id            BIGINT PRIMARY KEY,               -- 雪花 ID
    tenant_id     BIGINT NOT NULL,
    name          TEXT NOT NULL,
    cover_file_id BIGINT,                           -- 封面（首张自动回填；NULL=空集）
    owner_id      BIGINT,                           -- NULL=租户公共集（admin 上架）；非空=个人集
    status        SMALLINT NOT NULL DEFAULT 1,      -- 1 启用 2 停用（公共集下架）
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sticker_set_tenant ON sticker_set (tenant_id);
CREATE INDEX idx_sticker_set_owner ON sticker_set (owner_id);

CREATE TABLE sticker (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    set_id     BIGINT NOT NULL,
    file_id    BIGINT NOT NULL,
    name       TEXT,
    sort       INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sticker_set_items ON sticker (set_id);
CREATE UNIQUE INDEX uk_sticker_set_file ON sticker (set_id, file_id); -- 同集同图去重

ALTER TABLE sticker_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE sticker  ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_tenant ON sticker_set USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON sticker  USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

COMMIT;
