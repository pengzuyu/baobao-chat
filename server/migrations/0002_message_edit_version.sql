-- 0002：message 补 edit_version（D03 API-IM-08 响应字段；edit_history 留痕不变）。
-- 分区表父表 ALTER 自动传播至各分区（含 default 兜底分区）。
-- 幂等写法：版本记录丢失重放时不炸（IF NOT EXISTS）。
ALTER TABLE message ADD COLUMN IF NOT EXISTS edit_version SMALLINT NOT NULL DEFAULT 1;
