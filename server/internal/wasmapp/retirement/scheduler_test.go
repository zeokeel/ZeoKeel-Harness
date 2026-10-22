package retirement

// 退役真删调度器的行为级用例（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.5、§9.7）。
//
// 口径：真 PG（serverstore.NewTestDB）+ **真文件系统**（t.TempDir 造数据根）。
// 断言落在"目录真的消失/真的还在""元数据行还在不在""审计写了没有""读数对不对"，
// **不是**"函数被调用过"。
//
// 变异验证（每条判据对应一处可被删掉的实现，删掉后本用例必红）：
//   - 去掉 `deleted_at IS NOT NULL`（PurgeCandidates）⇒ 未删除应用的目录被删 ⇒
//     TestPurgeOnlyTouchesDueDeletedApps 红；
//   - 去掉 `purge_after <= now` ⇒ 未到期应用的目录被删 ⇒ 同一用例红；
//   - 去掉 `snapshot_at IS NOT NULL` ⇒ 无快照应用的目录被删（并且 data loss）⇒
//     TestPurgeSkipsAppsWithoutSnapshot 红；
//   - 删掉 os.RemoveAll ⇒ "目录消失"断言红；
//   - 删掉 MarkWasmAppPurged ⇒ purged_at 断言红（且下一轮会重复处理）；
//   - 删掉审计写入 ⇒ 审计断言红；
//   - Errors 不统计 skipped ⇒ TestPurgeSkipsAppsWithoutSnapshot 的读数断言红；
//   - 不在 cmd/server 登记（scheduler_status.go 的 wasm_retirement）⇒ 本包做不到，
//     由 cmd/server 的装配判据覆盖（见 TestWasmRetirementRegisteredInSchedulerStatus）。

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// purgeFixture 是一套"真库 + 真数据根"夹具。
type purgeFixture struct {
	t        *testing.T
	db       *sql.DB
	dataRoot string
	now      time.Time
	sched    *Scheduler
	audits   []string
}

func newPurgeFixture(t *testing.T) *purgeFixture {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	f := &purgeFixture{
		t:        t,
		db:       db,
		dataRoot: t.TempDir(),
		now:      time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC),
	}
	f.sched = NewScheduler(Options{
		DB: db, DataRoot: f.dataRoot, Now: func() time.Time { return f.now },
		Logger: func(string, ...any) {},
		Audit: func(appID, username, action, detail string) error {
			f.audits = append(f.audits, appID+"|"+username+"|"+action+"|"+detail)
			return serverstore.AuditLogApp(db, appID, username, action, detail)
		},
	})
	return f
}

