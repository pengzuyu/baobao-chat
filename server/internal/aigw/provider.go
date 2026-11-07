// Package aigw AI 网关域（docs/19）：模型流量唯一出入口。
// 本文件：供应商适配层——Provider 抽象 + mock（开发/联调/E2E）与
// openai_compatible（真实上游 HTTP 透传，密钥经环境注入）两实现。
package aigw

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strings"
	"time"
)

// ChatMessage OpenAI 兼容消息（透传形态；网关只读不组装，§1.2-6）
type ChatMessage struct {
	Role       string         `json:"role"`
	Content    any            `json:"content"` // string 或分段数组（透传）
	ToolCalls  []ToolCallMsg  `json:"tool_calls,omitempty"`
	ToolCallID string         `json:"tool_call_id,omitempty"`
	Name       string         `json:"name,omitempty"`
	Raw        map[string]any `json:"-"`
}

// ToolCallMsg 工具调用（assistant 消息内）
type ToolCallMsg struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
	Index *int `json:"index,omitempty"` // 流式增量槽位
}

// ChatRequest 入口请求（OpenAI 兼容子集）
type ChatRequest struct {
	Model       string           `json:"model"`
	Messages    []ChatMessage    `json:"messages"`
	Tools       []map[string]any `json:"tools,omitempty"`
	Stream      *bool            `json:"stream,omitempty"`
	Temperature *float64         `json:"temperature,omitempty"`
	MaxTokens   *int             `json:"max_tokens,omitempty"`
}

// UsageOpenAI OpenAI usage 形态（网关终帧口径）
type UsageOpenAI struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ProviderResult 一次供应商调用结果：SSE 原始帧（data: 行内容，去掉前缀）按序产出 + usage
type ProviderResult struct {
	// Frames 逐帧产出（已是 OpenAI chunk JSON 或 [DONE]；channel 由实现关闭）
	Frames <-chan string
	Usage  *UsageOpenAI // 非流式/终帧 usage（nil=未知，计量按估算）
	Err    error
}

// Provider 供应商适配器（§3.1 适配层；kind 决定实现）
type Provider interface {
	ID() int64
	Name() string
	Kind() string
	// StreamChat 流式对话：resp 载荷经 frames 透传（含 [DONE] 由网关补，实现可不发）
	StreamChat(ctx context.Context, req *ChatRequest) *ProviderResult
	// Embed 维度固定 1024（01 篇冻结）；v0.1 仅 mock 实现
	Embed(ctx context.Context, input []string) ([][]float32, *UsageOpenAI, error)
}

// ---- mock 供应商（echo-agent 启发式；开发/联调/E2E 专用）----

// MockProvider 行为：上下文含工具结果 → 总结收尾；用户消息含文件名且未执行过 →
// 发起 read_file 工具调用；否则回显式应答。全流程确定性，供 bbrt 端到端联调。
type MockProvider struct {
	id   int64
	name string
}

// NewMockProvider 构造
func NewMockProvider(id int64, name string) *MockProvider { return &MockProvider{id: id, name: name} }

// ID 供应商标识
func (m *MockProvider) ID() int64 { return m.id }

// Name 名称
func (m *MockProvider) Name() string { return m.name }

// Kind 适配类型
func (m *MockProvider) Kind() string { return "mock" }

func estimateTokens(msgs []ChatMessage) int {
	n := 0
	for _, msg := range msgs {
		switch v := msg.Content.(type) {
		case string:
			n += len([]rune(v))
		case fmt.Stringer:
			n += len([]rune(v.String()))
		}
		for _, tc := range msg.ToolCalls {
			n += len([]rune(tc.Function.Name)) + len([]rune(tc.Function.Arguments))
		}
	}
	if n < 8 {
		return 8
	}
	return n
}

