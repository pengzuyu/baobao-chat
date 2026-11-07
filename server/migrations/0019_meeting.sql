-- 0019_meeting：会议域阶段一（21 篇务实版）
-- 三表齐建（13 篇 §3 回填口径）：meeting（instant/scheduled 双形态）+
-- meeting_participant（RSVP）+ calendar_event（唯一日历事实源）。
-- 阶段一裁剪登记：meeting_recurrence/meeting_minutes（周期会 RRULE 展开、
-- 纪要转写随阶段二——ASR 依赖 19 篇真实模型）；meeting.call_session_id
-- 保留 bigint 占位（05 篇 call 为内存态无表 ID，绑定经 meeting_no 复用
-- 为 call_id，登记）；等候室/锁定/主持控制媒体面/邮件 iCal/会中聊天
-- 临时群/外部访客随后续批次。
-- ID 分配 advisory lock 9129/9130。

CREATE TABLE IF NOT EXISTS meeting (
    id             BIGINT PRIMARY KEY,
    tenant_id      BIGINT NOT NULL DEFAULT 1,
    meeting_no     TEXT NOT NULL,               -- 9 位会议号（UK，随机防猜测；入会深链组成）
    title          TEXT NOT NULL,
    agenda_md      TEXT NOT NULL DEFAULT '',    -- 议程（Markdown）
    type           SMALLINT NOT NULL,           -- 1 instant 2 scheduled（3 recurring 阶段二）
    organizer_id   BIGINT NOT NULL,
    host_id        BIGINT NOT NULL,             -- 当前主持人（默认=组织者，可移交阶段二）
    status         SMALLINT NOT NULL DEFAULT 1, -- 1 scheduled 2 live 3 ended 4 canceled
    start_time     TIMESTAMPTZ NOT NULL,        -- UTC 存储（即时会=创建时刻）
    end_time       TIMESTAMPTZ NOT NULL,
    tz             TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    conv_id        BIGINT,                      -- 绑定群（meeting_card 落此群；空=临时群阶段二）
    chat_conv_id   BIGINT,                      -- 会中聊天临时会话（阶段二）
    call_session_id BIGINT NOT NULL DEFAULT 0,  -- 场次回链占位（05 篇内存态，经 meeting_no 绑定，登记）
    settings       JSONB NOT NULL DEFAULT '{}', -- waiting_room/lock/提醒（阶段二消费）
    minutes_status SMALLINT NOT NULL DEFAULT 0, -- 0 无（1-3 转写/草稿/发布随纪要阶段二）
    created_by     BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_meeting_no UNIQUE (tenant_id, meeting_no)
);
CREATE INDEX IF NOT EXISTS idx_meeting_organizer_time ON meeting (organizer_id, start_time);

CREATE TABLE IF NOT EXISTS meeting_participant (
    id           BIGINT PRIMARY KEY,
    tenant_id    BIGINT NOT NULL DEFAULT 1,
    meeting_id   BIGINT NOT NULL REFERENCES meeting(id),
    user_id      BIGINT NOT NULL,
    role         SMALLINT NOT NULL DEFAULT 3, -- 1 organizer 2 host 3 participant
    rsvp         SMALLINT NOT NULL DEFAULT 1, -- 1 pending 2 accepted 3 tentative 4 declined
    invite_source SMALLINT NOT NULL DEFAULT 1, -- 1 应用内（2 群绑定 3 邮件 iCal 阶段二）
    invited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    CONSTRAINT uk_meeting_participant UNIQUE (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_participant_user ON meeting_participant (user_id);

-- 统一日历事件（唯一事实源；ics 入站 source=2 随 D22 iCal 阶段二）
CREATE TABLE IF NOT EXISTS calendar_event (
    id          BIGINT PRIMARY KEY,
    tenant_id   BIGINT NOT NULL DEFAULT 1,
    user_id     BIGINT NOT NULL,               -- 日历归属人（每人一行镜像）
    source      SMALLINT NOT NULL DEFAULT 1,   -- 1 meeting（2 ical_external 3 manual 预留）
    ref_id      BIGINT NOT NULL,               -- source=1→meeting_id
    title       TEXT NOT NULL,
    start_ts    TIMESTAMPTZ NOT NULL,
    end_ts      TIMESTAMPTZ NOT NULL,
    all_day     BOOLEAN NOT NULL DEFAULT FALSE,
    tz          TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    busy        BOOLEAN NOT NULL DEFAULT TRUE, -- 忙闲聚合口径
    rsvp_status SMALLINT NOT NULL DEFAULT 1,   -- 回执镜像（meeting RSVP 同步）
    series_ref  BIGINT,                        -- 周期系列（阶段二）
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_user_time ON calendar_event (user_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_calendar_ref ON calendar_event (source, ref_id);
