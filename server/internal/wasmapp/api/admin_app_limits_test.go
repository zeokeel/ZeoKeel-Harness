package api

// 应用级限流覆盖端点的判据（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.3/§2.6）。
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - PUT 不校验未知顶层键（交给结构体解码静默忽略）⇒ TestAdminAppLimitsPutRejectsUnknownField 红；
//   - PUT 不调 applimits.ValidateOverride ⇒ TestAdminAppLimitsPutRejectsIllegalCombination 红；
//   - 无变化重复 PUT 仍写审计 ⇒ TestAdminAppLimitsPutIsIdempotent 红（下发是幂等自愈，不算"变更"）；
//   - 清空不写审计（只写"有值的保存"）⇒ TestAdminAppLimitsClearAuditsAllNull 红；
//   - 应用不存在/已删除仍返回 200 ⇒ TestAdminAppLimitsUnknownAndDeletedAppAre404 红；
//   - 落库后不下发调度器 ⇒ TestAdminAppLimitsPutAppliesToScheduler 红（"先下发后落库"没有失败注入点，
//     这一半不可观测，不作为判据）；
//   - AppLimitsApply 未装配仍保存 ⇒ TestAdminAppLimitsPutRequiresApplyHook 红；
//   - override 视图把继承的轴渲染成 0 而不是 null ⇒ TestAdminAppLimitsGetNoOverride 红。
//
// 全部用例走**生产路径**（/api/server/admin/wasm-apps/:app_id/limits）+ 真 PG。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/queue"
)

// appLimitsEnv 是覆盖用例的夹具：真 DB + 真调度器 + 可替换的全局限制项。
type appLimitsEnv struct {
	*testEnv
	sched  *queue.Scheduler
	global applimits.Limits
}

// newAppLimitsEnv 建环境：全局限制项显式给一份已知值（app_running=2），调度器是真实例。
func newAppLimitsEnv(t *testing.T, mutate func(*applimits.Limits)) *appLimitsEnv {
	t.Helper()
	global := applimits.Defaults()
	global.AppRunning = 2
	global.UserPerAppRunning = 2
	global.AppQueue = 8
	global.UserPerAppQueued = 4
	if mutate != nil {
		mutate(&global)
	}
	if err := global.Validate(); err != nil {
		t.Fatalf("夹具的全局限制项非法：%v", err)
	}
	sched := queue.New(queue.Options{
		GlobalRunning:        global.MaxInstances,
		PerAppRunning:        global.AppRunning,
		PerAppQueue:          global.AppQueue,
		PerUserGlobalRunning: global.UserGlobalRunning,
		PerUserPerAppRunning: global.UserPerAppRunning,
		PerUserPerAppQueued:  global.UserPerAppQueued,
	})
	base := newTestEnv(t, func(o *Options) {
		o.Limits = func() applimits.Limits { return global }
		o.AppLimitsApply = sched.SetAppLimitOverride
		o.AppLimitsCount = sched.AppLimitOverrideCount
		o.AppLimitsEffective = func(appID string) (limits.Axes, bool) {
			eff := sched.EffectiveOptions(appID)
			_, has := sched.AppLimitOverride(appID)
			return limits.Axes{
				AppRunning:        eff.PerAppRunning,
				AppQueue:          eff.PerAppQueue,
				UserPerAppRunning: eff.PerUserPerAppRunning,
				UserPerAppQueued:  eff.PerUserPerAppQueued,
			}, has
		}
	})
	return &appLimitsEnv{testEnv: base, sched: sched, global: global}
}

// path 返回某应用的 limits 端点路径（生产路径）。
func (e *appLimitsEnv) path(appID string) string {
	return "/api/server/admin/wasm-apps/" + appID + "/limits"
}

// appLimitsViewOut 是响应视图（字段与决策 §2.3 一一对应）。
type appLimitsViewOut struct {
	AppID         string          `json:"app_id"`
	Global        map[string]int  `json:"global"`
	Override      map[string]*int `json:"override"`
	Effective     map[string]int  `json:"effective"`
	ExceedsGlobal map[string]bool `json:"exceeds_global"`
	Changed       bool            `json:"changed"`
}

