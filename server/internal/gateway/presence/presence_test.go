// 连接派生在线+自报态合成（D03 §5.3）
package presence

import "testing"

func TestConnTransitions(t *testing.T) {
	tr := NewTracker()
	if !tr.ConnUp(1) {
		t.Fatal("首连应 online 转变")
	}
	if tr.ConnUp(1) {
		t.Fatal("多端第二连非转变")
	}
	if got := tr.Get(1); got != StatusOnline {
		t.Fatalf("Get=%s", got)
	}
	if tr.ConnDown(1) {
		t.Fatal("仍余一连接非 offline")
	}
	if !tr.ConnDown(1) {
		t.Fatal("末连接应 offline 转变")
	}
	if got := tr.Get(1); got != StatusOffline {
		t.Fatalf("Get=%s", got)
	}
}

func TestReportedStatusAndInvisible(t *testing.T) {
	tr := NewTracker()
	tr.ConnUp(1)
	tr.Set(1, StatusDND)
	if got := tr.Get(1); got != StatusDND {
		t.Fatalf("DND 丢失: %s", got)
	}
	tr.Set(1, StatusInvisible)
	if got := tr.Get(1); got != StatusOffline {
		t.Fatalf("invisible 观察者视角应 offline: %s", got)
	}
	// 离线弃自报态
	tr.ConnDown(1)
	tr.ConnUp(1)
	if got := tr.Get(1); got != StatusOnline {
		t.Fatalf("重连应回落 online: %s", got)
	}
	// 非法状态回落 online
	if got := tr.Set(1, "bogus"); got != StatusOnline {
		t.Fatalf("非法态回落: %s", got)
	}
}

func TestSnapshotAndOnlineUIDs(t *testing.T) {
	tr := NewTracker()
	tr.ConnUp(2)
	tr.ConnUp(1)
	snap := tr.Snapshot()
	if len(snap) != 2 || snap[1] != StatusOnline || snap[2] != StatusOnline {
		t.Fatalf("snap=%v", snap)
	}
	uids := tr.OnlineUIDs()
	if uids[0] != 1 || uids[1] != 2 {
		t.Fatalf("升序: %v", uids)
	}
}
