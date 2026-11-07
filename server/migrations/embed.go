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
}
