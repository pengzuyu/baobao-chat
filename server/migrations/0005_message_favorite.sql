-- 0005：message_favorite 消息收藏表（D03 §6.1；04 篇 §9-2 PIM-08）。
-- 说明：任务基线曾记载「0001 已含 message_favorite」，实际核对 0001 仅建到
-- user_conv_state——补齐最小迁移，幂等写法可安全重放（同 0004 处理方式）。
-- 快照仅存 msg_id+conv_id（详情实时取：撤回消息可收藏，列表渲染占位）；
-- UK(user_id,msg_id) 幂等；上限 1000 为应用层校验（错误码 3022，14 篇 §7）。
CREATE TABLE IF NOT EXISTS message_favorite (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    msg_id     BIGINT NOT NULL,
    conv_id    BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON message_favorite (user_id, created_at DESC);

ALTER TABLE message_favorite ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON message_favorite;
CREATE POLICY p_tenant ON message_favorite
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
