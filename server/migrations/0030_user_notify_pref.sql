-- 0030：user_notify_pref 用户通知偏好（D10 设置中心 / EXECUTION-PLAN D12：
-- 通知设置服务端持久化——原 NotificationSettingsPage 纯本地 useState 骨架）。
-- 三项 v0.1 口径：msg_notify（新消息红点+桌面通知总开关）/ mention_notify
-- （@我强提醒）/ dnd_range（免打扰时段：off|work-night|all-day——系统通知静默，
-- 红点保留）。消费点 v0.1=agent 完成系统通知（notify.ts 按 dnd 静默）；
-- IM 桌面通知触发点随通知中心深度接（登记）。
CREATE TABLE IF NOT EXISTS user_notify_pref (
    user_id        BIGINT PRIMARY KEY,
    tenant_id      BIGINT      NOT NULL,
    msg_notify     BOOLEAN     NOT NULL DEFAULT TRUE,
    mention_notify BOOLEAN     NOT NULL DEFAULT TRUE,
    dnd_range      TEXT        NOT NULL DEFAULT 'off', -- off|work-night|all-day
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_notify_pref_tenant ON user_notify_pref (tenant_id);

ALTER TABLE user_notify_pref ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON user_notify_pref;
CREATE POLICY p_tenant ON user_notify_pref
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
