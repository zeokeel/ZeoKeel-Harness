package api

// 生产级评审（2026-10-22 管理员视角 P1）：/admin/runtime 必须能回答
// "哪个应用在拖垮平台/为什么用户一直失败/退役真删作业跑没跑"。
//
// 变异：删掉 adminRuntime 里的 queue/schedulers 段，或 cmd/server 不注入对应钩子
// ⇒ 本用例红。

import (
	"net/http"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/queue"
)

func TestAdminRuntimeExposesQueueAndSchedulers(t *testing.T) {
	started := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	lastRun := started.Add(time.Hour)
	e := newTestEnv(t, func(o *Options) {
		o.QueueStats = func() queue.Stats {
			return queue.Stats{
				GlobalRunning: 3, Waiting: 2, Apps: 2, TrackedApps: 4,
				RejectedQueueFull: 7, RejectedWallClock: 1,
				// P1-3：排队请求体字节账（上限/此刻/峰值/因它被拒）。
				RejectedQueueBytes: 5, QueuedBodyBytes: 3 << 20,
				MaxQueuedBodyBytes: 8 << 20, QueueBodyBytesLimit: limits.WasmQueueBodyBytesMax,
			}
		}
		o.QueueApps = func(limit int) []queue.AppWatermark {
			return []queue.AppWatermark{{AppID: "heavy-app", Running: 2, Waiting: 2, Rejected: 7, QueuedBodyBytes: 3 << 20}}
		}
		o.PurgeBacklog = func() ([]string, int) {
			return []string{"stuck-app"}, 2
		}
		o.SchedulerStatus = func() []SchedulerStatusView {
			return []SchedulerStatusView{{
				Name: "wasm_retirement", TickSeconds: 3600, Started: true, StartedAt: &started,
				MetricsAvailable: true, Source: "scheduler", Runs: 5, Errors: 1,
				LastRunAt: &lastRun, LastError: "disk full",
			}}
		}
	})
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/runtime", "", nil)
	var out struct {
		Runtime struct {
			Queue struct {
				GlobalRunning       int                  `json:"global_running"`
				Waiting             int                  `json:"waiting"`
				RejectedQueueFull   int64                `json:"rejected_queue_full"`
				RejectedWallClock   int64                `json:"rejected_wall_clock"`
				RejectedQueueBytes  int64                `json:"rejected_queue_bytes"`
				QueuedBodyBytes     int64                `json:"queued_body_bytes"`
				MaxQueuedBodyBytes  int64                `json:"max_queued_body_bytes"`
				QueueBodyBytesLimit int64                `json:"queue_body_bytes_limit"`
				TopApps             []queue.AppWatermark `json:"top_apps"`
			} `json:"queue"`
			Schedulers []SchedulerStatusView `json:"schedulers"`
			Purge      struct {
				BlockedNoSnapshot []string `json:"blocked_no_snapshot"`
				CleanupPending    int      `json:"cleanup_pending"`
			} `json:"purge"`
		} `json:"runtime"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Runtime.Queue.GlobalRunning != 3 || out.Runtime.Queue.Waiting != 2 {
		t.Fatalf("queue 水位错误：%+v", out.Runtime.Queue)
	}
	if out.Runtime.Queue.RejectedQueueFull != 7 || out.Runtime.Queue.RejectedWallClock != 1 {
		t.Fatalf("429 计数错误：%+v", out.Runtime.Queue)
	}
	// P1-3：管理面必须能回答"排队请求体有没有撞到上限"（此刻/峰值/上限/拒因计数）。
	if out.Runtime.Queue.QueuedBodyBytes != 3<<20 || out.Runtime.Queue.MaxQueuedBodyBytes != 8<<20 {
		t.Fatalf("排队体字节读数错误：%+v", out.Runtime.Queue)
	}
	if out.Runtime.Queue.QueueBodyBytesLimit != limits.WasmQueueBodyBytesMax {
		t.Fatalf("排队体上限 = %d，want %d（与运行期判据同源）",
			out.Runtime.Queue.QueueBodyBytesLimit, limits.WasmQueueBodyBytesMax)
	}
	if out.Runtime.Queue.RejectedQueueBytes != 5 {
		t.Fatalf("排队体拒绝计数 = %d，want 5", out.Runtime.Queue.RejectedQueueBytes)
	}
	if len(out.Runtime.Queue.TopApps) != 1 || out.Runtime.Queue.TopApps[0].AppID != "heavy-app" {
		t.Fatalf("按应用水位错误：%+v", out.Runtime.Queue.TopApps)
	}
	if out.Runtime.Queue.TopApps[0].QueuedBodyBytes != 3<<20 {
		t.Fatalf("按应用的排队体字节 = %d，want 3 MiB（谁吃掉了排队内存）",
			out.Runtime.Queue.TopApps[0].QueuedBodyBytes)
	}
	if len(out.Runtime.Purge.BlockedNoSnapshot) != 1 || out.Runtime.Purge.BlockedNoSnapshot[0] != "stuck-app" || out.Runtime.Purge.CleanupPending != 2 {
		t.Fatalf("purge 积压段错误：%+v", out.Runtime.Purge)
	}
	if len(out.Runtime.Schedulers) != 1 || out.Runtime.Schedulers[0].Name != "wasm_retirement" {
		t.Fatalf("调度器快照错误：%+v", out.Runtime.Schedulers)
	}
	if out.Runtime.Schedulers[0].Runs != 5 || out.Runtime.Schedulers[0].LastError != "disk full" {
		t.Fatalf("调度器读数错误：%+v", out.Runtime.Schedulers[0])
	}
}
