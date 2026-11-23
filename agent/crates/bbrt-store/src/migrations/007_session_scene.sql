-- 007：agent_session 增列 conv_id（2026-11-23 三区块场景提示词）。
-- IM embedded 会话的来源聊天 ID（im_history 工具参数；NULL=非 embedded）。
-- 场景判定复用既有 form 列（不动表 CHECK 约束 IN('embedded','workbench')）：
--   workspace 非空 = 项目；form=embedded + conv_id = 日常对话；
--   form=workbench + 空 workspace = 任务（工作台建的空目录会话语义）。
-- 复活路径（revive_session）从库行还原场景，runtime 不依赖前端 IDB 映射。
ALTER TABLE agent_session ADD COLUMN conv_id TEXT;