// getView 发 GET 并解码视图。
func (e *appLimitsEnv) getView(appID string) appLimitsViewOut {
	e.t.Helper()
	w := e.req(http.MethodGet, e.path(appID), "", nil)
	if w.Code != http.StatusOK {
		e.t.Fatalf("GET %s = %d: %s", e.path(appID), w.Code, w.Body.String())
	}
	var out appLimitsViewOut
	e.decodeJSON(w, http.StatusOK, &out)
	return out
}

// putView 发 PUT 并解码视图（期望 200）。
func (e *appLimitsEnv) putView(appID, body string) appLimitsViewOut {
	e.t.Helper()
	w := e.req(http.MethodPut, e.path(appID), "", body)
	if w.Code != http.StatusOK {
		e.t.Fatalf("PUT %s（body=%s）= %d: %s", e.path(appID), body, w.Code, w.Body.String())
	}
	var out appLimitsViewOut
	e.decodeJSON(w, http.StatusOK, &out)
	return out
}

// storedOverride 直接读库（DAO 会把"全 NULL 行"归一成 nil，用来断言"清空 = 删行"）。
func (e *testEnv) storedOverride(appID string) *serverstore.WasmAppLimitOverride {
	e.t.Helper()
	rec, err := serverstore.GetWasmAppLimitOverride(e.t.Context(), e.db, appID)
	if err != nil {
		e.t.Fatalf("读覆盖: %v", err)
	}
	return rec
}

// TestAdminAppLimitsGetNoOverride：没有覆盖时 override 四轴必须是 **null**（不是 0），
// effective 等于 global，exceeds_global 全 false。
func TestAdminAppLimitsGetNoOverride(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "limitless-tool"
	e.publishAppNoCompile(appID)

	view := e.getView(appID)
	if view.AppID != appID {
		t.Fatalf("app_id = %q，want %q", view.AppID, appID)
	}
	if view.Global["app_running"] != 2 || view.Global["app_queue"] != 8 {
		t.Fatalf("global 视图 = %v", view.Global)
	}
	for _, f := range limits.AppOverrideFieldNames() {
		if v, ok := view.Override[f]; !ok {
			t.Fatalf("override 缺字段 %s：%v", f, view.Override)
		} else if v != nil {
			t.Fatalf("没有覆盖时 override.%s 必须是 null，得到 %d", f, *v)
		}
		if view.Effective[f] != view.Global[f] {
			t.Fatalf("没有覆盖时 effective.%s=%d 必须等于 global=%d", f, view.Effective[f], view.Global[f])
		}
		if view.ExceedsGlobal[f] {
			t.Fatalf("没有覆盖时 exceeds_global.%s 不该为 true", f)
		}
	}
}

// TestAdminAppLimitsPutAppliesAndAudits：保存一条覆盖 ⇒ 落库 + 下发调度器 + 审计。
func TestAdminAppLimitsPutAppliesAndAudits(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "throttled-tool"
	e.publishAppNoCompile(appID)

	view := e.putView(appID, `{"app_running":1,"user_per_app_running":1}`)
	if !view.Changed {
		t.Fatal("首次保存必须 changed=true")
	}
	// override 视图：写了的轴有值，没写的轴仍是 null（继承）。
	if view.Override["app_running"] == nil || *view.Override["app_running"] != 1 {
		t.Fatalf("override.app_running = %v，want 1", view.Override["app_running"])
	}
	if view.Override["app_queue"] != nil {
		t.Fatalf("没写的轴必须是 null（继承），得到 %v", view.Override["app_queue"])
	}
	// effective：app_running 被收紧到 1，app_queue 继承全局 8。
	if view.Effective["app_running"] != 1 || view.Effective["app_queue"] != 8 {
		t.Fatalf("effective = %v，want app_running=1/app_queue=8", view.Effective)
	}

	// 落库。
	rec := e.storedOverride(appID)
	if rec == nil || rec.AppRunning == nil || *rec.AppRunning != 1 {
		t.Fatalf("库里没有覆盖：%+v", rec)
	}
	if rec.UpdatedBy != "boss" {
		t.Fatalf("updated_by = %q，want boss", rec.UpdatedBy)
	}

	// 下发调度器（这是"即时生效"的唯一判据：只查库分不清有没有装进内存）。
	ov, ok := e.sched.AppLimitOverride(appID)
	if !ok || ov.AppRunning != 1 || ov.UserPerAppRunning != 1 {
		t.Fatalf("调度器没收到覆盖：%+v ok=%v", ov, ok)
	}

	// 审计：一条 wasm_app_limits_change，明细含四值与 actor_role。
	details := e.auditDetails(appID, AuditActionWasmAppLimitsChange)
	if len(details) != 1 {
		t.Fatalf("保存必须写一条 %s 审计，得到 %d 条：%v", AuditActionWasmAppLimitsChange, len(details), details)
	}
	for _, want := range []string{
		"app_running=1", "app_queue=null", "user_per_app_running=1", "user_per_app_queued=null",
		"actor=boss", "actor_role=admin_session",
	} {
		if !strings.Contains(details[0], want) {
			t.Fatalf("审计明细缺 %q；detail=%q", want, details[0])
		}
	}
}

