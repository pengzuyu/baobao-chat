// Package adminservice 管理域业务逻辑（D10 阶段一务实版）。
// 范围：仪表盘聚合 / 用户禁用启用（踢线+吊销）/ agent 策略只读 / 敏感词 CRUD（热更）/
// AI 用量汇总 / 审计时间线。取舍登记（不做项）见 api.go 包注释。
//
// 跨域聚合（D02 §4 依赖规则：不横向 import 业务包）——全部经 Options 闭包注入：
//
//	users/online/sessions/msgs/kb/files/usage 各域计数 + hub 踢线 + auth 吊销。
package adminservice

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/baobaochat/server/internal/admin/api"
	"github.com/baobaochat/server/internal/admin/repo"
	"github.com/baobaochat/server/internal/org/api"
	errx "github.com/baobaochat/server/internal/platform/errors"
	"github.com/baobaochat/server/internal/platform/pinyinutil"
)

// Options 装配项（main 注入；跨域闭包 + 管理员白名单）
type Options struct {
	// ── 跨域统计闭包（缺省=该指标报 0，页面卡显示「—」由端侧处理）──
	UsersTotal       func(ctx context.Context, tenantID int64) (int64, error)                         // org 用户总数
	OnlineNow        func() int64                                                                     // hub 连接数（非去重用户）
	ConvsActiveSince func(ctx context.Context, tenantID int64, since time.Time) (int64, error)        // message 活跃会话
	MsgsSince        func(ctx context.Context, tenantID int64, since time.Time) (int64, error)        // message 消息数
	KBDocs           func(ctx context.Context, tenantID int64) (int64, error)                         // kb 文档数
	FileBytes        func(ctx context.Context, tenantID int64) (int64, error)                         // file 存储量
	UsageRows        func(ctx context.Context, tenantID int64, days int) ([]adminapi.UsageRow, error) // 用量原始行（pg=ai_usage_hourly / memory=Meter）
	UsageMode        string                                                                           // "pg" | "memory"（UsageSummary.mode 透出）

	// ── 写路径副作用闭包 ──
	// KickUser 禁用即踢线：hub 按 uid 断开全部 WS 连接；返回断开连接数（审计留痕）
	KickUser func(userID int64) int
	// RevokeSessions 吊销该用户全部 refresh token（禁用后阻止静默续期；auth 域 Logout(all)）
	RevokeSessions func(ctx context.Context, userID int64) error

	// ── 管理员判定（RBAC 阶段二起主口径=权限点）──
	// ScopesOf RBAC 权限聚合闭包（main 注入 roleStore.PermissionPointsOf；nil=退回
	// users 行内 Scopes）。IsAdmin/PermPointsOf/守卫判定统一经此口径。
	ScopesOf func(ctx context.Context, tenantID, userID int64) ([]string, error)
	// AdminAccounts empno 白名单（BBC_ADMIN_ACCOUNTS，逗号分隔）：应急通道——
	// 角色链路装配异常/冷启动救砖用；日常管理员走「管理员」内置角色授权（bootstrap 自动挂）。
	AdminAccounts []string

	// NotifyUser 用户级 WS 单播闭包（main 注入 gateway hub；nil=不推送——单测/降级）。
	// 授权/收回/角色权限变更后发 perm.changed，端侧重拉权限摘要即时收窄导航（03 篇 §4）。
	NotifyUser func(tenantID, userID int64, event string, payload map[string]any)

	// BroadcastNotice 公告广播闭包（PAD-15；main 注入=message 域 BroadcastNotice
	// + org 活跃用户清单；nil=仅存档不广播——联调形态）
	BroadcastNotice func(ctx context.Context, tenantID int64, title, digest string) int
	// HashPassword 初始口令哈希闭包（PAD-06；main 注入 authservice.HashPassword；
	// nil=无口令哈希（测试/联调——导入用户将无法口令登录））
	HashPassword func(password string) (string, error)
	// CreateUser 建用户闭包（PAD-06；main 注入 orgRepo.CreateUser——admin 域不引 org repo）
	CreateUser func(ctx context.Context, u orgapi.User) (orgapi.User, error)
	// AttachDeptMember 挂部门闭包（2026-11-12 通讯录单建用户；main 注入 orgRepo.AttachUser）
	AttachDeptMember func(ctx context.Context, tenantID, userID, deptID int64, isPrimary bool) error
	// AgentUsage Agent 计量聚合闭包（PAD-14；main 注入 aigw Meter Snapshot 按用户聚合；nil=空列表）
	AgentUsage func(tenantID int64) []AgentUsageRow
	// KBSpaces KB 空间总览闭包（PAD-10；main 注入 kb repo 全量空间+文档数；nil=空列表）
	KBSpaces func() []KBSpaceClosure
	// KBGovern KB 治理写闭包（D8；main 注 kb 域——archived 即刻生效于检索/浏览）
	KBGovern func(ctx context.Context, tenantID, spaceID int64, archive bool, del bool) error

	// Now 时钟注入（测试用）
	Now func() time.Time
}

func (o *Options) fillDefaults() {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.UsageMode == "" {
		o.UsageMode = "memory"
	}
}

// Service 实现 adminapi.AdminService
type Service struct {
	users   orgapi.UserAdminReader // org 域（列表/计数/状态）+ UserReader（名称/判定）
	same    orgapi.UserReader
	store   adminrepo.Repo
	roles   adminrepo.RoleRepo   // 角色管理（PAD-08；nil=未装配）
	notices adminrepo.NoticeRepo // 平台公告（PAD-15；nil=未装配）
	toolPolicies adminrepo.ToolPolicyRepo // Agent 工具策略（D7；nil=未装配→快照恒 default）
	opts    Options

	agentKill   bool // Agent 平台总闸（PAD-14；内存态——持久化随策略域阶段二，登记）
	agentKillMu sync.Mutex
}

// internal 统一内部错误（角色/授权链路）
func (s *Service) internal(msg string) error { return errx.New(errx.CodeInternal, msg) }

// New 构造（依赖注入，D02 §3；users=管理写通道，reader=读取通道——org 模块同一
// Service 实现；roles 可为 nil=阶段一未装配形态）
func New(users orgapi.UserAdminReader, reader orgapi.UserReader, store adminrepo.Repo, roles adminrepo.RoleRepo, notices adminrepo.NoticeRepo, toolPolicies adminrepo.ToolPolicyRepo, opts Options) *Service {
	opts.fillDefaults()
	return &Service{users: users, same: reader, store: store, roles: roles, notices: notices, toolPolicies: toolPolicies, opts: opts}
}

var _ adminapi.AdminService = (*Service)(nil)

// ── 管理员判定（RBAC 阶段二）──

