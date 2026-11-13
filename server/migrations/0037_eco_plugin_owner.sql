-- 0037：eco_plugin 加 owner_user_id（方案 A 个人插件，2026-11-13 用户拍板）
-- 语义：0=公共插件（管理员发布，原口径不变）；>0=个人插件归属用户——
-- 个人插件 draft 即**仅 owner 可见可装**（自用沙盒）；管理员 publish 审核后
-- 变 published 进公共市场（owner 视角不变）。policy 恒 optional（force/recommend
-- 仅对公共插件有意义）。对齐专家库 corp/usr 双源先例（D14 §5）。
ALTER TABLE eco_plugin ADD COLUMN IF NOT EXISTS owner_user_id BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_eco_plugin_owner ON eco_plugin (tenant_id, owner_user_id);
