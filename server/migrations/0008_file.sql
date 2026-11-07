-- 0008：file 文件表（D06 文件消息阶段一务实版）。
-- v0.1 取舍登记（相对 docs/07 §5 blob/file 两层模型的简化）：
--   * blob/file 两层合并为单表：无 ref_count，同租户同 sha256（未软删）复用同一行，
--     重复上传返回原 id（引用计数语义留待阶段二拆表时恢复）；
--   * 单机本地磁盘存储 DATA_DIR/files/{tenant}/{sha前2}/{sha256}，无对象存储/预签名；
--   * width/height 仅 image.DecodeConfig 解析的元数据（缩略图不做，端内 CSS 渲染原图）；
--   * scan_status 建列恒 1 clean（病毒扫描服务阶段二接入后新文件转 0 pending）；
--   * source 取值 'upload'（已上传未随消息发送）/'message'（已随消息发送，转发复用判定依据）；
--   * file_share_link 外链表不建（分享阶段二）。
-- 幂等：IF NOT EXISTS 可安全重放（版本记录丢失场景兜底）。
CREATE TABLE IF NOT EXISTS file (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    owner_id     BIGINT      NOT NULL,
    name         TEXT        NOT NULL,
    ext          TEXT        NOT NULL DEFAULT '',
    size         BIGINT      NOT NULL,
    content_type TEXT        NOT NULL DEFAULT 'application/octet-stream',
    sha256       TEXT        NOT NULL,
    width        INT         NOT NULL DEFAULT 0,   -- 图片像素宽（非图片/解析失败=0）
    height       INT         NOT NULL DEFAULT 0,
    source       TEXT        NOT NULL DEFAULT 'upload',
    conv_id      BIGINT,                           -- 随消息发送后回填（群文件聚合冗余；可空）
    scan_status  SMALLINT    NOT NULL DEFAULT 1,   -- 0 pending 1 clean 2 infected 3 skipped；v0.1 恒 1
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ                      -- 软删除（回收站语义，物理清理阶段二）
);

-- 同租户 sha256 去重（07 篇隔离红线：跨租户绝不去重；软删行不参与去重）
CREATE UNIQUE INDEX IF NOT EXISTS uq_file_tenant_sha
    ON file (tenant_id, sha256) WHERE deleted_at IS NULL;
-- 我的文件（API-FL-08 主路径：owner + 未删，时间倒序）
CREATE INDEX IF NOT EXISTS idx_file_owner
    ON file (tenant_id, owner_id, created_at DESC) WHERE deleted_at IS NULL;
-- 会话文件聚合（群文件页签预留路径）
CREATE INDEX IF NOT EXISTS idx_file_conv
    ON file (tenant_id, conv_id, created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE file ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON file;
CREATE POLICY p_tenant ON file
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
