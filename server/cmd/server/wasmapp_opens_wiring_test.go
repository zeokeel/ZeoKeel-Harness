//go:build apps

package main

// `wasm_opens`（打开计数维护作业）与 C-10 运行期水位的**装配判据**
// （审计 2026-10-22 C-14 / C-10）。
//
// 为什么需要它：本仓历史高发形态是"有实现、有登记、没装配"或反过来
// （"注册了但没真的 Start"）。打开计数这条作业此前**两者都没有** ——
// 裸启动、不登记、无 Runs/Errors ⇒ 停摆时与"没人用"在运维面上同形。
// 这里判三件事：
//
//  1. 登记名常量 == "wasm_opens"（运维按名字核对，字面值是契约）；
//  2. 真的登记 + 真的 Start 之后，`schedulerStatuses()` 里那一条**读数可得**
//     （started=true / runs>0 / readings=scheduler）；
//  3. **生产装配源码**里登记在 Start 之前、读数注入与登记指向**同一个**实例，
//     并且 `module_cache`/`appdb_handles` 的访问器已接进 api.Options（C-10）——
//     源码级判据兜"测试里接好了、生产没接"的形态。
//
// 变异验证：
//   - 把 scheduler_status.go 的常量改名 ⇒ ① 红；
//   - 接缝只 register 不 Start ⇒ ② 的 runs>0 红；
//   - 把 registerSchedulerStatus(schedulerWasmOpens…) 从 wasmapp.go 删掉 ⇒ ③ 红；
//   - 把 opensSched.Start(ctx) 删掉 ⇒ ③ 红；
//   - 把 OpensHealth 换成另 new 一个 scheduler（读数与真跑的分叉）⇒ ③ 的
//     `opensSched.Runs()` 断言红；
//   - 删掉 ModuleCacheStats/AppDBPoolStats 注入 ⇒ ③ 的 C-10 断言红。

import (
	"bytes"
	"context"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/opens"
)

// TestWasmOpensRegisteredAndObservable 判 ②：真登记 + 真启动之后读数可得。
func TestWasmOpensRegisteredAndObservable(t *testing.T) {
	if schedulerWasmOpens != "wasm_opens" {
		t.Fatalf("登记名 = %q, want wasm_opens（运维按这个名字核对状态表）", schedulerWasmOpens)
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	resetSchedulerStatus(t)
	sched := opens.NewScheduler(db, opens.DefaultTick(), nil)
	registerSchedulerStatus(schedulerWasmOpens, sched.Tick(), sched)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sched.Start(ctx)

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
	if st.Name != schedulerWasmOpens {
		t.Fatalf("登记名 = %q, want %q", st.Name, schedulerWasmOpens)
	}
	if !st.Started || st.StartedAt.IsZero() {
		t.Fatalf("%s: started=%v started_at=%v —— 登记了却没有真的启动", st.Name, st.Started, st.StartedAt)
	}
	if !st.MetricsAvailable {
		t.Fatalf("%s: readings 不可得 —— 打开计数作业**自记账**（Runs/Errors/LastRunAt），必须如实可得", st.Name)
	}
	if st.Source != schedulerSourceSelf {
		t.Fatalf("%s: readings 来源 = %q, want %q", st.Name, st.Source, schedulerSourceSelf)
	}
	if st.Runs < 1 {
		t.Fatalf("%s: runs = %d, want ≥1（启动先跑一轮：停机积压不能等下一个 tick）", st.Name, st.Runs)
	}
	if st.Tick != opens.DefaultTick() {
		t.Fatalf("%s: tick = %v, want %v（登记的不是装配真正传进去的间隔）", st.Name, st.Tick, opens.DefaultTick())
	}
	// 一行可 grep 的状态日志（字段齐全，运维据此判断作业有没有在跑）。
	line := schedulerStatusLine("startup", st)
	for _, want := range []string{"name=wasm_opens", "started=true", "runs=", "readings=scheduler"} {
		if !strings.Contains(line, want) {
			t.Fatalf("状态日志缺 %q: %s", want, line)
		}
	}
}

// goSourceWithoutComments 返回**去掉注释**的源码渲染。
//
// 为什么不能直接搜原始文本（2026-10-22 实测踩到）：本文件的注释里会提到被断言的
// 代码形状（例如"登记经 registerSchedulerStatus(schedulerWasmOpens, …)"），
// 而字符串判据分不清"代码里有"与"注释里提过"—— 删掉真的那行，判据仍然绿。
// 与 cmd/server 既有的 mainGoCodeOnly 同一条纪律。
func goSourceWithoutComments(t *testing.T, filename string) string {
	t.Helper()
	src, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("读 %s: %v", filename, err)
	}
	fset := token.NewFileSet()
	// 不传 parser.ParseComments ⇒ AST 里没有注释节点，打印出来就是纯代码。
	f, err := parser.ParseFile(fset, filename, src, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", filename, err)
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, f); err != nil {
		t.Fatalf("print %s: %v", filename, err)
	}
	return buf.String()
}

