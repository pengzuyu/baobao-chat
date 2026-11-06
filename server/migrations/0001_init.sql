-- ============================================================================
-- BaobaoWork 0001_init：身份/组织（03 篇 §8）+ IM（04 篇 §5.1）基础表
-- 规范来源：13 篇 §1 公共规范（雪花 PK/tenant_id/RLS/timestamptz）
-- 迁移工具：golang-migrate（阶段一以单文件 up 落地；后续按域拆
--           migrations/<域>/NNN_desc.up.sql，表归属唯一域，跨域只按 ID 不建外键）
--
-- RLS 约定（03 篇 §3.2）：
--   连接池每请求执行 SET app.tenant = '<tenant_id>'；
--   current_setting('app.tenant', true) 未设置时返回 NULL → 策略判 false → 拒绝，
--   即"未设置租户必须拒绝而非放行"。
-- ============================================================================

BEGIN;

-- ─────────────────────────── 身份与组织 ───────────────────────────

CREATE TABLE tenant (
    id          BIGINT PRIMARY KEY,                 -- 雪花 ID（对外字符串透出）
    name        TEXT NOT NULL,
    status      SMALLINT NOT NULL DEFAULT 1,        -- 1 启用 2 停用（2004）
    plan        TEXT NOT NULL DEFAULT 'free',
    settings    JSONB NOT NULL DEFAULT '{}',        -- 租户策略（12 篇 admin_policy 热更入口）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 03 篇 user 表；user 为 PG 保留字，落地名 users（13 篇口径不变）
CREATE TABLE users (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    type            SMALLINT NOT NULL DEFAULT 1,    -- 1 human 2 bot（20 篇）
    employee_no     TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    avatar_file_id  BIGINT,
    email           TEXT,
    phone           TEXT,
    password_hash   TEXT,                           -- argon2id（阶段一服务端用 pbkdf2 过渡）
    status          SMALLINT NOT NULL DEFAULT 1,    -- 1 active 2 disabled
    mfa_secret_enc  TEXT,                           -- KMS 加密后的 TOTP 种子
    joined_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_users_tenant_empno UNIQUE (tenant_id, employee_no)
);
CREATE INDEX idx_users_tenant ON users (tenant_id);

CREATE TABLE dept (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    parent_id   BIGINT,                             -- 根为 NULL
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,                      -- 物化路径 /1/7/23/（前缀匹配判"本部门及以下"）
    sort        INT NOT NULL DEFAULT 0,
    status      SMALLINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dept_tenant_parent ON dept (tenant_id, parent_id);
CREATE INDEX idx_dept_path ON dept USING btree (path text_pattern_ops);

CREATE TABLE user_dept (
    user_id     BIGINT NOT NULL,
    dept_id     BIGINT NOT NULL,
    tenant_id   BIGINT NOT NULL,                    -- 13 篇 §1：所有业务表含 tenant_id（RLS）
    is_primary  BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, dept_id)
);

CREATE TABLE role (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    permissions  JSONB NOT NULL DEFAULT '[]',       -- 权限点数组 im:message:send ...
    is_builtin   BOOLEAN NOT NULL DEFAULT false,    -- 内置角色不可删
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_role_tenant_name ON role (tenant_id, name);

CREATE TABLE user_role (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    user_id       BIGINT NOT NULL,
    role_id       BIGINT NOT NULL,
    scope_type    SMALLINT NOT NULL DEFAULT 1,      -- 1 本人 2 本部门 3 本部门及以下 4 全租户 5 跨租户
    scope_dept_id BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_user_role UNIQUE (user_id, role_id, scope_type, scope_dept_id)
);
CREATE INDEX idx_user_role_user ON user_role (user_id);

-- 设备：多端在线（03 篇 §2.2）；did 与用户绑定
CREATE TABLE device (
    id             BIGINT PRIMARY KEY,
    tenant_id      BIGINT NOT NULL,
    user_id        BIGINT NOT NULL,
    device_name    TEXT,
    os             TEXT,
    did            TEXT NOT NULL,
    last_active_at TIMESTAMPTZ,
    trusted        BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uk_device_user_did UNIQUE (user_id, did)
);
CREATE INDEX idx_device_user ON device (user_id);

-- 刷新令牌：一次性轮换链（03 篇 §2.2/§8）
CREATE TABLE refresh_token (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    user_id      BIGINT NOT NULL,
    device_id    BIGINT NOT NULL,
    token_hash   TEXT NOT NULL,                     -- sha256hex，原文不落库
    expires_at   TIMESTAMPTZ NOT NULL,
    rotated_from BIGINT,                            -- 前驱 token ID（重放检测/审计链）
    status       SMALLINT NOT NULL DEFAULT 1,       -- 1 active 2 rotated 3 revoked
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_refresh_hash ON refresh_token (token_hash);
CREATE INDEX idx_refresh_user_status ON refresh_token (user_id, status);

-- ─────────────────────────── IM（04 篇 §5.1） ───────────────────────────

CREATE TABLE conversation (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    type            SMALLINT NOT NULL,              -- 1 单聊 2 群聊 3 广播群
    name            TEXT,
    avatar_file_id  BIGINT,
    owner_id        BIGINT,
    latest_seq      BIGINT NOT NULL DEFAULT 0,      -- 冗余（未读差值/sync 校验）
    last_msg_digest JSONB,
    last_msg_ts     TIMESTAMPTZ,
    member_count    INT NOT NULL DEFAULT 0,
    status          SMALLINT NOT NULL DEFAULT 1,    -- 1 active 2 dissolved
    created_by      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_tenant_last_ts ON conversation (tenant_id, last_msg_ts DESC);

CREATE TABLE conversation_member (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    conv_id    BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    role       SMALLINT NOT NULL DEFAULT 3,         -- 1 owner 2 admin 3 member 4 publisher
    join_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    join_by    BIGINT,
    mute_until TIMESTAMPTZ,                         -- 单人禁言
    status     SMALLINT NOT NULL DEFAULT 1,         -- 1 在群 2 已退 3 被移出
    CONSTRAINT uk_conv_member UNIQUE (conv_id, user_id)
);
CREATE INDEX idx_conv_member_user ON conversation_member (user_id, status);

-- 群设置（group/broadcast 才有；04 篇 §5.1）
CREATE TABLE group_setting (
    conv_id            BIGINT PRIMARY KEY,
    tenant_id          BIGINT NOT NULL,
    join_mode          SMALLINT NOT NULL DEFAULT 1, -- 1 直接进 2 需审批 3 仅邀请
    invite_policy      SMALLINT NOT NULL DEFAULT 1, -- 1 全员可邀 2 仅管理
    mention_all_policy SMALLINT NOT NULL DEFAULT 2, -- 1 全员 2 仅管理 3 禁用
    mute_all_until     TIMESTAMPTZ,
    history_visible    BOOLEAN NOT NULL DEFAULT true,
    announcement       TEXT,
    announcement_ts    TIMESTAMPTZ
);

-- message：按月分区（04 篇 §5.1；分区键 created_at）
-- 坑（重要）：PG 分区表的唯一约束必须包含分区键——
--   * 全局 PK 用 (id, created_at)；
--   * (conv_id, seq) 的会话内唯一无法用分区表 UK 表达，唯一性由
--     seq 分配器单点（Redis INCR）保证，辅助普通索引；
--   * (conv_id, client_msg_id) 幂等同理：服务层查重 + 分区本地索引兜底，
--     跨月重试场景由 Redis 幂等键（24h TTL，14 篇 §5.1）承接。
CREATE TABLE message (
    id             BIGINT NOT NULL,
    tenant_id      BIGINT NOT NULL,
    conv_id        BIGINT NOT NULL,
    seq            BIGINT NOT NULL,                 -- 会话内单调（Redis INCR 分配）
    client_msg_id  TEXT NOT NULL,
    sender_id      BIGINT NOT NULL,
    type           TEXT NOT NULL,                   -- text/image/file/...（04 篇 §1.2）
    body           JSONB,
    mentions       JSONB,
    reply_to_seq   BIGINT,
    ext            JSONB,                           -- reactions 等扩展
    status         SMALLINT NOT NULL DEFAULT 1,     -- 1 normal 2 recalled 3 edited
    edited_at      TIMESTAMPTZ,
    edit_history   JSONB,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_message_conv_seq ON message (conv_id, seq);
CREATE INDEX idx_message_conv_client_id ON message (conv_id, client_msg_id);
CREATE INDEX idx_message_tenant_created ON message (tenant_id, created_at);

-- 按月分区模板：
--   CREATE TABLE message_YYYY_MM PARTITION OF message
--     FOR VALUES FROM ('YYYY-MM-01 00:00+00') TO ('YYYY-MM-01+1month 00:00+00');
-- 生产由 pg_partman/定时任务滚动建分区（16 篇分区归档）；漫游到期分区转只读归档。
-- 兜底分区（新月份未建时写入不失败，监控告警后搬运）：
CREATE TABLE message_default PARTITION OF message DEFAULT;

-- 初始分区示例（当前 + 次月）
CREATE TABLE message_2026_11 PARTITION OF message
    FOR VALUES FROM ('2026-11-01 00:00+00') TO ('2026-12-01 00:00+00');
CREATE TABLE message_2026_12 PARTITION OF message
    FOR VALUES FROM ('2026-12-01 00:00+00') TO ('2027-01-01 00:00+00');

-- 回执：O(成员数) 聚合游标，不做逐条回执（04 篇 §5.1）
CREATE TABLE message_receipt (
    conv_id       BIGINT NOT NULL,
    user_id       BIGINT NOT NULL,
    tenant_id     BIGINT NOT NULL,
    delivered_seq BIGINT NOT NULL DEFAULT 0,
    read_seq      BIGINT NOT NULL DEFAULT 0,        -- 只进不退，取 max
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conv_id, user_id)
);

-- 用户会话态：置顶/免打扰/草稿/游标（多端漫游，04 篇 §5.1）
CREATE TABLE user_conv_state (
    user_id      BIGINT NOT NULL,
    conv_id      BIGINT NOT NULL,
    tenant_id    BIGINT NOT NULL,
    pinned       BOOLEAN NOT NULL DEFAULT false,
    mute         BOOLEAN NOT NULL DEFAULT false,
    draft        TEXT NOT NULL DEFAULT '',          -- ≤2000 字（3020）
    read_seq     BIGINT NOT NULL DEFAULT 0,
    acked_seq    BIGINT NOT NULL DEFAULT 0,
    unread_badge INT NOT NULL DEFAULT 0,            -- 写扩散冗余；广播群实时差值不落库
    hidden       BOOLEAN NOT NULL DEFAULT false,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conv_id)
);
CREATE INDEX idx_user_conv_state_conv ON user_conv_state (conv_id);

-- ─────────────────────────── RLS（全部业务表） ───────────────────────────
-- tenant 表自身为平台运营域，不开 RLS（跨租户仅 platform:tenant:manage）。

ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE dept             ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_dept        ENABLE ROW LEVEL SECURITY;
ALTER TABLE role             ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role        ENABLE ROW LEVEL SECURITY;
ALTER TABLE device           ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation     ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_setting    ENABLE ROW LEVEL SECURITY;
ALTER TABLE message          ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_default  ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_receipt  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_conv_state  ENABLE ROW LEVEL SECURITY;

-- 直含 tenant_id 的表：等值过滤
CREATE POLICY p_tenant ON users        USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON dept         USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON user_dept    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON role         USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON user_role    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON device       USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON refresh_token USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON conversation USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON conversation_member USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON group_setting USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON message         USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON message_default USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON message_receipt USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
CREATE POLICY p_tenant ON user_conv_state USING (tenant_id = current_setting('app.tenant', true)::BIGINT);

-- 连接角色：业务连接一律非超级用户，否则 RLS 不生效（BYRLS 绕过陷阱）
-- 应用账号需显式 NOBYPASSRLS（默认即无）。

COMMIT;
