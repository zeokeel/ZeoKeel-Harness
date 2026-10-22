package serverstore

// C-13 / C-08 / F-1 的**存储层**判据（审计 2026-10-22 第二轮服务端）。
//
//	C-13：`ListWasmApps` 支持 LIMIT/OFFSET，`CountWasmApps` 与它**同一谓词**，
//	     `ListWasmAppsPage` 一次给出 rows+total。搜索词按 LIKE 字面量转义（用户的
//	     `%`/`_` 不是通配符）；`Status` 的 `pending` 与徽标（CountPendingReleases）
//	     同一判据集合（排除已删除/已清除应用）。
//	C-08：`PurgeStalePendingReleases` 批量把待审版本标 withdrawn、释放字节、reason 固定、
//	     幂等，且**不动**已删除应用的待审行。
//	F-1 ：`CountPendingReleases` / `PendingWasmReleases` 必须排除已删除应用
//	     （否则页头徽标与待审队列会分叉）。
//
// 变异验证：
//   - 删掉 ListWasmApps 的 LIMIT/OFFSET 拼接 ⇒ TestListWasmAppsPageLimitOffsetAndCount 红；
//   - 把 CountWasmApps 换成 `len(rows)` 的口径（例如加 `LIMIT` 影响 count）⇒ 同上红；
//   - 删掉 escapeLikePattern ⇒ `%` 用例红（搜索变成通配符，命中全部）；
//   - 把 Status=pending 的 EXISTS 谓词去掉 `deleted_at IS NULL` ⇒
//     TestListWasmAppsStatusMatchesBadgePredicate 的 pending 断言红；
//   - 去掉 PurgeStalePendingReleases 的 `r.status = pending` 判据 ⇒ 幂等用例红
//     （第二次仍会"清理"已 withdrawn 的行并重复计数）；
//   - 去掉 `a.deleted_at IS NULL` ⇒ 已删除应用的待审行被改动，用例红。

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"
)

// wave2Fixture 是本文件用的最小夹具（独立临时库 + 常用构造器）。
type wave2Fixture struct {
	t   *testing.T
	db  *sql.DB
	ctx context.Context
}

// TestListWasmAppsPageLimitOffsetAndCount 覆盖 LIMIT/OFFSET 与 total 的独立性。
func TestListWasmAppsPageLimitOffsetAndCount(t *testing.T) {
	f := newWave2Fixture(t)
	for i := 0; i < 5; i++ {
		f.app(fmt.Sprintf("p-%03d", i), true)
	}

	first, err := ListWasmAppsPage(f.ctx, f.db, WasmAppFilter{Limit: 2, Offset: 0})
	if err != nil {
		t.Fatalf("ListWasmAppsPage: %v", err)
	}
	if first.Total != 5 {
		t.Fatalf("total = %d, want 5（与 LIMIT 无关）", first.Total)
	}
	if len(first.Apps) != 2 || first.Apps[0].AppID != "p-000" || first.Apps[1].AppID != "p-001" {
		t.Fatalf("第一页不对: %+v", first.Apps)
	}

	second, err := ListWasmAppsPage(f.ctx, f.db, WasmAppFilter{Limit: 2, Offset: 2})
	if err != nil {
		t.Fatalf("ListWasmAppsPage(offset=2): %v", err)
	}
	if second.Total != 5 || len(second.Apps) != 2 ||
		second.Apps[0].AppID != "p-002" || second.Apps[1].AppID != "p-003" {
		t.Fatalf("第二页不对: total=%d apps=%+v", second.Total, second.Apps)
	}

	tail, err := ListWasmAppsPage(f.ctx, f.db, WasmAppFilter{Limit: 2, Offset: 4})
	if err != nil {
		t.Fatalf("ListWasmAppsPage(offset=4): %v", err)
	}
	if tail.Total != 5 || len(tail.Apps) != 1 || tail.Apps[0].AppID != "p-004" {
		t.Fatalf("尾页不对: total=%d apps=%+v", tail.Total, tail.Apps)
	}

	beyond, err := ListWasmAppsPage(f.ctx, f.db, WasmAppFilter{Limit: 2, Offset: 99})
	if err != nil {
		t.Fatalf("ListWasmAppsPage(offset=99): %v", err)
	}
	if beyond.Total != 5 || len(beyond.Apps) != 0 {
		t.Fatalf("越界页应空但 total 不变: total=%d apps=%d", beyond.Total, len(beyond.Apps))
	}

	// Limit=0 保持旧语义（不分页、全量）。
	all, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{})
	if err != nil || len(all) != 5 {
		t.Fatalf("Limit=0 应返回全量: err=%v n=%d", err, len(all))
	}
}

