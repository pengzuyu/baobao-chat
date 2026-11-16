-- 0038：OIDC Provider 六表（D28 §4，批次 Q1）。
-- bbw auth 对外做标准 OIDC OP（zitadel/oidc v3 嵌入，ES256+jwks，授权码+PKCE）。
-- 相对 D28 §4 设计新增 oidc_access_token：JWT 访问令牌行存（introspection/
-- userinfo 由 tokenID 反查 + 撤销语义需要），auth_request 采用「列字段+JSONB 快照」
-- 而非全 JSONB（等待页/确认链要按列查询）。web 会话 7 天滑动（v0.2 拍板 7）。
-- 注意：历史已有两份 0037 撞号（eco_plugin_owner / kb_blog），本表从 0038 起编。

-- 客户端注册（admin 面；一期只开 public client=PKCE-only，secret 列为机密客户端预留）
CREATE TABLE IF NOT EXISTS oidc_client (
    id               BIGINT PRIMARY KEY,
    tenant_id        BIGINT      NOT NULL,
    client_id        TEXT        NOT NULL,            -- 对外 client_id（bbw-xxxxxxxx）
    client_secret_hash TEXT      NOT NULL DEFAULT '', -- sha256；public client 空
    name             TEXT        NOT NULL,
    logo_file_id     BIGINT,
    redirect_uris    JSONB       NOT NULL DEFAULT '[]',   -- 精确匹配白名单
    scopes           JSONB       NOT NULL DEFAULT '[]',   -- 允许申请的 scope 白名单（含 openid/profile）
    grant_types      JSONB       NOT NULL DEFAULT '["authorization_code","refresh_token"]',
    access_ttl_sec   INT         NOT NULL DEFAULT 900,
    refresh_ttl_sec  INT         NOT NULL DEFAULT 2592000,
    status           TEXT        NOT NULL DEFAULT 'active', -- active|disabled
    created_by       BIGINT      NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_oidc_client UNIQUE (tenant_id, client_id)
);

-- 授权请求（authorize 创建 → 等待页/web 登录认领 → code 签发 → token 换取后删除）
-- code 只存 sha256（一次性，60s 由应用层校验过期=created 保底+code_issued_at）
CREATE TABLE IF NOT EXISTS oidc_auth_request (
    id            TEXT PRIMARY KEY,               -- uuid（op.CreateAuthRequest 生成）
    tenant_id     BIGINT      NOT NULL,
    client_id     TEXT        NOT NULL,
    user_id       BIGINT,                         -- 认领后回填
    did           TEXT        NOT NULL DEFAULT '',-- 发起确认的 desktop 设备（Q2 深链用）
    scopes        JSONB       NOT NULL DEFAULT '[]',
    nonce         TEXT        NOT NULL DEFAULT '',
    state         TEXT        NOT NULL DEFAULT '',
    code_challenge   TEXT      NOT NULL DEFAULT '',
    code_challenge_m TEXT      NOT NULL DEFAULT '',
    code_hash        TEXT,                        -- sha256(code)；NULL=未签发
    confirm_code     TEXT        NOT NULL DEFAULT '', -- 6 位确认码 hash（Q2 防钓鱼）
    snapshot     JSONB       NOT NULL DEFAULT '{}',   -- op.AuthRequest 全量快照（audience/response_type 等）
    status       TEXT        NOT NULL DEFAULT 'pending', -- pending|approved|denied|consumed
    auth_time    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at  TIMESTAMPTZ,
    consumed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oidc_auth_code ON oidc_auth_request (code_hash);

-- 用户×应用授权记录（「已授权应用」页 + 撤销依据）
CREATE TABLE IF NOT EXISTS oidc_grant (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    client_id   TEXT        NOT NULL,
    scopes      JSONB       NOT NULL DEFAULT '[]',
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    CONSTRAINT uk_oidc_grant UNIQUE (user_id, client_id)
);

-- OIDC refresh（与内部 auth.refresh_token 分表：client 维度+轮换链同语义）
CREATE TABLE IF NOT EXISTS oidc_refresh_token (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL,
    grant_id     BIGINT,
    user_id      BIGINT      NOT NULL,
    client_id    TEXT        NOT NULL,
    token_hash   TEXT        NOT NULL,           -- sha256(opaque token 值)
    claims       JSONB       NOT NULL DEFAULT '{}', -- TokenRequest 快照（scopes/audience/amr/auth_time）
    rotated_from BIGINT,
    status       TEXT        NOT NULL DEFAULT 'active', -- active|rotated|revoked
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_oidc_refresh UNIQUE (token_hash)
);

-- OIDC access token 行存（JWT 型；introspection/userinfo 按 tokenID 反查 + 撤销位）
CREATE TABLE IF NOT EXISTS oidc_access_token (
    id          TEXT PRIMARY KEY,                -- uuid（嵌入 JWT 的 token id）
    tenant_id   BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    client_id   TEXT        NOT NULL,
    scopes      JSONB       NOT NULL DEFAULT '[]',
    audience    JSONB       NOT NULL DEFAULT '[]',
    amr         JSONB       NOT NULL DEFAULT '[]',
    auth_time   TIMESTAMPTZ,
    refresh_id  BIGINT,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked     BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oidc_access_refresh ON oidc_access_token (refresh_id);

-- IdP 浏览器会话（web 兜底登录态，SSO 免密载体；7 天滑动，v0.2 拍板 7）
CREATE TABLE IF NOT EXISTS oidc_web_session (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL,
    user_id       BIGINT      NOT NULL,
    did           TEXT        NOT NULL DEFAULT '', -- 浏览器首次登录生成的稳定设备号
    token_hash    TEXT        NOT NULL,           -- HttpOnly cookie 中 opaque 值的 sha256
    sliding_expires_at TIMESTAMPTZ NOT NULL,      -- 滑动过期（每次使用续期）
    user_agent    TEXT        NOT NULL DEFAULT '',
    ip            TEXT        NOT NULL DEFAULT '',
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT        NOT NULL DEFAULT 'active', -- active|revoked
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ,
    CONSTRAINT uk_oidc_web_session UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS idx_oidc_web_session_user ON oidc_web_session (user_id, status);