// app 建一个 wasm 应用 + 一个 approved 版本 + 数据目录（模拟真实使用过）。
func (f *purgeFixture) app(appID string, deleted bool, purgeAfter time.Time, withSnapshot bool) {
	f.t.Helper()
	ctx := context.Background()
	if err := serverstore.UpsertWasmApp(ctx, f.db, serverstore.WasmApp{
		AppID: appID, Title: appID, Owner: "alice", Enabled: true,
	}); err != nil {
		f.t.Fatalf("建应用 %s: %v", appID, err)
	}
	relID, err := serverstore.CreateWasmRelease(ctx, f.db, serverstore.WasmRelease{
		AppID: appID, Version: "1.0.0", Title: appID, Publisher: "alice",
		Checksum: "sum", Size: 4, Status: serverstore.ReleaseStatusApproved,
		Wasm: []byte("wasm"), ConfigJSON: `{"access":"login"}`,
	})
	if err != nil {
		f.t.Fatalf("建版本 %s: %v", appID, err)
	}
	// 部署历史必须在软删**之前**建立（软删之后 DAO 会拒绝部署：APP_DELETED）。
	// 这条历史也是"真删不动历史"的判据载体。
	if _, _, err := serverstore.DeployWasmRelease(ctx, f.db, serverstore.DeployWasmReleaseInput{
		AppID: appID, ReleaseID: relID, Kind: serverstore.DeployKindPublish,
		Actor: "alice", ActorRole: serverstore.ActorRoleOwner,
	}); err != nil {
		f.t.Fatalf("部署 %s: %v", appID, err)
	}
	// 真删目标是整棵应用目录（app.db + snapshots 一起）。
	dir := filepath.Join(f.dataRoot, limits.AppsDirName, appID)
	if err := os.MkdirAll(filepath.Join(dir, "snapshots", "2026-10-01T00:00:00Z"), 0o700); err != nil {
		f.t.Fatalf("造数据目录 %s: %v", appID, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.db"), []byte("sqlite-bytes"), 0o600); err != nil {
		f.t.Fatalf("造 app.db %s: %v", appID, err)
	}
	if deleted {
		at := f.now.AddDate(0, 0, -limits.RetirementSnapshotRetentionDays)
		if err := serverstore.SoftDeleteWasmAppWithTimeline(ctx, f.db, appID, at, purgeAfter); err != nil {
			f.t.Fatalf("软删 %s: %v", appID, err)
		}
	}
	if withSnapshot {
		snapAt := f.now.AddDate(0, 0, -limits.RetirementSnapshotRetentionDays)
		if err := serverstore.SetWasmAppSnapshot(ctx, f.db, appID, serverstore.WasmSnapshotRecord{
			At: &snapAt, Path: filepath.Join(dir, "snapshots", snapAt.Format(time.RFC3339)),
		}); err != nil {
			f.t.Fatalf("记快照 %s: %v", appID, err)
		}
	}
}

func (f *purgeFixture) appDir(appID string) string {
	return filepath.Join(f.dataRoot, limits.AppsDirName, appID)
}

func (f *purgeFixture) exists(appID string) bool {
	_, err := os.Stat(f.appDir(appID))
	return err == nil
}

func (f *purgeFixture) getApp(appID string) *serverstore.WasmApp {
	f.t.Helper()
	app, err := serverstore.GetWasmApp(context.Background(), f.db, appID)
	if err != nil {
		f.t.Fatalf("GetWasmApp(%s): %v", appID, err)
	}
	return app
}

func (f *purgeFixture) auditRows(t *testing.T, appID string) []serverstore.AuditLogEntry {
	t.Helper()
	logs, err := serverstore.ListAuditLogsByApp(f.db, appID, 100)
	if err != nil {
		t.Fatalf("读审计 %s: %v", appID, err)
	}
	return logs
}

// TestPurgeOnlyTouchesDueDeletedApps 是本作业的核心判据：只有
// `deleted + 到期 + 有快照` 三个条件同时成立的应用才被删除。
func TestPurgeOnlyTouchesDueDeletedApps(t *testing.T) {
	f := newPurgeFixture(t)
	due := f.now.Add(-24 * time.Hour)
	future := f.now.Add(24 * time.Hour)

	f.app("due-ok", true, due, true)       // ✅ 应删
	f.app("not-due", true, future, true)   // ❌ 未到期
	f.app("not-deleted", false, due, true) // ❌ 未删除

	ctx := context.Background()
	res := f.sched.TryRun(ctx)

	// ① due-ok：目录消失、purged_at 落库、指针清空、审计一条（actor=system）。
	if f.exists("due-ok") {
		t.Fatal("已删+到期+有快照的应用，数据目录必须被删除")
	}
	app := f.getApp("due-ok")
	if app.PurgedAt == nil {
		t.Fatal("真删必须写 purged_at（否则下一轮会重复处理）")
	}
	if app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("真删必须清当前指针（release=%d deployment=%d）", app.CurrentReleaseID, app.CurrentDeploymentID)
	}
	logs := f.auditRows(t, "due-ok")
	var purgeAudit *serverstore.AuditLogEntry
	for i := range logs {
		if logs[i].Action == auditAction {
			purgeAudit = &logs[i]
		}
	}
	if purgeAudit == nil {
		t.Fatalf("真删必须写审计 %s，实际动作=%v", auditAction, auditActionsOf(logs))
	}
	if purgeAudit.Username != "system" {
		t.Fatalf("真删审计的 actor 必须是 system（没有人按下这个按钮），得到 %q", purgeAudit.Username)
	}
	if !strings.Contains(purgeAudit.Detail, f.appDir("due-ok")) {
		t.Fatalf("审计必须写清删了哪个目录（可追溯是本设计的核心承诺），detail=%q", purgeAudit.Detail)
	}
	// ② 未到期 / 未删除：目录原封不动、purged_at 仍为空。
	for _, appID := range []string{"not-due", "not-deleted"} {
		if !f.exists(appID) {
			t.Fatalf("%s 不该被删除（未到期/未删除），目录却消失了", appID)
		}
		if a := f.getApp(appID); a.PurgedAt != nil {
			t.Fatalf("%s 不该被标记 purged", appID)
		}
	}
	if len(res.Purged) != 1 || res.Purged[0] != "due-ok" {
		t.Fatalf("本轮 Purged = %v, want [due-ok]", res.Purged)
	}
	// ③ 元数据与部署历史保留（tombstone 语义）。
	if n := len(f.auditRows(t, "due-ok")); n == 0 {
		// 审计行本身就是"元数据保留"的一部分（app_id 维度仍可查）。
		t.Fatal("真删之后按 app_id 查审计必须仍可查（元数据留档）")
	}
	hist, err := serverstore.ListWasmDeployments(ctx, f.db, "due-ok", 10)
	if err != nil {
		t.Fatalf("真删后读部署历史: %v", err)
	}
	if len(hist) != 1 || hist[0].Version != "1.0.0" {
		t.Fatalf("真删之后部署历史必须完整保留，得到 %+v", hist)
	}
	releases, err := serverstore.ListWasmReleases(ctx, f.db, "due-ok", true)
	if err != nil || len(releases) != 1 {
		t.Fatalf("真删之后版本元数据行必须保留（tombstone），得到 %d 行 err=%v", len(releases), err)
	}

	// ④ 读数：跑了一轮、没有失败项。
	if got := f.sched.Runs(); got != 1 {
		t.Fatalf("Runs = %d, want 1", got)
	}
	if got := f.sched.Errors(); got != 0 {
		t.Fatalf("Errors = %d, want 0（本轮全部成功）", got)
	}
	if f.sched.LastRunAt().IsZero() {
		t.Fatal("LastRunAt 必须记账（运维要能判断作业停没停）")
	}
	if f.sched.LastError() != "" {
		t.Fatalf("LastError = %q, want 空串（本轮无错）", f.sched.LastError())
	}
}

