-- 0014_transfer_record：传输记录服务端镜像（D06 阶段二；07 篇 §5）
-- 跨端"我发过/收过什么"；客户端 SQLite 另存本地执行态（断点恢复源），
-- 本表由服务端在上传/分片进度/票据下载节点写入（v0.2 务实：下载完成度
-- 服务端不可知，恒 transferring，断点下载阶段三补 done 态，登记）。
-- upload_id 为 07 篇字段超集（分片会话进度更新关联键，登记）。

CREATE TABLE IF NOT EXISTS transfer_record (
    id               BIGINT PRIMARY KEY,
    tenant_id        BIGINT NOT NULL DEFAULT 1,
    user_id          BIGINT NOT NULL,             -- 发起传输的用户
    file_id          BIGINT,                      -- complete/上传成功后回填；进行中可空
    upload_id        TEXT,                        -- 分片会话关联（multipart/下载记录为空）
    direction        SMALLINT NOT NULL,           -- 1 上传 2 下载
    state            TEXT NOT NULL,               -- queued/transferring/resuming/paused/processing/done/failed/canceled/expired（OQ-C29）
    bytes_transferred BIGINT NOT NULL DEFAULT 0,
    total_bytes      BIGINT NOT NULL DEFAULT 0,
    error_code       INT,                         -- failed 态携带
    target_path      TEXT,                        -- 下载落盘路径（客户端回填口径，服务端留空）
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transfer_tenant_user ON transfer_record (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_upload ON transfer_record (upload_id) WHERE upload_id IS NOT NULL;
