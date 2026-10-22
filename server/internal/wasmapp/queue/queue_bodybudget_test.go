package queue

// 生产级评审（2026-10-22 管理员视角 P1-3）：**排队请求体字节必须有一个全局硬上界**，
// 而且这个上界必须与"/readyz 内存账里的那一笔"同源同值。
//
// 缺陷形态（评审证据 applimits.go:403 / serve.go:352-368 / readyz.go:1107-1158）：
// 服务端在准入**之前**就把请求体读进内存（1 MiB/请求），而排队容量只按**条数**判
// （`app_queue`，合法上界 4096）⇒ 一个应用就能把 4096 × 1 MiB ≈ 4 GiB 已读字节挂在
// 队列里，而四笔账 + 页缓存都不含它 ⇒ `/readyz` 的 `mem_budget_ok` 仍是绿。
//
// 本文件的判据（每条都实跑过变异，红→还原记录在交付报告里）：
//   - 缺省预算来自 limits.WasmQueueBodyBytesMax（单一真源）；
//   - 超限 ⇒ 第 N+1 个请求 429 APP_QUEUE_FULL + details.reason=queue_bytes_exceeded；
//   - 离开队列（授权/超时/被拒）三条路径都归还额度 ⇒ 计数不漂移、额度可复用；
//   - **合法最大配置**（app_queue=4096）也攒不出 4 GiB：上限由字节预算封顶；
//   - 大/小 body 混排不超卖（判据是"加上它之后是否超"，不是"当前是否已满"）；
//   - Stats 的 queued/max/limit/rejected 字段随入队出队变化。

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
)

// bodyLedger 返回三份账：全局 queuedBodyBytes、按应用求和、按在队 waiter 求和。
//
// 三份必须**同时**相等（charge/refund 的唯一实现在 chargeQueuedBodyLocked /
// refundQueuedBodyLocked —— 任何一处绕过它就会出现"全局账平了、按应用的账没平"）。
// 全部在持锁状态下读：本文件的用例里有并发 goroutine 在等队列。
func bodyLedger(t *testing.T, s *Scheduler) (global, perApp, waiters int64) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, as := range s.apps {
		perApp += as.queuedBytes
		for _, w := range as.waiters {
			waiters += w.bodyBytes
		}
	}
	return s.queuedBodyBytes, perApp, waiters
}

// assertLedgerBalanced 断言三份账一致且等于 want，并与 Stats 同值（计数漂移的判据）。
func assertLedgerBalanced(t *testing.T, s *Scheduler, want int64) {
	t.Helper()
	global, perApp, waiters := bodyLedger(t, s)
	if global != want {
		t.Fatalf("全局排队体字节 = %d，want %d（占用/归还漏账）", global, want)
	}
	if perApp != global {
		t.Fatalf("按应用求和 = %d ≠ 全局 %d：两处记账不同源（charge/refund 被绕过？）", perApp, global)
	}
	if waiters != global {
		t.Fatalf("在队 waiter 求和 = %d ≠ 全局 %d：出现没有等待者却仍占账的字节（泄漏）", waiters, global)
	}
	if st := s.Stats(); st.QueuedBodyBytes != want {
		t.Fatalf("Stats.QueuedBodyBytes = %d，want %d（观测面与实际占账必须同值）", st.QueuedBodyBytes, want)
	}
}

// rejectReason 取错误明细里的 details.reason（没有则返回空串）。
func rejectReason(e *apperr.Error) string {
	if e == nil {
		return ""
	}
	if v, ok := e.Details["reason"].(string); ok {
		return v
	}
	return ""
}

// waitWaiting 轮询等待调度器的排队总人数达到 want（带超时）。
func waitWaiting(t *testing.T, s *Scheduler, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s.Stats().Waiting == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待排队人数 = %d 超时，实际 %d", want, s.Stats().Waiting)
}

