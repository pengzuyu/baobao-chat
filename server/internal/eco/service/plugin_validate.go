// 插件包校验器（D22 §3.3 / L1：服务端发布第一道；客户端落盘前复跑同规则）。
//
// 职责：zip → manifest 快照（组件统计/权限声明）。全部规则：
//   - 包 ≤10MB；
//   - 清单三目录名识别（.bbc-plugin 优先 → .claude-plugin → .zcode-plugin），
//     兼容「顶层单目录 / 根即内容」两种打包形态；
//   - name/version/description 规则（同 skill 口径）；
//   - 全条目 zip slip 检查（.. / 绝对路径拒绝）；
//   - 组件目录存在性（显式声明优先，缺省扫默认目录）；
//   - .mcp.json（或内联 mcpServers 对象）可解析、server 名合法、stdio 有
//     command / HTTP 有 url；
//   - hooks.json 可解析（不执行）；
//   - 身份使用探测（${BBC_USER_TOKEN}）与 config 声明收集（安装确认页语料）。
package ecoservice

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"

	errx "github.com/baobaochat/server/internal/platform/errors"
)

// PluginMaxPackageBytes 包体上限（D22 §3.1）
const PluginMaxPackageBytes = 10 << 20

// PluginComponents 组件统计（manifest 快照）
type PluginComponents struct {
	Skills     int  `json:"skills"`
	McpServers int  `json:"mcpServers"`
	Commands   int  `json:"commands"`
	Agents     int  `json:"agents"`
	Hooks      bool `json:"hooks"`
}

// PluginManifest 校验器产出的清单快照（存 pkg/version.manifest 列）
type PluginManifest struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Components  PluginComponents `json:"components"`
	Risk        string   `json:"risk,omitempty"`      // low|medium|high（bbc.risk）
	Category    string   `json:"category,omitempty"`   // bbc.category（pkg 元数据同步）
	NetAllow    []string `json:"netAllow,omitempty"`   // v0.1 仅展示
	UsesIdentity bool   `json:"usesIdentity"`          // .mcp.json 出现 ${BBC_USER_TOKEN} 或声明 x-bbc-auth（D38）
	// AuthAudiences 统一身份受众清单（D38 §5：x-bbc-auth 声明的 server url——
	// 安装确认页明示「将以你的身份访问…」的目的地）
	AuthAudiences []string `json:"authAudiences,omitempty"`
	ConfigKeys  []string `json:"configKeys,omitempty"` // bbc.config 声明（详情页配置表单）
	// ConfigSecrets secret 型配置键（L4：客户端分流钥匙串存储的判定依据）
	ConfigSecrets []string `json:"configSecrets,omitempty"`
}

// pluginJSONRaw plugin.json 原始形态（组件字段 string=路径；mcpServers 两态）
type pluginJSONRaw struct {
	Name        string          `json:"name"`
	Version     string          `json:"version"`
	Description string          `json:"description"`
	Author      json.RawMessage `json:"author"`
	Skills      json.RawMessage `json:"skills"`
	Commands    json.RawMessage `json:"commands"`
	Agents      json.RawMessage `json:"agents"`
	McpServers  json.RawMessage `json:"mcpServers"` // string=路径 | object=内联
	Hooks       json.RawMessage `json:"hooks"`
	BBC         *struct {
		Risk     string   `json:"risk"`
		Category string   `json:"category"`
		NetAllow []string `json:"netAllow"`
		Config   []struct {
			Key      string `json:"key"`
			Label    string `json:"label"`
			Type     string `json:"type"`
			Required bool   `json:"required"`
		} `json:"config"`
	} `json:"bbc"`
}

// mcpJSONRaw .mcp.json 形态：{"mcpServers": {name: {command|url,...}}}
type mcpJSONRaw struct {
	McpServers map[string]json.RawMessage `json:"mcpServers"`
}