// effectiveScopesOf 用户有效权限点 = users 行内 Scopes ∪ 角色聚合（03 篇 §4）。
// ScopesOf 未装配/查询失败/无角色时退回行内值（登录链路同口径，authservice.effectiveScopes）；
// 行内值不落库恒 nil（org repo postgres.go「Scopes 不落库」），须兜非 nil 空切片——
// AdminUser.Scopes 无 omitempty，nil 会序列化成 JSON null 炸穿前端 scopes.filter（2026-11-12 用户管理白屏）。
func (s *Service) effectiveScopesOf(ctx context.Context, u *orgapi.User) []string {
	if s.opts.ScopesOf == nil {
		return nonNilScopes(u.Scopes)
	}
	extra, err := s.opts.ScopesOf(ctx, u.TenantID, u.ID)
	if err != nil || len(extra) == 0 {
		return nonNilScopes(u.Scopes)
	}
	seen := make(map[string]struct{}, len(u.Scopes)+len(extra))
	out := make([]string, 0, len(u.Scopes)+len(extra))
	for _, p := range append(append([]string{}, u.Scopes...), extra...) {
		if _, dup := seen[p]; !dup {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	return out
}

// isWhitelisted 应急白名单命中（BBC_ADMIN_ACCOUNTS）——视为管理域全集
func (s *Service) isWhitelisted(u *orgapi.User) bool {
	for _, emp := range s.opts.AdminAccounts {
		if emp != "" && emp == u.EmployeeNo {
			return true
		}
	}
	return false
}

// HasPerm 权限点判定（守卫与页面显隐同源）：有效权限点集合精确含 code；
// 持 "admin"（内存种子裸码）或命中应急白名单视为管理域全集命中。
func (s *Service) HasPerm(ctx context.Context, tenantID, userID int64, code string) bool {
	u, err := s.same.GetUser(ctx, userID)
	if err != nil || u == nil || u.TenantID != tenantID {
		return false
	}
	if s.isWhitelisted(u) {
		return true
	}
	for _, p := range s.effectiveScopesOf(ctx, u) {
		if p == code || p == "admin" {
			return true
		}
	}
	return false
}

// IsAdmin 口径 v0.2（03 篇 §4）：有效权限点（行内 ∪ 角色聚合）含任一
// "admin"/"admin:*"/"platform:*"，或 empno 命中 BBC_ADMIN_ACCOUNTS 应急白名单。
func (s *Service) IsAdmin(ctx context.Context, tenantID, userID int64) bool {
	u, err := s.same.GetUser(ctx, userID)
	if err != nil || u == nil {
		return false
	}
	if u.TenantID != tenantID {
		return false
	}
	for _, sc := range s.effectiveScopesOf(ctx, u) {
		if sc == "admin" || strings.HasPrefix(sc, "admin:") || strings.HasPrefix(sc, "platform:") {
			return true
		}
	}
	return s.isWhitelisted(u)
}

// MyPermPoints 当前用户权限摘要（GET /me/permissions；有效权限点口径）
func (s *Service) MyPermPoints(ctx context.Context, tenantID, userID int64) ([]string, error) {
	u, err := s.same.GetUser(ctx, userID)
	if err != nil || u == nil {
		return nil, errx.New(errx.CodeNotFound, "用户不存在")
	}
	if u.TenantID != tenantID {
		return nil, errx.New(errx.CodeNotFound, "用户不存在")
	}
	return s.effectiveScopesOf(ctx, u), nil
}

// ── 仪表盘 ──

// Dashboard 六指标聚合 + 近 7 日 AI tokens 趋势（指标源缺失时该指标为 0——
// 阶段一各闭包恒装配；「—」化由端侧处理，PAD-02 degraded 语义）
func (s *Service) Dashboard(ctx context.Context, tenantID int64) (*adminapi.Dashboard, error) {
	now := s.opts.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	// 各域计数相互独立：单源失败不影响整盘（P2 降级语义），错误吞掉记 0
	safe := func(f func() int64) int64 {
		if f == nil {
			return 0
		}
		return f()
	}
	var usersTotal, sessions, msgs, kbDocs, fileBytes int64
	if s.opts.UsersTotal != nil {
		usersTotal, _ = s.opts.UsersTotal(ctx, tenantID)
	}
	if s.opts.ConvsActiveSince != nil {
		sessions, _ = s.opts.ConvsActiveSince(ctx, tenantID, todayStart)
	}
	if s.opts.MsgsSince != nil {
		msgs, _ = s.opts.MsgsSince(ctx, tenantID, todayStart)
	}
	if s.opts.KBDocs != nil {
		kbDocs, _ = s.opts.KBDocs(ctx, tenantID)
	}
	if s.opts.FileBytes != nil {
		fileBytes, _ = s.opts.FileBytes(ctx, tenantID)
	}

	// 今日 AI + 趋势共用一次用量拉取（近 7 日）
	aiToday := adminapi.AITodayStat{}
	trend := []adminapi.TrendPoint{}
	if s.opts.UsageRows != nil {
		if rows, err := s.opts.UsageRows(ctx, tenantID, 7); err == nil {
			agg := aggregateDaily(rows)
			today := now.UTC().Format("2006-01-02")
			for _, date := range sortedDates(agg) {
				d := agg[date]
				trend = append(trend, adminapi.TrendPoint{Date: date, TotalTokens: d.tokens})
				if date == today {
					aiToday.Requests = d.requests
					aiToday.TotalTokens = d.tokens
				}
			}
		}
	}
	return &adminapi.Dashboard{
		AsOf:             now.UTC().Format(time.RFC3339),
		UsersTotal:       usersTotal,
		OnlineNow:        safe(func() int64 { return int64(s.opts.OnlineNow()) }),
		SessionsToday:    sessions,
		MsgsToday:        msgs,
		AIToday:          aiToday,
		KBDocs:           kbDocs,
		FileStorageBytes: fileBytes,
		AITokensTrend:    trend,
	}, nil
}

// ── 用户管理 ──

// ListUsers 用户列表（org 域透传）
func (s *Service) ListUsers(ctx context.Context, tenantID int64, keyword string, status, cursor int64, limit int) (*adminapi.UserPage, error) {
	users, hasMore, err := s.users.ListUsers(ctx, orgapi.UserListFilter{
		TenantID: tenantID, Keyword: strings.TrimSpace(keyword), Status: int(status),
		Cursor: cursor, Limit: limit,
	})
	if err != nil {
		return nil, errx.From(err)
	}
	page := &adminapi.UserPage{Items: make([]adminapi.AdminUser, 0, len(users)), HasMore: hasMore}
	for _, u := range users {
		au := toAdminUser(u)
		au.Scopes = s.effectiveScopesOf(ctx, &u) // RBAC 聚合口径（管理端不再恒空）
		au.Roles = s.rolesOfUser(ctx, tenantID, u.ID) // 角色列展示（2026-11-18）
		page.Items = append(page.Items, au)
		if page.NextCursor == "" || u.ID > 0 {
			page.NextCursor = strconv.FormatInt(u.ID, 10)
		}
	}
	if !hasMore {
		page.NextCursor = ""
	}
	return page, nil
}

// SetUserStatus 启用/禁用：状态落库 →（禁用）踢线+吊销 refresh → 审计。
// 幂等：重复置同态直接返回现值（不重复审计，不产生副作用）。
func (s *Service) SetUserStatus(ctx context.Context, tenantID, operatorID, targetUserID int64, status int) (*adminapi.AdminUser, error) {
	if status != orgapi.UserStatusActive && status != orgapi.UserStatusDisabled {
		return nil, errx.New(errx.CodeBadRequest, "status 仅支持 1(启用)/2(禁用)")
	}
	if targetUserID == operatorID {
		return nil, errx.New(errx.CodeBadRequest, "不能禁用自己") // 防自锁（矩阵 §4.1 防自我提权同源）
	}
	u, err := s.same.GetUser(ctx, targetUserID)
	if err != nil || u == nil {
		return nil, errx.New(errx.CodeNotFound, "用户不存在")
	}
	already := u.Status == status
	if !already {
		if err := s.users.SetUserStatus(ctx, targetUserID, status); err != nil {
			return nil, errx.From(err)
		}
	}

	action := "user.enable"
	detail := map[string]any{"user_id": targetUserID, "employee_no": u.EmployeeNo, "status": status}
	if status == orgapi.UserStatusDisabled {
		action = "user.disable"
		kicked := 0
		if !already {
			if s.opts.KickUser != nil {
				kicked = s.opts.KickUser(targetUserID) // 禁用即踢线（hub 按 uid 断连）
			}
			if s.opts.RevokeSessions != nil {
				_ = s.opts.RevokeSessions(ctx, targetUserID) // 吊销 refresh（best-effort，失败不阻断）
			}
		}
		detail["kicked_conns"] = kicked
	}
	if !already { // 幂等：仅真实变更记审计
		_ = s.audit(ctx, tenantID, operatorID, action, "user:"+strconv.FormatInt(targetUserID, 10), detail)
	}

	after := *u
	after.Status = status
	out := toAdminUser(after)
	return &out, nil
}

// ── Agent 策略（只读快照）──

// defaultAgentPolicy v0.1 默认工具策略（09 篇 §5.2 语义的字段名对齐；
// agent_tool_policy 表随 Agent 域阶段二落地，届时本快照切读表）
func defaultAgentPolicy() map[string]any {
	return map[string]any{
		"version":                    1,
		"tool_mode":                  "allowlist",
		"builtin_tools":              map[string]bool{"fs_read": true, "fs_write": true, "shell_exec": false, "http_fetch": false},
		"app_namespace_tools":        map[string]bool{},
		"risk_override":              map[string]any{},
		"audit_report_level":         "metadata",
		"full_auto_admission":        false,
		"permanent_memory_high_risk": false,
	}
}

// AgentPolicy 工具策略快照（default + 行覆盖合成；无行=source "default"）
func (s *Service) AgentPolicy(ctx context.Context, tenantID int64) (*adminapi.AgentPolicySnapshot, error) {
	policy := defaultAgentPolicy()
	snap := &adminapi.AgentPolicySnapshot{
		Version: 1,
		UpdatedAt: s.opts.Now().UTC().Format(time.RFC3339),
		Source:  "default",
		Policy:  policy,
	}
	if s.toolPolicies == nil {
		return snap, nil
	}
	rows, err := s.toolPolicies.ListToolPolicies(ctx, tenantID)
	if err != nil {
		return nil, errx.From(err)
	}
	if len(rows) == 0 {
		return snap, nil
	}
	// 合成：builtin_tools/app_namespace_tools 开关覆盖 + risk_override 合并
	builtin, _ := policy["builtin_tools"].(map[string]bool)
	appNS, _ := policy["app_namespace_tools"].(map[string]bool)
	risk, _ := policy["risk_override"].(map[string]any)
	if builtin == nil {
		builtin = map[string]bool{}
	}
	if appNS == nil {
		appNS = map[string]bool{}
	}
	if risk == nil {
		risk = map[string]any{}
	}
	dtoRows := make([]adminapi.AgentToolPolicyRow, 0, len(rows))
	for _, r := range rows {
		dtoRows = append(dtoRows, adminapi.AgentToolPolicyRow{
			Subject: r.Subject, Allowed: r.Allowed,
			RiskOverride: r.RiskOverride, Config: r.Config,
			UpdatedBy: strconv.FormatInt(r.UpdatedBy, 10),
			UpdatedAt: r.UpdatedAt.UTC().Format(time.RFC3339),
		})
		if strings.HasPrefix(r.Subject, "app:") {
			appNS[r.Subject] = r.Allowed
		} else {
			builtin[r.Subject] = r.Allowed
		}
		if o := strings.TrimSpace(r.RiskOverride); o != "" && o != "{}" {
			var m map[string]any
			if json.Unmarshal([]byte(o), &m) == nil {
				for k, v := range m {
					risk[k] = v
				}
			}
		}
	}
	policy["builtin_tools"] = builtin
	policy["app_namespace_tools"] = appNS
	policy["risk_override"] = risk
	last := rows[len(rows)-1]
	snap.Source = "table"
	snap.UpdatedAt = last.UpdatedAt.UTC().Format(time.RFC3339)
	snap.Rows = dtoRows
	return snap, nil
}

// UpdateAgentToolPolicy 行级 upsert（D7；subject 白名单字符校验防注入形态）
func (s *Service) UpdateAgentToolPolicy(ctx context.Context, tenantID, updatedBy int64, req adminapi.AgentToolPolicyReq) (*adminapi.AgentPolicySnapshot, error) {
	if s.toolPolicies == nil {
		return nil, errx.New(errx.CodeInternal, "工具策略存储未装配")
	}
	subject := strings.TrimSpace(req.Subject)
	if subject == "" || len(subject) > 128 {
		return nil, errx.New(errx.CodeBadRequest, "subject 非空 ≤128 字符")
	}
	for _, ch := range subject {
		if !(ch == ':' || ch == '*' || ch == '_' || ch == '-' || ch == '.' ||
			(ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
			return nil, errx.New(errx.CodeBadRequest, "subject 仅允许字母数字与 : * _ - .")
		}
	}
	if req.Allowed == nil {
		return nil, errx.New(errx.CodeBadRequest, "allowed 必填")
	}
	// risk_override/config 须为合法 JSON 对象（空串=保持既有/缺省 "{}"）
	validateJSONObject := func(s string, field string, keep bool) (string, error) {
		v := strings.TrimSpace(s)
		if v == "" {
			if keep {
				return "", nil // 空=保持（Upsert 前读旧行由调用方语义——简化：空→"{}"）
			}
			return "{}", nil
		}
		var probe map[string]any
		if json.Unmarshal([]byte(v), &probe) != nil {
			return "", errx.New(errx.CodeBadRequest, field+" 须为 JSON 对象")
		}
		return v, nil
	}
	risk, err := validateJSONObject(req.RiskOverride, "risk_override", true)
	if err != nil {
		return nil, err
	}
	if risk == "" {
		risk = "{}"
	}
	cfg, err := validateJSONObject(req.Config, "config", true)
	if err != nil {
		return nil, err
	}
	if cfg == "" {
		cfg = "{}"
	}
	if _, err := s.toolPolicies.UpsertToolPolicy(ctx, adminrepo.ToolPolicy{
		TenantID: tenantID, Subject: subject, Allowed: *req.Allowed,
		RiskOverride: risk, Config: cfg, UpdatedBy: updatedBy,
	}); err != nil {
		return nil, errx.From(err)
	}
	// agent.policy.updated 热更事件随 Agent 域消费方接线（阶段二，09 §5.2 登记）
	return s.AgentPolicy(ctx, tenantID)
}

// DeleteAgentToolPolicy 删行回落默认
func (s *Service) DeleteAgentToolPolicy(ctx context.Context, tenantID int64, subject string) (*adminapi.AgentPolicySnapshot, error) {
	if s.toolPolicies == nil {
		return nil, errx.New(errx.CodeInternal, "工具策略存储未装配")
	}
	if err := s.toolPolicies.DeleteToolPolicy(ctx, tenantID, strings.TrimSpace(subject)); err != nil {
		if err == adminrepo.ErrToolPolicyNotFound {
			return nil, errx.New(errx.CodeNotFound, "策略行不存在")
		}
		return nil, errx.From(err)
	}
	return s.AgentPolicy(ctx, tenantID)
}

// ── 敏感词（CRUD + 热更）──

// ListSensitiveWords 分页 + 全量计数
func (s *Service) ListSensitiveWords(ctx context.Context, tenantID int64, cursor, limit int64) (*adminapi.WordPage, error) {
	words, hasMore, err := s.store.ListSensitiveWords(ctx, tenantID, cursor, int(limit))
	if err != nil {
		return nil, errx.From(err)
	}
	total, _ := s.store.CountSensitiveWords(ctx, tenantID)
	page := &adminapi.WordPage{Items: make([]adminapi.SensitiveWord, 0, len(words)), Total: total, HasMore: hasMore}
	for _, w := range words {
		page.Items = append(page.Items, adminapi.SensitiveWord{
			ID: strconv.FormatInt(w.ID, 10), Word: w.Word, Mode: w.Mode,
			Category: w.Category, Enabled: w.Enabled,
			CreatedAt: w.CreatedAt.UTC().Format(time.RFC3339),
		})
		page.NextCursor = strconv.FormatInt(w.ID, 10)
	}
	if !hasMore || len(words) == 0 {
		page.NextCursor = ""
	}
	return page, nil
}

// AddSensitiveWord 新增（mode=1 拦截；写后 message 域即时生效——repo 缓存已失效）+ 审计
func (s *Service) AddSensitiveWord(ctx context.Context, tenantID, operatorID int64, word, category string) (*adminapi.SensitiveWord, error) {
	word = strings.TrimSpace(word)
	if word == "" {
		return nil, errx.New(errx.CodeBadRequest, "敏感词不能为空")
	}
	if len([]rune(word)) > 64 {
		return nil, errx.New(errx.CodeBadRequest, "敏感词过长（≤64 字）")
	}
	w, err := s.store.InsertSensitiveWord(ctx, adminrepo.SensitiveWord{
		TenantID: tenantID, Word: word, Mode: 1, Category: strings.TrimSpace(category),
		Enabled: true, CreatedBy: operatorID, CreatedAt: s.opts.Now(),
	})
	if err != nil {
		if err == adminrepo.ErrDupWord {
			return nil, errx.New(errx.CodeBadRequest, "该敏感词已存在")
		}
		return nil, errx.From(err)
	}
	_ = s.audit(ctx, tenantID, operatorID, "policy.sensitive_word.add",
		"sensitive_word:"+strconv.FormatInt(w.ID, 10),
		map[string]any{"word": word, "mode": 1, "category": category})
	return &adminapi.SensitiveWord{
		ID: strconv.FormatInt(w.ID, 10), Word: w.Word, Mode: w.Mode, Category: w.Category,
		Enabled: w.Enabled, CreatedAt: w.CreatedAt.UTC().Format(time.RFC3339),
	}, nil
}

// DeleteSensitiveWord 删除 + 审计
func (s *Service) DeleteSensitiveWord(ctx context.Context, tenantID, operatorID, id int64) error {
	if err := s.store.DeleteSensitiveWord(ctx, tenantID, id); err != nil {
		if err == adminrepo.ErrWordNotFound {
			return errx.New(errx.CodeNotFound, "敏感词不存在")
		}
		return errx.From(err)
	}
	_ = s.audit(ctx, tenantID, operatorID, "policy.sensitive_word.delete",
		"sensitive_word:"+strconv.FormatInt(id, 10), map[string]any{"word_id": id})
	return nil
}

// ── 用量 ──

// UsageSummary 近 N 日（默认 7，上限 30）日粒度 + tier/scene 汇总
func (s *Service) UsageSummary(ctx context.Context, tenantID int64, days int) (*adminapi.UsageSummary, error) {
	if days <= 0 {
		days = 7
	}
	if days > 30 {
		days = 30
	}
	if s.opts.UsageRows == nil {
		return &adminapi.UsageSummary{
			AsOf: s.opts.Now().UTC().Format(time.RFC3339), Days: days, Mode: s.opts.UsageMode,
			Daily: []adminapi.UsageDaily{}, ByTier: []adminapi.UsageByDim{}, ByScene: []adminapi.UsageByDim{},
		}, nil
	}
	rows, err := s.opts.UsageRows(ctx, tenantID, days)
	if err != nil {
		return nil, errx.From(err)
	}
	agg := aggregateDaily(rows)
	tierAgg, sceneAgg := map[string]*adminapi.UsageByDim{}, map[string]*adminapi.UsageByDim{}
	for _, r := range rows {
		t := tierAgg[r.Tier]
		if t == nil {
			t = &adminapi.UsageByDim{Key: r.Tier}
			tierAgg[r.Tier] = t
		}
		t.Requests += r.Requests
		t.TotalTokens += r.TotalTokens
		c := sceneAgg[r.Scene]
		if c == nil {
			c = &adminapi.UsageByDim{Key: r.Scene}
			sceneAgg[r.Scene] = c
		}
		c.Requests += r.Requests
		c.TotalTokens += r.TotalTokens
	}
	daily := make([]adminapi.UsageDaily, 0, len(agg))
	total := adminapi.UsageDaily{}
	for _, date := range sortedDates(agg) {
		d := agg[date]
		daily = append(daily, adminapi.UsageDaily{
			Date: date, Requests: d.requests,
			PromptTokens: d.prompt, CompletionTokens: d.completion, TotalTokens: d.tokens,
		})
		total.Requests += d.requests
		total.PromptTokens += d.prompt
		total.CompletionTokens += d.completion
		total.TotalTokens += d.tokens
	}
	return &adminapi.UsageSummary{
		AsOf:    s.opts.Now().UTC().Format(time.RFC3339),
		Days:    days,
		Mode:    s.opts.UsageMode,
		Daily:   daily,
		ByTier:  sortByKeyDesc(tierAgg),
		ByScene: sortByKeyDesc(sceneAgg),
		Total:   total,
	}, nil
}

// ── 审计 ──

// ListAudit 时间线（操作人名称解析 best-effort）
func (s *Service) ListAudit(ctx context.Context, tenantID int64, cursor, limit int64) (*adminapi.AuditPage, error) {
	actions, hasMore, err := s.store.ListAudit(ctx, tenantID, cursor, int(limit))
	if err != nil {
		return nil, errx.From(err)
	}
	page := &adminapi.AuditPage{Items: make([]adminapi.AuditItem, 0, len(actions)), HasMore: hasMore}
	for _, a := range actions {
		item := adminapi.AuditItem{
			ID: strconv.FormatInt(a.ID, 10), OperatorID: strconv.FormatInt(a.OperatorID, 10),
			Action: a.Action, Target: a.Target, CreatedAt: a.CreatedAt.UTC().Format(time.RFC3339),
			OperatorName: strconv.FormatInt(a.OperatorID, 10),
		}
		if u, err := s.same.GetUser(ctx, a.OperatorID); err == nil && u != nil {
			item.OperatorName = u.DisplayName
		}
		if len(a.Detail) > 0 {
			var d map[string]any
			if json.Unmarshal(a.Detail, &d) == nil {
				item.Detail = d
			}
		}
		page.Items = append(page.Items, item)
		page.NextCursor = strconv.FormatInt(a.ID, 10)
	}
	if !hasMore || len(actions) == 0 {
		page.NextCursor = ""
	}
	return page, nil
}

// audit 追加审计行（best-effort：审计失败不阻断业务操作，错误由调用方记日志）
func (s *Service) audit(ctx context.Context, tenantID, operatorID int64, action, target string, detail map[string]any) error {
	raw, _ := json.Marshal(detail)
	_, err := s.store.InsertAudit(ctx, adminrepo.AuditAction{
		TenantID: tenantID, OperatorID: operatorID, Action: action, Target: target,
		Detail: raw, CreatedAt: s.opts.Now(),
	})
	return err
}

// ── 聚合小工具 ──

type dailyAgg struct {
	requests   int64
	prompt     int64
	completion int64
	tokens     int64
}

// aggregateDaily 按日聚合（date "2006-01-02" → 汇总行；缺失日不补点——端侧简表直接渲染）
func aggregateDaily(rows []adminapi.UsageRow) map[string]*dailyAgg {
	agg := map[string]*dailyAgg{}
	for _, r := range rows {
		d, ok := agg[r.Date]
		if !ok {
			d = &dailyAgg{}
			agg[r.Date] = d
		}
		d.requests += r.Requests
		d.prompt += r.PromptTokens
		d.completion += r.CompletionTokens
		d.tokens += r.TotalTokens
	}
	return agg
}

// sortedDates 日期键升序
func sortedDates(agg map[string]*dailyAgg) []string {
	dates := make([]string, 0, len(agg))
	for k := range agg {
		dates = append(dates, k)
	}
	sort.Strings(dates)
	return dates
}

func sortByKeyDesc(m map[string]*adminapi.UsageByDim) []adminapi.UsageByDim {
	out := make([]adminapi.UsageByDim, 0, len(m))
	for _, v := range m {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TotalTokens > out[j].TotalTokens })
	return out
}

// toAdminUser org 用户 → 管理端行（ID 字符串化）
func toAdminUser(u orgapi.User) adminapi.AdminUser {
	return adminapi.AdminUser{
		ID: strconv.FormatInt(u.ID, 10), EmployeeNo: u.EmployeeNo,
		DisplayName: u.DisplayName, Email: u.Email, Status: u.Status, Scopes: nonNilScopes(u.Scopes),
	}
}

// nonNilScopes nil → 空切片（JSON [] 而非 null；Scopes 无 omitempty 的响应字段统一走此口径）
func nonNilScopes(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// rolesOfUser 用户角色引用聚合（ListUsers 行内角色列）；roles 未装配/查询失败/无角色
// 退空切片——AdminUser.Roles 无 omitempty，null 会炸前端 roles.filter（scopes 白屏同口径）。
func (s *Service) rolesOfUser(ctx context.Context, tenantID, userID int64) []adminapi.UserRoleRef {
	if s.roles == nil {
		return []adminapi.UserRoleRef{}
	}
	grants, err := s.roles.ListUserRoles(ctx, tenantID, userID)
	if err != nil {
		return []adminapi.UserRoleRef{}
	}
	out := make([]adminapi.UserRoleRef, 0, len(grants))
	for _, g := range grants {
		out = append(out, adminapi.UserRoleRef{RoleID: strconv.FormatInt(g.RoleID, 10), RoleName: g.RoleName})
	}
	return out
}

/* ── 角色与授权（PAD-08；权限点字典 v0.1 前端静态维护，服务端只校验格式） ── */

const maxRoleName = 50

func (s *Service) ListRoles(ctx context.Context, tenantID int64) ([]adminapi.RoleDTO, error) {
	if s.roles == nil {
		return []adminapi.RoleDTO{}, nil
	}
	roles, err := s.roles.ListRoles(ctx, tenantID)
	if err != nil {
		return nil, s.internal("角色列表读取失败")
	}
	counts, _ := s.roles.CountRoleUsers(ctx, tenantID)
	out := make([]adminapi.RoleDTO, 0, len(roles))
	for _, r := range roles {
		out = append(out, adminapi.RoleDTO{
			ID: r.ID, Name: r.Name, Description: r.Description,
			Permissions: r.Permissions, IsBuiltin: r.IsBuiltin,
			UserCount: counts[r.ID], CreatedAt: r.CreatedAt.UnixMilli(),
		})
	}
	return out, nil
}

func (s *Service) validateRole(name string, permissions []string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > maxRoleName {
		return errx.New(errx.CodeBadRequest, "角色名必填（≤50 字）")
	}
	if len(permissions) > 200 {
		return errx.New(errx.CodeBadRequest, "权限点 ≤200 项")
	}
	for _, p := range permissions {
		// RBAC 阶段二起收口权威字典（D12 §2.4）：字典外权限点拒绝保存
		if !adminapi.KnownPermPoint(p) {
			return errx.New(errx.CodeBadRequest, "权限点不在字典内（先在 D12 §2.4 登记）: "+p)
		}
		if strings.HasPrefix(p, "platform:") {
			return errx.New(errx.CodeBadRequest, "自定义角色不得含 platform:* 权限点（D12 §2.5）")
		}
	}
	return nil
}

func (s *Service) CreateRole(ctx context.Context, tenantID, operatorID int64, name, description string, permissions []string) (*adminapi.RoleDTO, error) {
	if s.roles == nil {
		return nil, s.internal("角色管理未装配")
	}
	if err := s.validateRole(name, permissions); err != nil {
		return nil, err
	}
	r, err := s.roles.InsertRole(ctx, adminrepo.Role{
		TenantID: tenantID, Name: strings.TrimSpace(name),
		Description: strings.TrimSpace(description), Permissions: permissions,
	})
	if err != nil {
		if err == adminrepo.ErrDupRole {
			return nil, errx.New(errx.CodeBadRequest, "同名角色已存在")
		}
		return nil, s.internal("角色创建失败")
	}
	_ = s.audit(ctx, tenantID, operatorID, "role.create", r.Name, map[string]any{"permissions": len(permissions)})
	return &adminapi.RoleDTO{
		ID: r.ID, Name: r.Name, Description: r.Description,
		Permissions: r.Permissions, CreatedAt: r.CreatedAt.UnixMilli(),
	}, nil
}

func (s *Service) UpdateRole(ctx context.Context, tenantID, operatorID, roleID int64, name, description string, permissions []string) error {
	if s.roles == nil {
		return s.internal("角色管理未装配")
	}
	if err := s.validateRole(name, permissions); err != nil {
		return err
	}
	if err := s.roles.UpdateRole(ctx, tenantID, roleID, strings.TrimSpace(name), strings.TrimSpace(description), permissions); err != nil {
		if err == adminrepo.ErrRoleGone {
			return errx.New(errx.CodeBadRequest, "角色不存在")
		}
		return s.internal("角色更新失败")
	}
	// 权限点变更 → 全部持有者收 perm.changed（03 篇 §4 实时生效；14 篇 §3.2 事件）
	if holders, err := s.roles.UserIDsOfRole(ctx, tenantID, roleID); err == nil {
		for _, uid := range holders {
			s.notifyPermChanged(tenantID, uid)
		}
	}
	return s.audit(ctx, tenantID, operatorID, "role.update", name, map[string]any{"permissions": len(permissions)})
}

// notifyPermChanged 向单用户推 perm.changed（NotifyUser 未装配=静默跳过）
func (s *Service) notifyPermChanged(tenantID, userID int64) {
	if s.opts.NotifyUser == nil {
		return
	}
	s.opts.NotifyUser(tenantID, userID, "perm.changed", map[string]any{"user_id": userID})
}

func (s *Service) DeleteRole(ctx context.Context, tenantID, operatorID, roleID int64) error {
	if s.roles == nil {
		return s.internal("角色管理未装配")
	}
	if err := s.roles.DeleteRole(ctx, tenantID, roleID); err != nil {
		switch err {
		case adminrepo.ErrBuiltinRole:
			return errx.New(errx.CodeBadRequest, "内置角色不可删除")
		case adminrepo.ErrRoleGone:
			return errx.New(errx.CodeBadRequest, "角色不存在")
		}
		return s.internal("角色删除失败")
	}
	return s.audit(ctx, tenantID, operatorID, "role.delete", "", map[string]any{"role_id": roleID})
}

func (s *Service) GrantRole(ctx context.Context, tenantID, operatorID, userID, roleID int64, scopeType int, scopeDeptID int64) error {
	if s.roles == nil {
		return s.internal("角色管理未装配")
	}
	// scope 校验（D10）：四档；2/3 须部门 ID；1/4 不携部门
	if scopeType == 0 {
		scopeType = 4
	}
	if scopeType < 1 || scopeType > 4 {
		return errx.New(errx.CodeBadRequest, "scope_type 合法值：1(本人) 2(本部门) 3(本部门及以下) 4(全租户)")
	}
	if (scopeType == 2 || scopeType == 3) && scopeDeptID <= 0 {
		return errx.New(errx.CodeBadRequest, "scope_type 2/3 须携带 scope_dept_id")
	}
	if scopeType == 1 || scopeType == 4 {
		scopeDeptID = 0
	}
	// 存在性校验（RBAC 阶段二补齐——防孤儿授权行：user_role 无 FK）
	if u, err := s.same.GetUser(ctx, userID); err != nil || u == nil || u.TenantID != tenantID {
		return errx.New(errx.CodeBadRequest, "用户不存在")
	}
	if roles, err := s.roles.ListRoles(ctx, tenantID); err == nil {
		found := false
		for _, r := range roles {
			if r.ID == roleID {
				found = true
				break
			}
		}
		if !found {
			return errx.New(errx.CodeBadRequest, "角色不存在")
		}
	}
	if err := s.roles.InsertUserRole(ctx, adminrepo.UserRole{
		TenantID: tenantID, UserID: userID, RoleID: roleID,
		ScopeType: scopeType, ScopeDeptID: scopeDeptID,
	}); err != nil {
		if err == adminrepo.ErrDupGrant {
			return errx.New(errx.CodeBadRequest, "该用户已拥有此角色")
		}
		return s.internal("授权失败")
	}
	s.notifyPermChanged(tenantID, userID)
	return s.audit(ctx, tenantID, operatorID, "role.grant", "", map[string]any{"user_id": userID, "role_id": roleID, "scope_type": scopeType, "scope_dept_id": scopeDeptID})
}

func (s *Service) RevokeRole(ctx context.Context, tenantID, operatorID, grantID int64) error {
	if s.roles == nil {
		return s.internal("角色管理未装配")
	}
	g, err := s.roles.GetUserRole(ctx, tenantID, grantID) // 先定位受影响用户（删除后不可查）
	if err != nil {
		return errx.New(errx.CodeBadRequest, "授权记录不存在")
	}
	if err := s.roles.DeleteUserRole(ctx, tenantID, grantID); err != nil {
		return errx.New(errx.CodeBadRequest, "授权记录不存在")
	}
	s.notifyPermChanged(tenantID, g.UserID)
	return s.audit(ctx, tenantID, operatorID, "role.revoke", "", map[string]any{"grant_id": grantID, "user_id": g.UserID})
}

func (s *Service) ListUserGrants(ctx context.Context, tenantID, userID int64) ([]adminapi.GrantDTO, error) {
	if s.roles == nil {
		return []adminapi.GrantDTO{}, nil
	}
	grants, err := s.roles.ListUserRoles(ctx, tenantID, userID)
	if err != nil {
		return nil, s.internal("授权列表读取失败")
	}
	out := make([]adminapi.GrantDTO, 0, len(grants))
	for _, g := range grants {
		out = append(out, adminapi.GrantDTO{
			ID: g.ID, UserID: g.UserID, RoleID: g.RoleID,
			RoleName: g.RoleName, CreatedAt: g.CreatedAt.UnixMilli(),
		})
	}
	return out, nil
}

/* ── 平台公告（PAD-15；发布=存档+全员通知广播 kind=announcement） ── */

func (s *Service) PublishNotice(ctx context.Context, tenantID, operatorID int64, title, content string) (*adminapi.NoticeDTO, error) {
	if s.notices == nil {
		return nil, s.internal("公告未装配")
	}
	title = strings.TrimSpace(title)
	content = strings.TrimSpace(content)
	if title == "" || len([]rune(title)) > 100 {
		return nil, errx.New(errx.CodeBadRequest, "标题必填（≤100 字）")
	}
	if content == "" || len([]rune(content)) > 4000 {
		return nil, errx.New(errx.CodeBadRequest, "正文必填（≤4000 字）")
	}
	// 全员触达：org 闭包取活跃用户 → message 域广播（kind=announcement 通知中心"系统公告"分组）
	reach := 0
	if s.opts.BroadcastNotice != nil {
		reach = s.opts.BroadcastNotice(ctx, tenantID, title, firstLine(content, 80))
	}
	n, err := s.notices.InsertNotice(ctx, adminrepo.Notice{
		TenantID: tenantID, Title: title, Content: content,
		CreatedBy: operatorID, Reach: reach,
	})
	if err != nil {
		return nil, s.internal("公告存档失败")
	}
	_ = s.audit(ctx, tenantID, operatorID, "notice.publish", title, map[string]any{"reach": reach})
	return &adminapi.NoticeDTO{
		ID: n.ID, Title: n.Title, Content: n.Content,
		CreatedBy: n.CreatedBy, Reach: n.Reach, CreatedAt: n.CreatedAt.UnixMilli(),
	}, nil
}

func (s *Service) ListNotices(ctx context.Context, tenantID int64, cursor int64, limit int) ([]adminapi.NoticeDTO, bool, error) {
	if s.notices == nil {
		return []adminapi.NoticeDTO{}, false, nil
	}
	rows, more, err := s.notices.ListNotices(ctx, tenantID, cursor, limit)
	if err != nil {
		return nil, false, s.internal("公告列表读取失败")
	}
	out := make([]adminapi.NoticeDTO, 0, len(rows))
	for _, n := range rows {
		out = append(out, adminapi.NoticeDTO{
			ID: n.ID, Title: n.Title, Content: n.Content,
			CreatedBy: n.CreatedBy, Reach: n.Reach, CreatedAt: n.CreatedAt.UnixMilli(),
		})
	}
	return out, more, nil
}

// firstLine 正文首行截断（通知 digest；rune 安全）
func firstLine(s string, max int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

/* ── 批量导入（PAD-06；v0.1 同步 ≤100 行/次；admin_task 异步化+初始口令首登改密阶段二登记） ── */

const maxImportRows = 100

func (s *Service) BatchImportUsers(ctx context.Context, tenantID, operatorID int64, rows []adminapi.ImportUserRow) (*adminapi.ImportResult, error) {
	if len(rows) == 0 {
		return nil, errx.New(errx.CodeBadRequest, "导入行为空")
	}
	if len(rows) > maxImportRows {
		return nil, errx.New(errx.CodeBadRequest, "单次 ≤100 行（更大批量走异步任务，阶段二）")
	}
	res := &adminapi.ImportResult{Rows: make([]adminapi.ImportRow, 0, len(rows))}
	seen := map[string]bool{}
	for i, r := range rows {
		row := adminapi.ImportRow{Row: i + 1, Empno: strings.TrimSpace(r.Empno), Name: strings.TrimSpace(r.Name)}
		switch {
		case row.Empno == "" || len(row.Empno) > 32:
			row.Reason = "工号非法（非空 ≤32）"
		case row.Name == "" || len([]rune(row.Name)) > 50:
			row.Reason = "姓名非法（非空 ≤50 字）"
		case seen[row.Empno]:
			row.Reason = "工号与本批次重复"
		default:
			seen[row.Empno] = true
			// 既有用户查重（UserReader——org 域读取通道）
			if u, err := s.same.GetUserByLogin(ctx, tenantID, row.Empno); err == nil && u != nil {
				row.Reason = "工号已存在"
				break
			}
			if s.opts.CreateUser == nil {
				row.Reason = "用户创建通道未装配"
				break
			}
			// 初始口令 = 工号 + 固定盐后缀（首登强制改密已接：must_change_password 置位；HashPassword 闭包注入）
			hash := ""
			if s.opts.HashPassword != nil {
				if h, herr := s.opts.HashPassword(row.Empno + "!BBC"); herr == nil {
					hash = h
				}
			}
			if _, cerr := s.opts.CreateUser(ctx, orgapi.User{
				TenantID: tenantID, Type: orgapi.UserTypeHuman, EmployeeNo: row.Empno,
				DisplayName: row.Name, Email: strings.TrimSpace(r.Email),
				PasswordHash: hash, Status: orgapi.UserStatusActive,
				Scopes: []string{"im:message:send"}, // 新用户基础权限（角色化随 RBAC 收口）
				MustChangePassword: true,            // D11：初始口令=工号+!BBC，首登强制改密
			}); cerr != nil {
				row.Reason = "创建失败：" + cerr.Error()
			} else {
				row.OK = true
			}
		}
		if row.OK {
			res.Created++
		} else {
			res.Failed++
		}
		res.Rows = append(res.Rows, row)
	}
	_ = s.audit(ctx, tenantID, operatorID, "users.import", "", map[string]any{"created": res.Created, "failed": res.Failed})
	return res, nil
}

/* ── 单建用户（2026-11-12 通讯录合并页：组织树上直接开人）── */

// pinyinBase 姓名→工号基名（实现抽至 platform/pinyinutil 供登录页搜人共用；此处薄委托）
func pinyinBase(name string) string {
	return pinyinutil.Pinyin(name)
}

// SuggestEmpno 工号建议：基名重名两位补零递增（zhangsan→zhangsan02→zhangsan03，
// 用户拍板口径；首号无后缀）。查重经 UserReader.GetByLogin（与导入同口径）。
func (s *Service) SuggestEmpno(ctx context.Context, tenantID int64, name string) (string, error) {
	base := pinyinBase(strings.TrimSpace(name))
	if base == "" {
		return "", errx.New(errx.CodeBadRequest, "姓名无法生成拼音工号（生僻字/纯符号），请手填")
	}
	// 后缀最多 2 位 + 字段上限 32 字符内
	if len(base) > 30 {
		base = base[:30]
	}
	for i := 0; i <= 98; i++ {
		cand := base
		if i > 0 {
			cand = fmt.Sprintf("%s%02d", base, i+1)
		}
		if u, err := s.same.GetUserByLogin(ctx, tenantID, cand); err != nil || u == nil {
			return cand, nil
		}
	}
	return "", errx.New(errx.CodeBadRequest, "同名工号已超 99 个，请手填")
}

// CreateUser 单建（工号空=自动建议；可选挂部门标主部门+授角色 scope=4；审计）。
// 部分失败语义（用户已建但挂靠/授权失败）：报错明示，用户已落库不回滚——低频管理操作可接受，登记。
func (s *Service) CreateUser(ctx context.Context, tenantID, operatorID int64, req adminapi.CreateUserReq) (*adminapi.AdminUser, error) {
	name := strings.TrimSpace(req.DisplayName)
	if name == "" || len([]rune(name)) > 50 {
		return nil, errx.New(errx.CodeBadRequest, "姓名非法（非空 ≤50 字）")
	}
	empno := strings.TrimSpace(req.EmployeeNo)
	if empno == "" {
		suggested, serr := s.SuggestEmpno(ctx, tenantID, name)
		if serr != nil {
			return nil, serr
		}
		empno = suggested
	} else if len(empno) > 32 {
		return nil, errx.New(errx.CodeBadRequest, "工号非法（非空 ≤32）")
	}
	if u, err := s.same.GetUserByLogin(ctx, tenantID, empno); err == nil && u != nil {
		return nil, errx.New(errx.CodeBadRequest, "工号已存在")
	}
	if s.opts.CreateUser == nil {
		return nil, s.internal("用户创建通道未装配")
	}
	// 初始口令 = 工号 + 固定盐后缀（批量导入同口径；首登强制改密）
	hash := ""
	if s.opts.HashPassword != nil {
		if h, herr := s.opts.HashPassword(empno + "!BBC"); herr == nil {
			hash = h
		}
	}
	created, cerr := s.opts.CreateUser(ctx, orgapi.User{
		TenantID: tenantID, Type: orgapi.UserTypeHuman, EmployeeNo: empno,
		DisplayName: name, Email: strings.TrimSpace(req.Email),
		PasswordHash: hash, Status: orgapi.UserStatusActive,
		Scopes:            []string{"im:message:send"}, // 与导入同口径（角色化随 RBAC 收口）
		MustChangePassword: true,
	})
	if cerr != nil {
		return nil, errx.New(errx.CodeBadRequest, "创建失败："+cerr.Error())
	}
	if req.DeptID > 0 {
		if s.opts.AttachDeptMember == nil {
			return nil, s.internal("部门挂靠通道未装配")
		}
		if aerr := s.opts.AttachDeptMember(ctx, tenantID, created.ID, req.DeptID, true); aerr != nil {
			return nil, errx.New(errx.CodeBadRequest, "用户已建但挂部门失败："+aerr.Error())
		}
	}
	if req.RoleID > 0 {
		if gerr := s.GrantRole(ctx, tenantID, operatorID, created.ID, req.RoleID, 4, 0); gerr != nil {
			return nil, errx.New(errx.CodeBadRequest, "用户已建但授权失败："+gerr.Error())
		}
	}
	_ = s.audit(ctx, tenantID, operatorID, "user.create", "user:"+strconv.FormatInt(created.ID, 10),
		map[string]any{"employee_no": empno, "dept_id": req.DeptID, "role_id": req.RoleID})
	au := toAdminUser(created)
	return &au, nil
}

/* ── Agent 治理（PAD-14；v0.1：计量聚合视图+令牌吊销+总闸内存态） ── */

// AgentUsageRow 计量闭包输入（main 从 aigw Meter Snapshot 聚合）
type AgentUsageRow struct {
	UserID   int64
	Requests int64
	Tokens   int64
	Sessions int
	LastHour int64 // ms
}

func (s *Service) ListAgentUsers(ctx context.Context, tenantID int64) ([]adminapi.AgentUserRow, error) {
	if s.opts.AgentUsage == nil {
		return []adminapi.AgentUserRow{}, nil
	}
	rows := s.opts.AgentUsage(tenantID)
	out := make([]adminapi.AgentUserRow, 0, len(rows))
	for _, r := range rows {
		name := ""
		if u, err := s.same.GetUser(ctx, r.UserID); err == nil && u != nil {
			name = u.DisplayName
		}
		out = append(out, adminapi.AgentUserRow{
			UserID: r.UserID, Name: name,
			Requests: r.Requests, Tokens: r.Tokens, Sessions: r.Sessions, LastHour: r.LastHour,
		})
	}
	return out, nil
}

func (s *Service) RevokeAgentAccess(ctx context.Context, tenantID, operatorID, userID int64) error {
	if userID <= 0 {
		return errx.New(errx.CodeBadRequest, "user_id 非法")
	}
	// 通道一：吊销全部会话令牌（refresh+OBO——auth 域 Logout all）
	if s.opts.RevokeSessions != nil {
		if err := s.opts.RevokeSessions(ctx, userID); err != nil {
			return s.internal("令牌吊销失败")
		}
	}
	// 通道二：踢线（活跃 WS 断开，Agent 宿主 OboCache 续签即失败）
	kicked := 0
	if s.opts.KickUser != nil {
		kicked = s.opts.KickUser(userID)
	}
	return s.audit(ctx, tenantID, operatorID, "agent.revoke", "", map[string]any{
		"user_id": userID, "kicked": kicked,
	})
}

func (s *Service) AgentKillswitch(_ context.Context, tenantID, operatorID int64, on bool) (bool, error) {
	s.agentKillMu.Lock()
	prev := s.agentKill
	if operatorID > 0 { // operatorID=0 查询态（不审计不改）
		s.agentKill = on
	}
	s.agentKillMu.Unlock()
	if operatorID > 0 && prev != on {
		_ = s.audit(context.Background(), tenantID, operatorID, "agent.killswitch", "", map[string]any{"on": on})
	}
	return s.agentKill, nil
}

// AgentKillOn 总闸状态读（生效路径阶段二：OBO 签发/aigw scene 闸门接入，登记）
func (s *Service) AgentKillOn() bool {
	s.agentKillMu.Lock()
	defer s.agentKillMu.Unlock()
	return s.agentKill
}

/* ── KB 治理总览（PAD-10；v0.1 只读——空间停用/删除随 D07 敏感治理阶段二登记） ── */

// KBSpaceClosure 闭包输入（main 从 kb repo 全量组装；D02 §4 admin 不引 kb 包）
type KBSpaceClosure struct {
	ID, OwnerID, DocCount, Quota, Used int64
	Type, Name                         string
	Status    string
}

func (s *Service) ListKBSpaces(_ context.Context, _ int64) ([]adminapi.KBSpaceRow, error) {
	if s.opts.KBSpaces == nil {
		return []adminapi.KBSpaceRow{}, nil
	}
	rows := s.opts.KBSpaces()
	out := make([]adminapi.KBSpaceRow, 0, len(rows))
	for _, r := range rows {
		owner := ""
		if u, err := s.same.GetUser(context.Background(), r.OwnerID); err == nil && u != nil {
			owner = u.DisplayName
		}
		out = append(out, adminapi.KBSpaceRow{
			ID: r.ID, Type: r.Type, Name: r.Name, Status: r.Status,
			OwnerID: r.OwnerID, OwnerName: owner,
			DocCount: r.DocCount, QuotaBytes: r.Quota, UsedBytes: r.Used,
		})
	}
	return out, nil
}

// SetKBSpaceStatus 停用/启用（D8；闭包 nil=治理未装配）
func (s *Service) SetKBSpaceStatus(ctx context.Context, tenantID, spaceID int64, archived bool) error {
	if s.opts.KBGovern == nil {
		return errx.New(errx.CodeInternal, "KB 治理未装配")
	}
	return s.opts.KBGovern(ctx, tenantID, spaceID, archived, false)
}

// DeleteKBSpace 删除（级联；personal 7010 由 kb 域拒）
func (s *Service) DeleteKBSpace(ctx context.Context, tenantID, spaceID int64) error {
	if s.opts.KBGovern == nil {
		return errx.New(errx.CodeInternal, "KB 治理未装配")
	}
	return s.opts.KBGovern(ctx, tenantID, spaceID, false, true)
}