// TestListWasmAppsSearchAndStatusPushdown 覆盖 q / status 的 SQL 语义。
func TestListWasmAppsSearchAndStatusPushdown(t *testing.T) {
	f := newWave2Fixture(t)
	f.app("alpha-tool", true) // published
	f.app("beta-tool", false) // unpublished
	f.app("pct-row", true)    // 标题含 %（LIKE 字面量判据）
	f.release("pct-row", "1.0.0", ReleaseStatusApproved, true)
	f.app("frozen-tool", true)
	if err := FreezeWasmApp(f.ctx, f.db, "frozen-tool", time.Now().UTC()); err != nil {
		t.Fatalf("冻结: %v", err)
	}
	f.app("gone-tool", true)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "gone-tool", time.Now().UTC(), time.Now().UTC().Add(90*24*time.Hour)); err != nil {
		t.Fatalf("软删: %v", err)
	}
	// 给标题写一个 %：验证搜索按字面量（通配符会命中全部行）。
	if _, err := f.db.Exec(`UPDATE apps SET title = '完成度 100% 报表' WHERE kind = $1 AND app_id = 'pct-row'`,
		AppKindWasmApp); err != nil {
		t.Fatalf("改标题: %v", err)
	}
	// pending 行的应用（存活）与被删除应用的 pending（不得计入）。
	f.app("pending-live", true)
	f.release("pending-live", "1.1.0", ReleaseStatusPending, true)
	f.app("pending-gone", true)
	f.release("pending-gone", "2.0.0", ReleaseStatusPending, true)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "pending-gone", time.Now().UTC(), time.Now().UTC().Add(90*24*time.Hour)); err != nil {
		t.Fatalf("软删 pending-gone: %v", err)
	}

	// q：子串、大小写不敏感。
	list, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Query: "ALPHA"})
	if err != nil || len(list) != 1 || list[0].AppID != "alpha-tool" {
		t.Fatalf("q 大小写不敏感子串失败: err=%v %+v", err, list)
	}
	// q 里的 % 必须按字面量匹配（否则会命中全部）。
	pct, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Query: "100%"})
	if err != nil || len(pct) != 1 || pct[0].AppID != "pct-row" {
		t.Fatalf("q 里的 %% 必须按字面量匹配: err=%v %+v", err, pct)
	}
	// 单独一个 % 不得匹配全部（通配符化的典型后果）。
	if wild, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Query: "%"}); err != nil || len(wild) != 1 {
		t.Fatalf("q=%% 只应命中标题里真的含 %% 的一行: err=%v n=%d", err, len(wild))
	}

	// status：published 排除已删除/冻结/下架。
	published, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: WasmAppListStatusPublished})
	if err != nil {
		t.Fatalf("status=published: %v", err)
	}
	ids := map[string]bool{}
	for _, a := range published {
		ids[a.AppID] = true
	}
	for _, want := range []string{"alpha-tool", "pct-row", "pending-live"} {
		if !ids[want] {
			t.Fatalf("published 应含 %s: %v", want, ids)
		}
	}
	for _, gone := range []string{"beta-tool", "frozen-tool", "gone-tool", "pending-gone"} {
		if ids[gone] {
			t.Fatalf("published 不该含 %s: %v", gone, ids)
		}
	}
	if unpublished, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: WasmAppListStatusUnpublished}); err != nil ||
		len(unpublished) != 1 || unpublished[0].AppID != "beta-tool" {
		t.Fatalf("status=unpublished 不对: err=%v %+v", err, unpublished)
	}
	if frozen, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: WasmAppListStatusFrozen}); err != nil ||
		len(frozen) != 1 || frozen[0].AppID != "frozen-tool" {
		t.Fatalf("status=frozen 不对: err=%v %+v", err, frozen)
	}
	if deleted, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: WasmAppListStatusDeleted}); err != nil ||
		len(deleted) != 2 {
		t.Fatalf("status=deleted 应命中 2 行（gone-tool/pending-gone）: err=%v n=%d", err, len(deleted))
	}

	// pending：与徽标（CountPendingReleases）同一判据集合 —— 已删除应用的待审不计入。
	pending, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: WasmAppListStatusPending})
	if err != nil {
		t.Fatalf("status=pending: %v", err)
	}
	if len(pending) != 1 || pending[0].AppID != "pending-live" {
		t.Fatalf("status=pending 只应命中存活应用: %+v", pending)
	}
	count, err := CountPendingReleases(f.ctx, f.db)
	if err != nil || count != len(pending) {
		t.Fatalf("徽标计数 %d 与 status=pending 行数 %d 必须同判据: err=%v", count, len(pending), err)
	}
	// 反证 F-1 的存储层半边：`PendingWasmReleases`（列表页的 map）同样必须排除已删除应用的
	// 待审版本 —— 它的旧实现只查 app_releases、不 join apps ⇒ 页头徽标会把"已删除应用的
	// 待审版本"也数进去，而队列里看不到、approve/reject 又一律 404（数字永远清不掉）。
	byApp, err := PendingWasmReleases(f.ctx, f.db)
	if err != nil {
		t.Fatalf("PendingWasmReleases: %v", err)
	}
	if _, ok := byApp["pending-gone"]; ok {
		t.Fatalf("PendingWasmReleases 不得包含已删除应用的待审版本: %+v", byApp)
	}
	if got := byApp["pending-live"]; len(got) != 1 || got[0] != "1.1.0" {
		t.Fatalf("PendingWasmReleases 必须包含存活应用的待审版本: %+v", byApp)
	}

	// 未知 status：报错而不是静默不筛（否则"筛了却什么都没有"会被读成空集）。
	if _, err := ListWasmApps(f.ctx, f.db, WasmAppFilter{Status: "bogus"}); err == nil {
		t.Fatal("未知 status 必须报错（静默不筛 = 管理员以为筛过了）")
	}
}

