package appserver

// 生产级评审（2026-10-22 管理员视角 P1-3）：准入**之前**已读入的请求体必须按**真实长度**
// 交给调度器占账（AcquireWithSize），否则全局排队体预算形同虚设。
//
// 本文件有两条判据：
//  1. 行为判据（需要真 PG，无 PG 时 skip）：一个超过排队体预算的请求在**队列条数还有
//     余量**时就被 429 + details.reason=queue_bytes_exceeded 拒掉 —— 这只有"体长真的
//     传给了调度器"才可能成立（传 0 会一路进队列等到墙钟）。
//  2. 接线守卫（不需要 PG）：serve.go 必须调用 AcquireWithSize(…, int64(len(body)))，
//     且不得残留裸 Acquire(...)：回归形态就是"把新增接口换回旧调用"，这行代码是
//     整笔账的唯一入口，值得一条不依赖数据库的静态判据。

import (
	"context"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/queue"
)

// TestServe_QueueBodyBudgetRejectsOversizeQueuedBody：真实体长进准入判据。
//
// 变异：把 serve.go 的 AcquireWithSize(…, int64(len(body))) 换回 Acquire(…)
// ⇒ 本用例拿到的错误码是 APP_QUEUE_FULL/wall_clock_exceeded（而不是
// queue_bytes_exceeded），断言红。
func TestServe_QueueBodyBudgetRejectsOversizeQueuedBody(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		qopt := queue.DefaultOptions()
		qopt.PerAppRunning = 1
		qopt.PerAppQueue = 32 // 条数余量充足：被拒只可能是**字节**闸门
		qopt.PerUserPerAppQueued = 32
		qopt.QueueBodyBytes = 1 << 10 // 1 KiB：4 KiB 的体必然超
		// 墙钟压到 2 s（来自生效限制项，serve.go 用的是 CurrentLimits().WallClock()）：
		// 万一体长没传进来，请求会真的入队等墙钟 —— 2 s 后以 wall_clock_exceeded 收场，
		// 用例**快速失败**而不是挂 60 s。
		lim := applimits.Defaults()
		lim.GuestBudgetSeconds = 1
		lim.RequestWallClockSeconds = 2
		o.Limits = lim
		o.Scheduler = queue.New(qopt)
	})
	appID := e.appID("bodybudget")
	e.publishApp(appSpec{appID: appID})

	// 占住唯一执行槽（userID=0：不参与"每用户在跑"计数）。
	held, aerr := e.srv.scheduler.Acquire(context.Background(), appID, 0)
	if aerr != nil {
		t.Fatalf("占住执行槽: %v", aerr)
	}
	defer held.Release()

	oversize := strings.Repeat("a", 4<<10)
	rec := e.post(appID, "/api/save", "application/json", oversize)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("超过排队体预算应 429，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got == "" {
		t.Fatal("429 必须带 Retry-After（§7.4）")
	}
	env := decodeJSON(t, strings.NewReader(rec.Body.String()))
	errObj, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatalf("响应不是错误信封：%v", env)
	}
	if code, _ := errObj["code"].(string); code != "APP_QUEUE_FULL" {
		t.Fatalf("错误码 = %q，want APP_QUEUE_FULL", code)
	}
	details, _ := errObj["details"].(map[string]any)
	if got, _ := details["reason"].(string); got != "queue_bytes_exceeded" {
		t.Fatalf("details.reason = %q，want queue_bytes_exceeded（体长没有进准入判据？）", got)
	}
	if got, _ := details["request_body_bytes"].(float64); int64(got) != int64(len(oversize)) {
		t.Fatalf("details.request_body_bytes = %v，want %d（必须是**真实**体长）", details["request_body_bytes"], len(oversize))
	}

	// 被拒的请求一个字节都不许占账（超卖一次就多一份常驻）。
	st := e.srv.scheduler.Stats()
	if st.QueuedBodyBytes != 0 || st.MaxQueuedBodyBytes != 0 {
		t.Fatalf("被拒的请求占了排队体账：queued=%d max=%d", st.QueuedBodyBytes, st.MaxQueuedBodyBytes)
	}
	if st.RejectedQueueBytes != 1 {
		t.Fatalf("RejectedQueueBytes = %d，want 1（管理面要能看到「因排队内存被拒」）", st.RejectedQueueBytes)
	}
	if r, w := e.srv.scheduler.AppStats(appID); r != 1 || w != 0 {
		t.Fatalf("drain 后 running=%d waiting=%d，want 1/0（只有占位的那一个在跑）", r, w)
	}
}

// TestServePassesRealBodySizeToScheduler 是**接线守卫**（不需要 PG）：
// 生产管线必须把 `len(body)` 交给 AcquireWithSize。
//
// 变异：把那一行换回 `s.scheduler.Acquire(ctx, appID, userIDOf(user))` ⇒ 本用例红
// （这是唯一一处能让"排队体预算"生效的接线，回归成本极低、后果是整笔账静默失效）。
func TestServePassesRealBodySizeToScheduler(t *testing.T) {
	src, err := os.ReadFile("serve.go")
	if err != nil {
		t.Fatalf("读取 serve.go: %v", err)
	}
	code := string(src)
	want := regexp.MustCompile(`AcquireWithSize\(\s*ctx\s*,\s*appID\s*,\s*userIDOf\(user\)\s*,\s*int64\(len\(body\)\)\s*\)`)
	if !want.MatchString(code) {
		t.Fatalf("serve.go 必须用 AcquireWithSize(ctx, appID, userIDOf(user), int64(len(body))) " +
			"把**真实请求体长度**交给调度器（否则全局排队体预算失效，评审 P1-3）")
	}
	old := regexp.MustCompile(`scheduler\.Acquire\(\s*ctx\s*,\s*appID\s*,\s*userIDOf\(user\)\s*\)`)
	if old.MatchString(code) {
		t.Fatal("serve.go 不得再调用不带体长的 Acquire（回归形态：排队体预算被绕过）")
	}
}
