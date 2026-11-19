-- 0004 工作日日历（D35 Agent 定时任务）：仅存“默认规则之外”的日期。
-- 默认规则=周一~五工作日、六日周末（读取时合并）；本表只落例外：
-- 法定节假日、调休上班（周末标工作日）、管理员手工改过的周末。
-- day_type: 1=工作日(含调休) 2=周末 3=节假日；source: default|manual|import。
CREATE TABLE IF NOT EXISTS public.workday_calendar (
    tenant_id  bigint      NOT NULL,
    day        date        NOT NULL,
    day_type   smallint    NOT NULL CHECK (day_type BETWEEN 1 AND 3),
    name       text        NOT NULL DEFAULT '',
    source     text        NOT NULL DEFAULT 'manual',
    updated_by bigint      NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, day)
);