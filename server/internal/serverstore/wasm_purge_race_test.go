package serverstore

// 真删两阶段（迁移 0088）的行为级判据：purge 与 restore 必须互斥，且
// "purged_at 已置"与"数据目录已清"分别可收敛。
//
// 缺陷现场（2026-10-22 生产级评审 · 管理员视角 P0）：旧实现先 RemoveAppData 再
// MarkWasmAppPurged，中间无行锁，Mark 的 WHERE 只有 purged_at IS NULL。管理员在
// 保留期刚过时点恢复：restore 200 之后 purge 把刚恢复的数据与快照一起删掉，并把
// purged_at 置位 ⇒ 之后恢复/导出永久 410，不可逆。
//
// 变异验证（删哪行会红）：
//   - BeginWasmAppPurge 去掉 `FOR UPDATE` 或去掉 deleted_at 重校验 ⇒
//     并发用例出现 restore=nil 且 purged=true；
//   - 去掉 snapshot_at/purge_after 重校验 ⇒ 资格矩阵用例红；
//   - 去掉 data_cleaned_at 条件 ⇒ 清理候选用例红。

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"
)

// purgeFixtureApp 造一个"已删 + 到期 + 有快照"的应用。
func purgeFixtureApp(t *testing.T, f *releaseFixture, appID string, past time.Time) {
	t.Helper()
	f.app(appID)
	f.approved(appID, "1.0.0", appID, `{"access":"login"}`)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, appID, past, past); err != nil {
		t.Fatalf("软删 %s: %v", appID, err)
	}
	if err := SetWasmAppSnapshot(f.ctx, f.db, appID, WasmSnapshotRecord{At: &past, Path: "/snap/" + appID}); err != nil {
		t.Fatalf("记快照 %s: %v", appID, err)
	}
}

// TestBeginWasmAppPurgeRequiresEligibility：资格不满足一律拒绝，且不改任何状态。
func TestBeginWasmAppPurgeRequiresEligibility(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)
	future := now.Add(24 * time.Hour)

	purgeFixtureApp(t, f, "due", past)
	// 未到期
	f.app("future")
	f.approved("future", "1.0.0", "future", `{"access":"login"}`)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "future", past, future); err != nil {
		t.Fatalf("软删 future: %v", err)
	}
	if err := SetWasmAppSnapshot(f.ctx, f.db, "future", WasmSnapshotRecord{At: &past, Path: "/snap/future"}); err != nil {
		t.Fatalf("快照 future: %v", err)
	}
	// 未删除
	f.app("live")
	f.approved("live", "1.0.0", "live", `{"access":"login"}`)
	if err := SetWasmAppSnapshot(f.ctx, f.db, "live", WasmSnapshotRecord{At: &past, Path: "/snap/live"}); err != nil {
		t.Fatalf("快照 live: %v", err)
	}
	// 已清除
	f.app("already")
	f.approved("already", "1.0.0", "already", `{"access":"login"}`)
	if err := MarkWasmAppPurged(f.ctx, f.db, "already", past); err != nil {
		t.Fatalf("标记 already: %v", err)
	}

	for _, appID := range []string{"future", "live", "already"} {
		ok, err := BeginWasmAppPurge(f.ctx, f.db, appID, now)
		if err != nil {
			t.Fatalf("BeginWasmAppPurge(%s): %v", appID, err)
		}
		if ok {
			t.Fatalf("%s 不满足资格却被标记 purged（会造成不可逆误删）", appID)
		}
		if appID != "already" {
			if app := f.getApp(appID); app.PurgedAt != nil {
				t.Fatalf("%s 资格不满足却写了 purged_at", appID)
			}
		}
	}

	ok, err := BeginWasmAppPurge(f.ctx, f.db, "due", now)
	if err != nil || !ok {
		t.Fatalf("满足资格的应用必须可进入 purged 终态：ok=%v err=%v", ok, err)
	}
	app := f.getApp("due")
	if app.PurgedAt == nil {
		t.Fatal("BeginWasmAppPurge 必须写 purged_at")
	}
	if app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("purged 必须清当前指针：release=%d deployment=%d", app.CurrentReleaseID, app.CurrentDeploymentID)
	}
}

// TestBeginPurgeAfterRestoreIsRejected：restore 先提交 ⇒ purge 重校验失败、不删数据。
func TestBeginPurgeAfterRestoreIsRejected(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)
	purgeFixtureApp(t, f, "restored-first", past)

	if err := RestoreWasmApp(f.ctx, f.db, "restored-first"); err != nil {
		t.Fatalf("restore: %v", err)
	}
	ok, err := BeginWasmAppPurge(f.ctx, f.db, "restored-first", now)
	if err != nil {
		t.Fatalf("BeginWasmAppPurge: %v", err)
	}
	if ok {
		t.Fatal("已被恢复的应用不得被标记 purged（旧实现会在这里删掉刚恢复的数据）")
	}
	app := f.getApp("restored-first")
	if app.PurgedAt != nil || app.DeletedAt != nil {
		t.Fatalf("恢复后的状态被 purge 污染：purged=%v deleted=%v", app.PurgedAt, app.DeletedAt)
	}
}

// TestBeginPurgeThenRestoreIsRejected：purge 先提交 ⇒ restore 必须回 ErrAppPurged。
func TestBeginPurgeThenRestoreIsRejected(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)
	purgeFixtureApp(t, f, "purged-first", past)

	if ok, err := BeginWasmAppPurge(f.ctx, f.db, "purged-first", now); err != nil || !ok {
		t.Fatalf("BeginWasmAppPurge: ok=%v err=%v", ok, err)
	}
	if err := RestoreWasmApp(f.ctx, f.db, "purged-first"); !errors.Is(err, ErrAppPurged) {
		t.Fatalf("purged 之后 restore 必须回 ErrAppPurged，得到 %v", err)
	}
}

