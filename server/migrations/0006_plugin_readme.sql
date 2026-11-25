-- 0006 插件 README 与市场统计（2026-11-25 D39）：安装前说明文档 + 装机数/最近更新。
-- readme=插件级元数据（随最新上传对齐，与 name/description 同组；非版本快照）；
-- ≤64KB 由服务端校验器兜底；空串=无说明（详情页不渲染说明区块，向后兼容）。
ALTER TABLE public.eco_plugin ADD COLUMN readme text NOT NULL DEFAULT '';

-- 装机数聚合（COUNT(*) GROUP BY pkg_id，D39 §2）辅助索引；行数=用户×插件，万级。
CREATE INDEX idx_eco_plugin_install_pkg ON public.eco_plugin_install (tenant_id, pkg_id);
