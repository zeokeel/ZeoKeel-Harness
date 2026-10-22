package queue

// 应用级限流覆盖的**行为判据**（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.6 第 4 条）。
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - `effectiveOptionsLocked` 不读覆盖（直接返回 s.opt）⇒
//     TestAppOverrideTightensOnlyThatApp、TestAppOverrideAboveGlobalLetsAppReachFour、
//     TestAppOverrideClearedReturnsToGlobal、TestAppOverrideTightenDoesNotInterruptRunning 全红；
//   - 只改 canRunLocked、不改 Acquire 的队列容量 / pumpAppLocked ⇒
//     TestAppOverrideQueueDepthAndWakeup 红（覆盖只在快路径生效）；
//   - pumpAppLocked 用全局上限 ⇒ 覆盖 app_running=1 之后 Release 仍会放行第二个等待者
//     （TestAppOverrideTightenDoesNotInterruptRunning 的后半段 + TestAppOverrideQueueDepthAndWakeup 红）；
//   - SetAppLimitOverride 清空时不清 map（只把值改成零值）⇒ TestAppOverrideClearedReturnsToGlobal 红
//     （AppLimitOverride 仍报 ok）。

import (
	"context"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
)

// appOverrideCtx 给本文件所有 Acquire 一个有界 ctx。
//
// 为什么不用 context.Background()：变异验证时会故意"去掉某处上限判据"，那时本该 429 的
// 调用会**永久阻塞**（没有 deadline，也没有槽位释放）—— 变异验证要的是"测试变红"，
// 不是"测试挂住"。有界 ctx 让这种变异以"拿到 wall_clock_exceeded 错误"的形式被断言出来。
func appOverrideCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// waitQueued 等到某应用的等待者数量达到 want（超时即失败）。
func waitQueued(t *testing.T, s *Scheduler, appID string, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, w := s.AppStats(appID); w == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, w := s.AppStats(appID)
	t.Fatalf("%s 的等待者 = %d，want %d", appID, w, want)
}

// mustNotGrant 断言在 wait 时间内拿不到槽（= 真的在排队，而不是被放行）。
func mustNotGrant(t *testing.T, done <-chan *Ticket, wait time.Duration, why string) {
	t.Helper()
	select {
	case tk := <-done:
		if tk != nil {
			tk.Release()
		}
		t.Fatalf("%s（请求不该被授权）", why)
	case <-time.After(wait):
	}
}

// TestAppOverrideTightensOnlyThatApp：给 A 设 app_running=1 ⇒ 同应用第 2 个并发排队，
// 而**其他应用不受影响**（B 仍按全局 2 并发）。
func TestAppOverrideTightensOnlyThatApp(t *testing.T) {
	o := DefaultOptions()
	if o.PerAppRunning < 2 {
		t.Fatalf("本用例前提：全局每应用并发 > 1（得到 %d）", o.PerAppRunning)
	}
	s := New(o)
	s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 1})
	ctx := appOverrideCtx(t)

	a1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("A 的第一个请求应可运行: %v", err)
	}
	// A 的第二个请求必须排队（AppRunning=1）。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 2)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	waitQueued(t, s, "app-a", 1)
	mustNotGrant(t, done, 100*time.Millisecond, "A 设了 app_running=1 时第二个请求必须排队")

	// B 没有覆盖 ⇒ 仍按全局并发（2 个都能立刻跑）。
	b1, err := s.Acquire(ctx, "app-b", 1)
	if err != nil {
		t.Fatalf("B 的请求不该被 A 的覆盖影响: %v", err)
	}
	b2, err := s.Acquire(ctx, "app-b", 2)
	if err != nil {
		t.Fatalf("B 应按全局 app_running=%d 放行第 2 个: %v", o.PerAppRunning, err)
	}

	// 释放 A 的第一个 ⇒ 排队的第二个被唤醒（收紧不影响已排队的请求）。
	a1.Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("A 释放后其排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("A 释放后排队请求未被唤醒")
	}
	b1.Release()
	b2.Release()
}

