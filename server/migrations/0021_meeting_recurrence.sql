-- 0021_meeting_recurrence：周期会（21 §4.2 RRULE 简化子集 + §5 系列）
-- 四频率 daily/weekly(选周几)/biweekly/monthly(按日或第 N 个周 X)；
-- 结束 count≤52 或 until 取先到；展开为独立 meeting 行（各场独立会议号，
-- 21 §4.2 默认）；系列编辑三选一（this=单场既有 API/this_and_after=拆分
-- /all=系列属性应用）。
-- 裁剪登记：节假日跳过（skip_holidays 开关落库，holiday_cal 日历数据源
-- 随租户节假日维护阶段二——无数据=不跳）；"第 N 个周 X"月末边界（第 5
-- 个周 X 不存在时跳过该月，登记）。

ALTER TABLE meeting ADD COLUMN IF NOT EXISTS series_id BIGINT; -- → meeting_recurrence（单场 NULL）
CREATE INDEX IF NOT EXISTS idx_meeting_series ON meeting (series_id) WHERE series_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_recurrence (
    id              BIGINT PRIMARY KEY,
    tenant_id       BIGINT NOT NULL DEFAULT 1,
    rule            JSONB NOT NULL,             -- {freq, by_weekday[], month_mode, month_day, nth, count, until_ms}
    skip_holidays   BOOLEAN NOT NULL DEFAULT FALSE,
    holiday_cal_id  BIGINT,                     -- 节假日日历引用（数据源阶段二）
    split_from      BIGINT,                     -- "本场及之后"拆分来源系列
    organizer_id    BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
