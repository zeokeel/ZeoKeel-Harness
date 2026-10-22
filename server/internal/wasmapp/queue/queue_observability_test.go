package queue

// 生产级评审（2026-10-22 管理员视角 P1）：队列 429 必须有**计数与按应用水位**，
// 否则 /admin/runtime 无法回答"哪个应用在拖垮平台/为什么用户一直失败"。
//
// 变异验证：
//   - 删掉 rejectedQueueFull++ / rejectedWallClock++ ⇒ Stats 断言红；
//   - 删掉 rejectedByApp[appID]++ ⇒ AppWatermarks 的 Rejected 红；
//   - AppWatermarks 不做有界截断/排序 ⇒ 顺序与 limit 断言红。

import (
	"context"
	"testing"
	"time"
)

// TestQueueRejectsAreCountedAndAttributed：队列满/墙钟两类 429 分别计数，并按 app 归属。
func TestQueueRejectsAreCountedAndAttributed(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 1
	o.PerUserPerAppQueued = 1
	o.PerUserGlobalRunning = 8
	s := New(o)
	ctx := context.Background()

	held, err := s.Acquire(ctx, "busy-app", 1)
	if err != nil {
		t.Fatalf("占住槽位: %v", err)
	}

	// 第 2 个进队列（占满 app_queue=1）。
	queued := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "busy-app", 2)
		if e != nil {
			queued <- nil
			return
		}
		queued <- tk
	}()
	waitQueued(t, s, "busy-app", 1)

	// 第 3 个：应用队列满 ⇒ 429 计数。
	if _, qerr := s.Acquire(ctx, "busy-app", 3); qerr == nil {
		t.Fatal("队列满时应 429")
	}
	// 同一用户再排队 ⇒ 用户占位满 ⇒ 也计入 rejectedQueueFull。
	if _, qerr := s.Acquire(ctx, "busy-app", 2); qerr == nil {
		t.Fatal("同用户占位满时应 429")
	}

	st := s.Stats()
	if st.RejectedQueueFull != 2 {
		t.Fatalf("RejectedQueueFull = %d，want 2", st.RejectedQueueFull)
	}
	if st.RejectedWallClock != 0 {
		t.Fatalf("RejectedWallClock = %d，want 0（尚未发生墙钟超时）", st.RejectedWallClock)
	}

	held.Release()
	if tk := <-queued; tk != nil {
		tk.Release()
	}

	// 墙钟：排队方用短超时 ctx，超时后计 rejectedWallClock。
	held2, err := s.Acquire(ctx, "slow-app", 1)
	if err != nil {
		t.Fatalf("占住 slow-app: %v", err)
	}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, werr := s.Acquire(short, "slow-app", 2); werr == nil {
		t.Fatal("排队超过墙钟应 429")
	}
	held2.Release()
	st = s.Stats()
	if st.RejectedWallClock != 1 {
		t.Fatalf("RejectedWallClock = %d，want 1", st.RejectedWallClock)
	}

	// 按应用水位：busy-app 有 2 次拒绝（队列满），slow-app 1 次（墙钟）。
	wm := s.AppWatermarks(10)
	byApp := map[string]AppWatermark{}
	for _, w := range wm {
		byApp[w.AppID] = w
	}
	if byApp["busy-app"].Rejected != 2 {
		t.Fatalf("busy-app 拒绝计数 = %d，want 2（watermarks=%+v）", byApp["busy-app"].Rejected, wm)
	}
	if byApp["slow-app"].Rejected != 1 {
		t.Fatalf("slow-app 拒绝计数 = %d，want 1（watermarks=%+v）", byApp["slow-app"].Rejected, wm)
	}
}

// TestAppWatermarksBoundedAndSorted：按"在跑+等待"降序、limit 有界。
func TestAppWatermarksBoundedAndSorted(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 4
	o.PerUserPerAppQueued = 4
	o.PerUserGlobalRunning = 8
	s := New(o)
	ctx := context.Background()
	held, err := s.Acquire(ctx, "top-app", 1)
	if err != nil {
		t.Fatalf("占住: %v", err)
	}
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "top-app", 2)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	waitQueued(t, s, "top-app", 1)
	// 另一个应用只有在跑。
	other, err := s.Acquire(ctx, "side-app", 1)
	if err != nil {
		t.Fatalf("side-app: %v", err)
	}
	defer other.Release()

	wm := s.AppWatermarks(1)
	if len(wm) != 1 || wm[0].AppID != "top-app" {
		t.Fatalf("top1 必须是 top-app（running+waiting 最大），得到 %+v", wm)
	}
	if wm[0].Running != 1 || wm[0].Waiting != 1 {
		t.Fatalf("top-app 水位 = %+v，want running=1 waiting=1", wm[0])
	}
	held.Release()
	if tk := <-done; tk != nil {
		tk.Release()
	}
}