type mcpServerRaw struct {
	Command string            `json:"command"`
	URL     string            `json:"url"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Headers map[string]string `json:"headers"`
	// XBbcAuth 统一身份声明（D38 §5：{"type":"obo","scope":[...]}；仅 HTTP 可声明）
	XBbcAuth json.RawMessage `json:"x-bbc-auth"`
}

var (
	rePluginID    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	reMcpServerID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
	reIdentityVar = regexp.MustCompile(`\$\{BBC_USER_(?:TOKEN|ID|NAME)\}`)
)

// manifestDirs 清单识别顺序（D22 §0 决策 1：三名都认，bbc 优先）
var manifestDirs = []string{".bbc-plugin", ".claude-plugin", ".zcode-plugin"}

// validatePluginPackage 校验 zip 包并产出 manifest 快照与组件路径集合。
// 返回（快照、组件文件清单——供客户端复跑对照，err）。
func validatePluginPackage(pkg []byte) (*PluginManifest, []string, error) {
	if len(pkg) > PluginMaxPackageBytes {
		return nil, nil, errx.New(errx.CodeBadRequest, fmt.Sprintf("包体超限（>%dMB）", PluginMaxPackageBytes>>20))
	}
	zr, err := zip.NewReader(bytes.NewReader(pkg), int64(len(pkg)))
	if err != nil {
		return nil, nil, errx.New(errx.CodeBadRequest, "zip 解析失败: "+err.Error())
	}
	files := map[string][]byte{} // 清洗后名 → 内容（小文件全载，包 ≤10MB）
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := path.Clean(f.Name)
		if strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") || name == ".." ||
			strings.Contains(f.Name, "\\") {
			return nil, nil, errx.New(errx.CodeBadRequest, "包内路径非法（zip slip）: "+f.Name)
		}
		if len(name) > 255 {
			return nil, nil, errx.New(errx.CodeBadRequest, "包内路径过长: "+f.Name)
		}
		rc, oerr := f.Open()
		if oerr != nil {
			return nil, nil, errx.New(errx.CodeBadRequest, "包内文件读取失败: "+f.Name)
		}
		data, rerr := io.ReadAll(io.LimitReader(rc, PluginMaxPackageBytes))
		rc.Close()
		if rerr != nil {
			return nil, nil, errx.New(errx.CodeBadRequest, "包内文件读取失败: "+f.Name)
		}
		files[name] = data
	}

	// 清单识别（兼容顶层单目录：dir/.bbc-plugin/plugin.json 或根 .bbc-plugin/plugin.json）
	base := ""
	var raw pluginJSONRaw
	found := false
	tryLoad := func(name string) error {
		data, ok := files[name]
		if !ok {
			return nil // 未命中不动 found
		}
		var perr error
		raw, perr = parsePluginJSON(data)
		if perr != nil {
			return perr
		}
		found = true
		return nil
	}
	for _, dir := range manifestDirs {
		if err := tryLoad(dir + "/plugin.json"); err != nil || found {
			if err != nil {
				return nil, nil, err
			}
			break
		}
		// 单顶层目录形态：<dir>/.{x}-plugin/plugin.json
		for name := range files {
			parts := strings.SplitN(name, "/", 3)
			if len(parts) == 3 && parts[1] == dir && parts[2] == "plugin.json" {
				if err := tryLoad(name); err != nil {
					return nil, nil, err
				}
				base = parts[0]
				break
			}
		}
		if found {
			break
		}
	}
	if !found {
		return nil, nil, errx.New(errx.CodeBadRequest,
			"未找到插件清单（.bbc-plugin/.claude-plugin/.zcode-plugin/plugin.json 任一）")
	}

	m := &PluginManifest{Name: raw.Name, Version: raw.Version, Description: raw.Description}
	if !rePluginID.MatchString(m.Name) {
		return nil, nil, errx.New(errx.CodeBadRequest, "name 非法（小写字母数字与 . _ -，≤64，字母数字开头）")
	}
	if !validSemver(m.Version) {
		return nil, nil, errx.New(errx.CodeBadRequest, "version 须语义化（x.y.z）")
	}
	if strings.TrimSpace(m.Description) == "" {
		return nil, nil, errx.New(errx.CodeBadRequest, "description 必填")
	}
	if len([]rune(m.Description)) > 200 {
		return nil, nil, errx.New(errx.CodeBadRequest, "description ≤200 字")
	}

	join := func(p string) string {
		if base != "" {
			return base + "/" + strings.TrimPrefix(p, "./")
		}
		return strings.TrimPrefix(p, "./")
	}

	// 组件目录解析（显式声明优先；缺省默认目录）
	skillDir, cmdDir, agentDir := "skills", "commands", "agents"
	if s := rawString(raw.Skills); s != "" {
		skillDir = s
	}
	if s := rawString(raw.Commands); s != "" {
		cmdDir = s
	}
	if s := rawString(raw.Agents); s != "" {
		agentDir = s
	}

	// skills/commands/agents 计数（声明目录存在性校验：显式声明但目录空 → 拒）
	// 形态：skills 为 `<dir>/SKILL.md` 或 `<dir>/<name>/SKILL.md`（一层子目录——
	// Claude 生态标准形态）；commands/agents 为 `<dir>/*.md`（不嵌套）
	componentFiles := []string{}
	countGlob := func(dir string, suffix string, explicit bool, nested bool) int {
		n := 0
		prefix := join(dir) + "/"
		for name := range files {
			if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
				continue
			}
			rest := strings.TrimPrefix(name, prefix)
			depth := strings.Count(rest, "/")
			ok := depth == 0 || (nested && depth == 1)
			if ok {
				n++
				componentFiles = append(componentFiles, name)
			}
		}
		if explicit && n == 0 {
			return -1
		}
		return n
	}
	if n := countGlob(skillDir, "SKILL.md", rawString(raw.Skills) != "", true); n < 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "声明的 skills 目录缺失或为空: "+skillDir)
	} else {
		m.Components.Skills = n
	}
	if n := countGlob(cmdDir, ".md", rawString(raw.Commands) != "", false); n < 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "声明的 commands 目录缺失或为空: "+cmdDir)
	} else {
		m.Components.Commands = n
	}
	if n := countGlob(agentDir, ".md", rawString(raw.Agents) != "", false); n < 0 {
		return nil, nil, errx.New(errx.CodeBadRequest, "声明的 agents 目录缺失或为空: "+agentDir)
	} else {
		m.Components.Agents = n
	}

	// MCP：内联对象或路径（缺省 .mcp.json）
	authAudiences := []string{} // D38：x-bbc-auth 受众收集（确认页目的地语料）
	mcpRaw := raw.McpServers
	if s := rawString(mcpRaw); s != "" {
		data, ok := files[join(s)]
		if !ok {
			return nil, nil, errx.New(errx.CodeBadRequest, "声明的 mcpServers 文件缺失: "+s)
		}
		mcpRaw = json.RawMessage(data)
		componentFiles = append(componentFiles, join(s))
	} else if mcpRaw == nil {
		if data, ok := files[join(".mcp.json")]; ok {
			mcpRaw = json.RawMessage(data)
			componentFiles = append(componentFiles, join(".mcp.json"))
		}
	}
	mcpText := string(mcpRaw)
	if mcpRaw != nil {
		// 两种形态：.mcp.json 文件（{"mcpServers":{...}} 包裹）或 plugin.json
		// 内联（字段值即 servers map 本体）
		servers := parseMcpServers(mcpRaw)
		if servers == nil {
			return nil, nil, errx.New(errx.CodeBadRequest, "MCP 定义解析失败")
		}
		if len(servers) == 0 {
			return nil, nil, errx.New(errx.CodeBadRequest, "MCP 定义须含至少一个 server（mcpServers）")
		}
		for name, body := range servers {
			if !reMcpServerID.MatchString(name) {
				return nil, nil, errx.New(errx.CodeBadRequest, "MCP server 名非法: "+name)
			}
			var srv mcpServerRaw
			if err := json.Unmarshal(body, &srv); err != nil {
				return nil, nil, errx.New(errx.CodeBadRequest, "MCP server "+name+" 定义非法: "+err.Error())
			}
			if srv.Command == "" && srv.URL == "" {
				return nil, nil, errx.New(errx.CodeBadRequest, "MCP server "+name+" 须含 command（stdio）或 url（HTTP）")
			}
			if srv.URL != "" && !strings.HasPrefix(srv.URL, "http://") && !strings.HasPrefix(srv.URL, "https://") {
				return nil, nil, errx.New(errx.CodeBadRequest, "MCP server "+name+" url 须 http(s)://")
			}
			// D38 拍板 5：url 只许打包写死——禁止引用任何变量（票不可被引到用户可控地址）
			if srv.URL != "" && strings.Contains(srv.URL, "${") {
				return nil, nil, errx.New(errx.CodeBadRequest,
					"MCP server "+name+" url 禁止引用变量（只许打包写死——D38 拍板 5）")
			}
			// x-bbc-auth 结构校验（D38 §5）：type=obo；stdio 不可声明（拍板 8）
			if len(srv.XBbcAuth) > 0 && string(srv.XBbcAuth) != "null" {
				if srv.Command != "" {
					return nil, nil, errx.New(errx.CodeBadRequest,
						"MCP server "+name+" 为 stdio 形态不可声明 x-bbc-auth（D38：stdio 永不需要令牌）")
				}
				var auth struct {
					Type  string   `json:"type"`
					Scope []string `json:"scope"`
				}
				if err := json.Unmarshal(srv.XBbcAuth, &auth); err != nil {
					return nil, nil, errx.New(errx.CodeBadRequest, "MCP server "+name+" x-bbc-auth 解析失败: "+err.Error())
				}
				if auth.Type != "obo" {
					return nil, nil, errx.New(errx.CodeBadRequest, "MCP server "+name+" x-bbc-auth.type 仅支持 obo")
				}
				if srv.URL != "" {
					authAudiences = append(authAudiences, srv.URL)
				}
			}
		}
		m.Components.McpServers = len(servers)
	}
	// 身份使用探测（D38 批6）：旧 ${BBC_USER_TOKEN} 占位 或 x-bbc-auth 声明
	m.UsesIdentity = reIdentityVar.MatchString(mcpText) || len(authAudiences) > 0
	m.AuthAudiences = authAudiences

	// hooks：可解析即过（不执行）
	if s := rawString(raw.Hooks); s != "" {
		if data, ok := files[join(s)]; ok {
			if !json.Valid(data) {
				return nil, nil, errx.New(errx.CodeBadRequest, "hooks 文件非合法 JSON: "+s)
			}
			m.Components.Hooks = true
		} else {
			return nil, nil, errx.New(errx.CodeBadRequest, "声明的 hooks 文件缺失: "+s)
		}
	} else if data, ok := files[join("hooks/hooks.json")]; ok {
		if !json.Valid(data) {
			return nil, nil, errx.New(errx.CodeBadRequest, "hooks/hooks.json 非合法 JSON")
		}
		m.Components.Hooks = true
	}

	// bbc 扩展块
	if raw.BBC != nil {
		m.Risk = raw.BBC.Risk
		switch m.Risk {
		case "", "low", "medium", "high":
		default:
			return nil, nil, errx.New(errx.CodeBadRequest, "bbc.risk ∈ low|medium|high")
		}
		m.Category = raw.BBC.Category
		m.NetAllow = raw.BBC.NetAllow
		for _, c := range raw.BBC.Config {
			if !reMcpServerID.MatchString(c.Key) {
				return nil, nil, errx.New(errx.CodeBadRequest, "bbc.config key 非法: "+c.Key)
			}
			if c.Type != "" && c.Type != "secret" && c.Type != "string" {
				return nil, nil, errx.New(errx.CodeBadRequest, "bbc.config type ∈ secret|string: "+c.Key)
			}
			m.ConfigKeys = append(m.ConfigKeys, c.Key)
			if c.Type == "secret" {
				m.ConfigSecrets = append(m.ConfigSecrets, c.Key)
			}
		}
	}

	// 至少携带一类组件（空插件拒绝）
	if m.Components.Skills+m.Components.McpServers+m.Components.Commands+m.Components.Agents == 0 && !m.Components.Hooks {
		return nil, nil, errx.New(errx.CodeBadRequest, "插件未携带任何组件（skills/工具/命令/专家/hooks 至少其一）")
	}
	return m, componentFiles, nil
}

func parsePluginJSON(data []byte) (pluginJSONRaw, error) {
	var raw pluginJSONRaw
	if err := json.Unmarshal(data, &raw); err != nil {
		return raw, errx.New(errx.CodeBadRequest, "plugin.json 解析失败: "+err.Error())
	}
	return raw, nil
}

// parseMcpServers 两形态归一：文件形态（{"mcpServers":{...}}）→ 内联形态
// （servers map 本体）；解析失败返回 nil
func parseMcpServers(raw json.RawMessage) map[string]json.RawMessage {
	var doc mcpJSONRaw
	if err := json.Unmarshal(raw, &doc); err == nil && len(doc.McpServers) > 0 {
		return doc.McpServers
	}
	var inline map[string]json.RawMessage
	if err := json.Unmarshal(raw, &inline); err == nil && len(inline) > 0 {
		// 内联形态：值须都是对象（server 定义）；混入标量视为解析失败
		for _, v := range inline {
			trimmed := strings.TrimSpace(string(v))
			if !strings.HasPrefix(trimmed, "{") {
				return nil
			}
		}
		return inline
	}
	return nil
}

// rawString JSON 字段为字符串时取值（其他形态返回空）
func rawString(v json.RawMessage) string {
	if len(v) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}
