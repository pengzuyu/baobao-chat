-- 0015_admin_notice：平台公告（D10 PAD-15；admin:notice:publish 已登记 18 篇 ✅2）
-- 发布 = 存档 + 经 message 域 BroadcastNotice 全员通知（kind=announcement）。

CREATE TABLE IF NOT EXISTS admin_notice (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL DEFAULT 1,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_by BIGINT NOT NULL,
    reach      INT NOT NULL DEFAULT 0,            -- 广播落行数（发布快照）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notice_tenant ON admin_notice (tenant_id, created_at DESC);
