// Package filerepo 文件域数据访问接口（内存实现先行；唯一允许写 SQL 的层——D02 §3）。
// v0.1 务实口径（D06 阶段一）：blob/file 两层模型合并为单表 file，同租户同 sha256
// （未软删）复用同一行；ref_count/blob 表留待阶段二拆分（取舍登记见迁移 0008）。
package filerepo

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound 行不存在 sentinel（service 映射 4005）
var ErrNotFound = errors.New("filerepo: not found")

// ErrDuplicateFileSHA 同租户同 sha256 未删行已存在（并发上传去重兜底；
// service 捕获后改走 GetBySHA 复用原行）
var ErrDuplicateFileSHA = errors.New("filerepo: duplicate tenant sha256")

// source 取值（v0.1 两态：upload 未随消息发送 / message 已随消息发送）
const (
	SourceUpload  = "upload"
	SourceMessage = "message"
)

// scan_status 枚举（07 篇 §5；v0.1 建列恒 Clean——扫描服务阶段二接入）
const (
	ScanPending  = 0
	ScanClean    = 1
	ScanInfected = 2
	ScanSkipped  = 3
)

// File 文件行（迁移 0008 file 表）
type File struct {
	ID          int64
	TenantID    int64
	OwnerID     int64
	Name        string // 显示名（不唯一：同一内容可多名，07 §7.3）
	Ext         string // 小写无点（"png"）；无扩展名为空串
	Size        int64
	ContentType string
	SHA256      string
	Width       int // 图片像素宽；0=非图片/解析失败
	Height      int
	Source      string // upload / message
	ConvID      int64  // 随消息发送后回填；0=未关联
	MsgSeq      int64  // 消息锚点（群文件"定位消息"，OQ-B24）；0=未关联
	Recalled    bool   // 锚点消息已撤回（文件保留、锚点置灰，OQ-B24）
	ScanStatus  int
	CreatedAt   time.Time
	DeletedAt   time.Time // 零值=未删
}

// Deleted 软删判定
func (f File) Deleted() bool { return !f.DeletedAt.IsZero() }

// Repo 文件域仓储接口
type Repo interface {
	// Insert 新增；ID=0 时分配（内存自增 / PG advisory lock 9109 + max+1，雪花占位，13 篇 §1）。
	// 同租户同 sha256 未删行冲突返回 ErrDuplicateFileSHA（调用方改走 GetBySHA 复用）
	Insert(ctx context.Context, f File) (File, error)
	// Get 按 ID 查（含已软删行；软删判定在 service）。不存在返回 ErrNotFound
	Get(ctx context.Context, id int64) (*File, error)
	// GetBySHA 同租户同 sha256 的未软删行（去重复用路径）；无命中返回 nil, nil
	GetBySHA(ctx context.Context, tenantID int64, sha256 string) (*File, error)
	// SoftDelete 软删（deleted_at=at；行不存在返回 ErrNotFound）
	SoftDelete(ctx context.Context, id int64, at time.Time) error
	// MarkSent 随消息发送后回填 source='message' + conv_id/msg_seq（锚点，OQ-B24）
	MarkSent(ctx context.Context, id int64, convID int64, msgSeq int64) error
	// MarkRecalledByMsg 锚点消息撤回联动（OQ-B24：文件保留、recalled 置灰锚点；无匹配=no-op）
	MarkRecalledByMsg(ctx context.Context, convID int64, msgSeq int64) error
	// ListByUser 我的文件（未软删，created_at 倒序；v0.1 全量不分页，cursor 阶段二）
	ListByUser(ctx context.Context, tenantID, userID int64) ([]File, error)
	// ListByConv 会话文件聚合（未软删，created_at 倒序；群文件页签预留）
	ListByConv(ctx context.Context, tenantID, convID int64) ([]File, error)
}

// FileStatsReader 管理端统计可选接口（D10 仪表盘跨域闭包；不进 Repo 主接口）
type FileStatsReader interface {
	// SumStorageBytes 文件存储量（未软删行 size 求和）
	SumStorageBytes(ctx context.Context, tenantID int64) (int64, error)
}

// ── 分享外链（07 §4.4：三要素=有效期/次数/密码；访问仍需登录） ──

// expire_mode 取值（1 永不 2 时限 3 次数）
const (
	ShareExpireNever = 1
	ShareExpireAt    = 2
	ShareExpireTimes = 3
)

// share status（1 启用 2 取消）
const (
	ShareActive   = 1
	ShareDisabled = 2
)

// Share 分享链接行（迁移 0013 file_share）
type Share struct {
	ID           int64
	TenantID     int64
	FileID       int64
	CreatorID    int64
	Code         string // UK，链接组成 /s/{code}（随机不可枚举）
	ExpireMode   int    // 1 永不 2 时限 3 次数
	ExpiresAt    time.Time
	MaxTimes     int
	UsedTimes    int
	PasswordHash string // 可选；空=无密码（Hash/Verify 闭包注入，main 接 auth 域口径）
	Status       int
	CreatedAt    time.Time
}

// ShareRepo 分享外链仓储（独立接口：share 生命周期与文件行解耦）
type ShareRepo interface {
	// InsertShare 新增（code 冲突由随机性规避，UK 兜底）
	InsertShare(ctx context.Context, s Share) (Share, error)
	// GetShareByCode 按 code 查（含已取消行；状态判定在 service）
	GetShareByCode(ctx context.Context, tenantID int64, code string) (*Share, error)
	// IncShareUsed 命中计数 +1（解析成功路径）
	IncShareUsed(ctx context.Context, id int64) error
	// DisableShare 取消分享（creator 校验在 service；行不存在 ErrNotFound）
	DisableShare(ctx context.Context, tenantID, id, creatorID int64) error
}

// ── 传输记录（07 §5：服务端镜像，跨端"我发过/收过什么"） ──

// direction 取值
const (
	TransferUp   = 1
	TransferDown = 2
)

// state 取值（OQ-C29 已回填 07 篇枚举；paused/expired 由客户端操作触发，阶段三接）
const (
	TransferQueued       = "queued"
	TransferTransferring = "transferring"
	TransferResuming     = "resuming"
	TransferProcessing   = "processing"
	TransferDone         = "done"
	TransferFailed       = "failed"
	TransferCanceled     = "canceled"
	TransferExpired      = "expired"
)

// TransferRecord 传输记录行（迁移 0014）
type TransferRecord struct {
	ID               int64
	TenantID         int64
	UserID           int64
	FileID           int64 // 0=进行中（complete 后回填）
	UploadID         string
	Direction        int
	State            string
	BytesTransferred int64
	TotalBytes       int64
	ErrorCode        int
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// TransferRepo 传输记录仓储
type TransferRepo interface {
	// Insert 新增（分片会话 init/上传成功/票据下载节点）
	Insert(ctx context.Context, t TransferRecord) (TransferRecord, error)
	// GetByUpload 分片会话关联行（无/多返回首行 nil）
	GetByUpload(ctx context.Context, tenantID int64, uploadID string) (*TransferRecord, error)
	// UpdateProgress 进度更新（state/bytes；file_id>0 时回填；error_code -1 清空）
	UpdateProgress(ctx context.Context, id int64, state string, bytes int64, fileID int64, errorCode int) error
	// ListByUser 本人记录（direction 0=全部；created_at 倒序）
	ListByUser(ctx context.Context, tenantID, userID int64, direction int, limit int) ([]TransferRecord, error)
}