// TestPurgeSkipsAppsWithoutSnapshot：到期但**拿不到快照**的应用必须跳过（不删数据），
// 并计入 Errors / LastError（运维可见），下一轮仍然跳过（fail-closed 不会自愈成删除）。
//
// 注意"拿不到"而不是"还没有"：调度器会先**重试**一次快照（设计 §5.4），所以本用例
// 必须让重试也失败 —— 手法是把应用数据目录换成一个**普通文件**（快照的
// `MkdirAll(<app>/snapshots/<t>)` 必然 ENOTDIR）。只把 snapshot_at 留空是测不出来的：
// 重试会成功并当轮删掉它（那本身是另一条用例 TestSnapshotRetryHealsFrozenApp 的正向判据）。
func TestPurgeSkipsAppsWithoutSnapshot(t *testing.T) {
	f := newPurgeFixture(t)
	due := f.now.Add(-24 * time.Hour)
	f.app("no-snap", true, due, false)
	// 让快照**必然失败**：数据目录位置放一个普通文件。
	if err := os.RemoveAll(f.appDir("no-snap")); err != nil {
		t.Fatalf("清目录: %v", err)
	}
	if err := os.WriteFile(f.appDir("no-snap"), []byte("not-a-dir"), 0o600); err != nil {
		t.Fatalf("造阻塞文件: %v", err)
	}

	res := f.sched.TryRun(context.Background())

	if !f.exists("no-snap") {
		t.Fatal("没有成功快照的应用**绝对不能**被真删（不可逆数据丢失）；fail-closed 要求跳过")
	}
	app := f.getApp("no-snap")
	if app.PurgedAt != nil {
		t.Fatal("跳过的应用不得被标记 purged")
	}
	if len(res.Blocked) != 1 || res.Blocked[0] != "no-snap" {
		t.Fatalf("本轮 Blocked = %v, want [no-snap]（跳过必须可观测）", res.Blocked)
	}
	if got := f.sched.Errors(); got != 1 {
		t.Fatalf("无快照跳过必须计入 Errors（=1），得到 %d —— 不计错误会让「保留期到期却没删」静默", got)
	}
	if !strings.Contains(f.sched.LastError(), "快照") {
		t.Fatalf("LastError 必须说明跳过原因（快照不可得），得到 %q", f.sched.LastError())
	}

	// 第二轮：仍然跳过、Errors 累计到 2（读数不会"自愈成 0"）。
	f.sched.TryRun(context.Background())
	if !f.exists("no-snap") {
		t.Fatal("第二轮仍不得删除无快照应用（fail-closed 不会因为重试就放行）")
	}
	if got := f.sched.Runs(); got != 2 {
		t.Fatalf("Runs = %d, want 2", got)
	}
	if got := f.sched.Errors(); got != 2 {
		t.Fatalf("Errors = %d, want 2（每轮每个被跳过的应用记一次）", got)
	}
}