// TestAppOverrideAboveGlobalLetsAppReachFour：B 设 app_running=4 而全局 2 ⇒ B 能到 4，
// A（无覆盖）仍然只能到 2。这是"允许高于全局"（决策 §2.1）的行为判据。
func TestAppOverrideAboveGlobalLetsAppReachFour(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 2 // 固定前提，不依赖默认值
	o.PerUserPerAppRunning = 4
	s := New(o)
	s.SetAppLimitOverride("app-b", limits.AppOverride{AppRunning: 4})
	ctx := appOverrideCtx(t)

	var held []*Ticket
	for i := 0; i < 4; i++ {
		tk, err := s.Acquire(ctx, "app-b", int64(10+i))
		if err != nil {
			t.Fatalf("B 的第 %d 个请求应按覆盖 4 放行: %v", i+1, err)
		}
		held = append(held, tk)
	}
	if running, _ := s.AppStats("app-b"); running != 4 {
		t.Fatalf("B 应在跑 4，得到 %d", running)
	}
	// 第 5 个必须排队（覆盖 4 仍是上限）。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-b", 99)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	waitQueued(t, s, "app-b", 1)
	mustNotGrant(t, done, 100*time.Millisecond, "B 的覆盖是 4，第 5 个必须排队")

	// A 没有覆盖 ⇒ 只能到全局 2。
	a1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("A 第 1 个: %v", err)
	}
	a2, err := s.Acquire(ctx, "app-a", 2)
	if err != nil {
		t.Fatalf("A 第 2 个: %v", err)
	}
	doneA := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 3)
		if e != nil {
			doneA <- nil
			return
		}
		doneA <- tk
	}()
	waitQueued(t, s, "app-a", 1)
	mustNotGrant(t, doneA, 100*time.Millisecond, "A 没有覆盖，第 3 个必须按全局 2 排队")
	a1.Release()
	select {
	case tk := <-doneA:
		if tk == nil {
			t.Fatal("A 释放后排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("A 释放后排队请求未被唤醒")
	}
	a2.Release()
	for _, tk := range held {
		tk.Release()
	}
}

// TestAppOverrideClearedReturnsToGlobal：清空覆盖后回到全局值（内存表里那条真的没了）。
func TestAppOverrideClearedReturnsToGlobal(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 2
	s := New(o)
	ctx := appOverrideCtx(t)

	s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 1})
	if ov, ok := s.AppLimitOverride("app-a"); !ok || ov.AppRunning != 1 {
		t.Fatalf("覆盖没存进去：%+v ok=%v", ov, ok)
	}
	s.SetAppLimitOverride("app-a", limits.AppOverride{}) // 清空
	if ov, ok := s.AppLimitOverride("app-a"); ok {
		t.Fatalf("清空后仍能读到覆盖：%+v", ov)
	}
	if s.AppLimitOverrideCount() != 0 {
		t.Fatalf("清空后覆盖表应为空，得到 %d", s.AppLimitOverrideCount())
	}

	// 行为：回到全局 2（两个并发都能跑）。
	t1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("第 1 个: %v", err)
	}
	t2, err := s.Acquire(ctx, "app-a", 2)
	if err != nil {
		t.Fatalf("清空覆盖后应按全局 2 放行第 2 个: %v", err)
	}
	t1.Release()
	t2.Release()
}

// TestAppOverrideTightenDoesNotInterruptRunning：收紧**不打断在跑**（决策 §2.4）。
func TestAppOverrideTightenDoesNotInterruptRunning(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 2
	s := New(o)
	ctx := appOverrideCtx(t)

	t1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("第 1 个: %v", err)
	}
	t2, err := s.Acquire(ctx, "app-a", 2)
	if err != nil {
		t.Fatalf("第 2 个: %v", err)
	}
	// 收紧到 1：两个在跑的必须继续跑（只是不再放行新的）。
	s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 1})
	if running, _ := s.AppStats("app-a"); running != 2 {
		t.Fatalf("收紧不该打断在跑：running=%d，want 2", running)
	}
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 3)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	waitQueued(t, s, "app-a", 1)
	mustNotGrant(t, done, 100*time.Millisecond, "收紧到 app_running=1 后新请求必须排队")

	// 释放一个 ⇒ 仍有 1 个在跑（= 新上限）⇒ 排队者**不能**被放行。
	t1.Release()
	mustNotGrant(t, done, 150*time.Millisecond, "在跑数仍等于新上限 1，排队者不该被唤醒")
	// 再释放 ⇒ 现在可以放行。
	t2.Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("在跑清零后排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("在跑清零后排队请求未被唤醒")
	}
}

