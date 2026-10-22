package applimits

// 应用级限流覆盖（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.1）的判据。
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - ApplyOverride 漏掉某一轴（例如 user_per_app_queued）⇒ TestApplyOverrideInheritsAndOverrides 红；
//   - 覆盖校验不调用 Limits.Validate（自己另写一套范围）⇒
//     TestApplyOverrideRejectsIllegalCombinations 的跨字段用例红；
//   - ParseOverride 忽略未知键（不 fail-loud）⇒ TestParseOverrideRejectsUnknownField 红；
//   - ParseOverride 把 `{}` 当成"四轴都设成 0"而不是清空语义 ⇒ TestParseOverrideClearForms 红；
//   - 默认值退回 1 ⇒ TestDefaultUserPerAppRunningIsTwo 红。

import (
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/memprofile"
)

// TestDefaultUserPerAppRunningIsTwo 钉住本轮默认值（决策 §1）：1 → 2。
//
// 判据三层：编译期常量 → applimits.Defaults() → 各部署档位折算后仍自洽
// （small 档 max_instances=3 ⇒ app_running 被钳到 3，user_per_app_running 2 仍 ≤ 3）。
func TestDefaultUserPerAppRunningIsTwo(t *testing.T) {
	if got := Defaults().UserPerAppRunning; got != 2 {
		t.Fatalf("applimits.Defaults().UserPerAppRunning = %d，want 2（决策 2026-10-22 §1）", got)
	}
	if err := Defaults().Validate(); err != nil {
		t.Fatalf("默认限制项自身非法：%v（%s）", err, Defaults().Encode())
	}
	if got := FromProfile(memprofile.Small()).UserPerAppRunning; got != 2 {
		t.Fatalf("small 档 user_per_app_running = %d，want 2（必须 ≤ 被钳后的 app_running）", got)
	}
	for _, p := range []memprofile.Profile{memprofile.Default(), memprofile.Small(), memprofile.Large()} {
		l := FromProfile(p)
		if err := l.Validate(); err != nil {
			t.Fatalf("档位 %s 折算后非法：%v（%s）", p.Name, err, l.Encode())
		}
	}
}

// TestApplyOverrideInheritsAndOverrides：0 = 继承，非 0 = 覆盖，且只有这四个轴受影响。
func TestApplyOverrideInheritsAndOverrides(t *testing.T) {
	global := Defaults()
	ov := AppOverride{AppRunning: 1, UserPerAppQueued: 9}

	eff := ApplyOverride(global, ov)
	if eff.AppRunning != 1 {
		t.Fatalf("app_running = %d，want 1（覆盖）", eff.AppRunning)
	}
	if eff.UserPerAppQueued != 9 {
		t.Fatalf("user_per_app_queued = %d，want 9（覆盖）", eff.UserPerAppQueued)
	}
	// 未覆盖的队列轴必须**原样继承**（不是 0）。
	if eff.AppQueue != global.AppQueue {
		t.Fatalf("未覆盖的 app_queue 没有继承全局：%+v（全局 %+v）", eff, global)
	}
	// 未覆盖的**子轴**在父轴被收紧时向下钳：app_running 覆盖成 1 ⇒ 继承来的
	// user_per_app_running（全局 2）必须跟着变成 1，否则"把应用降成串行"这个最常用的
	// 收紧会被判成非法组合（规则与理由见 limits.Axes.Resolve）。
	if eff.UserPerAppRunning != 1 {
		t.Fatalf("user_per_app_running = %d，want 1（继承值被收紧的 app_running 钳位）", eff.UserPerAppRunning)
	}
	// 覆盖只动四轴，其余字段（内存/时间预算）必须逐字相同。
	if eff.MaxInstances != global.MaxInstances || eff.GuestBudgetSeconds != global.GuestBudgetSeconds ||
		eff.InstanceMemoryMB != global.InstanceMemoryMB {
		t.Fatalf("覆盖改了不属于它的字段：%+v", eff)
	}
	// 零值覆盖 = 原样返回（这是"清空覆盖后回到全局"的判据）。
	if got := ApplyOverride(global, AppOverride{}); got != global {
		t.Fatalf("零值覆盖必须原样返回全局值，得到 %+v", got)
	}
}