// TestAdminAppLimitsPutIsIdempotent：同一份覆盖重复 PUT ⇒ changed=false、不写审计、库不变。
func TestAdminAppLimitsPutIsIdempotent(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "idempotent-tool"
	e.publishAppNoCompile(appID)

	body := `{"app_running":1}`
	first := e.putView(appID, body)
	if !first.Changed {
		t.Fatal("第一次保存必须 changed=true")
	}
	second := e.putView(appID, body)
	if second.Changed {
		t.Fatal("同一份覆盖重复 PUT 必须 changed=false（幂等）")
	}
	if got := len(e.auditDetails(appID, AuditActionWasmAppLimitsChange)); got != 1 {
		t.Fatalf("重复 PUT 不该追加审计，得到 %d 条", got)
	}
	// 库里的 updated_by 仍是第一次写入的那个（没有被"空写"覆盖）。
	if rec := e.storedOverride(appID); rec == nil || rec.UpdatedBy != "boss" {
		t.Fatalf("库状态被重复 PUT 改动了：%+v", rec)
	}
}

// TestAdminAppLimitsClearAuditsAllNull：清空覆盖（null / {} / DELETE）都留痕，
// 明细四值全 null + actor_role，且库里行被删。
func TestAdminAppLimitsClearAuditsAllNull(t *testing.T) {
	cases := []struct {
		name  string
		clear func(e *appLimitsEnv, appID string) appLimitsViewOut
	}{
		{"null", func(e *appLimitsEnv, appID string) appLimitsViewOut { return e.putView(appID, `null`) }},
		{"空对象", func(e *appLimitsEnv, appID string) appLimitsViewOut { return e.putView(appID, `{}`) }},
		{"DELETE", func(e *appLimitsEnv, appID string) appLimitsViewOut {
			w := e.req(http.MethodDelete, e.path(appID), "", nil)
			if w.Code != http.StatusOK {
				e.t.Fatalf("DELETE = %d: %s", w.Code, w.Body.String())
			}
			var out appLimitsViewOut
			e.decodeJSON(w, http.StatusOK, &out)
			return out
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newAppLimitsEnv(t, nil)
			appID := "clear-tool"
			e.publishAppNoCompile(appID)
			if view := e.putView(appID, `{"app_running":1,"app_queue":4}`); !view.Changed {
				t.Fatal("先写一条覆盖失败")
			}
			view := tc.clear(e, appID)
			if !view.Changed {
				t.Fatal("清空必须 changed=true")
			}
			if e.storedOverride(appID) != nil {
				t.Fatal("清空必须删行（不是写一行全 NULL）")
			}
			if ov, ok := e.sched.AppLimitOverride(appID); ok {
				t.Fatalf("清空后调度器仍持有覆盖：%+v", ov)
			}
			details := e.auditDetails(appID, AuditActionWasmAppLimitsChange)
			if len(details) != 2 {
				t.Fatalf("清空也必须留痕（写一条 + 清空一条 = 2），得到 %d：%v", len(details), details)
			}
			// `ListAuditLogsByApp` 的返回顺序不是契约的一部分 ⇒ 按**内容**找清空那条
			//（按位置取最后一条会被排序变化打断，而这里要钉的是"清空留痕的样子"）。
			cleared := ""
			for _, d := range details {
				if strings.Contains(d, "清空覆盖") {
					cleared = d
					break
				}
			}
			if cleared == "" {
				t.Fatalf("没有找到清空覆盖的审计：%v", details)
			}
			for _, want := range []string{
				"app_running=null", "app_queue=null", "user_per_app_running=null", "user_per_app_queued=null",
				"清空覆盖", "actor_role=admin_session",
			} {
				if !strings.Contains(cleared, want) {
					t.Fatalf("清空审计缺 %q；detail=%q", want, cleared)
				}
			}
			// 再清一次：无变化 ⇒ 不追加审计。
			if view := tc.clear(e, appID); view.Changed {
				t.Fatal("重复清空必须 changed=false")
			}
			if got := len(e.auditDetails(appID, AuditActionWasmAppLimitsChange)); got != 2 {
				t.Fatalf("重复清空不该追加审计，得到 %d 条", got)
			}
		})
	}
}

