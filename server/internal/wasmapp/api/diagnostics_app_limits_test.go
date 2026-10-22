package api

// 生产化评审（2026-10-22）：诊断响应必须下发**该应用**的生效并发四轴与来源，
// 429 提示必须按生效值渲染。[应用开发者] 需要知道"我是不是被单独降额了"，
// [管理员] 需要能解释某个应用的排队现象。
//
// 变异验证（删实现后本用例必红）：
//   - read.go 不注入 axes（回到 SummaryWithLimits/HintsForLimits）⇒ hints 不含"本应用生效上限"；
//   - 响应删掉 limits 段 / source 恒为 global ⇒ 前两条断言红；
//   - cmd/server 不注入 AppLimitsEffective ⇒ 装配级用例（cmd/server）红。

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
)

// diagnosticsBodyFor 真跑 diagnosticsPayload（含 DB 查询与 hints 合并）。
func asJSONMap(t *testing.T, v any) map[string]any {
	t.Helper()
	if v == nil {
		return nil
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func diagnosticsBodyFor(t *testing.T, h *Handlers, appID string) map[string]any {
	t.Helper()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET",
		"/api/client/v2/apps/wasm/"+appID+"/diagnostics?minutes=60&limit=10", nil)
	body, aerr := h.diagnosticsPayload(c, appID, &serverstore.WasmApp{AppID: appID, Enabled: true})
	if aerr != nil {
		t.Fatalf("diagnosticsPayload: %v", aerr.JSON())
	}
	return body
}

// TestDiagnosticsPayloadExposesEffectiveAppLimits：响应里的 limits 段 = 生效值 + 来源。
func TestDiagnosticsPayloadExposesEffectiveAppLimits(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const appID = "diag-app-limits"

	global := applimits.Defaults() // 4 / 32 / 2 / 4
	if _, err := db.ExecContext(ctx, `INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, guest_exit_code, stderr_tail, cpu_ms, peak_memory_bytes, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		appID, 0, "error", string(apperr.CodeAppQueueFull), 0, "", 1, 1024,
		time.Now().UTC()); err != nil {
		t.Fatalf("写调用事件: %v", err)
	}

	h := NewHandlers(Options{
		DB:     db,
		Limits: func() applimits.Limits { return global },
		AppLimitsEffective: func(string) (limits.Axes, bool) {
			return limits.Axes{AppRunning: 1, AppQueue: 4, UserPerAppRunning: 1, UserPerAppQueued: 2}, true
		},
	})
	body := diagnosticsBodyFor(t, h, appID)
	lim := asJSONMap(t, body["limits"])
	if lim == nil {
		t.Fatalf("响应缺 limits 段：%v", body)
	}
	if lim["source"] != "override" {
		t.Fatalf("limits.source = %v，want override", lim["source"])
	}
	if lim["app_running"] != float64(1) || lim["app_queue"] != float64(4) || lim["user_per_app_running"] != float64(1) {
		t.Fatalf("limits 段没有用生效值：%v", lim)
	}
	raw, _ := json.Marshal(body["hints"])
	var hints []string
	_ = json.Unmarshal(raw, &hints)
	if !hintsContain(hints, "本应用生效上限") {
		t.Fatalf("429 提示必须按应用生效值渲染：%v", hints)
	}
	if !hintsContain(hints, "每应用队列 4") || !hintsContain(hints, "在跑 1 个") {
		t.Fatalf("429 提示必须含应用生效数值：%v", hints)
	}
	if hintsContain(hints, "每应用队列 32") {
		t.Fatalf("429 首条提示不能以全局默认队列 32 为主导：%v", hints)
	}
}

// TestDiagnosticsPayloadLimitsFallbackGlobal：未装配生效钩子 ⇒ 回落全局值且 source=global。
func TestDiagnosticsPayloadLimitsFallbackGlobal(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	const appID = "diag-global-only"
	global := applimits.Defaults()
	global.AppRunning = 3
	h := NewHandlers(Options{DB: db, Limits: func() applimits.Limits { return global }})
	body := diagnosticsBodyFor(t, h, appID)
	lim := asJSONMap(t, body["limits"])
	if lim == nil || lim["source"] != "global" || lim["app_running"] != float64(3) {
		t.Fatalf("未装配钩子时必须回落全局值且 source=global：%v", lim)
	}
}