// TestPurgeStalePendingReleasesStore 覆盖 C-08 的存储层语义。
func TestPurgeStalePendingReleasesStore(t *testing.T) {
	f := newWave2Fixture(t)
	f.app("purge-a", true)
	f.release("purge-a", "1.0.0", ReleaseStatusApproved, true)
	f.release("purge-a", "1.1.0", ReleaseStatusPending, true)
	f.app("purge-b", true)
	f.release("purge-b", "2.0.0", ReleaseStatusPending, true)
	f.app("purge-gone", true)
	f.release("purge-gone", "3.0.0", ReleaseStatusPending, true)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "purge-gone", time.Now().UTC(), time.Now().UTC().Add(90*24*time.Hour)); err != nil {
		t.Fatalf("软删: %v", err)
	}

	n, err := PurgeStalePendingReleases(f.ctx, f.db, "")
	if err != nil {
		t.Fatalf("PurgeStalePendingReleases: %v", err)
	}
	if n != 2 {
		t.Fatalf("应清理 2 个存活应用的待审版本，得到 %d", n)
	}
	// 存活行：withdrawn + 字节释放 + 固定 reason。
	for _, tc := range []struct{ app, version string }{{"purge-a", "1.1.0"}, {"purge-b", "2.0.0"}} {
		var status, reason string
		var archiveLen *int
		var size int64
		if err := f.db.QueryRow(`SELECT status, reason, octet_length(archive), size FROM app_releases
			WHERE kind = $1 AND app_id = $2 AND version = $3`,
			AppKindWasmApp, tc.app, tc.version).Scan(&status, &reason, &archiveLen, &size); err != nil {
			t.Fatalf("读版本行: %v", err)
		}
		if status != ReleaseStatusWithdrawn || archiveLen != nil || size != 0 {
			t.Fatalf("%s v%s 应 withdrawn 且释放字节: status=%q archive=%v size=%d",
				tc.app, tc.version, status, archiveLen, size)
		}
		if reason != StalePendingPurgeReason {
			t.Fatalf("%s v%s 的 reason = %q, want %q", tc.app, tc.version, reason, StalePendingPurgeReason)
		}
	}
	// 已删除应用的待审行不得被改动（与徽标/队列同一判据集合）。
	var goneStatus string
	if err := f.db.QueryRow(`SELECT status FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
		AppKindWasmApp, "purge-gone", "3.0.0").Scan(&goneStatus); err != nil {
		t.Fatalf("读已删除应用的版本行: %v", err)
	}
	if goneStatus != ReleaseStatusPending {
		t.Fatalf("已删除应用的待审版本不得被清理，得到 %q", goneStatus)
	}
	// approved 版本不动。
	var approvedStatus string
	if err := f.db.QueryRow(`SELECT status FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
		AppKindWasmApp, "purge-a", "1.0.0").Scan(&approvedStatus); err != nil {
		t.Fatalf("读 approved 行: %v", err)
	}
	if approvedStatus != ReleaseStatusApproved {
		t.Fatalf("approved 版本不得被清理，得到 %q", approvedStatus)
	}
	// 幂等：第二次影响 0 行。
	if n, err := PurgeStalePendingReleases(f.ctx, f.db, ""); err != nil || n != 0 {
		t.Fatalf("重复清理必须幂等: n=%d err=%v", n, err)
	}
}