// TestPurgeCleanupCandidatesCoverTwoPhases：data_cleaned_at 未置 ⇒ 进清理候选；置后消失。
func TestPurgeCleanupCandidatesCoverTwoPhases(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)
	purgeFixtureApp(t, f, "two-phase", past)
	if ok, err := BeginWasmAppPurge(f.ctx, f.db, "two-phase", now); err != nil || !ok {
		t.Fatalf("BeginWasmAppPurge: ok=%v err=%v", ok, err)
	}
	ids, err := PurgeCleanupCandidates(f.ctx, f.db, 100)
	if err != nil {
		t.Fatalf("PurgeCleanupCandidates: %v", err)
	}
	if len(ids) != 1 || ids[0] != "two-phase" {
		t.Fatalf("purged 但未记 data_cleaned_at 的应用必须进清理候选，得到 %v", ids)
	}
	if err := MarkWasmAppDataCleaned(f.ctx, f.db, "two-phase", now); err != nil {
		t.Fatalf("MarkWasmAppDataCleaned: %v", err)
	}
	ids, err = PurgeCleanupCandidates(f.ctx, f.db, 100)
	if err != nil {
		t.Fatalf("PurgeCleanupCandidates(2): %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("清理完成后不得再进候选，得到 %v", ids)
	}
}

// TestPurgeVsRestoreConcurrentInvariant：并发下不变量——
// 绝不允许「restore 返回 nil 且 purged_at 非空」；也绝不允许「restore nil 且数据被标记清除」。
// 用多轮同步屏障放大竞争窗口；旧实现（删盘→置位、无 deleted_at 重校验）可稳定打出反例。
func TestPurgeVsRestoreConcurrentInvariant(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)

	for i := 0; i < 20; i++ {
		appID := "race-" + string(rune('a'+i))
		purgeFixtureApp(t, f, appID, past)

		start := make(chan struct{})
		var wg sync.WaitGroup
		var purgeOK bool
		var purgeErr error
		var restoreErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			purgeOK, purgeErr = BeginWasmAppPurge(f.ctx, f.db, appID, now)
		}()
		go func() {
			defer wg.Done()
			<-start
			restoreErr = RestoreWasmApp(f.ctx, f.db, appID)
		}()
		close(start)
		wg.Wait()

		if purgeErr != nil {
			t.Fatalf("%s purge err: %v", appID, purgeErr)
		}
		app := f.getApp(appID)
		// 不变量 1：restore 成功 ⇒ purged_at 必须为空（否则恢复出来的是"已清除"的应用）。
		if restoreErr == nil && app.PurgedAt != nil {
			t.Fatalf("%s: restore 成功但 purged_at 非空（旧 P0 的现场）", appID)
		}
		// 不变量 2：purge 成功 ⇒ restore 必须被拒（ErrAppPurged）。
		if purgeOK && !errors.Is(restoreErr, ErrAppPurged) {
			t.Fatalf("%s: purge 成功但 restore 返回 %v（应 ErrAppPurged）", appID, restoreErr)
		}
		// 不变量 3：两者都成功是不可能的。
		if purgeOK && restoreErr == nil {
			t.Fatalf("%s: purge 与 restore 同时成功（必须互斥）", appID)
		}
		// 不变量 4：restore 成功 ⇒ 删除时间线已清（后续可正常发布/打开）。
		if restoreErr == nil && app.DeletedAt != nil {
			t.Fatalf("%s: restore 成功但 deleted_at 仍非空", appID)
		}
		_ = context.Background()
	}
}

// TestMigration0088IsReplayable：0088 可重放且不改既有应用行（新增列 + 部分索引）。
func TestMigration0088IsReplayable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	var m88 *migration
	for _, m := range migrationsFor() {
		if m.version == 88 {
			mm := m
			m88 = &mm
		}
	}
	if m88 == nil {
		t.Fatal("找不到 0088 迁移")
	}
	if err := UpsertWasmApp(ctx, db, WasmApp{AppID: "m88-app", Title: "m88", Owner: "alice", Enabled: true, Purpose: "演示", DataSensitivity: "internal"}); err != nil {
		t.Fatalf("建应用: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := db.Exec(m88.sql); err != nil {
			t.Fatalf("重放 0088（第 %d 次）: %v", i+1, err)
		}
	}
	var col int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'apps' AND column_name = 'data_cleaned_at'`).Scan(&col); err != nil {
		t.Fatalf("查列: %v", err)
	}
	if col != 1 {
		t.Fatalf("data_cleaned_at 列不存在（重放后）")
	}
	var idx int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_indexes
		WHERE tablename = 'apps' AND indexname = 'idx_apps_purge_cleanup'`).Scan(&idx); err != nil {
		t.Fatalf("查索引: %v", err)
	}
	if idx != 1 {
		t.Fatalf("idx_apps_purge_cleanup 索引不存在")
	}
	if app := getWasmAppForTest(t, ctx, db, "m88-app"); app == nil {
		t.Fatal("重放 0088 不得丢失既有应用行")
	}
}

// getWasmAppForTest 读一行应用（测试用，避免依赖别的文件的私有 helper）。
func getWasmAppForTest(t *testing.T, ctx context.Context, db *sql.DB, appID string) *WasmApp {
	t.Helper()
	app, err := GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp(%s): %v", appID, err)
	}
	return app
}