// TestSnapshotRetryHealsFrozenApp 钉住设计 §5.4「快照失败 → 调度器重试」：
// 冻结后快照失败（snapshot_at 仍为空）的应用，下一轮应当被补上快照；补上之后才允许
// 真删（本用例只冻结不删除，因此 purged_at 必须仍为空）。
func TestSnapshotRetryHealsFrozenApp(t *testing.T) {
	f := newPurgeFixture(t)
	ctx := context.Background()
	// 冻结但**没有**快照：模拟冻结那一刻快照失败（snapshot_error 落库）。
	f.app("frozen-no-snap", false, time.Time{}, false)
	at := f.now.AddDate(0, 0, -limits.RetirementSnapshotRetentionDays)
	if err := serverstore.FreezeWasmAppWithRetention(ctx, f.db, "frozen-no-snap", at, f.now.AddDate(0, 0, 90)); err != nil {
		t.Fatalf("冻结: %v", err)
	}
	if err := serverstore.SetWasmAppSnapshot(ctx, f.db, "frozen-no-snap",
		serverstore.WasmSnapshotRecord{Error: "冻结时磁盘抖动（用例注入）"}); err != nil {
		t.Fatalf("记失败快照: %v", err)
	}
	// 夹具里的 app.db 是占位字节（不是真库）；快照会 `VACUUM INTO` 它 ⇒ 必然失败。
	// 本用例要测的是"重试把快照补上"，所以先移除占位库（没有库也能生成 export.json
	// 快照 —— 那是应用从未被使用过的正常形态）。
	if err := os.Remove(filepath.Join(f.appDir("frozen-no-snap"), "app.db")); err != nil {
		t.Fatalf("移除占位库: %v", err)
	}
	res := f.sched.TryRun(ctx)
	if len(res.Failed) != 0 {
		t.Fatalf("快照重试应当成功，本轮不该有失败项: %+v", res.Failed)
	}
	app := f.getApp("frozen-no-snap")
	if app.SnapshotAt == nil || app.SnapshotPath == "" {
		t.Fatal("冻结期间快照失败的应用必须由调度器补上成功快照（否则真删永久被阻断）")
	}
	if app.SnapshotError != "" {
		t.Fatalf("补快照成功后必须清掉旧 snapshot_error，得到 %q", app.SnapshotError)
	}
	if app.PurgedAt != nil {
		t.Fatal("仅冻结（未删除）的应用不得被真删")
	}
	if !f.exists("frozen-no-snap") {
		t.Fatal("仅冻结的应用数据必须保留")
	}
	if got := f.sched.Errors(); got != 0 {
		t.Fatalf("Errors = %d, want 0（补快照成功）", got)
	}
}