// newWave2Fixture 建独立临时库。
func newWave2Fixture(t *testing.T) *wave2Fixture {
	t.Helper()
	db, cleanup := newTestDB(t)
	t.Cleanup(cleanup)
	return &wave2Fixture{t: t, db: db, ctx: context.Background()}
}

// app 建一个 wasm 应用行。
func (f *wave2Fixture) app(appID string, enabled bool) {
	f.t.Helper()
	if err := UpsertWasmApp(f.ctx, f.db, WasmApp{
		AppID: appID, Title: appID + " 标题", Owner: "alice", Enabled: enabled,
		Purpose: "演示", DataSensitivity: "internal", ConfigJSON: `{"access":"login"}`,
	}); err != nil {
		f.t.Fatalf("建应用 %s: %v", appID, err)
	}
}

// release 写一个版本行（带字节）。
func (f *wave2Fixture) release(appID, version, status string, withBytes bool) int64 {
	f.t.Helper()
	var archive []byte
	if withBytes {
		archive = []byte("wasm-" + appID + "-" + version)
	}
	id, err := CreateWasmRelease(f.ctx, f.db, WasmRelease{
		AppID: appID, Version: version, Title: appID + " " + version,
		Description: "描述", Changelog: "第 " + version + " 版", Publisher: "alice",
		Checksum: "sum-" + version, Size: int64(len(archive)), Status: status,
		Wasm: archive, ConfigJSON: `{"access":"login","purpose":"演示","data_sensitivity":"internal"}`,
	})
	if err != nil {
		f.t.Fatalf("建版本 %s v%s: %v", appID, version, err)
	}
	return id
}