// TestWasmOpensWiredIntoProductionAssembly 判 ③：生产装配源码里三行都在且顺序正确。
func TestWasmOpensWiredIntoProductionAssembly(t *testing.T) {
	text := goSourceWithoutComments(t, "wasmapp.go")

	// ① 构造 + 登记 + 启动三行都在，且登记**先于** Start。
	if !strings.Contains(text, "opensSched := opens.NewScheduler(db, opens.DefaultTick(), nil)") {
		t.Fatal("wasmapp.go 里没有构造 opens 调度器（作业不存在 ⇒ 看板数字永远不动）")
	}
	registerAt := strings.Index(text, "registerSchedulerStatus(schedulerWasmOpens")
	if registerAt < 0 {
		t.Fatal("wasmapp.go 里没有 registerSchedulerStatus(schedulerWasmOpens…) —— " +
			"打开计数作业的运行状态不会进 schedulerStatuses()，运维面看不到它（C-14）")
	}
	startAt := strings.Index(text, "opensSched.Start(ctx)")
	if startAt < 0 {
		t.Fatal("wasmapp.go 里没有 opensSched.Start(ctx) —— 登记了却从不启动")
	}
	if registerAt > startAt {
		t.Fatal("必须先登记再 Start：Start 会立刻跑一轮，排在登记之前的那一轮没有读数可查")
	}

	// ② 读数注入必须指向**同一个**实例（另 new 一个 = 读数与真跑的作业分叉）。
	if !strings.Contains(text, "OpensHealth: func() wasmapi.OpensJobHealth {") {
		t.Fatal("wasmapp.go 必须把 OpensHealth 注入 api.Options（opens/summary 的 stale/aggregated_until 依赖它）")
	}
	for _, want := range []string{"opensSched.Started()", "opensSched.Runs()", "opensSched.LastRunAt()", "opensSched.Tick()"} {
		if !strings.Contains(text, want) {
			t.Fatalf("OpensHealth 读数必须取自同一个 opensSched（缺 %q）", want)
		}
	}

	// ③ C-10：运行期水位访问器已接进 api.Options。
	for _, want := range []string{
		"ModuleCacheStats: func() wasmapi.ModuleCacheStats {",
		"appSrv.ModuleCacheStats()",
		"AppDBPoolStats: func() wasmapi.AppDBPoolStats {",
		"appSrv.AppDBPoolStats()",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("C-10：wasmapp.go 必须注入运行期水位访问器（缺 %q）", want)
		}
	}

	// ④ 死字段已删：`OpensCleanup` 零消费者（反证 F-6），留着会让"装配判据能读到
	// 同一个实例"变成假话。
	if strings.Contains(text, "OpensCleanup") {
		t.Fatal("wasmPlatform.OpensCleanup 是零消费者的死字段（反证 F-6）—— 必须删除，不要只加注释")
	}
}
