-- 0007：user_notification 用户通知表（D03 §3.9 PIM-09 通知中心）。
-- kind：mention(@我)/reply(回复我)/apply(入群审批)/agent_done(Agent 完成，建表预留——
--       服务端尚无 agent 域事件源，登记不做)/announcement(系统公告)。
-- 聚合：同 (user_id, kind, conv_id) 10s 窗口内不新增行，原行 count+1（生成侧 repo.InsertMerged）；
--       「1 分钟 ≤5 条系统通知超出仅计红点」「勿扰时段只入中心不发系统通知」属客户端投递策略（D03 §4.1 INT-IM-22）。
-- 幂等：IF NOT EXISTS 可安全重放（版本记录丢失场景兜底）。
CREATE TABLE IF NOT EXISTS user_notification (
    id         BIGINT PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    kind       TEXT NOT NULL,                     -- mention|reply|apply|agent_done|announcement
    conv_id    BIGINT,                            -- 关联会话（点击路由依据；可空）
    msg_id     BIGINT,                            -- 关联消息（mention/reply 定位 seq 用；可空）
    seq        BIGINT,                            -- 会话内 seq（定位闪烁）
    title      TEXT NOT NULL DEFAULT '',
    digest     TEXT NOT NULL DEFAULT '',
    count      INT NOT NULL DEFAULT 1,            -- 10s 窗口合并计数（"×N"渲染依据）
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at    TIMESTAMPTZ                        -- NULL=未读
);

-- 红点/列表主查询路径：user_id + 未读优先（D03 §3.9 idx(user_id,read_at)）
CREATE INDEX IF NOT EXISTS idx_user_notification_user_read
    ON user_notification (user_id, read_at);
-- 分组 tab 过滤路径（kind）
CREATE INDEX IF NOT EXISTS idx_user_notification_user_kind
    ON user_notification (user_id, kind, id DESC);

ALTER TABLE user_notification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant ON user_notification;
CREATE POLICY p_tenant ON user_notification
    USING (tenant_id = current_setting('app.tenant', true)::BIGINT);
