package api

// A3 / A6 的作者面反馈判据（审计 2026-10-22 功能合理性审计 P2）。
//
// A3「诊断不告诉你事件被丢过」：调用事件走有界环形缓冲，满了丢最旧并计数
// （events.Sink.Dropped），落库失败丢整批并计数（Failed）。管理面一直能看到这两个数，
// 作者面诊断却一个字段都不给 —— 作者（第一消费者是 AI）看到 `summary.failed=0`
// 会直接得出"没有问题"。
//
// A6「whitelist 是假准入」：`access=whitelist` 的名单由应用自己判定，平台不比对（R24）。
// 诊断与发布回执必须当场说清 `whitelist_enforced=false` 与"应用该怎么自己判"。
//
// 变异验证（每条都应红）：
//   - 删掉 diagnosticsPayload 里的 `events_dropped`/`events_flush_failed` 键
//     ⇒ TestDiagnosticsReportsEventDrops 的零态断言红；
//   - 把 `dropped+failed>0` 的 hint 删掉 ⇒ 同一用例的"统计可能不完整"断言红；
//   - 把 `whitelist_enforced` 恒写成 true ⇒ 两个用例都红；
//   - 删掉 publish 回执的 warnings（对 whitelist 配置）⇒ 回执用例红。

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/capapi"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/events"
)

// diagEventsOut 是诊断响应的 A3/A6 投影。
type diagEventsOut struct {
	Diagnostics struct {
		Access            string   `json:"access"`
		WhitelistEnforced bool     `json:"whitelist_enforced"`
		EventsDropped     int64    `json:"events_dropped"`
		EventsFlushFailed int64    `json:"events_flush_failed"`
		EventsAvailable   bool     `json:"events_available"`
		Hints             []string `json:"hints"`
	} `json:"diagnostics"`
}

// TestDiagnosticsReportsEventDrops 覆盖 A3 的两态：0 也下发；非 0 时带"统计可能不完整"。
func TestDiagnosticsReportsEventDrops(t *testing.T) {
	var sink *events.Sink
	e := newTestEnv(t, func(o *Options) {
		// 环容量 1：第二条记录就会丢最旧一条，且 FlushInterval 拉长到 1 小时
		// （用例自己掌控何时落库，避免后台 worker 把计数背景化）。
		sink = events.NewSink(o.DB, events.Options{RingSize: 1, FlushInterval: time.Hour})
		o.Events = sink
	})
	t.Cleanup(func() { _ = sink.Close() })
	e.publishOK(e.tokens["alice"], "diag-events", "1.0.0", testGuestModule(t), goodConfig())

	fetch := func() diagEventsOut {
		t.Helper()
		w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/diag-events/diagnostics", e.tokens["alice"], nil)
		var out diagEventsOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out
	}

	// ① 零态：字段必须**在**（缺字段与 0 在 JSON 消费侧无法区分）。
	raw := e.req(http.MethodGet, "/api/client/v2/apps/wasm/diag-events/diagnostics", e.tokens["alice"], nil).Body.String()
	for _, want := range []string{`"events_dropped":0`, `"events_flush_failed":0`, `"events_available":true`} {
		if !strings.Contains(raw, want) {
			t.Fatalf("诊断响应必须恒带 %s（0 也要下发）: %s", want, raw)
		}
	}
	if got := fetch(); got.Diagnostics.EventsDropped != 0 || got.Diagnostics.EventsFlushFailed != 0 {
		t.Fatalf("还没有丢弃/失败时两个计数应为 0: %+v", got.Diagnostics)
	}

	// ② 非零态（dropped）：环容量 1，连记两条 ⇒ 丢最旧一条。
	sink.Record(capapi.CallMetrics{AppID: "diag-events", Outcome: capapi.OutcomeOK})
	sink.Record(capapi.CallMetrics{AppID: "diag-events", Outcome: capapi.OutcomeOK})
	if sink.Dropped() == 0 {
		t.Fatal("夹具失效：环容量 1 时第二条记录应计入 Dropped")
	}
	// ③ 非零态（flush failed）：把事件表临时改名，Close 时的同步 flush 必然失败。
	if _, err := e.db.Exec(`ALTER TABLE wasm_call_events RENAME TO wasm_call_events_a3_bak`); err != nil {
		t.Fatalf("临时改名事件表失败: %v", err)
	}
	_ = sink.Close()
	if _, err := e.db.Exec(`ALTER TABLE wasm_call_events_a3_bak RENAME TO wasm_call_events`); err != nil {
		t.Fatalf("恢复事件表名失败: %v", err)
	}
	if sink.Failed() == 0 {
		t.Fatal("夹具失效：表不可用时 flush 应计入 Failed")
	}

	got := fetch()
	if got.Diagnostics.EventsDropped < 1 || got.Diagnostics.EventsFlushFailed < 1 {
		t.Fatalf("非零态必须如实下发 events_dropped/events_flush_failed: %+v", got.Diagnostics)
	}
	if got.Diagnostics.EventsAvailable != true {
		t.Fatalf("events_available 应如实为 true（sink 已注入）: %+v", got.Diagnostics)
	}
	if !containsSubstring(got.Diagnostics.Hints, "统计可能不完整") {
		t.Fatalf("丢弃>0 时必须给「统计可能不完整」hint，得到 %v", got.Diagnostics.Hints)
	}
}