// TestAdminAppLimitsPutRejectsUnknownField：未知顶层键 fail-loud，且**零副作用**。
func TestAdminAppLimitsPutRejectsUnknownField(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "strict-tool"
	e.publishAppNoCompile(appID)

	w := e.req(http.MethodPut, e.path(appID), "", `{"app_running":1,"max_instances":64}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("未知键必须 400，得到 %d: %s", w.Code, w.Body.String())
	}
	env := e.decodeErr(w, http.StatusBadRequest)
	if got := env.Error.Details["field"]; got != "max_instances" {
		t.Fatalf("details.field = %v，want max_instances", got)
	}
	if env.Error.Code != "VALIDATION" {
		t.Fatalf("code = %q，want VALIDATION", env.Error.Code)
	}
	if e.storedOverride(appID) != nil {
		t.Fatal("被拒的请求不能有副作用（库里不该有覆盖）")
	}
	if got := len(e.auditDetails(appID, AuditActionWasmAppLimitsChange)); got != 0 {
		t.Fatalf("被拒的请求不能写审计，得到 %d 条", got)
	}
}

// TestAdminAppLimitsPutRejectsIllegalCombination：per-app 与全局保存同一份判据。
func TestAdminAppLimitsPutRejectsIllegalCombination(t *testing.T) {
	e := newAppLimitsEnv(t, nil) // 全局 app_running=2
	appID := "illegal-tool"
	e.publishAppNoCompile(appID)

	// user_per_app_running=3 > 本应用 app_running=2。
	w := e.req(http.MethodPut, e.path(appID), "", `{"user_per_app_running":3}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法组合必须 400，得到 %d: %s", w.Code, w.Body.String())
	}
	env := e.decodeErr(w, http.StatusBadRequest)
	if got := env.Error.Details["field"]; got != "user_per_app_running" {
		t.Fatalf("details.field = %v，want user_per_app_running", got)
	}
	if len(env.Error.Hints) == 0 || !strings.Contains(strings.Join(env.Error.Hints, " "), "允许范围") {
		t.Fatalf("必须给可操作 hint（全局值 + 允许范围）：%v", env.Error.Hints)
	}
	if e.storedOverride(appID) != nil {
		t.Fatal("被拒的请求不能落库")
	}
}

// TestAdminAppLimitsPutAllowsExceedingGlobalLowerAppPlan：显式允许高于全局（决策 §2.1），
// 响应带 exceeds_global=true，前端据此二次确认。
func TestAdminAppLimitsPutAllowsExceedingGlobal(t *testing.T) {
	e := newAppLimitsEnv(t, nil) // 全局 app_running=2、user_per_app_running=2
	appID := "heavy-tool"
	e.publishAppNoCompile(appID)

	view := e.putView(appID, `{"app_running":4,"user_per_app_running":4}`)
	if !view.Changed {
		t.Fatal("高于全局是允许的动作，必须 changed=true")
	}
	if !view.ExceedsGlobal["app_running"] || !view.ExceedsGlobal["user_per_app_running"] {
		t.Fatalf("exceeds_global 应报两条 true：%v", view.ExceedsGlobal)
	}
	if view.Effective["app_running"] != 4 {
		t.Fatalf("effective.app_running = %d，want 4", view.Effective["app_running"])
	}
	if ov, ok := e.sched.AppLimitOverride(appID); !ok || ov.AppRunning != 4 {
		t.Fatalf("调度器没收到更高的覆盖：%+v ok=%v", ov, ok)
	}
}

