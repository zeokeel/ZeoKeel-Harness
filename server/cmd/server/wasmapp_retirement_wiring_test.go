//go:build apps

package main

// 退役真删调度（`wasm_retirement`）的**装配判据**（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.5、§9.7）。
//
// 为什么需要它（审计 2026-10-22 C-01/C-14）：本仓历史高发形态是"有实现、有登记、
// 没装配"或反过来（"注册了但没真的 Start"）。冻结/退役的承诺正是这样落空的 ——
// UI、审计链、limits 表四处承诺"到期平台回收"，而调度器不存在。所以这里判三件事：
//
//  1. 登记名常量 == "wasm_retirement"（运维按名字核对，字面值是契约）；
//  2. 真的登记 + 真的 Start 之后，`schedulerStatuses()` 里那一条**读数可得**
//     （started=true / runs>0 / readings=scheduler）—— 不是"表里有个名字"；
//  3. **生产装配源码**里 register 在 Start 之前、且三行（构造/登记/启动）都在
//     setupWasmPlatform 内 —— 源码级判据兜"测试里接好了、生产没接"的形态。
//
// 变异验证：
//   - 把 scheduler_status.go 的常量改名 ⇒ ① 红；
//   - 接缝只 register 不 Start ⇒ ② 的 runs>0 红（Started 也许为真，但一轮都不跑）；
//   - 把 registerSchedulerStatus 那行从 wasmapp.go 删掉 ⇒ ③ 红（状态表看不到它）；
//   - 把 retirementSched.Start(ctx) 删掉 ⇒ ③ 红（登记了但生产从不启动）。

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/retirement"
)

// TestWasmRetirementRegisteredAndObservable 判 ②：真登记 + 真启动之后读数可得。
func TestWasmRetirementRegisteredAndObservable(t *testing.T) {
	if schedulerWasmRetirement != "wasm_retirement" {
		t.Fatalf("登记名 = %q, want wasm_retirement（运维按这个名字核对状态表）", schedulerWasmRetirement)
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	resetSchedulerStatus(t)
	sched := retirement.NewScheduler(retirement.Options{
		DB: db, DataRoot: t.TempDir(), Tick: retirement.DefaultTick,
		Now: func() time.Time { return time.Now().UTC() },
	})
	registerSchedulerStatus(schedulerWasmRetirement, sched.Tick(), sched)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sched.Start(ctx)
	defer sched.Stop()

	// Start 会先跑一轮；等它把 runs 记上（无候选时也是一轮）。
	deadline := time.Now().Add(10 * time.Second)
	for sched.Runs() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	statuses := schedulerStatuses()
	if len(statuses) != 1 {
		t.Fatalf("状态表条目数 = %d, want 1（登记与启动必须成对）", len(statuses))
	}
	st := statuses[0]
	if st.Name != schedulerWasmRetirement {
		t.Fatalf("登记名 = %q, want %q", st.Name, schedulerWasmRetirement)
	}
	if !st.Started || st.StartedAt.IsZero() {
		t.Fatalf("%s: started=%v started_at=%v —— 登记了却没有真的启动", st.Name, st.Started, st.StartedAt)
	}
	if !st.MetricsAvailable {
		t.Fatalf("%s: readings 不可得 —— 退役作业**自记账**（Runs/Errors/LastRunAt），必须如实可得", st.Name)
	}
	if st.Source != schedulerSourceSelf {
		t.Fatalf("%s: readings 来源 = %q, want %q", st.Name, st.Source, schedulerSourceSelf)
	}
	if st.Runs < 1 {
		t.Fatalf("%s: runs = %d, want ≥1（启动先跑一轮：停机期间到期的应用不能等下一个 tick）", st.Name, st.Runs)
	}
	if st.Tick != retirement.DefaultTick {
		t.Fatalf("%s: tick = %v, want %v", st.Name, st.Tick, retirement.DefaultTick)
	}
	// 一行可 grep 的状态日志（字段齐全，运维据此判断作业有没有在跑）。
	line := schedulerStatusLine("startup", st)
	for _, want := range []string{"name=wasm_retirement", "started=true", "runs=", "readings=scheduler"} {
		if !strings.Contains(line, want) {
			t.Fatalf("状态日志缺 %q: %s", want, line)
		}
	}
}

// TestWasmRetirementWiredIntoProductionAssembly 判 ③：生产装配源码里三行都在且顺序正确。
func TestWasmRetirementWiredIntoProductionAssembly(t *testing.T) {
	src, err := os.ReadFile("wasmapp.go")
	if err != nil {
		t.Fatalf("读 wasmapp.go: %v", err)
	}
	text := string(src)
	registerAt := strings.Index(text, "registerSchedulerStatus(schedulerWasmRetirement")
	if registerAt < 0 {
		t.Fatal("wasmapp.go 里没有 registerSchedulerStatus(schedulerWasmRetirement…) —— " +
			"退役作业的运行状态不会进 schedulerStatuses()，运维面看不到它")
	}
	startAt := strings.Index(text, "retirementSched.Start(ctx)")
	if startAt < 0 {
		t.Fatal("wasmapp.go 里没有 retirementSched.Start(ctx) —— 登记了却从不启动（C-01 的原缺陷形态）")
	}
	if registerAt > startAt {
		t.Fatal("必须先登记再 Start：Start 会立刻跑一轮，排在登记之前的那一轮没有读数可查")
	}
	if !strings.Contains(text, "Retirement:    retirementSched") && !strings.Contains(text, "Retirement: retirementSched") {
		t.Fatal("wasmPlatform 必须持有 Retirement（装配级判据要能读到同一个实例，不允许再 new 一个）")
	}
}