// TestApplyOverrideClampsInheritedChildren 钉住"继承的子轴向下钳"这条规则
// （`limits.Axes.Resolve` 的唯一实现，queue 与 API 视图同源）。
//
// 判据四条：收紧父轴 ⇒ 继承子轴跟着降；显式子轴不被钳（交给 Validate 拒）；
// 放宽父轴不动子轴；钳位只向下（永不把子轴抬高）。
func TestApplyOverrideClampsInheritedChildren(t *testing.T) {
	global := Defaults() // app_running=4、user_per_app_running=2、app_queue=32、user_per_app_queued=4

	// ① 父轴收紧 ⇒ 继承的子轴跟着降。
	if eff := ApplyOverride(global, AppOverride{AppRunning: 1}); eff.UserPerAppRunning != 1 {
		t.Fatalf("app_running=1 时继承的 user_per_app_running = %d，want 1", eff.UserPerAppRunning)
	}
	if eff := ApplyOverride(global, AppOverride{AppQueue: 2}); eff.UserPerAppQueued != 2 {
		t.Fatalf("app_queue=2 时继承的 user_per_app_queued = %d，want 2", eff.UserPerAppQueued)
	}

	// ② 显式子轴**不**被钳（管理员明确要的组合交给 Validate 判，绝不静默改写）。
	eff := ApplyOverride(global, AppOverride{AppRunning: 1, UserPerAppRunning: 2})
	if eff.UserPerAppRunning != 2 {
		t.Fatalf("显式 user_per_app_running 被静默改写成 %d（必须是 2，由 Validate 拒）", eff.UserPerAppRunning)
	}
	if verr := ValidateOverride(global, AppOverride{AppRunning: 1, UserPerAppRunning: 2}); verr == nil {
		t.Fatal("显式 illegal 组合必须被 Validate 拒")
	}

	// ③ 放宽父轴不动子轴（钳位只向下：全局 user_per_app_running=2 不会被抬到 4）。
	if eff := ApplyOverride(global, AppOverride{AppRunning: 4}); eff.UserPerAppRunning != 2 {
		t.Fatalf("放宽 app_running 不该抬高 user_per_app_running（得到 %d，want 2）", eff.UserPerAppRunning)
	}

	// ④ 钳位结果自身必须过 Validate（否则"合法的保存"会产出非法生效值）。
	for _, ov := range []AppOverride{
		{AppRunning: 1}, {AppQueue: 1}, {AppRunning: 1, AppQueue: 1},
		{AppRunning: 2, UserPerAppRunning: 2},
	} {
		if verr := ValidateOverride(global, ov); verr != nil {
			t.Fatalf("覆盖 %+v 钳位后仍非法：%v（生效 %+v）", ov, verr, ApplyOverride(global, ov))
		}
	}
}

// TestApplyOverrideRejectsIllegalCombinations 钉住"per-app 与全局保存走同一份判据"：
// 每条非法组合都必须回 VALIDATION + 点名字段（Admin 要能直接看出改哪一格）。
func TestApplyOverrideRejectsIllegalCombinations(t *testing.T) {
	global := Defaults()
	cases := []struct {
		name  string
		ov    AppOverride
		field string
	}{
		{
			name:  "user_per_app_running > 本应用的 app_running",
			ov:    AppOverride{AppRunning: 1, UserPerAppRunning: 2},
			field: "user_per_app_running",
		},
		{
			name:  "app_running > max_instances",
			ov:    AppOverride{AppRunning: global.MaxInstances + 1},
			field: "app_running",
		},
		{
			name:  "app_queue > MaxAppQueue",
			ov:    AppOverride{AppQueue: MaxAppQueue + 1},
			field: "app_queue",
		},
		{
			name:  "user_per_app_queued > 本应用的 app_queue",
			ov:    AppOverride{AppQueue: 2, UserPerAppQueued: 3},
			field: "user_per_app_queued",
		},
		{
			name:  "负值（不是 0 ⇒ 不是继承，必须被拒）",
			ov:    AppOverride{AppRunning: -1},
			field: "app_running",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateOverride(global, tc.ov)
			if err == nil {
				t.Fatalf("%+v 必须被拒（全局 %s）", tc.ov, global.Encode())
			}
			if err.Details["field"] != tc.field {
				t.Fatalf("details.field = %v，want %q（details=%v）", err.Details["field"], tc.field, err.Details)
			}
			if len(err.Hints) == 0 {
				t.Fatal("必须有可操作 hint（全局值 + 允许范围）")
			}
			joined := strings.Join(err.Hints, " | ")
			if !strings.Contains(joined, "允许范围") {
				t.Fatalf("hint 必须给出允许范围：%v", err.Hints)
			}
			if _, ok := err.Details["effective"]; !ok {
				t.Fatalf("details 必须带 effective（前端要展示改完会变成什么）：%v", err.Details)
			}
		})
	}
}