// TestAdminAppLimitsUnknownAndDeletedAppAre404：不存在与已删除都 404（不泄露存在性），
// 读/写两面一致，且写面零副作用。
func TestAdminAppLimitsUnknownAndDeletedAppAre404(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	// 不存在的应用：GET / PUT / DELETE 都 404。
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		w := e.req(m, e.path("ghost-tool"), "", `{"app_running":1}`)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s 不存在的应用 = %d，want 404: %s", m, w.Code, w.Body.String())
		}
	}
	// 已删除的应用：同样 404（写面不能给已删除应用设覆盖）。
	appID := "deleted-tool"
	e.publishAppNoCompile(appID)
	if _, err := e.db.Exec(`UPDATE apps SET deleted_at = now() WHERE app_id = ?`, appID); err != nil {
		t.Fatalf("软删应用失败: %v", err)
	}
	for _, m := range []string{http.MethodGet, http.MethodPut} {
		w := e.req(m, e.path(appID), "", `{"app_running":1}`)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s 已删除的应用 = %d，want 404: %s", m, w.Code, w.Body.String())
		}
	}
	if e.storedOverride(appID) != nil {
		t.Fatal("已删除应用不能有覆盖行")
	}
}

// TestAdminAppLimitsPutRequiresApplyHook：装配缺下发钩子 ⇒ 保存 fail-closed（不落库）。
func TestAdminAppLimitsPutRequiresApplyHook(t *testing.T) {
	e := newTestEnv(t, func(o *Options) {
		// 故意不注入 AppLimitsApply（装配事故）。
		o.Limits = func() applimits.Limits { return applimits.Defaults() }
	})
	appID := "no-hook-tool"
	e.publishAppNoCompile(appID)
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/"+appID+"/limits", "", `{"app_running":1}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("未装配必须 500（fail-closed），得到 %d: %s", w.Code, w.Body.String())
	}
	if rec := e.storedOverride(appID); rec != nil {
		t.Fatalf("未装配时不能只落库：%+v", rec)
	}
}

// publishAppNoCompile 造一个应用行（不做编译：本文件测的是限流端点，与发布链路无关）。
//
// 为什么要一个"不编译"的入口：`publishApp` 会真起编译子进程（3–11 s/用例），
// 而限流端点只依赖 apps 行存在（adminApp 走 GetWasmApp），与版本/制品无关。
func (e *testEnv) publishAppNoCompile(appID string) {
	e.t.Helper()
	if err := serverstore.UpsertWasmApp(e.t.Context(), e.db, serverstore.WasmApp{
		AppID: appID, Title: appID + " 标题", Owner: "alice", Enabled: true,
		CurrentReleaseID: 1,
	}); err != nil {
		e.t.Fatalf("建应用 %s 失败: %v", appID, err)
	}
}

// TestAdminAppLimitsZeroMeansInherit：`0` 与 `null` 同义（该轴继承全局），
// 四轴全 0 = 清空（2026-10-22 反证 F-5：此前 Go 注释与前端口径不一致，且无用例）。
func TestAdminAppLimitsZeroMeansInherit(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "zero-tool"
	e.publishAppNoCompile(appID)

	// app_running=0 ⇒ 继承（2），app_queue=4 ⇒ 覆盖。
	view := e.putView(appID, `{"app_running":0,"app_queue":4}`)
	if !view.Changed {
		t.Fatal("有效覆盖应 changed=true")
	}
	if view.Override["app_running"] != nil {
		t.Fatalf("0 必须归一成继承（override.app_running 应为 null），得到 %v", *view.Override["app_running"])
	}
	if view.Effective["app_running"] != view.Global["app_running"] {
		t.Fatalf("0 继承后 effective.app_running=%d 必须等于 global=%d",
			view.Effective["app_running"], view.Global["app_running"])
	}
	if view.Override["app_queue"] == nil || *view.Override["app_queue"] != 4 {
		t.Fatalf("app_queue 覆盖没生效：%v", view.Override)
	}

	// 四轴全 0 ⇒ 与 null/{} 一样是清空（删行）。
	view = e.putView(appID, `{"app_running":0,"app_queue":0,"user_per_app_running":0,"user_per_app_queued":0}`)
	if !view.Changed {
		t.Fatal("从有覆盖到全 0 必须 changed=true（清空）")
	}
	if e.storedOverride(appID) != nil {
		t.Fatal("四轴全 0 必须删除覆盖行")
	}
	for _, f := range limits.AppOverrideFieldNames() {
		if view.Override[f] != nil {
			t.Fatalf("清空后 override.%s 必须为 null", f)
		}
	}
}

