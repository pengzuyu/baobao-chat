-- 0002：OIDC desktop 确认链（D28 批次 Q2）——确认码尝试计数。
-- 6 位确认码错 3 次即作废该授权请求（1012；防钓鱼码爆破）。幂等（ADD IF NOT EXISTS）。
-- 注意：基线 squash 后首个增量（c52d5a7 规矩：新变更=新 NNNN 文件+embed.go 登记）。
ALTER TABLE oidc_auth_request
    ADD COLUMN IF NOT EXISTS confirm_attempts INT NOT NULL DEFAULT 0;