// TestApplyOverrideAllowsExceedingGlobal：允许**高于全局**（管理员显式动作），
// 只要不越过绝对上界；`ExceedsGlobal` 如实报告哪些轴高（API 的确认提示）。
func TestApplyOverrideAllowsExceedingGlobal(t *testing.T) {
	global := Defaults() // app_running=4、app_queue=32、user_per_app_running=2
	ov := AppOverride{AppRunning: global.AppRunning, UserPerAppRunning: 4, AppQueue: 64}
	if err := ValidateOverride(global, ov); err != nil {
		t.Fatalf("高于全局但未越绝对上界必须放行：%v", err)
	}
	exceeds := OverrideExceedsGlobal(global, ov)
	if !exceeds["user_per_app_running"] || !exceeds["app_queue"] || exceeds["app_running"] {
		t.Fatalf("exceeds_global 算错了：%v（全局 %+v）", exceeds, global)
	}
	if eff := ApplyOverride(global, ov); eff.AppRunning != 4 || eff.UserPerAppRunning != 4 {
		t.Fatalf("生效值 = %+v", eff)
	}
}

// TestParseOverrideClearForms：null / 空 body / `{}` / 四键全 null 都是**清空**。
func TestParseOverrideClearForms(t *testing.T) {
	for _, body := range []string{"", "null", "{}", "  {  }  ",
		`{"app_running":null,"app_queue":null,"user_per_app_running":null,"user_per_app_queued":null}`} {
		ov, cleared, err := ParseOverride([]byte(body))
		if err != nil {
			t.Fatalf("body %q 不该报错：%v", body, err)
		}
		if !cleared || !ov.IsZero() {
			t.Fatalf("body %q 必须解析成「清空」，得到 cleared=%v ov=%+v", body, cleared, ov)
		}
	}
}

// TestParseOverridePartialAndNullValue：部分键 + 显式 null（= 继承）。
func TestParseOverridePartialAndNullValue(t *testing.T) {
	ov, cleared, err := ParseOverride([]byte(`{"app_running":1,"app_queue":null,"user_per_app_running":2}`))
	if err != nil || cleared {
		t.Fatalf("合法部分覆盖解析失败：cleared=%v err=%v", cleared, err)
	}
	if ov.AppRunning != 1 || ov.UserPerAppRunning != 2 {
		t.Fatalf("解析结果 = %+v", ov)
	}
	if ov.AppQueue != 0 || ov.UserPerAppQueued != 0 {
		t.Fatalf("null/缺失的轴必须是继承（0），得到 %+v", ov)
	}
}

// TestParseOverrideRejectsUnknownField：未知顶层键 fail-loud（与全局 limits 信封同一纪律）。
func TestParseOverrideRejectsUnknownField(t *testing.T) {
	_, _, err := ParseOverride([]byte(`{"app_running":1,"max_instances":64}`))
	if err == nil {
		t.Fatal("未知键必须被拒（拼错字段名会让改动静默不生效）")
	}
	if err.Details["field"] != "max_instances" {
		t.Fatalf("details.field = %v，want max_instances", err.Details["field"])
	}
	if err.Details["allowed"] == nil {
		t.Fatalf("必须回显允许的键集合：%v", err.Details)
	}
}

// TestParseOverrideRejectsNonInteger：类型错误必须点名到字段（不是一句笼统的语法错误）。
func TestParseOverrideRejectsNonInteger(t *testing.T) {
	_, _, err := ParseOverride([]byte(`{"app_running":"2"}`))
	if err == nil {
		t.Fatal("字符串值必须被拒")
	}
	if err.Details["field"] != "app_running" {
		t.Fatalf("details.field = %v，want app_running", err.Details["field"])
	}
}

// TestAppOverrideEqual：相等口径（幂等判定）只认四个值，0 与 0 相等。
func TestAppOverrideEqual(t *testing.T) {
	a := AppOverride{AppRunning: 1, AppQueue: 8}
	b := AppOverride{AppRunning: 1, AppQueue: 8}
	c := AppOverride{AppRunning: 1, AppQueue: 9}
	if !a.Equal(b) {
		t.Fatal("同一份覆盖必须相等（重复 PUT 不写审计的判据）")
	}
	if a.Equal(c) {
		t.Fatal("不同覆盖不能相等")
	}
	if !(AppOverride{}).Equal(AppOverride{}) {
		t.Fatal("两个「无覆盖」必须相等")
	}
}