// waitUntil 轮询等待条件成立（带超时），失败时打印最终的 Stats。
func waitUntil(t *testing.T, s *Scheduler, cond func(Stats) bool, what string) Stats {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st := s.Stats(); cond(st) {
			return st
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s（stats=%+v）", what, s.Stats())
	return Stats{}
}

// spawnQueued 在一个 goroutine 里排队；结果（ticket 或 error）写进 out。
// 调用方负责用 cancel 让它可以退出，并从 out 里取回结果（Release ticket）。
func spawnQueued(s *Scheduler, ctx context.Context, appID string, user, bodyBytes int64,
	out chan<- queuedResult) {
	go func() {
		tk, e := s.AcquireWithSize(ctx, appID, user, bodyBytes)
		out <- queuedResult{tk: tk, err: e}
	}()
}

type queuedResult struct {
	tk  *Ticket
	err *apperr.Error
}

// drainResult 从 out 取一个结果；拿到 ticket 时**不**自动 Release（调用方按序断言）。
func drainResult(t *testing.T, out <-chan queuedResult, what string) queuedResult {
	t.Helper()
	select {
	case r := <-out:
		return r
	case <-time.After(10 * time.Second):
		t.Fatalf("%s：等待结果超时", what)
		return queuedResult{}
	}
}

// TestQueueBodyBudgetDefaultsFromLimits：预算的缺省值只有一个真源（limits），
// 且必须容得下"一个默认深度满配的应用"（否则常见热点会被别的应用误拒）。
//
// 变异：把 DefaultOptions 的 QueueBodyBytes 去掉（回到 0/无上界）⇒ 本用例第一个断言红。
func TestQueueBodyBudgetDefaultsFromLimits(t *testing.T) {
	if got := DefaultOptions().QueueBodyBytes; got != limits.WasmQueueBodyBytesMax {
		t.Fatalf("缺省排队体预算 = %d，want limits.WasmQueueBodyBytesMax = %d",
			got, limits.WasmQueueBodyBytesMax)
	}
	// 零值 ⇒ 回落默认（装配点不必显式填）。
	if got := New(Options{}).Options().QueueBodyBytes; got != limits.WasmQueueBodyBytesMax {
		t.Fatalf("零值 Options 必须回落默认预算，得到 %d", got)
	}
	// 一个默认队列满配的应用（AppQueueDepth × AppRequestBodyMaxBytes）必须装得下：
	// 否则"这个应用的 32 个等待者"会因为别的应用在排队而被拒 —— 那是误伤，不是保护。
	var oneFullApp = int64(limits.AppQueueDepth) * int64(limits.AppRequestBodyMaxBytes)
	if int64(limits.WasmQueueBodyBytesMax) < oneFullApp {
		t.Fatalf("预算 %d 装不下一个默认深度的满配应用 %d", limits.WasmQueueBodyBytesMax, oneFullApp)
	}
	// 它必须**显著小于**"合法最大配置"的乘积（4 GiB）—— 那正是本笔账要封顶的东西。
	var legalMaxProduct = int64(4096) * int64(limits.AppRequestBodyMaxBytes)
	if int64(limits.WasmQueueBodyBytesMax) >= legalMaxProduct/4 {
		t.Fatalf("预算 %d 不得接近合法最大配置的乘积 %d（否则什么都没封住）",
			limits.WasmQueueBodyBytesMax, legalMaxProduct)
	}
}

// TestQueueBodyBudgetRejectsAndRestores 是核心行为判据：
// 超预算 ⇒ 429 + reason=queue_bytes_exceeded；离开队列后额度恢复（可再次入队）。
//
// 变异：删掉 AcquireWithSize 里的 bodyBytes 预算检查 ⇒ 第三个请求不再 429（红）；
// 删掉授权路径的 refundQueuedBodyLocked ⇒ "额度恢复"那一步 429（红）。
func TestQueueBodyBudgetRejectsAndRestores(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 32 // 条数不是瓶颈：本用例只测**字节**闸门
	o.PerUserPerAppQueued = 32
	o.PerUserGlobalRunning = 32
	o.QueueBodyBytes = 4 << 10 // 4 KiB：两个 2 KiB 就满
	s := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	held, err := s.Acquire(ctx, "hot-app", 0)
	if err != nil {
		t.Fatalf("占住执行槽: %v", err)
	}

	// 两个 2 KiB 的请求排队（刚好占满 4 KiB）。
	queued := make(chan queuedResult, 2)
	spawnQueued(s, ctx, "hot-app", 1, 2<<10, queued)
	spawnQueued(s, ctx, "hot-app", 2, 2<<10, queued)
	waitWaiting(t, s, 2)
	assertLedgerBalanced(t, s, 4<<10)
	if st := s.Stats(); st.MaxQueuedBodyBytes != 4<<10 {
		t.Fatalf("峰值 = %d，want 4 KiB（峰值必须随入队抬高）", st.MaxQueuedBodyBytes)
	}
	if st := s.Stats(); st.QueueBodyBytesLimit != 4<<10 {
		t.Fatalf("Stats.QueueBodyBytesLimit = %d，want 4 KiB（上限必须可读）", st.QueueBodyBytesLimit)
	}

	// 第 3 个：字节预算已满 ⇒ fail-closed 429，且**原因可分辨**。
	//
	// ⚠️ 这里用一个**短超时** ctx：本用例的价值在于"没有队列体预算时必须被拒"，
	// 而缺失预算检查的实现会让这个请求真的入队 → 用 Background ctx 会挂满端到端墙钟
	// （60 s）。短超时让变异以 wall_clock_exceeded 快速收场（仍然红，且红得快）。
	rctx, rcancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer rcancel()
	_, qerr := s.AcquireWithSize(rctx, "hot-app", 3, 1<<10)
	if qerr == nil {
		t.Fatal("排队体预算满时必须 429（fail-closed）")
	}
	if qerr.Code != apperr.CodeAppQueueFull {
		t.Fatalf("错误码 = %s，want APP_QUEUE_FULL", qerr.Code)
	}
	if got := rejectReason(qerr); got != "queue_bytes_exceeded" {
		t.Fatalf("details.reason = %q，want queue_bytes_exceeded（否则运维分不清是队列条数满还是内存满）", got)
	}
	if len(qerr.Hints) == 0 {
		t.Fatal("必须带可操作 hint（告诉调用方这是平台排队内存满、该怎么退避）")
	}
	// 被拒的请求**不得**占账（超卖一次就多一份常驻）。
	assertLedgerBalanced(t, s, 4<<10)
	if st := s.Stats(); st.RejectedQueueBytes != 1 {
		t.Fatalf("RejectedQueueBytes = %d，want 1（拒因必须单独计数）", st.RejectedQueueBytes)
	}

	// 释放执行槽 ⇒ 队首被授权 ⇒ 它那 2 KiB 出队（不再占**排队**体）。
	held.Release()
	first := drainResult(t, queued, "释放执行槽后队首应被授权")
	if first.err != nil {
		t.Fatalf("队首应被授权，得到错误 %v", first.err)
	}
	assertLedgerBalanced(t, s, 2<<10)

	// 额度恢复：再进一个 2 KiB 的请求必须**能**入队（而不是永久卡在"预算已满"）。
	spawnQueued(s, ctx, "hot-app", 4, 2<<10, queued)
	waitWaiting(t, s, 2) // 剩下的 2 KiB + 新的 2 KiB
	assertLedgerBalanced(t, s, 4<<10)

	// 收尾：取消 ctx ⇒ 队列里的等待者走超时路径归还额度。
	first.tk.Release()
	cancel()
	for i := 0; i < 2; i++ {
		if r := drainResult(t, queued, "收尾等待排队者退出"); r.tk != nil {
			r.tk.Release()
		}
	}
	assertLedgerBalanced(t, s, 0)
}

// TestQueueBodyBytesReturnedOnAllExitPaths：**三条**离开队列的路径都要归还额度。
//
//	①被授权（pumpAppLocked）②排队超时/取消（removeWaiterLocked）③被拒（未入队 ⇒ 不占账）
//
// 变异：把 refundQueuedBodyLocked 从 pumpAppLocked 里删掉 ⇒ ①之后计数漂移（红）；
// 从 removeWaiterLocked 里删掉 ⇒ ②之后计数漂移（红）。
func TestQueueBodyBytesReturnedOnAllExitPaths(t *testing.T) {
	base := func() Options {
		o := DefaultOptions()
		o.PerAppRunning = 1
		o.PerAppQueue = 4
		o.PerUserPerAppQueued = 4
		o.PerUserGlobalRunning = 8
		o.QueueBodyBytes = 64 << 10
		return o
	}

	// ① 被授权：排队 → 释放槽位 → 额度归还。
	{
		s := New(base())
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		held, err := s.Acquire(ctx, "grant-app", 0)
		if err != nil {
			t.Fatalf("① 占住: %v", err)
		}
		out := make(chan queuedResult, 1)
		spawnQueued(s, ctx, "grant-app", 1, 3<<10, out)
		waitQueued(t, s, "grant-app", 1)
		assertLedgerBalanced(t, s, 3<<10)
		held.Release()
		r := drainResult(t, out, "① 授权路径")
		if r.err != nil || r.tk == nil {
			t.Fatalf("① 应拿到 ticket：%v", r.err)
		}
		// 被授权 ⇒ 已离开队列 ⇒ 不再占**排队**体（它现在算"在跑"，由并发上限约束）。
		assertLedgerBalanced(t, s, 0)
		r.tk.Release()
	}

	// ② 超时/取消：短 ctx 排队 ⇒ 走 removeWaiterLocked 归还。
	{
		s := New(base())
		held, err := s.Acquire(context.Background(), "timeout-app", 0)
		if err != nil {
			t.Fatalf("② 占住: %v", err)
		}
		short, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		_, terr := s.AcquireWithSize(short, "timeout-app", 1, 5<<10)
		if terr == nil {
			t.Fatal("② 排队超过墙钟必须 429")
		}
		if got := rejectReason(terr); got != "wall_clock_exceeded" {
			t.Fatalf("② 超时原因 = %q，want wall_clock_exceeded", got)
		}
		assertLedgerBalanced(t, s, 0)
		if st := s.Stats(); st.RejectedWallClock != 1 {
			t.Fatalf("② RejectedWallClock = %d，want 1", st.RejectedWallClock)
		}
		held.Release()
	}

	// ③ 被拒（条数满 / 用户占位满）：**一个字节都不许占**。
	{
		o := base()
		o.PerAppQueue = 1
		o.PerUserPerAppQueued = 1
		s := New(o)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		held, err := s.Acquire(ctx, "reject-app", 0)
		if err != nil {
			t.Fatalf("③ 占住: %v", err)
		}
		out := make(chan queuedResult, 1)
		spawnQueued(s, ctx, "reject-app", 1, 1<<10, out)
		waitQueued(t, s, "reject-app", 1)

		// 条数满（PerAppQueue=1）⇒ 拒，且不占账。
		if _, e := s.AcquireWithSize(ctx, "reject-app", 2, 1<<10); e == nil {
			t.Fatal("③ 队列条数满必须 429")
		}
		if got := s.Stats().QueuedBodyBytes; got != 1<<10 {
			t.Fatalf("③ 被条数闸门拒的请求占了账：%d，want %d", got, int64(1<<10))
		}
		// 用户占位满 ⇒ 拒，同样不占账。
		if _, e := s.AcquireWithSize(ctx, "reject-app", 1, 1<<10); e == nil {
			t.Fatal("③ 用户占位满必须 429")
		}
		if got := s.Stats().QueuedBodyBytes; got != 1<<10 {
			t.Fatalf("③ 被用户占位闸门拒的请求占了账：%d，want %d", got, int64(1<<10))
		}
		// 这两个拒绝都不属于"排队内存满"，不得计入 RejectedQueueBytes。
		if st := s.Stats(); st.RejectedQueueBytes != 0 {
			t.Fatalf("③ RejectedQueueBytes = %d，want 0（条数/占位拒绝是另一类）", st.RejectedQueueBytes)
		}
		held.Release()
		cancel()
		if r := drainResult(t, out, "③ 收尾"); r.tk != nil {
			r.tk.Release()
		}
	}
}

// TestQueueBodyBudgetBoundsLegalMaxQueueConfig 是**评审现场的复现**：
// `app_queue` 取合法上界 4096（评审证据 applimits.go:403）时，4 GiB 已读体再也不可能
// 挂在队列里 —— 第 257 个 1 MiB 请求就被字节预算拒掉。
//
// 变异：删掉预算检查 ⇒ 排到 4096 条都不会被拒，QueuedBodyBytes 会到达 4 GiB
// （本用例的 cap/峰值/拒绝计数三条断言同时红）。
func TestQueueBodyBudgetBoundsLegalMaxQueueConfig(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 4096 // 合法最大条数（applimits.MaxAppQueue）
	o.PerUserPerAppQueued = 4096
	o.PerUserGlobalRunning = 4096
	// QueueBodyBytes 用缺省值（256 MiB）—— 本用例要验的正是**出厂配置**下的上界。
	s := New(o)
	if got := s.Options().QueueBodyBytes; got != limits.WasmQueueBodyBytesMax {
		t.Fatalf("前提：预算应为 limits 缺省 %d，得到 %d", limits.WasmQueueBodyBytesMax, got)
	}

	held, err := s.Acquire(context.Background(), "greedy-app", 0)
	if err != nil {
		t.Fatalf("占住执行槽: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	// 每个排队者用不同 userID：把"每用户占位"这条闸门排除掉，只留字节闸门。
	const attempts = int(limits.WasmQueueBodyBytesMax/limits.AppRequestBodyMaxBytes) + 3
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(user int64) {
			defer wg.Done()
			tk, e := s.AcquireWithSize(ctx, "greedy-app", user, limits.AppRequestBodyMaxBytes)
			if e == nil && tk != nil {
				tk.Release()
			}
		}(int64(i + 1))
	}
	wantCap := int(limits.WasmQueueBodyBytesMax / limits.AppRequestBodyMaxBytes) // 256
	st := waitUntil(t, s, func(st Stats) bool {
		return st.QueuedBodyBytes == int64(wantCap)*limits.AppRequestBodyMaxBytes
	}, "预算被 1 MiB 请求恰好吃满")

	if st.MaxQueuedBodyBytes > limits.WasmQueueBodyBytesMax {
		t.Fatalf("峰值 %d 超过全局预算 %d（超卖了）", st.MaxQueuedBodyBytes, limits.WasmQueueBodyBytesMax)
	}
	if st.Waiting != wantCap {
		t.Fatalf("排队人数 = %d，want %d（条数 4096 远未到，字节先封顶）", st.Waiting, wantCap)
	}
	// 反向判据：合法最大配置下**永远攒不出** 4 GiB（评审现场的 4096 × 1 MiB）。
	fourGiB := int64(4096) * limits.AppRequestBodyMaxBytes
	if st.QueuedBodyBytes >= fourGiB/8 {
		t.Fatalf("在队字节 = %d 已达到 %d 的 1/8：全局上界失效", st.QueuedBodyBytes, fourGiB)
	}

	// 再进一个 1 MiB：必须被**字节**闸门拒（不是条数闸门 —— 条数还有 4096-256 的余量）。
	// 短超时 ctx：缺预算检查的实现会真的入队，这里以墙钟快速收场（不挂满 60 s）。
	octx, ocancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer ocancel()
	_, over := s.AcquireWithSize(octx, "greedy-app", 9999, limits.AppRequestBodyMaxBytes)
	if over == nil {
		t.Fatal("超出全局排队体预算必须 429")
	}
	if got := rejectReason(over); got != "queue_bytes_exceeded" {
		t.Fatalf("拒因 = %q，want queue_bytes_exceeded（条数未满，说明是字节闸门）", got)
	}
	if st := s.Stats(); st.RejectedQueueBytes == 0 {
		t.Fatal("超预算的请求必须计入 RejectedQueueBytes")
	}
	// 归属也要正确（管理面 top_apps 要能指到应用）。
	wm := s.AppWatermarks(5)
	if len(wm) == 0 || wm[0].AppID != "greedy-app" {
		t.Fatalf("按应用水位应指向 greedy-app，得到 %+v", wm)
	}
	if wm[0].QueuedBodyBytes != int64(wantCap)*limits.AppRequestBodyMaxBytes {
		t.Fatalf("按应用的排队字节 = %d ≠ want %d", wm[0].QueuedBodyBytes, wantCap*limits.AppRequestBodyMaxBytes)
	}

	// 全量收尾：取消 ctx ⇒ 所有等待者走超时路径归还额度（**计数不漂移**的最终判据）。
	cancel()
	held.Release()
	wg.Wait()
	waitWaiting(t, s, 0)
	assertLedgerBalanced(t, s, 0)
	// 峰值是历史值：收尾后不得被清零/改写。
	if st := s.Stats(); st.MaxQueuedBodyBytes != int64(wantCap)*limits.AppRequestBodyMaxBytes {
		t.Fatalf("峰值应保留历史最大 %d，得到 %d", wantCap*limits.AppRequestBodyMaxBytes, st.MaxQueuedBodyBytes)
	}
}

// TestQueueBodyBudgetNoOversellWithMixedSizes：大/小 body 混排也不超卖 ——
// 判据是"**加上它之后**是否超过预算"，而不是"当前是否已满"。
//
// 变异：把判据改成 `if s.queuedBodyBytes >= limit`（当前已满才拒）⇒ 最后一个 1 KiB
// 会把账推到 5 KiB 以上（本用例红）。
func TestQueueBodyBudgetNoOversellWithMixedSizes(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 64
	o.PerUserPerAppQueued = 64
	o.PerUserGlobalRunning = 64
	o.QueueBodyBytes = 5 << 10 // 5 KiB
	s := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	held, err := s.Acquire(ctx, "mix-app", 0)
	if err != nil {
		t.Fatalf("占住: %v", err)
	}
	out := make(chan queuedResult, 2)
	var sum int64
	// 3 KiB + 1 KiB = 4 KiB（**未满** 5 KiB 预算）；再进 3 KiB ⇒ 4+3 = 7 KiB 会超。
	// ⚠️ 尺寸必须选成"当前未满、**加上就超**"：若判据写成"当前已满才拒"，
	// 第二个 3 KiB 就会被放行 ⇒ 账面变 7 KiB > 预算（超卖），本用例才抓得住。
	for i, size := range []int64{3 << 10, 1 << 10} {
		sum += size
		spawnQueued(s, ctx, "mix-app", int64(i+1), size, out)
		waitWaiting(t, s, i+1)
		assertLedgerBalanced(t, s, sum)
	}
	rctx, rcancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer rcancel()
	_, e := s.AcquireWithSize(rctx, "mix-app", 3, 3<<10)
	if e == nil {
		t.Fatal("5 KiB 预算下再进 3 KiB 必须被拒（4+3 > 5，超卖）")
	}
	if got := rejectReason(e); got != "queue_bytes_exceeded" {
		t.Fatalf("拒因 = %q，want queue_bytes_exceeded", got)
	}
	assertLedgerBalanced(t, s, 4<<10)
	if st := s.Stats(); st.MaxQueuedBodyBytes > 5<<10 {
		t.Fatalf("峰值 %d 超过预算 5 KiB（超卖）", st.MaxQueuedBodyBytes)
	}

	held.Release()
	cancel()
	for i := 0; i < 2; i++ {
		if r := drainResult(t, out, "混排收尾"); r.tk != nil {
			r.tk.Release()
		}
	}
	waitWaiting(t, s, 0)
	assertLedgerBalanced(t, s, 0)
}

// TestSetOptionsShrinkKeepsWaitersButFailsClosed：运行期把预算调小**不驱逐**已在队的
// 等待者（丢请求比 OOM 更糟：用户已经付了等待时间），但新的准入立刻按新预算 fail-closed。
//
// 变异：在 SetOptions 里加上"超预算就丢弃等待者"的逻辑 ⇒ 本用例第二个断言红。
func TestSetOptionsShrinkKeepsWaitersButFailsClosed(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 16
	o.PerUserPerAppQueued = 16
	o.PerUserGlobalRunning = 16
	o.QueueBodyBytes = 8 << 10
	s := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	held, err := s.Acquire(ctx, "shrink-app", 0)
	if err != nil {
		t.Fatalf("占住: %v", err)
	}
	out := make(chan queuedResult, 1)
	spawnQueued(s, ctx, "shrink-app", 1, 6<<10, out)
	waitQueued(t, s, "shrink-app", 1)
	assertLedgerBalanced(t, s, 6<<10)

	shrunk := o
	shrunk.QueueBodyBytes = 4 << 10 // 现在已在队的 6 KiB 就"超额"了
	s.SetOptions(shrunk)

	// 已在队的等待者保留（不被驱逐、不丢、不报错）。
	if _, w := s.AppStats("shrink-app"); w != 1 {
		t.Fatalf("收紧预算不得丢弃已在队的等待者，waiting=%d", w)
	}
	assertLedgerBalanced(t, s, 6<<10)
	if got := s.Stats().QueueBodyBytesLimit; got != 4<<10 {
		t.Fatalf("Stats 应反映收紧后的上限 %d，得到 %d", int64(4<<10), got)
	}
	// 新准入 fail-closed（此刻 6 KiB > 4 KiB 预算）。短超时 ctx：缺检查时快速红。
	sctx, scancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer scancel()
	_, e := s.AcquireWithSize(sctx, "shrink-app", 2, 1<<10)
	if e == nil {
		t.Fatal("预算收紧后新准入必须 fail-closed")
	}
	if got := rejectReason(e); got != "queue_bytes_exceeded" {
		t.Fatalf("拒因 = %q，want queue_bytes_exceeded", got)
	}
	held.Release()
	cancel()
	if r := drainResult(t, out, "收紧收尾"); r.tk != nil {
		r.tk.Release()
	}
	waitWaiting(t, s, 0)
	assertLedgerBalanced(t, s, 0)
}

// TestQueueBodyRejectionCarriesActionableDetails：429 的 details 必须让调用方/运维
// 算出"还差多少"（此刻 / 上限 / 本次请求 / 峰值），不能只有一个 bool。
//
// 变异：把 WithDetail 那几行删掉 ⇒ 本用例红。
func TestQueueBodyRejectionCarriesActionableDetails(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.QueueBodyBytes = 2 << 10
	s := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	held, err := s.Acquire(ctx, "detail-app", 0)
	if err != nil {
		t.Fatalf("占住: %v", err)
	}
	defer held.Release()
	out := make(chan queuedResult, 1)
	spawnQueued(s, ctx, "detail-app", 1, 2<<10, out)
	waitWaiting(t, s, 1)

	dctx, dcancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer dcancel()
	_, e := s.AcquireWithSize(dctx, "detail-app", 2, limits.AppRequestBodyMaxBytes)
	if e == nil {
		t.Fatal("超预算必须 429")
	}
	for _, key := range []string{"reason", "queued_body_bytes", "queue_body_bytes_limit", "request_body_bytes"} {
		if _, ok := e.Details[key]; !ok {
			t.Fatalf("details 缺 %q（可操作性要求：调用方能算出还差多少）：%+v", key, e.Details)
		}
	}
	if got, ok := e.Details["queue_body_bytes_limit"].(int64); !ok || got != 2<<10 {
		t.Fatalf("details.queue_body_bytes_limit = %v，want %d", e.Details["queue_body_bytes_limit"], 2<<10)
	}
	if got, ok := e.Details["queued_body_bytes"].(int64); !ok || got != 2<<10 {
		t.Fatalf("details.queued_body_bytes = %v，want %d", e.Details["queued_body_bytes"], 2<<10)
	}
	// single body 大于整个预算的极端形态也必须 fail-closed（不是"永远进不去队列"的活锁）。
	if _, err := s.AcquireWithSize(dctx, "detail-app", 3, 1<<20); err == nil {
		t.Fatal("单请求体大于整个排队预算时必须 fail-closed")
	} else if got := rejectReason(err); got != "queue_bytes_exceeded" {
		t.Fatalf("拒因 = %q，want queue_bytes_exceeded", got)
	}
	// hint 里要有可读的体量（不是裸字节数），便于直接贴进工单。
	if !containsAny(e.Hints, "MiB", "KiB") {
		t.Fatalf("hint 应给出可读体量（MiB/KiB）：%v", e.Hints)
	}
}

// containsAny 报告 hay 里是否有任一 needle 出现在任一字符串中。
func containsAny(hay []string, needles ...string) bool {
	for _, h := range hay {
		for _, n := range needles {
			if strings.Contains(h, n) {
				return true
			}
		}
	}
	return false
}
