//go:build apps

package main

// 启动期装载**应用级限流覆盖**的判据（决策
// docs/decisions/2026-10-22-wasm-per-app-limits.md §2.2 / §2.6 第 6 条）。
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - loadWasmAppLimitOverrides 不调用 setter（只读不装）⇒
//     TestLoadWasmAppLimitOverridesAppliesToScheduler 红（首个请求不会按覆盖判定）；
//   - 合并语义而不是整表替换（在调度器已有表上追加）⇒
//     TestLoadWasmAppLimitOverridesReplacesStaleTable 红；
//   - 不按当前全局值校验（非法覆盖照单全收）⇒ TestLoadWasmAppLimitOverridesSkipsInvalid 红；
//   - setupWasmPlatform 不再调用装载（或调了但用编译期默认值而不是当前全局值）⇒
//     TestWasmPlatformWiresAppLimitOverridesAtStartup 红。

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/queue"
)

// appLimitIntPtr 返回整数的指针（构造 serverstore 的可空字段用）。
func appLimitIntPtr(v int) *int { return &v }

// newAppLimitScheduler 按一份全局 Limits 建调度器（与 setupWasmPlatform 的 qopt 同形）。
func newAppLimitScheduler(l applimits.Limits) *queue.Scheduler {
	return queue.New(queue.Options{
		GlobalRunning:        l.MaxInstances,
		PerAppRunning:        l.AppRunning,
		PerAppQueue:          l.AppQueue,
		PerUserGlobalRunning: l.UserGlobalRunning,
		PerUserPerAppRunning: l.UserPerAppRunning,
		PerUserPerAppQueued:  l.UserPerAppQueued,
		WallClock:            l.WallClock(),
	})
}

// TestLoadWasmAppLimitOverridesAppliesToScheduler：库里已有覆盖 ⇒ 装载后**首个请求**
// 就按覆盖判定（不是"等管理员再保存一次"）。
func TestLoadWasmAppLimitOverridesAppliesToScheduler(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	global := applimits.Defaults()
	global.AppRunning = 2
	global.UserPerAppRunning = 2
	if err := global.Validate(); err != nil {
		t.Fatalf("夹具全局限制项非法：%v", err)
	}

	// A：收紧成串行（决策 §2.6 第 4 条的原样用例）；B：放宽到 4。
	if _, err := serverstore.SetWasmAppLimitOverride(ctx, db,
		serverstore.WasmAppLimitOverride{AppID: "app-a", AppRunning: appLimitIntPtr(1)}, "seed"); err != nil {
		t.Fatalf("写 A 的覆盖: %v", err)
	}
	if _, err := serverstore.SetWasmAppLimitOverride(ctx, db,
		serverstore.WasmAppLimitOverride{AppID: "app-b", AppRunning: appLimitIntPtr(4)}, "seed"); err != nil {
		t.Fatalf("写 B 的覆盖: %v", err)
	}

	sched := newAppLimitScheduler(global)
	if got := sched.EffectiveOptions("app-a").PerAppRunning; got != global.AppRunning {
		t.Fatalf("装载前 app-a 应等于全局 %d，得到 %d", global.AppRunning, got)
	}
	n, err := loadWasmAppLimitOverrides(ctx, db, global, sched.SetAppLimitOverrides)
	if err != nil {
		t.Fatalf("装载失败: %v", err)
	}
	if n != 2 {
		t.Fatalf("装载条数 = %d，want 2", n)
	}

	// 首个请求即按覆盖：A 的第 2 个并发必须排队（全局是 2，若覆盖没装载就会被放行）。
	a1, aerr := sched.Acquire(ctx, "app-a", 1)
	if aerr != nil {
		t.Fatalf("A 的首个请求应可运行: %v", aerr)
	}
	done := make(chan struct{}, 1)
	go func() {
		if tk, e := sched.Acquire(ctx, "app-a", 2); e == nil {
			tk.Release()
		}
		done <- struct{}{}
	}()
	select {
	case <-done:
		a1.Release()
		t.Fatal("装载后 app-a 的第 2 个并发必须排队（app_running=1 的覆盖没生效）")
	case <-time.After(120 * time.Millisecond):
	}
	a1.Release()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("释放后排队请求未被唤醒")
	}

	// B 放宽到 4：四个并发都能拿到槽。
	var held []*queue.Ticket
	for i := 0; i < 4; i++ {
		tk, berr := sched.Acquire(ctx, "app-b", int64(10+i))
		if berr != nil {
			t.Fatalf("B 的第 %d 个并发应按覆盖 4 放行: %v", i+1, berr)
		}
		held = append(held, tk)
	}
	for _, tk := range held {
		tk.Release()
	}
}

