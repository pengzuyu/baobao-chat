// 传输记录服务端镜像（07 §5）：上传/分片进度/票据下载节点写入，
// GET /files/transfers 跨端"我发过/收过什么"。写失败静默（记录是辅链路，
// 不阻断传输主流程——同 call_card 先例）；下载完成度服务端不可知，
// 恒 transferring（断点下载阶段三补 done，登记）。
package fileservice

import (
	"context"
	"strconv"

	fileapi "github.com/baobaowork/server/internal/file/api"
	filerepo "github.com/baobaowork/server/internal/file/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// ListTransfers 本人传输记录（direction 0=全部；created_at 倒序）
func (s *Service) ListTransfers(ctx context.Context, tenantID, userID int64, direction int, limit int) ([]fileapi.TransferDTO, error) {
	if s.transfers == nil {
		return []fileapi.TransferDTO{}, nil // 未装配（阶段一形态）——空表不报错
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.transfers.ListByUser(ctx, tenantID, userID, direction, limit)
	if err != nil {
		return nil, errInternal()
	}
	out := make([]fileapi.TransferDTO, 0, len(rows))
	for _, t := range rows {
		dto := fileapi.TransferDTO{
			ID:               strconv.FormatInt(t.ID, 10),
			FileID:           strconv.FormatInt(t.FileID, 10),
			Direction:        t.Direction,
			State:            t.State,
			BytesTransferred: t.BytesTransferred,
			TotalBytes:       t.TotalBytes,
			CreatedAt:        t.CreatedAt.UnixMilli(),
			UpdatedAt:        t.UpdatedAt.UnixMilli(),
		}
		if t.ErrorCode > 0 {
			dto.ErrorCode = t.ErrorCode
		}
		// 文件名联查（已回填 file_id 的行；失败留空——文件可能已软删）
		if t.FileID > 0 {
			if f, ferr := s.repo.Get(ctx, t.FileID); ferr == nil {
				dto.FileName = f.Name
			}
		}
		out = append(out, dto)
	}
	return out, nil
}

// recordTransferDone 上传成功（multipart 路径）：up/done 终态行
func (s *Service) recordTransferDone(ctx context.Context, tenantID, userID, fileID int64, total int64) {
	if s.transfers == nil {
		return
	}
	_, _ = s.transfers.Insert(ctx, filerepo.TransferRecord{
		TenantID: tenantID, UserID: userID, FileID: fileID,
		Direction: filerepo.TransferUp, State: filerepo.TransferDone,
		BytesTransferred: total, TotalBytes: total,
	})
}

// recordTransferQueued 分片会话建立：up/queued 行（upload_id 关联后续进度）
func (s *Service) recordTransferQueued(ctx context.Context, tenantID, userID int64, uploadID string, total int64) {
	if s.transfers == nil {
		return
	}
	_, _ = s.transfers.Insert(ctx, filerepo.TransferRecord{
		TenantID: tenantID, UserID: userID, UploadID: uploadID,
		Direction: filerepo.TransferUp, State: filerepo.TransferQueued,
		TotalBytes: total,
	})
}

// recordTransferProgress 分片落盘后进度更新（resuming=位图有存量；transferring=全新）
func (s *Service) recordTransferProgress(ctx context.Context, tenantID int64, uploadID string, resuming bool, doneBytes int64) {
	if s.transfers == nil {
		return
	}
	rec, err := s.transfers.GetByUpload(ctx, tenantID, uploadID)
	if err != nil || rec == nil {
		return
	}
	state := filerepo.TransferTransferring
	if resuming {
		state = filerepo.TransferResuming
	}
	_ = s.transfers.UpdateProgress(ctx, rec.ID, state, doneBytes, 0, -1)
}

// recordTransferComplete complete 成功：done + file_id 回填；作废：failed+error_code
func (s *Service) recordTransferComplete(ctx context.Context, tenantID int64, uploadID string, fileID int64, total int64, errorCode int) {
	if s.transfers == nil {
		return
	}
	rec, err := s.transfers.GetByUpload(ctx, tenantID, uploadID)
	if err != nil || rec == nil {
		return
	}
	if errorCode > 0 {
		_ = s.transfers.UpdateProgress(ctx, rec.ID, filerepo.TransferFailed, -1, 0, errorCode)
		return
	}
	_ = s.transfers.UpdateProgress(ctx, rec.ID, filerepo.TransferDone, total, fileID, -1)
}

// recordTransferDownload 票据消费开流：down/transferring 行（done 不可知，登记）
func (s *Service) recordTransferDownload(ctx context.Context, tenantID, userID, fileID, total int64) {
	if s.transfers == nil {
		return
	}
	_, _ = s.transfers.Insert(ctx, filerepo.TransferRecord{
		TenantID: tenantID, UserID: userID, FileID: fileID,
		Direction: filerepo.TransferDown, State: filerepo.TransferTransferring,
		TotalBytes: total,
	})
}

// errInternal 统一内部错误（记录链路读失败）
func errInternal() error {
	return errx.New(errx.CodeInternal, "传输记录读取失败")
}