// TestAdminAppLimitsIdempotentPutReapplies：库与调度器漂移时，**重复 PUT 同一份值**
// 必须把下发改回来（2026-10-22 反证 F-10：此前只在 changed 时下发，漂移永远修不回来）。
func TestAdminAppLimitsIdempotentPutReapplies(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	appID := "redeploy-tool"
	e.publishAppNoCompile(appID)

	body := `{"app_running":1}`
	if v := e.putView(appID, body); !v.Changed {
		t.Fatal("第一次保存应 changed=true")
	}
	if ov, ok := e.sched.AppLimitOverride(appID); !ok || ov.AppRunning != 1 {
		t.Fatalf("第一次保存后调度器覆盖 = %+v ok=%v", ov, ok)
	}
	// 模拟一次"下发失败/装配重建"造成的漂移：调度器丢了覆盖，但库里还在。
	e.sched.SetAppLimitOverride(appID, limits.AppOverride{})
	if _, ok := e.sched.AppLimitOverride(appID); ok {
		t.Fatal("夹具没清掉调度器覆盖")
	}
	// 再保存同一份值：changed=false（不写审计），但必须重新下发。
	beforeAudit := len(e.auditDetails(appID, AuditActionWasmAppLimitsChange))
	view := e.putView(appID, body)
	if view.Changed {
		t.Fatal("同一份值重复 PUT 必须 changed=false")
	}
	if ov, ok := e.sched.AppLimitOverride(appID); !ok || ov.AppRunning != 1 {
		t.Fatalf("重复 PUT 必须把覆盖重新下发以自愈漂移，得到 %+v ok=%v", ov, ok)
	}
	if got := len(e.auditDetails(appID, AuditActionWasmAppLimitsChange)); got != beforeAudit {
		t.Fatalf("幂等分支不该写审计：%d → %d", beforeAudit, got)
	}
}

// TestAdminAppLimitsListAndRuntimeCount：管理台总览（生产化评审管理员视角）。
// 变异：列表不读库 / 不套用 global ⇒ items 空或 effective 错；runtime 不接
// AppLimitsCount ⇒ override_count 缺失。
func TestAdminAppLimitsListAndRuntimeCount(t *testing.T) {
	e := newAppLimitsEnv(t, nil)
	e.publishAppNoCompile("listed-one")
	e.publishAppNoCompile("listed-two")
	if v := e.putView("listed-one", `{"app_running":1,"app_queue":4}`); !v.Changed {
		t.Fatal("先写覆盖失败")
	}

	type listItem struct {
		AppID         string          `json:"app_id"`
		Override      map[string]*int `json:"override"`
		Effective     map[string]int  `json:"effective"`
		ExceedsGlobal map[string]bool `json:"exceeds_global"`
		UpdatedBy     string          `json:"updated_by"`
	}
	type listOut struct {
		Global map[string]int `json:"global"`
		Items  []listItem     `json:"items"`
		Total  int            `json:"total"`
	}
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/limit-overrides", "", nil)
	var out listOut
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Total != 1 || len(out.Items) != 1 {
		t.Fatalf("total/items = %d/%d，want 1/1（只列有覆盖的应用）", out.Total, len(out.Items))
	}
	it := out.Items[0]
	if it.AppID != "listed-one" || it.Override["app_running"] == nil || *it.Override["app_running"] != 1 {
		t.Fatalf("列表项错误：%+v", it)
	}
	if it.Effective["app_running"] != 1 || it.Effective["app_queue"] != 4 {
		t.Fatalf("列表必须带生效值：%+v", it.Effective)
	}
	if it.UpdatedBy != "boss" {
		t.Fatalf("updated_by = %q，want boss", it.UpdatedBy)
	}
	if out.Global["app_running"] != e.global.AppRunning {
		t.Fatalf("global 段没下发：%v", out.Global)
	}

	// /admin/runtime 必须能看到"现在有几个例外配置"。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/runtime", "", nil)
	var rt struct {
		Runtime struct {
			AppLimits struct {
				OverrideCount int `json:"override_count"`
			} `json:"app_limits"`
		} `json:"runtime"`
	}
	e.decodeJSON(w, http.StatusOK, &rt)
	if rt.Runtime.AppLimits.OverrideCount != 1 {
		t.Fatalf("runtime.app_limits.override_count = %d，want 1", rt.Runtime.AppLimits.OverrideCount)
	}
}