// TestLoadWasmAppLimitOverridesSkipsInvalid：存进库的组合按**当前全局值**已非法时，
// 装载跳过并让该应用回到全局值（fail-closed：跳过只会更紧，绝不照单全收）。
func TestLoadWasmAppLimitOverridesSkipsInvalid(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	global := applimits.Defaults()
	global.AppRunning = 2
	// 模拟"保存时合法、之后全局被调小"：user_per_app_running=3 而全局 app_running=2。
	if _, err := serverstore.SetWasmAppLimitOverride(ctx, db,
		serverstore.WasmAppLimitOverride{AppID: "stale-app", UserPerAppRunning: appLimitIntPtr(3)}, "seed"); err != nil {
		t.Fatalf("写入历史覆盖: %v", err)
	}
	sched := newAppLimitScheduler(global)
	n, err := loadWasmAppLimitOverrides(ctx, db, global, sched.SetAppLimitOverrides)
	if err != nil {
		t.Fatalf("装载失败（非法条目应被跳过而不是让整次装载失败）: %v", err)
	}
	if n != 0 {
		t.Fatalf("非法覆盖必须被跳过，装载条数 = %d", n)
	}
	if _, ok := sched.AppLimitOverride("stale-app"); ok {
		t.Fatal("非法覆盖被装进了调度器")
	}
	if got := sched.EffectiveOptions("stale-app").PerUserPerAppRunning; got != global.UserPerAppRunning {
		t.Fatalf("跳过后应按全局 %d 判定，得到 %d", global.UserPerAppRunning, got)
	}
}

// TestLoadWasmAppLimitOverridesReplacesStaleTable：装载是**整表替换** ——
// 调度器里已有的旧覆盖（库里已删）不能在启动装载后继续存活。
func TestLoadWasmAppLimitOverridesReplacesStaleTable(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	global := applimits.Defaults()
	sched := newAppLimitScheduler(global)
	sched.SetAppLimitOverride("stale-app", limits.AppOverride{AppRunning: 1})

	n, err := loadWasmAppLimitOverrides(ctx, db, global, sched.SetAppLimitOverrides)
	if err != nil || n != 0 {
		t.Fatalf("空表装载：n=%d err=%v，want 0/nil", n, err)
	}
	if _, ok := sched.AppLimitOverride("stale-app"); ok {
		t.Fatal("启动装载必须整表替换（库里已删的覆盖不能继续留在内存里）")
	}
}

// TestWasmPlatformWiresAppLimitOverridesAtStartup 是**装配判据**：setupWasmPlatform 里
// 必须（a）在队列可用之后调用装载、且（b）把当前生效的全局限制项（limitsHolder.Get()）
// 作为校验基准、（c）把保存路径的下发钩子接到同一个调度器。
//
// 为什么用源码判据：(a)(b) 是**装配顺序/实参**问题，行为用例（上面的三个）覆盖不到
// "setup 里根本没调"。判据刻意断言**实参文本**（limitsHolder.Get()），因为传
// applimits.Defaults() 会让"控制台把全局调小之后，旧覆盖仍按默认值校验通过"。
func TestWasmPlatformWiresAppLimitOverridesAtStartup(t *testing.T) {
	raw, err := os.ReadFile("wasmapp.go")
	if err != nil {
		t.Fatalf("读 wasmapp.go: %v", err)
	}
	src := string(raw)

	call := "loadWasmAppLimitOverrides(ctx, db, limitsHolder.Get(), scheduler.SetAppLimitOverrides)"
	if !strings.Contains(src, call) {
		t.Fatalf("setupWasmPlatform 必须以当前全局限制项为基准装载覆盖：缺 %q", call)
	}
	hook := "AppLimitsApply: scheduler.SetAppLimitOverride,"
	if !strings.Contains(src, hook) {
		t.Fatalf("api.Options 必须把覆盖下发接到调度器：缺 %q", hook)
	}
	// 顺序：装载必须在队列构造之后、事件 sink/编译器之前（"队列已可用"才谈得上装载）。
	// 用**行号**而不是任意子串比较：同一文件里有多处 scheduler 相关代码。
	lineOf := func(s string) int {
		for i, line := range strings.Split(src, "\n") {
			if strings.Contains(line, s) {
				return i
			}
		}
		return -1
	}
	newIdx := lineOf("scheduler := queue.New(qopt)")
	loadIdx := lineOf("loadWasmAppLimitOverrides(ctx, db, limitsHolder.Get()")
	sinkIdx := lineOf("eventSink := events.NewSink(db, events.Options{})")
	if newIdx < 0 || loadIdx < 0 || sinkIdx < 0 {
		t.Fatalf("装配定位失败：new=%d load=%d sink=%d", newIdx, loadIdx, sinkIdx)
	}
	if !(newIdx < loadIdx && loadIdx < sinkIdx) {
		t.Fatalf("装载必须紧跟队列构造（new=%d < load=%d < sink=%d）", newIdx, loadIdx, sinkIdx)
	}
}

