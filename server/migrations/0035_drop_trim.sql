-- 0035：产品瘦身二阶段孤儿表清理（2026-11）。
-- 随代码整体移除的域/功能（删除前全量快照见 backup/full-suite-20261109 分支）：
--   * doc 文档中心（0011/0026/0027，代码随一阶段瘦身移除、表残留至今）；
--   * bot Outgoing（0033 + 0018 遗留 bot_webhook/bot_delivery_log，仅迁移无 Go 实现）；
--   * meeting 会议域（0019/0021，二阶段移除）；
--   * rtc 音视频域无独立表（通话记录=call_card 落 message 流，随域移除）；
--   * file_share 文件分享外链（0013，二阶段移除；聊天内票据下载通道保留）。
-- 全部 DROP IF EXISTS ... CASCADE（孤儿表间历史 FK 残留——开发库实测 bot 被
-- bot_webhook 外键牵连，级联仅波及孤儿集内对象）；已部署库安全；新库直通。
DROP TABLE IF EXISTS doc_version CASCADE;
DROP TABLE IF EXISTS doc_file CASCADE;
DROP TABLE IF EXISTS doc_folder CASCADE;
DROP TABLE IF EXISTS doc_share CASCADE;
DROP TABLE IF EXISTS bot_delivery_log CASCADE;
DROP TABLE IF EXISTS bot_webhook CASCADE;
DROP TABLE IF EXISTS bot_subscription CASCADE;
DROP TABLE IF EXISTS bot CASCADE;
DROP TABLE IF EXISTS meeting_participant CASCADE;
DROP TABLE IF EXISTS meeting CASCADE;
DROP TABLE IF EXISTS meeting_recurrence CASCADE;
DROP TABLE IF EXISTS calendar_event CASCADE;
DROP TABLE IF EXISTS file_share CASCADE;
