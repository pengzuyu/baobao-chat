-- 008_event_fts：会话全文索引（session_search 工具数据源）。
-- 两张 FTS5 虚表，行号=agent_event.id：
--   agent_event_fts      默认 unicode61 分词——英文等按词匹配（AND/OR/NOT、短语、前缀 *）
--   agent_event_fts_tri  trigram 分词——任意文字的子串匹配（中文无空格分词，词级索引搜不到）
-- 索引由触发器维护：与事件同事务写入/删除（会话删除会级联删事件，见 queries/session.rs
-- delete_session），不会出现「事件有、索引无」或索引残留的两份存储漂移。
-- 入索引三类：user.text / assistant.done / tool.call（tool + 脱敏 args）；
-- 思考过程与工具输出不入索引（体积大、噪音多，且会把文件/网页内容带回上下文）。
-- json_valid 守卫：坏 payload 只是不入索引，不连累事件本身写入。
-- 可重跑（拨回 user_version 再跑迁移的路径）：索引是纯派生数据，先清后建再回填，无损。
DROP TRIGGER IF EXISTS agent_event_fts_ai;
DROP TRIGGER IF EXISTS agent_event_fts_ad;
DROP TRIGGER IF EXISTS agent_event_fts_tri_ai;
DROP TRIGGER IF EXISTS agent_event_fts_tri_ad;
DROP TABLE IF EXISTS agent_event_fts;
DROP TABLE IF EXISTS agent_event_fts_tri;

CREATE VIRTUAL TABLE agent_event_fts USING fts5(text);
CREATE VIRTUAL TABLE agent_event_fts_tri USING fts5(text, tokenize='trigram');

CREATE TRIGGER agent_event_fts_ai AFTER INSERT ON agent_event
WHEN NEW.type IN ('user.text', 'assistant.done', 'tool.call') AND json_valid(NEW.payload)
BEGIN
  INSERT INTO agent_event_fts(rowid, text) VALUES (NEW.id,
    CASE NEW.type
      WHEN 'tool.call' THEN COALESCE(json_extract(NEW.payload, '$.tool'), '') || ' ' ||
                               COALESCE(json_extract(NEW.payload, '$.args'), '')
      ELSE COALESCE(json_extract(NEW.payload, '$.text'), '')
    END);
END;

CREATE TRIGGER agent_event_fts_ad AFTER DELETE ON agent_event
BEGIN
  DELETE FROM agent_event_fts WHERE rowid = OLD.id;
END;

CREATE TRIGGER agent_event_fts_tri_ai AFTER INSERT ON agent_event
WHEN NEW.type IN ('user.text', 'assistant.done', 'tool.call') AND json_valid(NEW.payload)
BEGIN
  INSERT INTO agent_event_fts_tri(rowid, text) VALUES (NEW.id,
    CASE NEW.type
      WHEN 'tool.call' THEN COALESCE(json_extract(NEW.payload, '$.tool'), '') || ' ' ||
                               COALESCE(json_extract(NEW.payload, '$.args'), '')
      ELSE COALESCE(json_extract(NEW.payload, '$.text'), '')
    END);
END;

CREATE TRIGGER agent_event_fts_tri_ad AFTER DELETE ON agent_event
BEGIN
  DELETE FROM agent_event_fts_tri WHERE rowid = OLD.id;
END;

-- 存量回填：整体在迁移事务里；重跑路径重建后的空表由这里灌满
INSERT INTO agent_event_fts(rowid, text)
SELECT id,
  CASE type
    WHEN 'tool.call' THEN COALESCE(json_extract(payload, '$.tool'), '') || ' ' ||
                             COALESCE(json_extract(payload, '$.args'), '')
    ELSE COALESCE(json_extract(payload, '$.text'), '')
  END
FROM agent_event
WHERE type IN ('user.text', 'assistant.done', 'tool.call') AND json_valid(payload);

INSERT INTO agent_event_fts_tri(rowid, text)
SELECT id,
  CASE type
    WHEN 'tool.call' THEN COALESCE(json_extract(payload, '$.tool'), '') || ' ' ||
                             COALESCE(json_extract(payload, '$.args'), '')
    ELSE COALESCE(json_extract(payload, '$.text'), '')
  END
FROM agent_event
WHERE type IN ('user.text', 'assistant.done', 'tool.call') AND json_valid(payload);
