-- 0024：file 消息锚点 + 撤回标记（OQ-B24 拍板：群文件页签对已撤回消息文件——
-- 文件保留、锚点置灰不可跳转。D06 §6.2 msg_id 锚点字段落位为 msg_seq）。
-- msg_seq=随消息发送后回填的消息 seq（群文件"定位消息"跳转依据；0=未关联）；
-- recalled=msg.recalled 事件联动标记（置灰依据；不影响文件本体保留与下载）。
ALTER TABLE file ADD COLUMN IF NOT EXISTS msg_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE file ADD COLUMN IF NOT EXISTS recalled BOOLEAN NOT NULL DEFAULT FALSE;

-- 撤回联动按 (conv_id, msg_seq) 定位（事件负载无 file_id；每 seq 至多一条文件消息）
CREATE INDEX IF NOT EXISTS idx_file_conv_msg
    ON file (conv_id, msg_seq) WHERE deleted_at IS NULL;
