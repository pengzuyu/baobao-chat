// Package migrations 内嵌 SQL 迁移（go:embed，随二进制分发）。
// 2026-11-16 squash（D28 会话拍板：无升级场景）：原 0001-0038 增量链收口为
// 单一终态基线——由 dev 库全链终态 pg_dump 导出。此后新增 schema 变更仍按
// NNNN 追加文件并在 List 登记（保持"单基线+增量"并存形态）。
// 执行通道：bbc-server 内嵌 Migrate（单通道权威；compose init 只做 pg 等待+扩展）。
package migrations

import _ "embed"

// Migration 单个迁移单元
type Migration struct {
	Version int64  // 版本号 = 文件名前缀 NNN（golang-migrate 约定）
	Name    string // 文件名去扩展名
	// Probe 已应用探测对象（regclass）。兼容"迁移已被外部通道直灌但无版本记录"
	// 的场景：探测命中则补登记版本而非重放 DDL——基线不含 IF NOT EXISTS，重放
	// 必然报 already exists。
	Probe string
	SQL   string // up 脚本内容
}

//go:embed 0001_init.sql
var baselineSQL string

//go:embed 0002_oidc_confirm_attempts.sql
var confirmAttemptsSQL string

//go:embed 0003_users_signature.sql
var usersSignatureSQL string

// List 全量迁移（顺序 = 切片序 = 版本序）；新增迁移向后追加，禁止插入/修改已发布项。
var List = []Migration{
	{Version: 1, Name: "0001_init", Probe: "public.users", SQL: baselineSQL},
	{Version: 2, Name: "0002_oidc_confirm_attempts", Probe: "", SQL: confirmAttemptsSQL},
	{Version: 3, Name: "0003_users_signature", Probe: "", SQL: usersSignatureSQL},
}
