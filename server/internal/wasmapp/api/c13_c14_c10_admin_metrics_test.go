package api

// C-13 / C-14 / C-10（审计 2026-10-22）的管理面判据。
//
//	C-13 列表 SQL 分页：limit/offset 下推、q/status 在 WHERE 里、total 由同一谓词
//	     COUNT(*) 给出（`ListWasmAppsPage`）；access 是唯一的内存筛选，必须由
//	     `sql_paged=false` 如实标注。
//	C-14 打开计数作业健康：`GET …/opens/summary` 的 `aggregated_until`/`stale`/
//	     `opens_job` 三件事必须能把"作业停摆"与"真的没人用"区分开。
//	C-10 运行期水位：`GET …/runtime` 的 module_cache / appdb_handles 在注入访问器后
//	     是真实值、并**移出** unavailable 段；未注入时进缺口清单而不是填 0。
//
// 变异验证（每条都应变红）：
//   - 把 adminList 改回 `ListWasmApps` 全量读入 + 内存分页 ⇒
//     TestAdminListPaginationIsSQLPaged / TestAdminListIsNotFullScanAnymore 红；
//   - 把 `total` 改成 `len(rows)` ⇒ total 断言红（第一页 limit=2 时 total=2）；
//   - 把 `q` 从 WHERE 里删掉（只回显不筛）⇒ "分页之外的行也能被搜到"红；
//   - 把 summary 的 aggregated_until 恒写成 now() ⇒ 陈旧用例红；
//   - 把 opens_job 未注入时填 0 而不是 null ⇒ 不可得用例红；
//   - 把 runtime 的 module_cache 段删掉（回到 unavailable 硬编码）⇒ 注入用例红。

