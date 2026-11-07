-- 0013_file_share：文件分享外链（D06 阶段二；07 篇 §4.4/§5 file_share_link）
-- 三要素：expire_mode(1 永不 2 时限 3 次数) / max_times / password_hash；
-- 访问仍需登录（企业内不匿名）；分片上传会话为服务端内存态+staging 落盘
--（07 §4.1，upload 会话表随对象存储化阶段三落库，登记）。

CREATE TABLE IF NOT EXISTS file_share (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    file_id       BIGINT NOT NULL,             -- 关联 file(id)（软删行不参与解析）
    creator_id    BIGINT NOT NULL,
    code          TEXT NOT NULL,               -- 链接组成 /s/{code}（随机不可枚举）
    expire_mode   SMALLINT NOT NULL DEFAULT 1, -- 1 永不 2 时限 3 次数
    expires_at    TIMESTAMPTZ,                 -- expire_mode=2 携带
    max_times     INT,                         -- expire_mode=3 携带
    used_times    INT NOT NULL DEFAULT 0,
    password_hash TEXT,                        -- 可选；空=无密码
    status        SMALLINT NOT NULL DEFAULT 1, -- 1 启用 2 取消
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_file_share_code UNIQUE (code)
);
CREATE INDEX IF NOT EXISTS idx_file_share_tenant_file ON file_share (tenant_id, file_id);
