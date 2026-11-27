// api.go：管理面 handler（权限守卫 admin:release:manage 由 main.go 挂）。
package release

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	errx "github.com/baobaochat/server/internal/platform/errors"

	"github.com/baobaochat/server/internal/platform/httpx"
	bbcpg "github.com/baobaochat/server/internal/platform/pgxpool"
)

// presignTTL 制品直传票据有效期（70MB 内网直传足够）
const presignTTL = 30 * time.Minute

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}

// HandlePresign POST /api/v1/admin/client-releases/presign
// 入参 {version, channel, platform, filename} → {storage_key, upload_url, expires_in}
// 前端拿到 upload_url 后 PUT 直传对象存储（不经 Go 服务）；随后调登记接口。
func (m *Module) HandlePresign(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Version  string `json:"version"`
		Channel  string `json:"channel"`
		Platform string `json:"platform"`
		Filename string `json:"filename"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Version == "" || req.Filename == "" || req.Platform == "" {
		httpx.Fail(w, r, errors.New("version/platform/filename 必填"))
		return
	}
	if req.Channel == "" {
		req.Channel = ChannelStable
	}
	if m.presigner == nil {
		httpx.Fail(w, r, errors.New("当前部署未启用对象存储（BBC_S3_ENDPOINT 空）——客户端发布管理需要对象存储"))
		return
	}
	key := StorageKeyFor(req.Version, req.Platform, req.Filename)
	url, err := m.presigner.PresignPutRelease(r.Context(), "releases/"+key, presignTTL)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.OK(w, r, map[string]any{
		"storage_key": key,
		"upload_url":  url,
		"expires_in":  int(presignTTL.Seconds()),
	})
}

// HandleRegister POST /api/v1/admin/client-releases（登记已上传制品，draft 态）
func (m *Module) HandleRegister(w http.ResponseWriter, r *http.Request) {
	var in RegisterInput
	if err := decodeJSON(r, &in); err != nil {
		httpx.Fail(w, r, errors.New("请求体非法"))
		return
	}
	if err := in.Validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.StorageKey == "" {
		in.StorageKey = StorageKeyFor(in.Version, in.Platform, in.Filename)
	}
	// 服务端校验（0.1.5）：验签 + 包内版本一致性（fetcher 与 pubkey 均就绪才启用；
	// 前端已做识别与预检，这里是防「错文件/换包未换签名/版本填错」的最终闸）。
	// 业务性失败→9001 带详情（前端信封 message 优先透出）；环境性失败→打日志留 trace_id 排查
	if m.fetcher != nil && m.opts.UpdaterPubkey != "" && strings.HasSuffix(in.Filename, ".app.tar.gz") {
		rc, err := m.fetcher.GetReleaseObject(r.Context(), in.StorageKey)
		if err != nil {
			log.Printf("[release] register %s/%s 拉取制品失败: %v", in.Version, in.Platform, err)
			httpx.Fail(w, r, err)
			return
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			log.Printf("[release] register %s/%s 读取制品失败: %v", in.Version, in.Platform, err)
			httpx.Fail(w, r, err)
			return
		}
		if int64(len(data)) != in.Size {
			log.Printf("[release] register %s/%s 大小不符: 登记 %d 实际 %d", in.Version, in.Platform, in.Size, len(data))
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, fmt.Sprintf("文件大小不符：登记 %d 字节，存储实际 %d 字节（直传不完整？请重传）", in.Size, len(data))))
			return
		}
		if err := VerifyMinisign(m.opts.UpdaterPubkey, in.Signature, data); err != nil {
			log.Printf("[release] register %s/%s 验签失败: %v", in.Version, in.Platform, err)
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, err.Error()))
			return
		}
		pkgVer, err := ExtractPkgVersion(bytes.NewReader(data))
		if err != nil {
			log.Printf("[release] register %s/%s 解包失败: %v", in.Version, in.Platform, err)
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, err.Error()))
			return
		}
		if pkgVer != "" && pkgVer != in.Version {
			log.Printf("[release] register %s/%s 版本不一致: 包内 %s 登记 %s", in.Version, in.Platform, pkgVer, in.Version)
			httpx.Fail(w, r, errx.New(errx.CodeBadRequest, fmt.Sprintf("版本号不一致：包内 Info.plist 为 %s，登记为 %s（以上传的包为准修正版本号）", pkgVer, in.Version)))
			return
		}
		log.Printf("[release] register %s/%s 校验通过（%d 字节）", in.Version, in.Platform, len(data))
	}
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	rec, err := m.store.Upsert(r.Context(), bbcpg.DefaultTenantID, &Record{
		Version:    in.Version,
		Channel:    in.Channel,
		Platform:   in.Platform,
		Filename:   in.Filename,
		Size:       in.Size,
		SHA256:     in.SHA256,
		StorageKey: in.StorageKey,
		Signature:  in.Signature,
		Notes:      in.Notes,
	}, uid)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.OK(w, r, rec)
}

// HandleList GET /api/v1/admin/client-releases?channel=stable
func (m *Module) HandleList(w http.ResponseWriter, r *http.Request) {
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = ChannelStable
	}
	items, err := m.store.ListByChannel(r.Context(), bbcpg.DefaultTenantID, channel)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// 概要：当前线上版本（published_at 最新者）+ 各平台覆盖
	live := ""
	liveAt := time.Time{}
	for _, it := range items {
		if it.Status == StatusPublished && it.PublishedAt.After(liveAt) {
			live = it.Version
			liveAt = it.PublishedAt
		}
	}
	httpx.OK(w, r, map[string]any{"items": items, "live_version": live})
}

type versionReq struct {
	Version string `json:"version"`
	Channel string `json:"channel"`
}

func (v *versionReq) validate() error {
	if v.Version == "" {
		return errors.New("version 必填")
	}
	if v.Channel == "" {
		v.Channel = ChannelStable
	}
	return nil
}

// HandlePublish POST /api/v1/admin/client-releases/publish（整版本发布）
func (m *Module) HandlePublish(w http.ResponseWriter, r *http.Request) {
	var req versionReq
	if err := decodeJSON(r, &req); err != nil {
		httpx.Fail(w, r, errors.New("请求体非法"))
		return
	}
	if err := req.validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	n, err := m.store.PublishVersion(r.Context(), bbcpg.DefaultTenantID, req.Channel, req.Version)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n == 0 {
		httpx.Fail(w, r, errors.New("该版本没有可发布的草稿（可能已发布或不存在）"))
		return
	}
	m.audit(r, "client_release.publish", req.Channel+"/"+req.Version)
	httpx.OK(w, r, map[string]any{"published": n})
}

// HandleRevoke POST /api/v1/admin/client-releases/revoke（撤回整版本）
func (m *Module) HandleRevoke(w http.ResponseWriter, r *http.Request) {
	var req versionReq
	if err := decodeJSON(r, &req); err != nil {
		httpx.Fail(w, r, errors.New("请求体非法"))
		return
	}
	if err := req.validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	n, err := m.store.RevokeVersion(r.Context(), bbcpg.DefaultTenantID, req.Channel, req.Version)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n == 0 {
		httpx.Fail(w, r, errors.New("该版本没有已发布记录（可能已撤回或仍是草稿）"))
		return
	}
	m.audit(r, "client_release.revoke", req.Channel+"/"+req.Version)
	httpx.OK(w, r, map[string]any{"revoked": n})
}

// HandleRollback POST /api/v1/admin/client-releases/rollback
// 把目标版本提升为线上（清单指针→published_at=now；不挪文件、不改内容）
func (m *Module) HandleRollback(w http.ResponseWriter, r *http.Request) {
	var req versionReq
	if err := decodeJSON(r, &req); err != nil {
		httpx.Fail(w, r, errors.New("请求体非法"))
		return
	}
	if err := req.validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	n, err := m.store.TouchVersion(r.Context(), bbcpg.DefaultTenantID, req.Channel, req.Version)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n == 0 {
		httpx.Fail(w, r, errors.New("目标版本不是已发布状态（撤回过的版本需先重新发布）"))
		return
	}
	m.audit(r, "client_release.rollback", req.Channel+"/"+req.Version)
	httpx.OK(w, r, map[string]any{"rolled_back_to": req.Version})
}

// HandleDelete DELETE /api/v1/admin/client-releases/{id}（仅草稿）
func (m *Module) HandleDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id == 0 {
		httpx.Fail(w, r, errors.New("id 非法"))
		return
	}
	if err := m.store.DeleteDraft(r.Context(), bbcpg.DefaultTenantID, id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.OK(w, r, map[string]bool{"ok": true})
}

// auditHook 审计出口（main.go 注入；nil=跳过）
type auditHook func(ctx context.Context, action, target string)

func (m *Module) audit(r *http.Request, action, target string) {
	if m.auditFn == nil {
		return
	}
	uid, _ := strconv.ParseInt(httpx.Claims(r.Context()).Subject, 10, 64)
	_ = uid
	m.auditFn(r.Context(), action, target)
}