// TestPurgeIsIdempotentOnMissingDir：目录已被手工删除（磁盘已空、元数据未更新）时，
// 重试必须收敛：RemoveAll 对不存在的目录是成功的，purged_at 照常落库。
func TestPurgeIsIdempotentOnMissingDir(t *testing.T) {
	f := newPurgeFixture(t)
	due := f.now.Add(-24 * time.Hour)
	f.app("gone-dir", true, due, true)
	if err := os.RemoveAll(f.appDir("gone-dir")); err != nil {
		t.Fatalf("预删目录: %v", err)
	}
	res := f.sched.TryRun(context.Background())
	if len(res.Purged) != 1 || res.Purged[0] != "gone-dir" {
		t.Fatalf("目录已不存在时仍应完成 purged 标记（幂等收敛），得到 %+v", res)
	}
	if app := f.getApp("gone-dir"); app.PurgedAt == nil {
		t.Fatal("目录已不存在也必须写 purged_at（否则元数据永远停在中途态）")
	}
}

// TestSchedulerSelfAccountingAndStart：Start 之后读数可用（cmd/server 的状态表依赖它）。
func TestSchedulerSelfAccountingAndStart(t *testing.T) {
	f := newPurgeFixture(t)
	f.app("due-ok", true, f.now.Add(-time.Hour), true)

	if f.sched.Started() {
		t.Fatal("构造后不该是已启动")
	}
	if got := f.sched.Tick(); got != DefaultTick {
		t.Fatalf("Tick = %v, want %v（每日一轮）", got, DefaultTick)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.sched.Start(ctx)
	defer f.sched.Stop()
	if !f.sched.Started() {
		t.Fatal("Start 之后 Started 必须为真（调度状态表的 started 判据）")
	}
	if f.sched.StartedAt().IsZero() {
		t.Fatal("Start 必须记启动时刻")
	}
	// Start 会先跑一轮（覆盖停机期间到期的应用）：等它完成（最多 5s）。
	deadline := time.Now().Add(5 * time.Second)
	for f.sched.Runs() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if f.sched.Runs() == 0 {
		t.Fatal("Start 后必须先跑一轮（停机期间到期的应用不能等到下一个 tick）")
	}
	if f.exists("due-ok") {
		t.Fatal("Start 触发的第一轮必须真的删掉到期应用")
	}
}

// auditActionsOf 把审计行折叠成动作序列（失败信息可读）。
func auditActionsOf(logs []serverstore.AuditLogEntry) []string {
	out := make([]string, 0, len(logs))
	for _, l := range logs {
		out = append(out, l.Action)
	}
	return out
}

// TestTryRunCleansPurgedAppLeftover：两阶段真删的"第二阶段重试"——
// 上一轮已提交 purged_at、但数据目录还在（进程崩溃/磁盘失败）⇒ 本轮必须补删并记账，
// 且不能把"没清理"误报成"没到期"（生产评审 P0 的配套可观测性）。
func TestTryRunCleansPurgedAppLeftover(t *testing.T) {
	f := newPurgeFixture(t)
	due := f.now.Add(-time.Hour)
	f.app("leftover", true, due, true)
	ctx := context.Background()
	ok, err := serverstore.BeginWasmAppPurge(ctx, f.db, "leftover", f.now)
	if err != nil || !ok {
		t.Fatalf("第一阶段: ok=%v err=%v", ok, err)
	}
	if !f.exists("leftover") {
		t.Fatal("夹具应在第一阶段后仍保留数据目录（模拟清理失败）")
	}
	res := f.sched.TryRun(ctx)
	if len(res.Cleaned) != 1 || res.Cleaned[0] != "leftover" {
		t.Fatalf("本轮 Cleaned = %v，want [leftover]", res.Cleaned)
	}
	if f.exists("leftover") {
		t.Fatal("第二阶段必须删除残留数据目录")
	}
	var cleaned any
	if err := f.db.QueryRowContext(ctx, `SELECT data_cleaned_at FROM apps WHERE app_id = 'leftover'`).Scan(&cleaned); err != nil {
		t.Fatalf("读 data_cleaned_at: %v", err)
	}
	if cleaned == nil {
		t.Fatal("清理完成必须记 data_cleaned_at（否则下一轮还会重试）")
	}
	// 管理面读的 WasmApp 必须能看到这一列（反证 R2-P1-1：不能只有 DB 列、读面为零）。
	if app, gerr := serverstore.GetWasmApp(ctx, f.db, "leftover"); gerr != nil || app == nil || app.DataCleanedAt == nil {
		t.Fatalf("GetWasmApp 必须下发 data_cleaned_at：app=%+v err=%v", app, gerr)
	}
	if len(f.auditRows(t, "leftover")) != 1 {
		t.Fatalf("补清理必须写且只写一条审计，得到 %d 条", len(f.auditRows(t, "leftover")))
	}
	// 再跑一轮：没有候选、没有重复审计。
	res2 := f.sched.TryRun(ctx)
	if len(res2.Cleaned) != 0 {
		t.Fatalf("已完成清理的应用不得重复进 Cleaned：%v", res2.Cleaned)
	}
	if len(f.auditRows(t, "leftover")) != 1 {
		t.Fatalf("重复运行不得重复写审计，得到 %d 条", len(f.auditRows(t, "leftover")))
	}
}

// TestPurgeBacklogExposesBlockedAndPending：/admin/runtime 的 purge 段数据源
// （反证 R2-P2-2：只有 runs/errors 回答不了"哪些应用卡住/待清理"）。
// 变异：TryRun 不记录 lastBlocked/CleanupPending ⇒ 本用例红。
func TestPurgeBacklogExposesBlockedAndPending(t *testing.T) {
	f := newPurgeFixture(t)
	due := f.now.Add(-time.Hour)
	// 到期但无快照 ⇒ blocked；已 purged 但目录还在 ⇒ cleanup pending。
	f.app("blocked-no-snap", true, due, false)
	f.app("leftover-cleaned", true, due, true)
	if ok, err := serverstore.BeginWasmAppPurge(context.Background(), f.db, "leftover-cleaned", f.now); err != nil || !ok {
		t.Fatalf("BeginWasmAppPurge: ok=%v err=%v", ok, err)
	}
	_ = f.sched.TryRun(context.Background())

	blocked, pending := f.sched.PurgeBacklog()
	if len(blocked) != 1 || blocked[0] != "blocked-no-snap" {
		t.Fatalf("blocked = %v，want [blocked-no-snap]", blocked)
	}
	if pending != 1 {
		t.Fatalf("cleanupPending = %d，want 1（leftover-cleaned 本轮被清掉，但它是本轮候选）", pending)
	}
	// 清理成功后下一轮不再有候选；blocked 仍应如实保留。
	f.sched.TryRun(context.Background())
	blocked, pending = f.sched.PurgeBacklog()
	if len(blocked) != 1 || pending != 0 {
		t.Fatalf("第二轮 backlog = %v/%d，want [blocked-no-snap]/0", blocked, pending)
	}
}
