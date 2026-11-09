// 备份域服务测试（OQ-B09 零知识链路：创建/幂等/列表/票据一次性/删除/越权）。
package agentbackupservice

import (
	"context"
	"strconv"
	"testing"

	agentbackupapi "github.com/baobaowork/server/internal/agentbackup/api"
	agentbackuprepo "github.com/baobaowork/server/internal/agentbackup/repo"
	errx "github.com/baobaowork/server/internal/platform/errors"
)

// codeOf 错误码断言助手（file 域同款）
func codeOf(t *testing.T, err error) errx.Code {
	t.Helper()
	if err == nil {
		t.Fatal("期望非 nil 错误")
	}
	return errx.From(err).Code
}

func newSvc(t *testing.T) *Service {
	t.Helper()
	return New(Options{DataDir: t.TempDir()}, agentbackuprepo.NewMemory())
}

func payload(sid, envelope string, n int) agentbackupapi.CreatePayload {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte('a' + i%26)
	}
	return agentbackupapi.CreatePayload{
		LocalSessionID: sid, Title: "会话 " + sid, EncAlg: "AES-256-GCM",
		KeyEnvelope: envelope, Data: data,
	}
}

func TestBackupCrudAndTickets(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	env := `{"v":1,"saltP":"cA==","saltR":"cg==","wrappedP":"AA==","wrappedR":"QQ=="}`

	// 创建（幂等键）：返回行 + 落盘
	dto, err := svc.Create(ctx, 1, 10001, payload("sess-1", env, 1024), "idem-1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if dto.Size != 1024 || dto.LocalSessionID != "sess-1" || dto.KeyEnvelope != env {
		t.Fatalf("dto 不符: %+v", dto)
	}
	// 幂等重放：同 key 返回既有行（不新增）
	again, err := svc.Create(ctx, 1, 10001, payload("sess-1", env, 2048), "idem-1")
	if err != nil || again.ID != dto.ID || again.Size != 1024 {
		t.Fatalf("幂等应返回既有行: %v %+v", err, again)
	}
	// 列表
	items, err := svc.List(ctx, 1, 10001)
	if err != nil || len(items) != 1 {
		t.Fatalf("list: %v %d", err, len(items))
	}
	// 票据：签发 → 下载一次成功 → 二次消费失效
	tk, err := svc.IssueRestoreTicket(ctx, 1, 10001, mustID(t, dto.ID))
	if err != nil || tk.Ticket == "" || tk.ExpiresIn != 120 {
		t.Fatalf("ticket: %+v %v", tk, err)
	}
	blob, err := svc.ReadTicket(ctx, tk.Ticket)
	if err != nil || len(blob.Data) != 1024 || blob.Row.KeyEnvelope != env {
		t.Fatalf("read ticket: %v len=%d", err, len(blob.Data))
	}
	if code := codeOf(t, err2Of(svc.ReadTicket(ctx, tk.Ticket))); code != errx.CodeNotFound {
		t.Fatalf("一次性票据二次消费应 9002: %v", err)
	}
	// 越权：他人签发被拒
	if code := codeOf(t, err2Of(svc.IssueRestoreTicket(ctx, 1, 10002, mustID(t, dto.ID)))); code != errx.CodeNotFound {
		t.Fatalf("他人票据应 9002: %v", err)
	}
	// 删除后再取票据 → 9002；列表清空
	if err := svc.Delete(ctx, 1, 10001, mustID(t, dto.ID)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if code := codeOf(t, err2Of(svc.IssueRestoreTicket(ctx, 1, 10001, mustID(t, dto.ID)))); code != errx.CodeNotFound {
		t.Fatalf("删除后应 9002: %v", err)
	}
	items, _ = svc.List(ctx, 1, 10001)
	if len(items) != 0 {
		t.Fatalf("删除后列表应空: %d", len(items))
	}
}

func TestBackupValidation(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	// 缺 envelope
	p := payload("s", "", 16)
	if code := codeOf(t, err2Of(svc.Create(ctx, 1, 10001, p, ""))); code != errx.CodeBadRequest {
		t.Fatalf("缺 envelope 应 9001: %d", code)
	}
	// 空密文
	p2 := payload("s", "{}", 0)
	if _, err := svc.Create(ctx, 1, 10001, p2, ""); err == nil {
		t.Fatal("空密文应拒绝")
	}
}

func mustID(t *testing.T, s string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("非法备份 ID: %s", s)
	}
	return n
}

// err2Of 双返回值取错误（codeOf 断言桥）
func err2Of(_ any, err error) error { return err }