import (
	"bytes"
	"fmt"
	"go/parser"
	"go/printer"
	"go/token"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// pageListOut 是 C-13 关注的列表响应投影。
type pageListOut struct {
	Apps []struct {
		AppID string `json:"app_id"`
	} `json:"apps"`
	Total     int  `json:"total"`
	Truncated bool `json:"truncated"`
	Limit     int  `json:"limit"`
	Offset    int  `json:"offset"`
	SQLPaged  bool `json:"sql_paged"`
}

// TestAdminListPaginationIsSQLPaged 覆盖 C-13 的分页/搜索/状态三条下推路径。
func TestAdminListPaginationIsSQLPaged(t *testing.T) {
	e := newTestEnv(t)
	for i := 0; i < 5; i++ {
		seedApp(t, e, fmt.Sprintf("page-%03d", i), fmt.Sprintf("分页应用 %03d", i), "alice", true)
	}
	// 一条**带 LIKE 元字符**的行：验证 q 是按字面量匹配（不是通配符）。
	seedApp(t, e, "pct-row", "完成度 100% 报表", "alice", true)
	// 一条历史 public 行（access 筛选的内存分支）。
	seedApp(t, e, "legacy-public-page", "历史公开", "alice", true)
	if _, err := e.db.Exec(`UPDATE apps SET config_json = '{"access":"public"}' WHERE kind='wasm_app' AND app_id='legacy-public-page'`); err != nil {
		t.Fatalf("造历史 public 行: %v", err)
	}

	fetch := func(query string) pageListOut {
		t.Helper()
		w := e.req(http.MethodGet, "/api/server/admin/wasm-apps"+query, "", nil)
		var out pageListOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out
	}

	// ① 分页：第二页只有两行，total 是全量（不是本页行数），并回显 limit/offset。
	page := fetch("?limit=2&offset=2")
	if len(page.Apps) != 2 || page.Total != 7 || !page.Truncated {
		t.Fatalf("SQL 分页结果不对: rows=%d total=%d truncated=%v", len(page.Apps), page.Total, page.Truncated)
	}
	if page.Limit != 2 || page.Offset != 2 {
		t.Fatalf("必须回显生效的 limit/offset: %+v", page)
	}
	if !page.SQLPaged {
		t.Fatalf("无 access 筛选时必须走 SQL 分页（sql_paged=true）: %+v", page)
	}
	// 行是按 app_id 排序后的第 3、4 行：全序是
	// legacy-public-page, page-000, page-001, page-002, page-003, page-004, pct-row
	// ⇒ offset=2 命中 page-001 / page-002（**不是** page-002/003 —— 排序是判据的一部分）。
	gotIDs := []string{page.Apps[0].AppID, page.Apps[1].AppID}
	wantIDs := []string{"page-001", "page-002"}
	if strings.Join(gotIDs, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("第二页行不对: got=%v want=%v", gotIDs, wantIDs)
	}

	// ② offset 越界：空页 + total 仍是全量（且不被标成 truncated）。
	empty := fetch("?limit=2&offset=99")
	if len(empty.Apps) != 0 || empty.Total != 7 || empty.Truncated {
		t.Fatalf("offset 越界应给空页且 total 不变: %+v", empty)
	}

	// ③ q 在 SQL 里筛（能捞到分页之外的行），且 `%` 按字面量匹配。
	byID := fetch("?q=pct-row")
	if byID.Total != 1 || len(byID.Apps) != 1 || byID.Apps[0].AppID != "pct-row" {
		t.Fatalf("按 app_id 搜索失败: %+v", byID)
	}
	byPct := fetch("?q=100%25")
	if byPct.Total != 1 || len(byPct.Apps) != 1 || byPct.Apps[0].AppID != "pct-row" {
		t.Fatalf("q 里的 %% 必须按字面量匹配（不是通配符）: %+v", byPct)
	}

	// ④ status 在 SQL 里筛，total 与筛选一致（与徽章同一谓词）。
	published := fetch("?status=published&limit=1")
	if published.Total != 7 || !published.Truncated {
		t.Fatalf("status=published 的 total 应为全量命中数: %+v", published)
	}
	frozen := fetch("?status=frozen")
	if frozen.Total != 0 {
		t.Fatalf("status=frozen 应为 0: %+v", frozen)
	}

	// ⑤ access 是**唯一**的内存筛选：必须如实标注 sql_paged=false，且 total 是过滤后的数。
	wl := fetch("?access=whitelist")
	if wl.Total != 0 {
		t.Fatalf("access=whitelist 应无命中: %+v", wl)
	}
	lg := fetch("?access=login")
	if lg.SQLPaged {
		t.Fatalf("带 access 筛选时应如实回显 sql_paged=false: %+v", lg)
	}
	if lg.Total != 7 || len(lg.Apps) != 7 {
		t.Fatalf("access=login 应命中 7 行（含历史 public）: total=%d rows=%d", lg.Total, len(lg.Apps))
	}
}

// TestAdminListIsNotFullScanAnymore 是 C-13 的**源码级**判据：adminList 必须走分页 DAO
// 并把 limit/offset 传下去（行为级用例分不清"SQL 分页"与"内存分页"给出的同一个结果，
// 而 C-13 的缺陷正是"每页 200 行却扫全表"）。
func TestAdminListIsNotFullScanAnymore(t *testing.T) {
	text := goCodeWithoutComments(t, "admin.go")
	// 先按 AST 打印成**去注释**源码：注释里提到 `serverstore.ListWasmApps(` 不该让判据红，
	// 也不该让"删掉真的调用"变绿（2026-10-22 实测踩过同类假绿，见 cmd/server 的
	// goSourceWithoutComments）。
	text = goCodeWithoutComments(t, "admin.go")
	start := strings.Index(text, "func (h *Handlers) adminList(c *gin.Context) {")
	if start < 0 {
		t.Fatal("找不到 adminList（判据锚点漂移，不得静默通过）")
	}
	end := strings.Index(text[start:], "\n}\n")
	if end < 0 {
		t.Fatal("找不到 adminList 的函数体结尾")
	}
	body := text[start : start+end]
	if !strings.Contains(body, "serverstore.ListWasmAppsPage(") {
		t.Fatal("adminList 必须用 ListWasmAppsPage（rows+total 同谓词），否则 total 与行数会来自两个集合")
	}
	if strings.Contains(body, "serverstore.ListWasmApps(") {
		t.Fatal("adminList 不得再调全量 ListWasmApps（C-13：每页 200 行却扫全表）")
	}
	for _, want := range []string{"filter.Limit, filter.Offset = limit, offset", "filter.Query = q", "filter.Status = status"} {
		if !strings.Contains(body, want) {
			t.Fatalf("adminList 必须把分页/搜索/状态下推（缺 %q）", want)
		}
	}
}

// TestAdminOpensSummaryReportsAggregationHealth 覆盖 C-14 的库侧判据（未注入作业读数）。
func TestAdminOpensSummaryReportsAggregationHealth(t *testing.T) {
	e := newTestEnv(t)
	type summaryOut struct {
		AggregatedUntil   *string  `json:"aggregated_until"`
		Stale             bool     `json:"stale"`
		StaleReasons      []string `json:"stale_reasons"`
		StaleAfterSeconds int      `json:"stale_after_seconds"`
		OpensJob          *struct {
			Started bool `json:"started"`
			Runs    int  `json:"runs"`
		} `json:"opens_job"`
	}
	fetch := func() summaryOut {
		t.Helper()
		w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary", "", nil)
		var out summaryOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out
	}

	// ① 没有任何日汇总行：aggregated_until=null、stale=true、原因可读；
	//    opens_job 未注入 ⇒ null（不是零值对象）。
	empty := fetch()
	if empty.AggregatedUntil != nil {
		t.Fatalf("无汇总时 aggregated_until 必须是 null（不得用 now() 冒充）: %v", *empty.AggregatedUntil)
	}
	if !empty.Stale {
		t.Fatal("没有任何汇总记录时必须判 stale")
	}
	if !containsSubstring(empty.StaleReasons, "没有任何汇总记录") {
		t.Fatalf("stale_reasons 必须说明原因: %v", empty.StaleReasons)
	}
	if empty.StaleAfterSeconds != 900 {
		t.Fatalf("缺省陈旧阈值应为 3×5min=900s，得到 %d", empty.StaleAfterSeconds)
	}
	if empty.OpensJob != nil {
		t.Fatalf("未注入 OpensHealth 时 opens_job 必须是 null（读不到≠跑了 0 轮）: %+v", empty.OpensJob)
	}

	// ② 写一条"刚刚汇总过"的日汇总 → aggregated_until 非空、stale=false。
	now := e.h.now().UTC()
	insertDaily := func(updatedAt time.Time) {
		t.Helper()
		if _, err := e.db.Exec(`INSERT INTO wasm_app_opens_daily (app_id, day, dept_id, pv, uv, updated_at)
			VALUES ($1, $2, 0, 1, 1, $3)
			ON CONFLICT (app_id, day, dept_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
			"fresh-app", serverstore.LocalDay(now), updatedAt); err != nil {
			t.Fatalf("写日汇总行: %v", err)
		}
	}
	insertDaily(now)
	fresh := fetch()
	if fresh.AggregatedUntil == nil || *fresh.AggregatedUntil == "" {
		t.Fatal("有日汇总行时 aggregated_until 必须给出实际时刻")
	}
	if fresh.Stale {
		t.Fatalf("刚刚汇总过不应判 stale: %+v", fresh)
	}
	if len(fresh.StaleReasons) != 0 {
		t.Fatalf("不陈旧时 stale_reasons 必须是空数组: %v", fresh.StaleReasons)
	}

	// ③ 把最后汇总时间推回 1 小时前 → stale=true 且原因里带"超过"。
	insertDaily(now.Add(-time.Hour))
	old := fetch()
	if !old.Stale {
		t.Fatal("最后汇总在 1 小时前必须判 stale（超过 3 个 tick）")
	}
	if !containsSubstring(old.StaleReasons, "超过") {
		t.Fatalf("陈旧原因必须说明超过了多久: %v", old.StaleReasons)
	}
}

// TestAdminOpensSummaryUsesInjectedJobHealth 覆盖 C-14 的作业读数面。
func TestAdminOpensSummaryUsesInjectedJobHealth(t *testing.T) {
	var health OpensJobHealth
	e := newTestEnv(t, func(o *Options) {
		o.OpensHealth = func() OpensJobHealth { return health }
	})
	type summaryOut struct {
		Stale        bool     `json:"stale"`
		StaleReasons []string `json:"stale_reasons"`
		OpensJob     *struct {
			Started   bool    `json:"started"`
			Runs      int     `json:"runs"`
			Errors    int     `json:"errors"`
			LastRunAt *string `json:"last_run_at"`
			TickSecs  int     `json:"tick_seconds"`
		} `json:"opens_job"`
	}
	fetch := func() summaryOut {
		t.Helper()
		var out summaryOut
		e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary", "", nil),
			http.StatusOK, &out)
		return out
	}

	// ① 作业未启动：stale=true 且原因点名"未启动"；读数如实（started=false/runs=0）。
	health = OpensJobHealth{Tick: 5 * time.Minute}
	off := fetch()
	if off.OpensJob == nil {
		t.Fatal("注入 OpensHealth 后必须下发 opens_job")
	}
	if off.OpensJob.Started || off.OpensJob.Runs != 0 || off.OpensJob.LastRunAt != nil {
		t.Fatalf("未启动时读数不对: %+v", off.OpensJob)
	}
	if !off.Stale || !containsSubstring(off.StaleReasons, "未启动") {
		t.Fatalf("作业未启动必须判 stale 并说明原因: stale=%v reasons=%v", off.Stale, off.StaleReasons)
	}

	// ② 作业刚跑过一轮：stale=false（即使库里没有任何日汇总行 —— LastRunAt 也是
	//    "最后一次汇总"的证据，否则没有打开数据的健康部署会被误判成停摆）。
	now := e.h.now().UTC()
	health = OpensJobHealth{Started: true, StartedAt: now.Add(-time.Hour), Runs: 12,
		LastRunAt: now, Tick: 5 * time.Minute}
	on := fetch()
	if on.OpensJob == nil || !on.OpensJob.Started || on.OpensJob.Runs != 12 || on.OpensJob.LastRunAt == nil {
		t.Fatalf("注入的读数必须原样下发: %+v", on.OpensJob)
	}
	if on.OpensJob.TickSecs != 300 {
		t.Fatalf("tick_seconds = %d, want 300", on.OpensJob.TickSecs)
	}
	if on.Stale {
		t.Fatalf("刚跑过一轮不应判 stale: %+v", on.StaleReasons)
	}

	// ③ 作业停了 1 小时：stale=true 且原因点名"超过"。
	health = OpensJobHealth{Started: true, StartedAt: now.Add(-2 * time.Hour), Runs: 3,
		LastRunAt: now.Add(-time.Hour), Tick: 5 * time.Minute}
	stopped := fetch()
	if !stopped.Stale || !containsSubstring(stopped.StaleReasons, "超过") {
		t.Fatalf("作业停摆 1 小时必须判 stale: stale=%v reasons=%v", stopped.Stale, stopped.StaleReasons)
	}
}

// runtimeStatsOut 是 C-10 关注的 runtime 响应投影。
type runtimeStatsOut struct {
	Runtime struct {
		ModuleCache *struct {
			Entries         int   `json:"entries"`
			CompiledEntries int   `json:"compiled_entries"`
			Bytes           int64 `json:"bytes"`
			MaxBytes        int64 `json:"max_bytes"`
			MaxEntries      int   `json:"max_entries"`
			IdleTTLSecs     int   `json:"idle_ttl_seconds"`
		} `json:"module_cache"`
		AppDBHandles *struct {
			Handles         int `json:"handles"`
			Max             int `json:"max"`
			Readers         int `json:"readers"`
			IdleTimeoutSecs int `json:"idle_timeout_seconds"`
		} `json:"appdb_handles"`
		Unavailable []struct {
			Name string `json:"name"`
		} `json:"unavailable"`
	} `json:"runtime"`
}

// TestAdminRuntimeReportsRealModuleCacheAndAppDBPool 覆盖 C-10 的"有值 vs 缺失如实"。
func TestAdminRuntimeReportsRealModuleCacheAndAppDBPool(t *testing.T) {
	fetch := func(e *testEnv) (runtimeStatsOut, string) {
		t.Helper()
		w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/runtime", "", nil)
		var out runtimeStatsOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out, w.Body.String()
	}
	hasUnavailable := func(out runtimeStatsOut, name string) bool {
		for _, u := range out.Runtime.Unavailable {
			if u.Name == name {
				return true
			}
		}
		return false
	}

	// ① 未注入（默认测试装配）：两项在 unavailable 段、**且响应里没有对应值段**
	//    （不填 0：管理员必须能区分"这个数是 0"与"这个数没有出口"）。
	bare := newTestEnv(t)
	missing, missingRaw := fetch(bare)
	if !hasUnavailable(missing, "module_cache") || !hasUnavailable(missing, "appdb_handles") {
		t.Fatalf("未注入时两项必须进缺口清单: %s", missingRaw)
	}
	if missing.Runtime.ModuleCache != nil || missing.Runtime.AppDBHandles != nil {
		t.Fatalf("未注入时不得下发 0 值冒充实测: %s", missingRaw)
	}

	// ② 注入访问器：数值原样下发、两项**移出**缺口清单（接线后仍列在缺口里 =
	//    把已经接好的显示成还没接）。
	mod := ModuleCacheStats{Entries: 3, CompiledEntries: 2, Bytes: 123456,
		MaxBytes: 64 << 20, MaxEntries: 32, IdleTTL: 10 * time.Minute}
	pool := AppDBPoolStats{Handles: 2, Max: 32, Readers: 4, IdleTimeout: 3 * time.Minute}
	e := newTestEnv(t, func(o *Options) {
		o.ModuleCacheStats = func() ModuleCacheStats { return mod }
		o.AppDBPoolStats = func() AppDBPoolStats { return pool }
	})
	out, raw := fetch(e)
	if out.Runtime.ModuleCache == nil || out.Runtime.AppDBHandles == nil {
		t.Fatalf("注入后必须下发真实值段: %s", raw)
	}
	mc := out.Runtime.ModuleCache
	if mc.Entries != 3 || mc.CompiledEntries != 2 || mc.Bytes != 123456 ||
		mc.MaxBytes != 64<<20 || mc.MaxEntries != 32 || mc.IdleTTLSecs != 600 {
		t.Fatalf("module_cache 段与注入值不符: %s", raw)
	}
	ah := out.Runtime.AppDBHandles
	if ah.Handles != 2 || ah.Max != 32 || ah.Readers != 4 || ah.IdleTimeoutSecs != 180 {
		t.Fatalf("appdb_handles 段与注入值不符: %s", raw)
	}
	if hasUnavailable(out, "module_cache") || hasUnavailable(out, "appdb_handles") {
		t.Fatalf("接线后两项必须移出缺口清单: %s", raw)
	}
	if !strings.Contains(raw, `"unavailable":[]`) {
		t.Fatalf("两项都接上时 unavailable 必须是空数组（不是 null）: %s", raw)
	}

	// ③ "有出口且真的是 0"：与"没有出口"是两件事 —— 值段在、缺口清单不在。
	mod = ModuleCacheStats{MaxBytes: 1, MaxEntries: 1, IdleTTL: time.Minute}
	pool = AppDBPoolStats{}
	zero, zeroRaw := fetch(e)
	if zero.Runtime.ModuleCache == nil || zero.Runtime.ModuleCache.Entries != 0 || zero.Runtime.AppDBHandles == nil {
		t.Fatalf("真实的 0 值必须下发（不是 unavailable）: %s", zeroRaw)
	}
}

// TestStalePendingPurgeRequiresReviewOff 是 C-08 的第一条闸门（审核仍开启时拒绝）。
func TestStalePendingPurgeRequiresReviewOff(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("guard-tool", "alice")
	e.seedLifecycleRelease("guard-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("guard-tool", "1.1.0", serverstore.ReleaseStatusPending, true)
	// 审核开关打开
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": true})
	e.decodeJSON(w, http.StatusOK, &map[string]any{})

	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/releases/purge-stale", "", nil)
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != "VALIDATION" {
		t.Fatalf("code = %s, want VALIDATION", eb.Error.Code)
	}
	if !strings.Contains(eb.Error.Message, "审核开关仍开启") {
		t.Fatalf("必须明说拒绝原因: %s", eb.Error.Message)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatal("拒绝时必须给可操作 hints（先关闭审核 / 逐个处置）")
	}
	// 状态未变（拒绝是 fail-closed 的，不产生任何写入）。
	if status, _, _ := e.releaseState("guard-tool", "1.1.0"); status != serverstore.ReleaseStatusPending {
		t.Fatalf("被拒后待审版本不得被改动: %q", status)
	}
	// 无管理会话 ⇒ 401。
	if w := e.reqWithAdminHeader(http.MethodPost, "/api/server/admin/wasm-apps/releases/purge-stale", "none", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("无会话 status = %d, want 401", w.Code)
	}
}

// goCodeWithoutComments 返回**去掉注释**的源码渲染（源码级判据的唯一读法）。
func goCodeWithoutComments(t *testing.T, filename string) string {
	t.Helper()
	src, err := os.ReadFile(filename)
	if err != nil {
		t.Fatalf("读 %s: %v", filename, err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filename, src, 0) // 不传 ParseComments
	if err != nil {
		t.Fatalf("parse %s: %v", filename, err)
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, f); err != nil {
		t.Fatalf("print %s: %v", filename, err)
	}
	return buf.String()
}
