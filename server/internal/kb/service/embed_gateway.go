// 网关嵌入通道：EmbedFn 的 HTTP 实现（生产装配）。
// 生产链路：kb 服务 → POST {origin}/v1/embeddings（model=bbw-embed，BBW_AIGW_DEV_TOKEN
// 开发令牌鉴权）→ aigw 网关路由 → mock/真实供应商 → 1024 维确定性向量。
// 内存模式单测不走本通道（直接注入假 EmbedFn，任务约束）。
package kbservice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// GatewayEmbedFn 构造指向本服务 AI 网关的嵌入函数。
// baseURL 形如 http://127.0.0.1:8090（不带路径）；token 为网关开发令牌
// （BBW_AIGW_DEV_TOKEN）；hc 可空（默认 30s 超时客户端）
func GatewayEmbedFn(baseURL, token string, hc *http.Client) EmbedFn {
	client := hc
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	u := strings.TrimSuffix(baseURL, "/") + "/v1/embeddings"
	return func(ctx context.Context, input []string) ([][]float32, error) {
		if len(input) == 0 {
			return nil, fmt.Errorf("embed input 为空")
		}
		if len(input) > 64 {
			return nil, fmt.Errorf("embed input 单请求 ≤64 条")
		}
		body, err := json.Marshal(map[string]any{"model": "bbw-embed", "input": input})
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("嵌入网关请求失败: %w", err)
		}
		defer resp.Body.Close()
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if resp.StatusCode != http.StatusOK {
			// 网关错误体：{"error":{"code":8050/8051/…,"message":…}}（docs/19 §6.2）
			return nil, fmt.Errorf("嵌入网关 %d: %s", resp.StatusCode, truncateStr(string(payload), 200))
		}
		var out struct {
			Data []struct {
				Embedding []float32 `json:"embedding"`
				Index     int       `json:"index"`
			} `json:"data"`
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil, fmt.Errorf("嵌入响应解析失败: %w", err)
		}
		if out.Error != nil {
			return nil, fmt.Errorf("嵌入网关错误 %d: %s", out.Error.Code, out.Error.Message)
		}
		vecs := make([][]float32, len(out.Data))
		for _, d := range out.Data {
			if d.Index < 0 || d.Index >= len(vecs) {
				return nil, fmt.Errorf("嵌入响应 index 越界: %d", d.Index)
			}
			vecs[d.Index] = d.Embedding
		}
		for i, v := range vecs {
			if len(v) == 0 {
				return nil, fmt.Errorf("嵌入响应第 %d 条为空", i)
			}
		}
		return vecs, nil
	}
}

func truncateStr(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
