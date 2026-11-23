// module.go：客户端发布模块装配与路由注册（D39）。
package release

import (
	"context"
	"net/http"
	"time"
)

// Presigner 对象存储直传票据能力（*filestore.S3 满足；Local 不满足→管理上传不可用）
type Presigner interface {
	PresignPutObject(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// RegisterPublicRoutes 公开更新面（不鉴权；nginx 仅转发两个清单路径到本服务）
func (m *Module) RegisterPublicRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /update/latest.json", m.HandleLatestManifest)
	mux.HandleFunc("GET /update/release-info.json", m.HandleReleaseInfo)
}

// RegisterAdminRoutes 管理面（guard=权限守卫中间件，需 admin:release:manage）
func (m *Module) RegisterAdminRoutes(mux *http.ServeMux, guard func(http.HandlerFunc) http.Handler) {
	mux.Handle("POST /api/v1/admin/client-releases/presign", guard(m.HandlePresign))
	mux.Handle("POST /api/v1/admin/client-releases", guard(m.HandleRegister))
	mux.Handle("GET /api/v1/admin/client-releases", guard(m.HandleList))
	mux.Handle("POST /api/v1/admin/client-releases/publish", guard(m.HandlePublish))
	mux.Handle("POST /api/v1/admin/client-releases/revoke", guard(m.HandleRevoke))
	mux.Handle("POST /api/v1/admin/client-releases/rollback", guard(m.HandleRollback))
	mux.Handle("DELETE /api/v1/admin/client-releases/{id}", guard(m.HandleDelete))
}