// StreamChat 启发式剧本
func (m *MockProvider) StreamChat(_ context.Context, req *ChatRequest) *ProviderResult {
	promptTokens := estimateTokens(req.Messages)
	frames := make(chan string, 16)
	usage := &UsageOpenAI{}
	res := &ProviderResult{Frames: frames, Usage: usage}
	go func() {
		defer close(frames)
		var lastUser, lastTool string
		for i := len(req.Messages) - 1; i >= 0; i-- {
			msg := req.Messages[i]
			if msg.Role == "user" && lastUser == "" {
				if s, ok := msg.Content.(string); ok {
					lastUser = s
				}
			}
			if msg.Role == "tool" && lastTool == "" {
				if s, ok := msg.Content.(string); ok {
					lastTool = s
				}
			}
		}
		emitText := func(text string, finish string) {
			frames <- fmt.Sprintf(`{"choices":[{"delta":{"content":%s},"index":0}]}`, mustJSONString(text))
			usage.CompletionTokens += len([]rune(text))
			frames <- fmt.Sprintf(`{"choices":[{"delta":{},"finish_reason":%s,"index":0}],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`,
				mustJSONString(finish), promptTokens, usage.CompletionTokens, promptTokens+usage.CompletionTokens)
			usage.PromptTokens = promptTokens
			usage.TotalTokens = promptTokens + usage.CompletionTokens
		}
		switch {
		case lastTool != "":
			// 已有工具结果：收尾作答（引用结果原文，确定性）
			emitText(fmt.Sprintf("根据工具结果：%s", firstLine(lastTool)), "stop")
		case fileOf(lastUser) != "" && len(req.Tools) > 0:
			// 用户提到文件且声明了工具：发起 read_file
			path := fileOf(lastUser)
			frames <- fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-mock-1","type":"function","function":{"name":"read_file","arguments":""}}]},"index":0}]}`)
			// 帧结构逐层闭合：function} tool_call} tool_calls] delta} choice{"index"} choices] root}
			frames <- fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":%s}}]},"index":0}]}`, mustJSONString(mustJSONStringMap("path", path)))
			usage.CompletionTokens += 24
			frames <- fmt.Sprintf(`{"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":%d,"completion_tokens":%d,"total_tokens":%d}}`,
				promptTokens, usage.CompletionTokens, promptTokens+usage.CompletionTokens)
			usage.PromptTokens = promptTokens
			usage.TotalTokens = promptTokens + usage.CompletionTokens
		default:
			emitText(fmt.Sprintf("[mock:%s] 已收到 %d 条消息。", m.name, len(req.Messages)), "stop")
		}
	}()
	return res
}

// Embed 确定性 1024 维向量（HMAC 哈希展开；仅联调用，语义无意义）
func (m *MockProvider) Embed(_ context.Context, input []string) ([][]float32, *UsageOpenAI, error) {
	out := make([][]float32, 0, len(input))
	for _, s := range input {
		out = append(out, mockEmbedOne(s))
	}
	tokens := 0
	for _, s := range input {
		tokens += len([]rune(s))
	}
	return out, &UsageOpenAI{PromptTokens: tokens, TotalTokens: tokens}, nil
}

// mockEmbedOne 词袋嵌入：分词（CJK 2-gram + ASCII 词）→ 每词 HMAC 定维累加 → L2 归一化。
// 语义性质：共享词汇的文本余弦相似度高（查询与文档重叠词越多越靠前）——
// KB 自检索（摄入 mock 向量→query mock 向量→pgvector 排序）因此真实可测；
// 完全不同的文本向量近正交（词袋不相交）。HMAC 确定性：同文本同向量。
func mockEmbedOne(s string) []float32 {
	vec := make([]float32, 1024)
	add := func(tok string, weight float32) {
		mac := hmac.New(sha256.New, []byte("bbw-embed-mock"))
		mac.Write([]byte(tok))
		sum := mac.Sum(nil)
		dim := binary.BigEndian.Uint32(sum[4:8]) % 1024
		vec[dim] += weight
	}
	runes := []rune(strings.ToLower(s))
	var ascii strings.Builder
	flushASCII := func() {
		if ascii.Len() > 0 {
			add(ascii.String(), 2.0) // 完整 ASCII 词权重高于 CJK 2-gram
			ascii.Reset()
		}
	}
	for i, r := range runes {
		if r < 128 && !isSpaceASCII(byte(r)) {
			ascii.WriteRune(r)
			continue
		}
		flushASCII()
		if r >= 0x4e00 && r <= 0x9fff && i+1 < len(runes) && runes[i+1] >= 0x4e00 && runes[i+1] <= 0x9fff {
			add(string(runes[i:i+2]), 1.0) // CJK bigram
		}
	}
	flushASCII()
	var norm float64
	for _, v := range vec {
		norm += float64(v) * float64(v)
	}
	if norm > 0 {
		sqrt := float32(math.Sqrt(norm))
		for i := range vec {
			vec[i] /= sqrt
		}
	}
	return vec
}

func isSpaceASCII(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', ',', '.', '!', '?', ';', ':', '"', '\'', '(', ')', '[', ']', '{', '}', '<', '>', '/', '\\', '|', '@', '#', '$', '%', '^', '&', '*', '+', '=', '~', '`':
		return true
	}
	return false
}

// ---- openai_compatible 供应商（真实上游透传）----

// OpenAICompatConfig 环境装配：BBW_AIGW_OPENAI_BASE / _KEY / _MODELS("strong=glm-4.7,fast=glm-4.7-air")
type OpenAICompatConfig struct {
	BaseURL string            // 如 https://open.bigmodel.cn/api/paas/v4
	APIKey  string            // 网关侧持有（§1.2-2），仅环境注入不落库
	Models  map[string]string // 档位 → 上游具体模型名
}

// OpenAICompatProvider HTTP 透传实现（SSE 原样回传）
type OpenAICompatProvider struct {
	IDOf   int64
	NameOf string
	Cfg    OpenAICompatConfig
	Client *http.Client
}

// ID 供应商标识
func (p *OpenAICompatProvider) ID() int64 { return p.IDOf }

