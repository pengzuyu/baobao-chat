// Package fileapi 文件域对外接口与 DTO（D06 阶段一务实版）。
// v0.1 务实口径（相对 docs/07 §6.1 API-FL 全表的裁剪，逐条登记）：
//   - 不做 check/uploads/complete 分片会话（单请求 multipart 直传 ≤20MB）；
//   - 下载不做对象存储预签名，走短期一次性票据 ?t=（120s，4014 失效/复用）；
//   - /files/{id} 元数据、restore、shares、/transfers、/files/convs/{id} 阶段二。
package fileapi

import (
	"context"
	"io"
)

// UploadResult POST /files/upload 响应（去重命中返回原行元数据 + dedup=true）
type UploadResult struct {
	ID          string `json:"id"` // file_id（消息 body 引用此 id；字符串透出与 IM ID 口径一致）
	Name        string `json:"name"`
	Ext         string `json:"ext"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	Width       int    `json:"width,omitempty"`  // 仅图片
	Height      int    `json:"height,omitempty"` // 仅图片
	Dedup       bool   `json:"dedup,omitempty"`  // 同租户同 sha 复用原行（07 §4.1 ③ 简化）
}

// TicketResult GET /files/{id}/ticket 响应（url 为相对路径，端内拼 API origin）
type TicketResult struct {
	URL       string `json:"url"`       // /api/v1/files/dl?t={token}
	ExpiresIn int    `json:"expiresIn"` // 秒（v0.1 恒 120）
}

// DownloadTarget dl 端点回放目标（票据消费成功后）
type DownloadTarget struct {
	FileID      int64
	TenantID    int64
	Name        string
	ContentType string
	SHA256      string
	Size        int64
}

// FileDTO GET /files/me 列表项
type FileDTO struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Ext         string `json:"ext"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`
	Source      string `json:"source"`           // upload / message
	ConvID      string `json:"convId,omitempty"` // 随消息发送后回填
	CreatedAt   int64  `json:"createdAt"`        // ms
}

// FileService 文件域服务接口（main REST 壳与 message 域校验依赖）
type FileService interface {
	// Upload 上传：扩展名黑名单(4002)/大小上限(4009)/sha 去重复用；图片解析宽高入元数据
	Upload(ctx context.Context, tenantID, ownerID int64, name, contentType string, convID int64, r io.Reader) (*UploadResult, error)
	// IssueTicket 取下载票据（owner 或 conv 成员；一次性 120s）
	IssueTicket(ctx context.Context, tenantID, userID int64, fileID int64) (*TicketResult, error)
	// Download 票据校验 → 打开内容流（票据一次性：二次消费 4014）
	Download(ctx context.Context, token string) (*DownloadTarget, io.ReadCloser, error)
	// ListMine 我的文件（软删排除）
	ListMine(ctx context.Context, tenantID, userID int64) ([]FileDTO, error)
	// SoftDelete owner 软删
	SoftDelete(ctx context.Context, tenantID, userID int64, fileID int64) error
	// CheckSendable msg.send type=file/image 校验：存在(4005)/未删(4013)/sender 为 owner 或 source=message(2003)
	CheckSendable(ctx context.Context, senderID int64, fileID int64) error
	// MarkSent 随消息发送后回填 source='message'+conv_id（message 域调用；尽力而为）
	MarkSent(ctx context.Context, fileID int64, convID int64) error
}