// TestDiagnosticsWhitelistIsNotEnforcedByPlatform 覆盖 A6：诊断面说清平台不比对名单。
func TestDiagnosticsWhitelistIsNotEnforcedByPlatform(t *testing.T) {
	e := newTestEnv(t)
	cfg := goodConfig()
	cfg["access"] = "whitelist"
	cfg["whitelist"] = []string{"alice", "bob"}
	e.publishOK(e.tokens["alice"], "wl-diag", "1.0.0", testGuestModule(t), cfg)

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/wl-diag/diagnostics", e.tokens["alice"], nil)
	var out diagEventsOut
	e.decodeJSON(w, http.StatusOK, &out)
	d := out.Diagnostics
	if d.Access != "whitelist" {
		t.Fatalf("诊断必须回显生效访问级别（作者要能对上配置），得到 %q", d.Access)
	}
	if d.WhitelistEnforced {
		t.Fatal("whitelist_enforced 必须恒为 false：平台不比对名单（R24）")
	}
	if !containsSubstring(d.Hints, "平台不比对白名单") || !containsSubstring(d.Hints, "zeokeel.app.json") {
		t.Fatalf("whitelist 诊断必须给「应用自己怎么判」的可操作 hint，得到 %v", d.Hints)
	}

	// 非 whitelist 行不该被刷这条 hint（否则等于给所有作者加噪音）。
	other := goodConfig()
	e.publishOK(e.tokens["alice"], "login-diag", "1.0.0", testGuestModule(t), other)
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/login-diag/diagnostics", e.tokens["alice"], nil)
	var plain diagEventsOut
	e.decodeJSON(w, http.StatusOK, &plain)
	if plain.Diagnostics.WhitelistEnforced {
		t.Fatal("whitelist_enforced 恒为 false 是平台事实，不应随 access 变化")
	}
	if containsSubstring(plain.Diagnostics.Hints, "平台不比对白名单") {
		t.Fatalf("access=login 的应用不该出现 whitelist hint: %v", plain.Diagnostics.Hints)
	}
}

// TestPublishReceiptStatesWhitelistNotEnforced 覆盖 A6 的回执面。
func TestPublishReceiptStatesWhitelistNotEnforced(t *testing.T) {
	e := newTestEnv(t)
	cfg := goodConfig()
	cfg["access"] = "whitelist"
	cfg["whitelist"] = []string{"alice"}
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/wl-receipt/releases", e.tokens["alice"],
		e.payload("wl-receipt", "1.0.0", testGuestModule(t), cfg))
	var out struct {
		WhitelistEnforced bool     `json:"whitelist_enforced"`
		Warnings          []string `json:"warnings"`
	}
	e.decodeJSON(w, http.StatusCreated, &out)
	if out.WhitelistEnforced {
		t.Fatal("发布回执的 whitelist_enforced 必须恒为 false（平台不比对名单，R24）")
	}
	if !containsSubstring(out.Warnings, "平台不比对白名单") {
		t.Fatalf("whitelist 版本的发布回执必须带一次性 warning，得到 %v", out.Warnings)
	}

	// 非 whitelist：warnings 恒在且为空数组（不是 null），whitelist_enforced 仍是 false。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/login-receipt/releases", e.tokens["alice"],
		e.payload("login-receipt", "1.0.0", testGuestModule(t), goodConfig()))
	raw := w.Body.String()
	e.decodeJSON(w, http.StatusCreated, &struct{}{})
	if !strings.Contains(raw, `"warnings":[]`) {
		t.Fatalf("非 whitelist 发布回执的 warnings 必须是空数组（不是 null/省略）: %s", raw)
	}
	if !strings.Contains(raw, `"whitelist_enforced":false`) {
		t.Fatalf("whitelist_enforced=false 必须恒在发布回执里: %s", raw)
	}
}

// containsSubstring 判断任一字符串包含 needle（hints 是保序去重后的数组）。
func containsSubstring(list []string, needle string) bool {
	for _, s := range list {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
