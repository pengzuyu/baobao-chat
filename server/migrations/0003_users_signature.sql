-- 0003 个人签名（2026-11-17 个人签名模块）：微信式一句签名。
-- 空串=未设置；长度上限 100 字（rune 口径，service 层校验）；
-- 展示位仅单聊会话侧栏名片（用户拍板：通讯录不展示、他人被动刷新）。
ALTER TABLE public.users ADD COLUMN signature text NOT NULL DEFAULT '';