// TestAppOverrideQueueDepthAndWakeup：队列容量与"每用户占位"也必须按覆盖值判
// （决策 §2.2：`Acquire` 的队列容量与用户占位检查用 effectiveOptionsLocked）。
//
// 两个场景分别钉住两条容量判据（顺序与 Acquire 里的检查顺序一致：先应用队列、再每用户）：
//   - A 覆盖 app_queue=1 ⇒ 第 2 个等待者立刻 429，details.queue_depth = 1（不是全局 8）；
//   - B 覆盖 user_per_app_queued=1 ⇒ 同一用户的第 2 个等待者 429，details.per_user_queued = 1。
func TestAppOverrideQueueDepthAndWakeup(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 1
	o.PerAppQueue = 8
	o.PerUserPerAppQueued = 8
	s := New(o)
	s.SetAppLimitOverride("app-a", limits.AppOverride{AppQueue: 1})
	s.SetAppLimitOverride("app-b", limits.AppOverride{UserPerAppQueued: 1})
	ctx := appOverrideCtx(t)

	// ---- 场景 1：应用队列长度覆盖 ----
	heldA, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("占满 A 的在跑槽: %v", err)
	}
	queuedA := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 2)
		if e != nil {
			queuedA <- nil
			return
		}
		queuedA <- tk
	}()
	waitQueued(t, s, "app-a", 1)

	_, qerr := s.Acquire(ctx, "app-a", 3)
	if qerr == nil {
		t.Fatal("app_queue 覆盖为 1 时第 2 个等待者必须 429")
	}
	if qerr.Code != apperr.CodeAppQueueFull {
		t.Fatalf("code=%s want APP_QUEUE_FULL", qerr.Code)
	}
	if qerr.Details["queue_depth"] != 1 {
		t.Fatalf("details.queue_depth = %v，want 1（覆盖值，不是全局 8）", qerr.Details["queue_depth"])
	}
	heldA.Release()
	select {
	case tk := <-queuedA:
		if tk == nil {
			t.Fatal("释放后 A 的排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后 A 的排队请求未被唤醒")
	}

	// ---- 场景 2：每用户占位覆盖 ----
	heldB, err := s.Acquire(ctx, "app-b", 1)
	if err != nil {
		t.Fatalf("占满 B 的在跑槽: %v", err)
	}
	queuedB := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-b", 7)
		if e != nil {
			queuedB <- nil
			return
		}
		queuedB <- tk
	}()
	waitQueued(t, s, "app-b", 1)

	_, uerr := s.Acquire(ctx, "app-b", 7)
	if uerr == nil {
		t.Fatal("user_per_app_queued 覆盖为 1 时同一用户的第 2 个等待者必须 429")
	}
	if uerr.Details["per_user_queued"] != 1 {
		t.Fatalf("details.per_user_queued = %v，want 1（覆盖值，不是全局 8）：%v",
			uerr.Details["per_user_queued"], uerr.Details)
	}
	heldB.Release()
	select {
	case tk := <-queuedB:
		if tk == nil {
			t.Fatal("释放后 B 的排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后 B 的排队请求未被唤醒")
	}
}

// TestAppOverridePerUserAxis：单用户同应用并发也必须按覆盖值判（0 = 继承）。
func TestAppOverridePerUserAxis(t *testing.T) {
	o := DefaultOptions()
	o.PerAppRunning = 4
	o.PerUserPerAppRunning = 1 // 全局：单用户串行
	s := New(o)
	// A 覆盖成 3 ⇒ 同一用户可在 A 里同时跑 3 个。
	s.SetAppLimitOverride("app-a", limits.AppOverride{UserPerAppRunning: 3})
	ctx := appOverrideCtx(t)

	var held []*Ticket
	for i := 0; i < 3; i++ {
		tk, err := s.Acquire(ctx, "app-a", 7)
		if err != nil {
			t.Fatalf("覆盖后的第 %d 个应可运行: %v", i+1, err)
		}
		held = append(held, tk)
	}
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 7)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	waitQueued(t, s, "app-a", 1)
	mustNotGrant(t, done, 100*time.Millisecond, "覆盖 3 之后同一用户第 4 个必须排队")
	held[0].Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("释放后排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后排队请求未被唤醒")
	}
	for _, tk := range held[1:] {
		tk.Release()
	}
}

// TestSetAppLimitOverridesReplacesTable：启动期整表装载是**替换**语义
// （库里删掉的覆盖不能因为重启继续存活）。
func TestSetAppLimitOverridesReplacesTable(t *testing.T) {
	s := New(DefaultOptions())
	s.SetAppLimitOverride("stale-app", limits.AppOverride{AppRunning: 1})
	s.SetAppLimitOverrides(map[string]limits.AppOverride{
		"app-a": {AppRunning: 2},
		"":      {AppRunning: 1}, // 空 app_id ⇒ 跳过
		"app-z": {},              // 零值 ⇒ 跳过（= 无覆盖）
	})
	if got := s.AppLimitOverrideCount(); got != 1 {
		t.Fatalf("整表装载后应有 1 条覆盖（空 app_id / 零值被归一化跳过），得到 %d", got)
	}
	if _, ok := s.AppLimitOverride("stale-app"); ok {
		t.Fatal("整表装载必须替换旧表（stale-app 的覆盖应消失）")
	}
	if ov, ok := s.AppLimitOverride("app-a"); !ok || ov.AppRunning != 2 {
		t.Fatalf("app-a 的覆盖装载失败：%+v ok=%v", ov, ok)
	}
}

