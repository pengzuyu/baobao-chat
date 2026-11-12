// Package fileapi 文件域对外接口与 DTO（D06 阶段一+阶段二 server 侧）。
// v0.2 落地：check 秒传预检 / 分片上传会话（uploads 初始化/PATCH 分片/
// complete 合并校验）。分享外链（/s/{code}）随 2026-11 产品瘦身二阶段移除。
// 仍裁剪登记：对象存储预签名直传（本地盘 PATCH 直传形态）、传输管理器
// /transfers、restore、/files/{id} 元数据端点。
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

// TicketResult GET /files/ticket/{id} 响应。
// Local 模式 url=相对路径 /api/v1/files/dl?t={token}（端内拼 API origin）；
// S3 模式 url=预签名 GET 绝对地址（120s；对外端点含 /oss 前缀，D25 拍板②）
type TicketResult struct {
	URL       string `json:"url"`
	ExpiresIn int    `json:"expiresIn"` // 秒（恒 120）
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

// CheckReq POST /files/check（秒传预检；服务端策略再校验——不信任端侧结论）
type CheckReq struct {
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	ConvID      int64  `json:"conv_id"`
}

// CheckResult 秒传判定（命中直接可发消息，跳过上传）
type CheckResult struct {
	FileID string `json:"file_id,omitempty"` // 命中才有
	Dedup  bool   `json:"dedup"`
}

// UploadInitReq POST /files/uploads（初始化分片会话）
type UploadInitReq struct {
	SHA256      string `json:"sha256"` // 声明指纹（complete 整体校验依据，4006）
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
	ConvID      int64  `json:"conv_id"`
	PartSize    int64  `json:"part_size"` // 缺省 4MB（07 §1.2；范围 1–8MB）
}

// UploadPartURL 分片预签名（D25 presign 模式；首批 ≤32 张、1h 时效、批间经 status 续签）
type UploadPartURL struct {
	No        int    `json:"no"`
	URL       string `json:"url"`               // 绝对地址（对外端点；PUT 原始字节、免 Authorization）
	Method    string `json:"method"`            // 恒 PUT
	ExpiresAt int64  `json:"expires_at"`        // ms（到期前 10min 客户端主动续签）
}

// UploadInitResult 会话建立响应（秒传命中直接返回 file_id 跳过分片）
type UploadInitResult struct {
	UploadID  string           `json:"upload_id,omitempty"`
	PartSize  int64            `json:"part_size,omitempty"`
	PartTotal int              `json:"part_total,omitempty"`
	Mode      string           `json:"mode,omitempty"`      // presign=客户端 PUT 直传（D25）；缺省/relay=PATCH 中转
	Parts     []UploadPartURL  `json:"parts,omitempty"`     // presign 首批（≤32）
	FileID    string           `json:"file_id,omitempty"`   // 秒传命中（dedup=true）才有
	Dedup     bool             `json:"dedup"`
}

// UploadStatus GET /files/uploads/{id}?from_part=N（断点续传位图 + 预签名续批）
type UploadStatus struct {
	UploadID string          `json:"upload_id"`
	Received []int           `json:"received"`           // 已收分片号（客户端跳过续传）
	Parts    []UploadPartURL `json:"parts,omitempty"`    // ?from_part= 时返回从该号起的续批（≤32）
}

// UploadPartResult PATCH /files/uploads/{id}/{no} 响应
type UploadPartResult struct {
	Received bool `json:"received"` // 恒 true（失败走错误码）
}

// CompleteResult POST /files/uploads/{id}/complete（合并+校验+落位）
type CompleteResult struct {
	FileID string `json:"file_id"`
	Dedup  bool   `json:"dedup,omitempty"` // 合并期间同 sha 已存在 → 复用
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
	MsgSeq      int64  `json:"msgSeq,omitempty"` // 消息锚点（群文件定位消息，OQ-B24）
	Recalled    bool   `json:"recalled"`         // 锚点消息已撤回（锚点置灰，文件保留）
	CreatedAt   int64  `json:"createdAt"`        // ms
}

// FileService 文件域服务接口（main REST 壳与 message 域校验依赖）
type FileService interface {
	// Upload 上传：扩展名黑名单(4002)/大小上限(4009)/sha 去重复用；图片解析宽高入元数据
	Upload(ctx context.Context, tenantID, ownerID int64, name, contentType string, convID int64, r io.Reader) (*UploadResult, error)
	// IssueTicket 取下载票据·内部 token 形态（kb 摄取等服务端消费方配 Download 回放流）
	IssueTicket(ctx context.Context, tenantID, userID int64, fileID int64) (*TicketResult, error)
	// IssueClientTicket 取下载票据·客户端形态（D25）：S3=预签名 GET 120s 绝对地址（variant
	// ∈ origin/240/720，缩略惰性生成）；Local=token dl 相对路径（与 IssueTicket 同源）
	IssueClientTicket(ctx context.Context, tenantID, userID int64, fileID int64, variant string) (*TicketResult, error)
	// Download 票据校验 → 打开内容流（票据一次性：二次消费 4014）
	Download(ctx context.Context, token string) (*DownloadTarget, io.ReadCloser, error)
	// ListMine 我的文件（软删排除）
	ListMine(ctx context.Context, tenantID, userID int64) ([]FileDTO, error)
	// ListByConv 会话文件聚合（群文件页签；会话成员可见，D03 §3.6）
	ListByConv(ctx context.Context, tenantID, userID, convID int64) ([]FileDTO, error)
	// SoftDelete owner 软删
	SoftDelete(ctx context.Context, tenantID, userID int64, fileID int64) error
	// CheckSendable msg.send type=file/image 校验：存在(4005)/未删(4013)/sender 为 owner 或 source=message(2003)
	CheckSendable(ctx context.Context, senderID int64, fileID int64) error
	// MarkSent 随消息发送回填 source/conv_id/msg_seq（msg_seq=群文件锚点，OQ-B24）
	MarkSent(ctx context.Context, fileID int64, convID int64, msgSeq int64) error
	// OnMsgRecalled 锚点消息撤回联动（OQ-B24：文件保留、recalled 置灰；尽力而为）
	OnMsgRecalled(ctx context.Context, convID int64, msgSeq int64) error

	// ── 分片上传会话（07 §4.1：relay=本地盘 PATCH 中转 / presign=S3 预签名直传 D25） ──
	// Check 秒传预检（策略再校验：大小/黑名单不因预检豁免）
	Check(ctx context.Context, tenantID, ownerID int64, req CheckReq) (*CheckResult, error)
	// InitUpload 建会话（7 天有效）；声明 sha 已存在 → 直接秒传建行；
	// presign 模式响应 mode/parts（首批 ≤32 张 1h 预签名，part_size 强制 8MB）
	InitUpload(ctx context.Context, tenantID, ownerID int64, req UploadInitReq) (*UploadInitResult, error)
	// UploadStatus 断点续传位图（会话过期 4008）；fromPart>0 时附预签名续批
	UploadStatus(ctx context.Context, tenantID, userID int64, uploadID string, fromPart int) (*UploadStatus, error)
	// UploadPart 写分片（no 范围校验；超 part_size 4009；覆盖写支持坏块重传）
	UploadPart(ctx context.Context, tenantID, userID int64, uploadID string, no int, r io.Reader) error
	// CompleteUpload 合并+整体 sha 校验（不一致 4006 作废）→ 落位去重建行
	CompleteUpload(ctx context.Context, tenantID, userID int64, uploadID string) (*CompleteResult, error)

	// ListTransfers 本人传输记录（07 §5 跨端镜像；direction 0=全部）
	ListTransfers(ctx context.Context, tenantID, userID int64, direction int, limit int) ([]TransferDTO, error)
}

// TransferDTO 传输记录项（GET /files/transfers）
type TransferDTO struct {
	ID               string `json:"id"`
	FileID           string `json:"file_id,omitempty"` // complete 后回填
	FileName         string `json:"file_name,omitempty"`
	Direction        int    `json:"direction"` // 1 上传 2 下载
	State            string `json:"state"`     // queued/transferring/resuming/…/done/failed
	BytesTransferred int64  `json:"bytes_transferred"`
	TotalBytes       int64  `json:"total_bytes"`
	ErrorCode        int    `json:"error_code,omitempty"`
	CreatedAt        int64  `json:"createdAt"`
	UpdatedAt        int64  `json:"updatedAt"`
}
