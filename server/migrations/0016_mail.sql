-- 0016_mail：邮件域阶段一（22 篇务实版）
-- 六表齐建（13 篇 §3 回填口径），入口按阶段一裁剪：
--   · mail_alias 建表无入口（别名/群发列表随 admin 治理阶段二）
--   · mail_rule 建表无入口（提醒规则引擎阶段二；默认规则"收件人含我"代码内置）
--   · mail_message.fts 建列（simple 配置）；阶段一查询走 ILIKE 降级
--     （zhparser 随真实邮件栈阶段二，同 kb 域向量降级先例）
--   · 正文阶段一直接落 body 列（body_state=2）；MinIO LRU 缓存阶段二
-- 邮件栈（docker-mailserver/auth-bridge/路径②）阶段二——阶段一 MailStack
-- 内存适配器进程内直投。ID 分配 advisory lock 9125/9126（postgres.go）。

CREATE TABLE IF NOT EXISTS mail_domain (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    domain       TEXT NOT NULL,
    mode         SMALLINT NOT NULL DEFAULT 1,  -- 1 内网 2 对外（22 §3.3）
    dkim_key_ref TEXT,                        -- kms://…（仅引用；阶段二随 DKIM 向导）
    dns_status   JSONB NOT NULL DEFAULT '{}', -- {mx,spf,dkim,dmarc,autodiscover}（阶段二检测）
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_mail_domain UNIQUE (domain)
);

CREATE TABLE IF NOT EXISTS mailbox (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    domain_id       BIGINT NOT NULL REFERENCES mail_domain(id),
    address         TEXT NOT NULL,             -- employee_no@domain
    type            SMALLINT NOT NULL DEFAULT 1, -- 1 personal 2 shared（shared 随 resource_acl 阶段二）
    owner_user_id   BIGINT,                    -- personal 必填
    govern_dept_id  BIGINT,                    -- shared 治理部门（阶段二）
    quota_bytes     BIGINT NOT NULL DEFAULT 5368709120, -- 5GB 租户默认
    used_bytes      BIGINT NOT NULL DEFAULT 0,
    settings        JSONB NOT NULL DEFAULT '{}',  -- 签名/自动转发/远程图片（22 §6.1 settings）
    status          SMALLINT NOT NULL DEFAULT 1, -- 1 active 2 suspended 3 archived
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_at    TIMESTAMPTZ,
    CONSTRAINT uk_mailbox_tenant_addr UNIQUE (tenant_id, address)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_owner ON mailbox (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mail_alias (
    id               BIGINT PRIMARY KEY,
    tenant_id        BIGINT NOT NULL DEFAULT 1,
    alias_address    TEXT NOT NULL,
    kind             SMALLINT NOT NULL DEFAULT 1, -- 1 alias→单 mailbox 2 list→成员展开
    target_mailbox_id BIGINT,
    members          JSONB NOT NULL DEFAULT '[]',
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       BIGINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_mail_alias UNIQUE (tenant_id, alias_address)
);

-- 应用专用密码（22 §3.4 路径②）：仅存 hash（auth 域 PBKDF2 闭包注入），
-- 吊销即时生效（auth-bridge 在线校验阶段二）
CREATE TABLE IF NOT EXISTS mail_app_password (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    user_id      BIGINT NOT NULL,
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mail_app_pwd_user ON mail_app_password (user_id) WHERE revoked_at IS NULL;

-- 文件夹元数据（未读计数查询源；uidvalidity/uid_next 同步游标真实栈阶段二）
CREATE TABLE IF NOT EXISTS mail_folder_meta (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    mailbox_id   BIGINT NOT NULL REFERENCES mailbox(id),
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,               -- inbox/sent/drafts/trash/junk/archive/custom
    uidvalidity  BIGINT NOT NULL DEFAULT 1,
    uid_next     BIGINT NOT NULL DEFAULT 1,
    sync_cursor  TEXT,
    total_count  INT NOT NULL DEFAULT 0,
    unread_count INT NOT NULL DEFAULT 0,
    CONSTRAINT uk_mail_folder UNIQUE (mailbox_id, name)
);

-- 邮件缓存索引（权威数据在邮件栈；阶段一内存栈即权威，本表兼任收件箱存储）
CREATE TABLE IF NOT EXISTS mail_message (
    id            BIGINT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL DEFAULT 1,
    mailbox_id    BIGINT NOT NULL REFERENCES mailbox(id),
    folder_id     BIGINT NOT NULL REFERENCES mail_folder_meta(id), -- 系统六文件夹开户即 seed
    message_id    TEXT NOT NULL,                 -- RFC822 Message-ID（幂等键 per mailbox）
    in_reply_to   TEXT,
    from_addr     TEXT NOT NULL,
    to_addrs      JSONB NOT NULL DEFAULT '[]',
    cc_addrs      JSONB NOT NULL DEFAULT '[]',
    bcc_addrs     JSONB NOT NULL DEFAULT '[]',
    subject       TEXT NOT NULL DEFAULT '',
    snippet       TEXT NOT NULL DEFAULT '',
    body          TEXT,                          -- 阶段一直存；MinIO LRU 阶段二
    has_attachment BOOLEAN NOT NULL DEFAULT FALSE,
    attachments   JSONB NOT NULL DEFAULT '[]',   -- [{file_id,name,size}]（07 篇 file_id 引用）
    flags         SMALLINT NOT NULL DEFAULT 0,   -- bit0 seen bit1 flagged bit2 answered bit3 draft bit4 scheduled
    size          BIGINT NOT NULL DEFAULT 0,
    body_state    SMALLINT NOT NULL DEFAULT 2,   -- 1 meta_only 2 cached
    body_obj_key  TEXT,
    send_at       TIMESTAMPTZ,                   -- 定时发送阶段二
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    fts           TSVECTOR                       -- simple 配置；查询阶段一 ILIKE 降级
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_mail_msg_mailbox_mid ON mail_message (mailbox_id, message_id);
CREATE INDEX IF NOT EXISTS idx_mail_msg_folder_time ON mail_message (folder_id, received_at DESC);
-- fts GIN 索引随 zhparser 阶段二（simple 下建了无收益）

CREATE TABLE IF NOT EXISTS mail_rule (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    user_id     BIGINT NOT NULL,
    kind        SMALLINT NOT NULL DEFAULT 1, -- 1 contact 2 custom
    conditions  JSONB NOT NULL DEFAULT '{}',
    action      SMALLINT NOT NULL DEFAULT 1, -- 1 im_remind 2 daily_digest
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mail_rule_user ON mail_rule (user_id);