// Name 名称
func (p *OpenAICompatProvider) Name() string { return p.NameOf }

// Kind 适配类型
func (p *OpenAICompatProvider) Kind() string { return "openai_compatible" }

// StreamChat 透传（model 换上游实名；流式逐帧回传；非流式转单帧）
func (p *OpenAICompatProvider) StreamChat(ctx context.Context, req *ChatRequest) *ProviderResult {
	frames := make(chan string, 32)
	res := &ProviderResult{Frames: frames}
	go func() {
		defer close(frames)
		upstream, ok := p.Cfg.Models[tierOf(req.Model)]
		if !ok {
			res.Err = fmt.Errorf("上游未配置档位 %s", req.Model)
			return
		}
		body := map[string]any{"model": upstream, "messages": req.Messages, "stream": true}
		if len(req.Tools) > 0 {
			body["tools"] = req.Tools
		}
		if req.Temperature != nil {
			body["temperature"] = *req.Temperature
		}
		if req.MaxTokens != nil {
			body["max_tokens"] = *req.MaxTokens
		}
		buf, _ := jsonMarshal(body)
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(p.Cfg.BaseURL, "/")+"/chat/completions", bytes.NewReader(buf))
		if err != nil {
			res.Err = err
			return
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Accept", "text/event-stream")
		httpReq.Header.Set("Authorization", "Bearer "+p.Cfg.APIKey)
		client := p.Client
		if client == nil {
			client = &http.Client{Timeout: 300 * time.Second}
		}
		resp, err := client.Do(httpReq)
		if err != nil {
			res.Err = err
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
			res.Err = fmt.Errorf("上游 %d: %s", resp.StatusCode, string(b))
			return
		}
		// SSE 逐 data: 行透传；usage 从终帧抓取
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "[DONE]" {
				return // 网关统一补 [DONE]
			}
			frames <- data
			if u := usageOfFrame(data); u != nil {
				res.Usage = u
			}
		}
		if err := scanner.Err(); err != nil {
			res.Err = err
		}
	}()
	return res
}

// Embed 真实嵌入：v0.1 未接 bge 服务，返回未实现（8052 侧档位不路由即不达）
func (p *OpenAICompatProvider) Embed(_ context.Context, _ []string) ([][]float32, *UsageOpenAI, error) {
	return nil, nil, fmt.Errorf("embed 档位未配置真实供应商")
}

// ---- 小工具 ----

func tierOf(alias string) string {
	return strings.TrimPrefix(alias, "bbw-")
}

func usageOfFrame(data string) *UsageOpenAI {
	if !strings.Contains(data, `"usage"`) {
		return nil
	}
	var frame struct {
		Usage *UsageOpenAI `json:"usage"`
	}
	if err := jsonUnmarshal([]byte(data), &frame); err != nil || frame.Usage == nil || frame.Usage.TotalTokens == 0 {
		return nil
	}
	return frame.Usage
}

// fileOf 从文本中提取首个 .txt/.md/.go 文件名（echo-agent 启发式）
func fileOf(text string) string {
	for _, field := range strings.FieldsFunc(text, func(r rune) bool { return r == ' ' || r == ',' || r == '，' || r == '。' || r == '\n' }) {
		f := strings.Trim(field, " \t.,。：:\"'“”")
		for _, ext := range []string{".txt", ".md", ".go"} {
			if strings.HasSuffix(f, ext) && len(f) > len(ext) {
				return f
			}
		}
	}
	return ""
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i > 0 {
		return s[:i]
	}
	if len([]rune(s)) > 60 {
		return string([]rune(s)[:60])
	}
	return s
}

// envLoadOpenAICompat 从环境装配上游（空 base=未启用）
func envLoadOpenAICompat() *OpenAICompatProvider {
	base := os.Getenv("BBW_AIGW_OPENAI_BASE")
	if base == "" {
		return nil
	}
	models := map[string]string{}
	for _, kv := range strings.Split(os.Getenv("BBW_AIGW_OPENAI_MODELS"), ",") {
		if parts := strings.SplitN(kv, "=", 2); len(parts) == 2 && parts[1] != "" {
			models[parts[0]] = parts[1]
		}
	}
	return &OpenAICompatProvider{
		IDOf:   2,
		NameOf: "openai-compat-upstream",
		Cfg: OpenAICompatConfig{
			BaseURL: base,
			APIKey:  os.Getenv("BBW_AIGW_OPENAI_KEY"),
			Models:  models,
		},
	}
}

// mustJSONString 字符串安全转 JSON 字面量
func mustJSONString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func mustJSONMap(m map[string]any) string {
	b, _ := json.Marshal(m)
	return string(b)
}

// mustJSONStringMap 便捷：{"k":"v"} 形态字面量
func mustJSONStringMap(k, v string) string { return mustJSONMap(map[string]any{k: v}) }

func jsonMarshal(v any) ([]byte, error)   { return json.Marshal(v) }
func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
