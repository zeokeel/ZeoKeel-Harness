package diag

// 生产级评审（2026-10-22 应用开发者视角 D-02）：诊断必须回答"哪个版本在失败"，
// 否则回滚后无法验证是否止血、新版本是否更差。
//
// 变异：Failure 不 select/scan version、summary 去掉按版本聚合 ⇒ 本用例红。

import (
	"context"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
)

func TestDiagnosticsExposeVersionDimension(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()
	const appID = "versioned-tool"

	ins := func(version, outcome, reason string, at time.Time) {
		t.Helper()
		if _, err := db.ExecContext(ctx, `INSERT INTO wasm_call_events
			(app_id, version, user_id, outcome, reason_code, guest_exit_code, stderr_tail, cpu_ms, peak_memory_bytes, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			appID, version, 1, outcome, reason, 0, "", 10, 1024, at); err != nil {
			t.Fatalf("写入事件: %v", err)
		}
	}
	ins("1.0.0", "ok", "", now.Add(-3*time.Hour))
	ins("1.0.0", "error", string(apperr.CodeRuntimeMemory), now.Add(-2*time.Hour))
	ins("2.0.0", "error", string(apperr.CodeRuntimeTrap), now.Add(-time.Hour))
	ins("2.0.0", "error", string(apperr.CodeRuntimeTrap), now.Add(-30*time.Minute))

	summary, err := SummaryWithLimits(ctx, db, appID, now.Add(-24*time.Hour), 0, applimitsForTest())
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if len(summary.Versions) != 2 {
		t.Fatalf("versions = %d 项，want 2：%+v", len(summary.Versions), summary.Versions)
	}
	// 次数降序：2.0.0（2 次）在 1.0.0（2 次）前时按版本号升序？两者次数相同 ⇒ 按 version 升序。
	by := map[string]VersionSummary{}
	for _, v := range summary.Versions {
		by[v.Version] = v
	}
	if by["1.0.0"].Total != 2 || by["1.0.0"].Failed != 1 {
		t.Fatalf("1.0.0 聚合错误：%+v", by["1.0.0"])
	}
	if by["2.0.0"].Total != 2 || by["2.0.0"].Failed != 2 {
		t.Fatalf("2.0.0 聚合错误：%+v", by["2.0.0"])
	}
	if by["2.0.0"].LastFailureAt == nil {
		t.Fatal("版本聚合必须带 last_failure_at")
	}

	failures, err := RecentFailures(ctx, db, appID, 10)
	if err != nil {
		t.Fatalf("RecentFailures: %v", err)
	}
	if len(failures) != 3 {
		t.Fatalf("failures = %d，want 3", len(failures))
	}
	for _, f := range failures {
		if f.Version == "" {
			t.Fatalf("失败记录必须带执行版本：%+v", f)
		}
	}
}

// applimitsForTest 返回一份合法的默认限制项（本用例只关心版本维度）。
func applimitsForTest() applimits.Limits { return applimits.Defaults() }