// TestEffectiveOptionsOnlyOverridesFourAxes：覆盖只动四轴，全局并发/墙钟恒用全局值。
func TestEffectiveOptionsOnlyOverridesFourAxes(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	s.SetAppLimitOverride("app-a", limits.AppOverride{
		AppRunning: 1, AppQueue: 2, UserPerAppRunning: 1, UserPerAppQueued: 1,
	})
	eff := s.EffectiveOptions("app-a")
	if eff.PerAppRunning != 1 || eff.PerAppQueue != 2 || eff.PerUserPerAppRunning != 1 || eff.PerUserPerAppQueued != 1 {
		t.Fatalf("四轴覆盖没生效：%+v", eff)
	}
	if eff.GlobalRunning != o.GlobalRunning || eff.PerUserGlobalRunning != o.PerUserGlobalRunning || eff.WallClock != o.WallClock {
		t.Fatalf("覆盖不该改全局/墙钟：%+v（全局 %+v）", eff, o)
	}
	// 未覆盖的应用拿到全局值。
	if got := s.EffectiveOptions("app-other"); got != o {
		t.Fatalf("未覆盖应用应拿到全局 Options，得到 %+v", got)
	}
}

// TestAppOverrideWideningWakesWaiters：**放宽/清空覆盖必须立刻唤醒已在排队的请求**
// （决策 §2.4）。2026-10-22 反证 F-3：实现里有 `pumpAllLocked()`，但全部用例都在
// "无等待者"时调用 SetAppLimitOverride ⇒ 删掉那两行仍然全绿（假绿）。
//
// 变异：删掉 SetAppLimitOverride / SetAppLimitOverrides 里的 `s.pumpAllLocked()`
// ⇒ 本条必须红（排队者要等到下一次 Release 才可能被唤醒）。
func TestAppOverrideWideningWakesWaiters(t *testing.T) {
	t.Run("widen", func(t *testing.T) {
		o := DefaultOptions()
		o.PerAppRunning = 1 // 全局：单应用串行
		o.PerUserPerAppRunning = 1
		o.PerUserGlobalRunning = 8
		s := New(o)
		ctx := appOverrideCtx(t)

		held, err := s.Acquire(ctx, "app-a", 1)
		if err != nil {
			t.Fatalf("占住在跑槽: %v", err)
		}
		s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 1})
		done := make(chan *Ticket, 1)
		go func() {
			tk, e := s.Acquire(ctx, "app-a", 2)
			if e != nil {
				done <- nil
				return
			}
			done <- tk
		}()
		waitQueued(t, s, "app-a", 1)

		// 放宽到 2：在跑仍是 held（1），但新上限允许第二个立刻放行。
		s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 2})
		select {
		case tk := <-done:
			if tk == nil {
				t.Fatal("放宽覆盖后排队请求应被授权")
			}
			tk.Release()
		case <-time.After(time.Second):
			t.Fatal("放宽 app_running 后没有唤醒已在排队的请求（SetAppLimitOverride 少了 pump）")
		}
		held.Release()
	})

	t.Run("clear", func(t *testing.T) {
		o := DefaultOptions()
		o.PerAppRunning = 2 // 全局允许 2
		o.PerUserPerAppRunning = 2
		o.PerUserGlobalRunning = 8
		s := New(o)
		ctx := appOverrideCtx(t)
		// 先收紧到 1，占住第 1 个并排一个等待者。
		s.SetAppLimitOverride("app-a", limits.AppOverride{AppRunning: 1})
		held, err := s.Acquire(ctx, "app-a", 1)
		if err != nil {
			t.Fatalf("占住: %v", err)
		}
		done := make(chan *Ticket, 1)
		go func() {
			tk, e := s.Acquire(ctx, "app-a", 2)
			if e != nil {
				done <- nil
				return
			}
			done <- tk
		}()
		waitQueued(t, s, "app-a", 1)

		// 清空覆盖 ⇒ 回到全局 2 ⇒ 等待者必须立刻被唤醒（仍在跑的是 held 一个）。
		s.SetAppLimitOverride("app-a", limits.AppOverride{})
		select {
		case tk := <-done:
			if tk == nil {
				t.Fatal("清空覆盖后排队请求应被授权")
			}
			tk.Release()
		case <-time.After(time.Second):
			t.Fatal("清空覆盖回到全局后没有唤醒已在排队的请求（SetAppLimitOverride 少了 pump）")
		}
		held.Release()
	})
}
