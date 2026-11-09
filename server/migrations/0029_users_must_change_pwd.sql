-- 0029：users.must_change_password 首登强制改密（D12 §账号安全 / EXECUTION-PLAN D11）。
-- 批量导入用户（初始口令=工号+!BBW）置 TRUE：登录响应携带 must_change_pwd →
-- 前端登录二步改密表单；POST /me/password 改密成功后清位。
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
