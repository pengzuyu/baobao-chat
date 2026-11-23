-- 0005_client_release：客户端安装包发布管理（D39；管理后台上传→发布→客户端/官网分发）
--
-- 背景：此前客户端发布靠 mac 命令行 rsync + nginx 静态清单（scripts/release/*）；
-- 本表让管理员在桌面端管理页上传产物并发布，服务端动态生成 /update/latest.json
-- 与 /update/release-info.json，制品存对象存储（RustFS bbc-releases 桶）由 nginx 直出。
--
-- 关键口径：
-- - 制品不可变：同 (version, channel, platform, filename) 唯一；发布后不可改内容，只能撤回或发新版
-- - signature：minisign .sig 内容（updater 清单必需）；官网直链包（.dmg/.deb）可为空
--   —— 发布校验时按 updater 文件类型强制要求（见 service）
-- - channel：稳定/内测通道（D39 最佳实践对齐 VS Code stable/insider）
-- - status 状态机：draft（已上传未发布）→ published（线上）→ revoked（撤回；已装用户不受影响）
-- - 回滚 = 把目标版本的各平台行改回 published 并把当前线上版本改 revoked（清单指针语义，不挪文件）
CREATE TABLE IF NOT EXISTS client_release (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL DEFAULT 1,
    version       TEXT        NOT NULL,
    channel       TEXT        NOT NULL DEFAULT 'stable',
    platform      TEXT        NOT NULL,
    filename      TEXT        NOT NULL,
    size          BIGINT      NOT NULL,
    sha256        TEXT        NOT NULL,
    storage_key   TEXT        NOT NULL,
    signature     TEXT        NOT NULL DEFAULT '',
    notes         TEXT        NOT NULL DEFAULT '',
    status        TEXT        NOT NULL DEFAULT 'draft',
    published_at  TIMESTAMPTZ,
    created_by    BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT client_release_status_chk CHECK (status IN ('draft', 'published', 'revoked')),
    CONSTRAINT client_release_channel_chk CHECK (channel IN ('stable', 'beta')),
    CONSTRAINT client_release_platform_chk CHECK (platform IN (
        'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64')),
    CONSTRAINT client_release_uk UNIQUE (tenant_id, channel, version, platform, filename)
);

-- 清单生成主查询：按通道取 published 版本 + 平台聚合
CREATE INDEX IF NOT EXISTS idx_client_release_pub
    ON client_release (tenant_id, channel, status, version DESC);