// TestReconcileWasmAppLimitOverridesClearsInvalid：**全局限制项变化**后按新全局值
// 重校验在册覆盖（2026-10-22 反证 F-6）：非法条目从库删除 + 审计，合法条目整表下发。
//
// 变异：reconcile 不调 ClearWasmAppLimitOverride ⇒ 库里非法行仍在（本用例红）；
// 不调 load ⇒ 调度器仍留着旧表（本用例红）；不写审计 ⇒ 最后一条红。
func TestReconcileWasmAppLimitOverridesClearsInvalid(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	// 新全局：max_instances=3 / app_running=2 ⇒ app_running=5 的覆盖已非法。
	global := applimits.Defaults()
	global.MaxInstances = 3
	global.AppRunning = 2
	global.UserPerAppRunning = 2
	if err := global.Validate(); err != nil {
		t.Fatalf("夹具全局限制项非法：%v", err)
	}

	if _, err := serverstore.SetWasmAppLimitOverride(ctx, db, serverstore.WasmAppLimitOverride{
		AppID: "keep-app", AppRunning: appLimitIntPtr(1),
	}, "admin"); err != nil {
		t.Fatalf("写合法覆盖: %v", err)
	}
	if _, err := serverstore.SetWasmAppLimitOverride(ctx, db, serverstore.WasmAppLimitOverride{
		AppID: "drop-app", AppRunning: appLimitIntPtr(5),
	}, "admin"); err != nil {
		t.Fatalf("写非法覆盖: %v", err)
	}

	sched := newAppLimitScheduler(global)
	// 预置一份"旧表"：模拟运行中已经有覆盖（reconcile 必须整表替换）。
	sched.SetAppLimitOverrides(map[string]limits.AppOverride{
		"drop-app":  {AppRunning: 5},
		"stale-app": {AppQueue: 1},
	})

	cleared, err := reconcileWasmAppLimitOverrides(ctx, db, global, sched.SetAppLimitOverrides)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if cleared != 1 {
		t.Fatalf("cleared = %d，want 1（只有 drop-app 非法）", cleared)
	}
	if rec, gerr := serverstore.GetWasmAppLimitOverride(ctx, db, "drop-app"); gerr != nil || rec != nil {
		t.Fatalf("非法覆盖必须从库里删除：rec=%+v err=%v", rec, gerr)
	}
	if rec, gerr := serverstore.GetWasmAppLimitOverride(ctx, db, "keep-app"); gerr != nil || rec == nil {
		t.Fatalf("合法覆盖不能被删：rec=%+v err=%v", rec, gerr)
	}
	if ov, ok := sched.AppLimitOverride("keep-app"); !ok || ov.AppRunning != 1 {
		t.Fatalf("合法覆盖必须重新下发：%+v ok=%v", ov, ok)
	}
	if _, ok := sched.AppLimitOverride("drop-app"); ok {
		t.Fatal("非法覆盖不该留在调度器里")
	}
	if _, ok := sched.AppLimitOverride("stale-app"); ok {
		t.Fatal("整表替换语义：旧表里已不存在的条目必须消失")
	}
	// 清理动作必须留痕（app 维度）。
	logs, lerr := serverstore.ListAuditLogsByApp(db, "drop-app", 10)
	if lerr != nil || len(logs) == 0 {
		t.Fatalf("全局收紧后的覆盖清理必须写审计（wasm_app_limits_change）：logs=%v err=%v", logs, lerr)
	}
}
