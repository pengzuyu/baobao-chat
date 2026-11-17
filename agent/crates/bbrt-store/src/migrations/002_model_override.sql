-- 002：agent_session 增列 model_override（0023 多供应商接入）。
-- 会话级模型直达引用（p:<provider_id>:<model>；NULL=走 model_policy 档位别名 bbc-fast/bbc-strong）。
-- 与 model_policy 正交：override 只作用于主循环对话模型，planner/压缩/探查/选角等
-- 内部辅助调用仍走档位（不跟用户选择走）。
ALTER TABLE agent_session ADD COLUMN model_override TEXT;
