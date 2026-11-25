-- 0007：D09 生态应用（eco apps）子域整域退役（2026-11-25 拍板）。
-- 背景：应用子域与 D22 插件概念撞车且运行时零消费——agent 装配三源
-- （corp/插件/个人）均不读 install 表，商店页「安装」无实际效果；管控分发
-- 需求（版本/灰度）未来长在插件市场侧，不复活本域。
-- 删除范围：eco_app / eco_app_version / eco_app_install / eco_rollout 四表
-- （0001 基线建表；四表间无数据库级 FK，逻辑关联 app_row_id，DROP 无顺序约束）。
-- 全量快照与设计文档存档见 docs/detail/D09。
DROP TABLE IF EXISTS eco_app CASCADE;
DROP TABLE IF EXISTS eco_app_version CASCADE;
DROP TABLE IF EXISTS eco_app_install CASCADE;
DROP TABLE IF EXISTS eco_rollout CASCADE;
