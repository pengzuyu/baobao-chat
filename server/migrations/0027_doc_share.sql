-- 0027：doc_share 文档分享外链（06 篇 §4.4「租户内链接分享」；EXECUTION-PLAN D3：
-- 替换 v0.1 假 bbw:// 占位链接，落地真实 /s/{code} 解析）。
-- · 仅租户内登录用户（无匿名外链——外部分享走 07 篇文件域）；
-- · 权限上限 view|comment（v0.1 markdown 只读预览：两档等效只读，登记）；
-- · 有效期 1h/1d/7d/30d/永久（NULL=永久；租户策略封顶阶段二）；
-- · 密码可选（password_hash bcrypt；访问 6009 二次校验）；
-- · 禁止下载可选（no_download：解析视图隐藏下载入口，服务端票据端点同样拒）；
-- · code 前缀 "d"（与文件域分享码分流：ShareResolvePage 按首字符路由）。
CREATE TABLE IF NOT EXISTS doc_share (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL,
    doc_id        BIGINT      NOT NULL,
    code          TEXT        NOT NULL,          -- "d"+9 随机字符（UK）
    perm          TEXT        NOT NULL DEFAULT 'view',
    expires_at    TIMESTAMPTZ,                   -- NULL=永久
    password_hash TEXT,                          -- NULL=无密码
    no_download   BOOLEAN     NOT NULL DEFAULT FALSE,
    creator_id    BIGINT      NOT NULL,
    revoked       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_share_code ON doc_share (code);
CREATE INDEX IF NOT EXISTS idx_doc_share_doc ON doc_share (tenant_id, doc_id) WHERE revoked = FALSE;

ALTER TABLE doc_share ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON doc_share;
CREATE POLICY p_tenant ON doc_share
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
