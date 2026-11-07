// Package migrations 内嵌 SQL 迁移（go:embed，随二进制分发）。
// 版本记录语义与 deploy/compose/init/01-init.sh 的 schema_migrations 完全一致
// （生产通道 golang-migrate，16 篇 §2.2；本包为免外部工具的兜底实现）。
package migrations

import _ "embed"

// Migration 单个迁移单元
type Migration struct {
	Version int64  // 版本号 = 文件名前缀 NNN（golang-migrate 约定）
	Name    string // 文件名去扩展名
	// Probe 已应用探测对象（regclass）。兼容"迁移已被外部通道直灌（如 compose init
	// 直接执行 0001）但无版本记录"的场景：探测命中则补登记版本而非重放 DDL——
	// 0001 不含 IF NOT EXISTS，重放必然报 already exists。
	Probe string
	SQL   string // up 脚本内容
}

//go:embed 0001_init.sql
var initSQL string

//go:embed 0002_message_edit_version.sql
var editVersionSQL string

//go:embed 0003_ai_gateway.sql
var aiGatewaySQL string

//go:embed 0004_conversation_apply.sql
var convApplySQL string

//go:embed 0005_message_favorite.sql
var msgFavoriteSQL string

//go:embed 0006_sensitive_word.sql
var sensitiveWordSQL string

//go:embed 0007_user_notification.sql
var userNotificationSQL string

//go:embed 0008_file.sql
var fileSQL string

//go:embed 0009_kb.sql
var kbSQL string

//go:embed 0010_admin_audit.sql
var adminAuditSQL string

//go:embed 0011_doc.sql
var docSQL string

//go:embed 0012_bot.sql
var botSQL string

//go:embed 0013_file_share.sql
var fileShareSQL string

//go:embed 0014_transfer_record.sql
var transferRecordSQL string

// List 全量迁移（顺序 = 切片序 = 版本序）；新增迁移向后追加，禁止插入/修改已发布项。
var List = []Migration{
	{Version: 1, Name: "0001_init", Probe: "public.users", SQL: initSQL},
	// Probe 必须留空：message 表 0001 即存在，探测会误判 0002 已应用而漏执行 ALTER；
	// 幂等性由 SQL 内 IF NOT EXISTS 兜底（版本记录丢失重放安全）。
	{Version: 2, Name: "0002_message_edit_version", Probe: "", SQL: editVersionSQL},
	// 0003 同理留空：ai_provider 表仅本迁移创建；幂等由 IF NOT EXISTS 兜底
	{Version: 3, Name: "0003_ai_gateway", Probe: "", SQL: aiGatewaySQL},
	// 0004 同理留空：conversation_apply 仅本迁移创建；幂等由 IF NOT EXISTS 兜底
	{Version: 4, Name: "0004_conversation_apply", Probe: "", SQL: convApplySQL},
	// 0005 同理留空：message_favorite 仅本迁移创建；幂等由 IF NOT EXISTS 兜底
	{Version: 5, Name: "0005_message_favorite", Probe: "", SQL: msgFavoriteSQL},
	// 0006 同理留空：sensitive_word 仅本迁移创建；幂等由 IF NOT EXISTS 兜底
	{Version: 6, Name: "0006_sensitive_word", Probe: "", SQL: sensitiveWordSQL},
	// 0007 同理留空：user_notification 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D03 PIM-09）
	{Version: 7, Name: "0007_user_notification", Probe: "", SQL: userNotificationSQL},
	// 0008 同理留空：file 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D06 阶段一务实版）
	{Version: 8, Name: "0008_file", Probe: "", SQL: fileSQL},
	// 0009 同理留空：kb_* 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D07 阶段一务实版）
	{Version: 9, Name: "0009_kb", Probe: "", SQL: kbSQL},
	// 0010 同理留空：admin_audit_action 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D10 阶段一务实版）
	{Version: 10, Name: "0010_admin_audit", Probe: "", SQL: adminAuditSQL},
	// 0011 同理留空：doc_file/doc_version 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D05 阶段一务实版）
	{Version: 11, Name: "0011_doc", Probe: "", SQL: docSQL},
	// 0012 同理留空：bot/bot_webhook 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（20 篇阶段一务实版）
	{Version: 12, Name: "0012_bot", Probe: "", SQL: botSQL},
	// 0013 同理留空：file_share 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D06 阶段二外链）
	{Version: 13, Name: "0013_file_share", Probe: "", SQL: fileShareSQL},
	// 0014 同理留空：transfer_record 仅本迁移创建；幂等由 IF NOT EXISTS 兜底（D06 阶段二传输镜像）
	{Version: 14, Name: "0014_transfer_record", Probe: "", SQL: transferRecordSQL},
}
