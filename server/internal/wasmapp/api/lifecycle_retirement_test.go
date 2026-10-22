package api

// 冻结 / 快照 / 删除 / 导出 / 管理面生命周期动作的**行为级**用例（迁移 0086；设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.4–§5.6、§6.2、§9.5–§9.8）。
//
// 本文件的判据全部落在**磁盘与库的真实后果**上：
//   - 冻结 ⇒ 快照目录里真的有 export.json（不是"字段写了 snapshot_at"）；
//   - 删除 ⇒ 快照失败时**没有**软删（fail-closed，数据没有丢）；
//   - 导出 zip ⇒ app.db 能被重新打开并读到表里的行（不是"zip 里有同名条目"）。
//
// 变异验证：
//   - 冻结不写 purge_after ⇒ TestFreezeSnapshotAndTimeline 的到期时刻断言红；
//   - 冻结不尝试快照 ⇒ 同一用例"快照目录存在"断言红；
//   - 删除不检查快照就软删 ⇒ TestDeleteFailsClosedWithoutSnapshot 的"未删除"断言红；
//   - 解冻不清 snapshot_at ⇒ TestFreezeSnapshotAndTimeline 的"快照状态已清"断言红；
//   - 导出 zip 不写 app.db ⇒ TestExportZipCarriesDatabase 的"能打开 app.db"断言红；
//   - assets=1 不打包资源 ⇒ 同一用例的资源条目断言红；
//   - 管理面导出记成 owner ⇒ TestAdminLifecycleSurface 的审计 actor_role 断言红；
//   - purged 之后数据面导出仍回 200 ⇒ TestExportPurgedIsGone 的 410 断言红。

import (
	"archive/zip"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
)

// appDataDir 返回测试数据根下某应用的数据目录。
func (e *testEnv) appDataDir(appID string) string {
	return filepath.Join(e.dataRoot, limits.AppsDirName, appID)
}

// writeAppDatabase 在应用数据目录里造一个**真** SQLite 库（导出的判定要用它证明
// "zip 里的 app.db 能打开、能读到行"，而不是只看条目名）。
func (e *testEnv) writeAppDatabase(appID string) {
	e.t.Helper()
	dir := e.appDataDir(appID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		e.t.Fatalf("建应用数据目录失败: %v", err)
	}
	path := filepath.Join(dir, "app.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		e.t.Fatalf("打开测试应用库失败: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`); err != nil {
		e.t.Fatalf("建表失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO notes (body) VALUES ('使用者数据-1'), ('使用者数据-2')`); err != nil {
		e.t.Fatalf("插行失败: %v", err)
	}
}

// TestFreezeSnapshotAndTimeline：冻结 = 停服 + 到期时刻 + **立即快照**；解冻清状态并删快照。
func TestFreezeSnapshotAndTimeline(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("snap-tool", "alice")
	e.seedLifecycleRelease("snap-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/snap-tool/freeze", e.tokens["alice"], nil)
	var out struct {
		App struct {
			AppID      string `json:"app_id"`
			Frozen     bool   `json:"frozen"`
			Enabled    bool   `json:"enabled"`
			PurgeAfter string `json:"purge_after"`
			SnapshotOK bool   `json:"snapshot_ok"`
		} `json:"app"`
		Note string `json:"note"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.App.Frozen || out.App.Enabled {
		t.Fatalf("冻结应停服: %+v", out.App)
	}
	if !out.App.SnapshotOK {
		t.Fatalf("冻结必须立即尝试快照且本次成功；note=%q", out.Note)
	}
	if out.App.PurgeAfter == "" {
		t.Fatal("冻结必须写下 purge_after（真删调度器的唯一到期判据）")
	}

	app := e.appRow("snap-tool")
	if app.FrozenAt == nil || app.PurgeAfter == nil {
		t.Fatalf("冻结时间线未落库: frozen_at=%v purge_after=%v", app.FrozenAt, app.PurgeAfter)
	}
	// 到期 = 冻结 + 保留天数（90 天；差一天就是"提前删数据"或"多留一年"）。
	wantPurge := app.FrozenAt.AddDate(0, 0, limits.RetirementSnapshotRetentionDays)
	if d := app.PurgeAfter.Sub(wantPurge); d > time.Minute || d < -time.Minute {
		t.Fatalf("purge_after = %v, want %v（冻结 + %d 天）", app.PurgeAfter, wantPurge,
			limits.RetirementSnapshotRetentionDays)
	}
	if app.SnapshotAt == nil || app.SnapshotPath == "" {
		t.Fatalf("快照成功后必须落 snapshot_at/path: at=%v path=%q", app.SnapshotAt, app.SnapshotPath)
	}
	// **磁盘判据**：快照目录里真的有 export.json，且内容是合法 JSON（含 lifecycle 段）。
	if _, err := os.Stat(filepath.Join(app.SnapshotPath, "export.json")); err != nil {
		t.Fatalf("快照目录里必须有 export.json（快照不是「记个时间戳」）: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(app.SnapshotPath, "export.json"))
	if err != nil {
		t.Fatalf("读 export.json: %v", err)
	}
	var doc struct {
		Export struct {
			Format    string         `json:"format"`
			Lifecycle map[string]any `json:"lifecycle"`
		} `json:"export"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("export.json 不是合法 JSON: %v", err)
	}
	if doc.Export.Format != "zeokeel.wasm-app-export/1" {
		t.Fatalf("快照里的导出体 format = %q", doc.Export.Format)
	}
	if doc.Export.Lifecycle["frozen_at"] == nil {
		t.Fatalf("快照必须带 lifecycle.frozen_at（退役快照的价值就是冻结时刻的现场）: %v", doc.Export.Lifecycle)
	}

	// 解冻：清时间线 + 尽力删快照目录 + 不自动上架。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/snap-tool/freeze", e.tokens["alice"],
		map[string]any{"frozen": false})
	e.decodeJSON(w, http.StatusOK, &out)
	app = e.appRow("snap-tool")
	if app.FrozenAt != nil || app.PurgeAfter != nil || app.SnapshotAt != nil || app.SnapshotPath != "" {
		t.Fatalf("解冻必须清冻结时间线与快照状态: %+v", app)
	}
	if app.Enabled {
		t.Fatal("解冻**不得**自动上架")
	}
	if _, err := os.Stat(filepath.Join(e.appDataDir("snap-tool"), "snapshots")); !os.IsNotExist(err) {
		t.Fatalf("解冻后快照目录应被删除（残留快照 = 残留数据），stat err=%v", err)
	}
}

// TestDeleteFailsClosedWithoutSnapshot：快照失败 ⇒ 删除失败，**应用没有被软删**。
//
// 模拟失败的手法：把 DataRoot 指到一个"父级是普通文件"的路径（MkdirAll 必然 ENOTDIR），
// 这样快照写不出去，而冻结仍然成功（冻结不依赖磁盘）。
func TestDeleteFailsClosedWithoutSnapshot(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("fail-tool", "alice")
	e.seedLifecycleRelease("fail-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("not-a-dir"), 0o600); err != nil {
		t.Fatalf("造阻塞文件: %v", err)
	}
	e.h.opt.DataRoot = filepath.Join(blocker, "sub")

	w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/fail-tool", e.tokens["alice"], nil)
	if w.Code < 500 {
		t.Fatalf("快照失败时删除必须失败（fail-closed），得到 %d: %s", w.Code, w.Body.String())
	}
	eb := e.decodeErr(w, w.Code)
	if len(eb.Error.Hints) == 0 {
		t.Fatal("删除失败的响应必须给可操作 hint")
	}
	app := e.appRow("fail-tool")
	if app.DeletedAt != nil {
		t.Fatal("快照失败时**不得**软删（软删会立刻释放全部制品字节，不可逆）")
	}
	if app.FrozenAt == nil {
		t.Fatal("删除前补冻结是成功路径的一部分（本次冻结应已生效）")
	}
	if app.SnapshotError == "" || app.SnapshotAt != nil {
		t.Fatalf("快照失败必须落 snapshot_error 且不落 snapshot_at: error=%q at=%v", app.SnapshotError, app.SnapshotAt)
	}
	if n := len(e.auditDetails("fail-tool", "wasm_app_delete")); n != 0 {
		t.Fatalf("删除失败不得写删除审计，得到 %d", n)
	}
}

// TestDeleteTakesSnapshotAndTimeline：删除成功路径 —— 快照先落、再软删、再写时间线。
func TestDeleteTakesSnapshotAndTimeline(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("del-tool", "alice")
	e.seedLifecycleRelease("del-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.writeAppDatabase("del-tool")

	w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/del-tool", e.tokens["alice"], nil)
	var out struct {
		App struct {
			Deleted      bool   `json:"deleted"`
			PurgeAfter   string `json:"purge_after"`
			SnapshotAt   string `json:"snapshot_at"`
			SnapshotPath string `json:"snapshot_path"`
		} `json:"app"`
		RetentionDays int `json:"retention_days"`
		Snapshot      struct {
			Path        string `json:"path"`
			HasDatabase bool   `json:"has_database"`
		} `json:"snapshot"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.App.Deleted {
		t.Fatalf("删除响应 app.deleted 必须为 true: %+v", out.App)
	}
	if out.RetentionDays != limits.RetirementSnapshotRetentionDays {
		t.Fatalf("retention_days = %d, want %d", out.RetentionDays, limits.RetirementSnapshotRetentionDays)
	}
	if !out.Snapshot.HasDatabase {
		t.Fatal("应用有 app.db 时快照必须包含数据库副本")
	}
	app := e.appRow("del-tool")
	if app.DeletedAt == nil || app.PurgeAfter == nil {
		t.Fatalf("删除必须同时落 deleted_at 与 purge_after: %+v", app)
	}
	if app.SnapshotAt == nil || app.SnapshotPath == "" {
		t.Fatal("删除必须留下成功快照（否则真删永远不会发生）")
	}
	if _, err := os.Stat(filepath.Join(app.SnapshotPath, "app.db")); err != nil {
		t.Fatalf("快照里必须有 app.db: %v", err)
	}
	// 删除会释放全部版本字节（配额口径不变）。
	var archive []byte
	if err := e.db.QueryRow(`SELECT archive FROM app_releases WHERE app_id = 'del-tool'`).Scan(&archive); err != nil {
		t.Fatalf("读版本字节: %v", err)
	}
	if archive != nil {
		t.Fatal("软删必须释放制品字节（R15C-G-03 的配额恢复路径）")
	}
	details := e.auditDetails("del-tool", "wasm_app_delete")
	if len(details) != 1 {
		t.Fatalf("删除必须写一条审计，得到 %d", len(details))
	}
	for _, want := range []string{"保留期剩余 90 天", "purge_after=", "snapshot=", "actor_role=owner"} {
		if !strings.Contains(details[0], want) {
			t.Fatalf("删除审计明细缺 %q；detail=%q", want, details[0])
		}
	}
	// 删除后：写动作 404、导出仍可用（保留期内）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/del-tool/freeze", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusNotFound)
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/del-tool/export", e.tokens["alice"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("保留期内必须可导出（R37 承诺）: %d", w.Code)
	}
}

// TestExportJSONHasLifecycleSection：默认 JSON 导出向后兼容 + 补 lifecycle 段。
func TestExportJSONHasLifecycleSection(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("exp-tool", "alice")
	e.seedLifecycleRelease("exp-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/exp-tool/export", e.tokens["alice"], nil)
	var doc struct {
		Export struct {
			Format    string         `json:"format"`
			Lifecycle map[string]any `json:"lifecycle"`
			Database  struct {
				Included bool `json:"included"`
			} `json:"database"`
			Deployments []map[string]any `json:"deployments"`
		} `json:"export"`
	}
	e.decodeJSON(w, http.StatusOK, &doc)
	if doc.Export.Format != "zeokeel.wasm-app-export/1" {
		t.Fatalf("format = %q（format /1 的数据契约不得改）", doc.Export.Format)
	}
	// lifecycle 段五个字段必须**存在**（值为 null 也算存在 —— 下游不必区分缺字段与无值）。
	for _, key := range []string{"frozen_at", "deleted_at", "purge_after", "purged_at", "snapshot_at", "current_deployment_id"} {
		if _, ok := doc.Export.Lifecycle[key]; !ok {
			t.Fatalf("lifecycle 段缺字段 %q: %v", key, doc.Export.Lifecycle)
		}
	}
	if doc.Export.Database.Included {
		t.Fatal("默认 JSON 导出不得含使用者数据（database.included 必须 false）")
	}
	// 导出也要审计（detail 含 database/assets/actor_role，且不含行内容）。
	details := e.auditDetails("exp-tool", "wasm_app_export")
	if len(details) != 1 {
		t.Fatalf("导出必须写审计，得到 %d", len(details))
	}
	for _, want := range []string{"database=false", "assets=false", "actor_role=owner"} {
		if !strings.Contains(details[0], want) {
			t.Fatalf("导出审计明细缺 %q；detail=%q", want, details[0])
		}
	}
}

// TestExportZipCarriesDatabaseAndAssets：`?database=1&assets=1` ⇒ zip 含可打开的 app.db + 资源。
func TestExportZipCarriesDatabaseAndAssets(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("zip-tool", "alice")
	relID := e.seedLifecycleRelease("zip-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.writeAppDatabase("zip-tool")
	// 历史按版本资源目录（2026-09-20 起新发布不再落盘，但存量/手工目录要能导出）。
	assetsDir := filepath.Join(e.appDataDir("zip-tool"), "assets", "1")
	if err := os.MkdirAll(assetsDir, 0o700); err != nil {
		t.Fatalf("建资源目录: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assetsDir, "hello.txt"), []byte("resource-bytes"), 0o600); err != nil {
		t.Fatalf("写资源文件: %v", err)
	}

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/zip-tool/export?database=1&assets=1", e.tokens["alice"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("zip 导出失败: %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/zip") {
		t.Fatalf("Content-Type = %q, want application/zip", ct)
	}
	zr, err := zip.NewReader(strings.NewReader(w.Body.String()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("响应不是合法 zip: %v", err)
	}
	entries := map[string]*zip.File{}
	for _, f := range zr.File {
		entries[f.Name] = f
	}
	// export.json 必须在，且 database.included 如实为 true。
	exportEntry, ok := entries["export.json"]
	if !ok {
		t.Fatalf("zip 缺 export.json，条目=%v", keysOfZip(entries))
	}
	raw, err := readZipEntry(exportEntry)
	if err != nil {
		t.Fatalf("读 export.json: %v", err)
	}
	var doc struct {
		Export struct {
			Database struct {
				Included bool `json:"included"`
			} `json:"database"`
		} `json:"export"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("zip 里的 export.json 不是合法 JSON: %v", err)
	}
	if !doc.Export.Database.Included {
		t.Fatal("database=1 且库存在时，export.json 的 database.included 必须为 true（如实反映）")
	}
	// app.db 必须在，且**能被重新打开并读到行**（判据不是"有同名条目"）。
	dbEntry, ok := entries["app.db"]
	if !ok {
		t.Fatalf("zip 缺 app.db，条目=%v", keysOfZip(entries))
	}
	dbBytes, err := readZipEntry(dbEntry)
	if err != nil {
		t.Fatalf("读 app.db: %v", err)
	}
	tmp := filepath.Join(t.TempDir(), "snapshot.db")
	if err := os.WriteFile(tmp, dbBytes, 0o600); err != nil {
		t.Fatalf("落盘快照库: %v", err)
	}
	conn, err := sql.Open("sqlite", "file:"+tmp+"?mode=ro")
	if err != nil {
		t.Fatalf("打开快照库: %v", err)
	}
	defer conn.Close()
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&n); err != nil {
		t.Fatalf("在快照库里查表失败（说明不是可用的 SQLite 快照）: %v", err)
	}
	if n != 2 {
		t.Fatalf("快照库里 notes 行数 = %d, want 2（VACUUM INTO 必须完整复制数据）", n)
	}
	// 资源条目：assets/<release_id>/<file>。
	assetName := "assets/" + strconv.FormatInt(relID, 10) + "/hello.txt"
	assetEntry, ok := entries[assetName]
	if !ok {
		t.Fatalf("zip 缺资源条目 %s，条目=%v", assetName, keysOfZip(entries))
	}
	assetRaw, err := readZipEntry(assetEntry)
	if err != nil {
		t.Fatalf("读资源: %v", err)
	}
	if string(assetRaw) != "resource-bytes" {
		t.Fatalf("资源内容 = %q, want resource-bytes", string(assetRaw))
	}
	// 审计：database/assets 都是 true。
	details := e.auditDetails("zip-tool", "wasm_app_export")
	last := details[len(details)-1]
	if !strings.Contains(last, "database=true") || !strings.Contains(last, "assets=true") {
		t.Fatalf("zip 导出的审计必须标 database=true assets=true；detail=%q", last)
	}
	if strings.Contains(last, "resource-bytes") || strings.Contains(last, "使用者数据") {
		t.Fatalf("导出审计不得包含行内容/文件内容；detail=%q", last)
	}
}

// TestExportPurgedIsGone：真删之后数据面导出 410，控制面 JSON 仍可用（设计 §3.1）。
func TestExportPurgedIsGone(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("gone-exp", "alice")
	e.seedLifecycleRelease("gone-exp", "1.0.0", serverstore.ReleaseStatusApproved, true)
	now := e.h.now().UTC()
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "gone-exp", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删: %v", err)
	}
	if err := serverstore.MarkWasmAppPurged(e.ctx(), e.db, "gone-exp", now); err != nil {
		e.t.Fatalf("标记 purged: %v", err)
	}
	// 数据面（库/资源）⇒ 410 APP_PURGED
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/gone-exp/export?database=1", e.tokens["alice"], nil)
	eb := e.decodeErr(w, http.StatusGone)
	if eb.Error.Code != serverstore.CodeAppPurged {
		t.Fatalf("已清除应用的数据面导出 code = %q, want %q", eb.Error.Code, serverstore.CodeAppPurged)
	}
	// 控制面元数据仍可导出（审计留档）。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/gone-exp/export", e.tokens["alice"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("已清除应用的控制面导出必须仍可用（元数据留档）: %d %s", w.Code, w.Body.String())
	}
}

// TestAdminLifecycleSurface 覆盖管理面的六条生命周期端点 + 401 矩阵 + actor_role=admin_session。
func TestAdminLifecycleSurface(t *testing.T) {
	e := newTestEnv(t)
	const adm = "/api/server/admin/wasm-apps"

	// 待审队列：跨应用清单（不是计数）。
	e.seedLifecycleApp("q1-tool", "alice")
	e.seedLifecycleRelease("q1-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("q1-tool", "1.1.0", serverstore.ReleaseStatusPending, true)
	e.seedLifecycleApp("q2-tool", "alice")
	e.seedLifecycleRelease("q2-tool", "2.0.0", serverstore.ReleaseStatusPending, true)

	w := e.req(http.MethodGet, adm+"/releases/pending", "", nil)
	var pending struct {
		Total   int `json:"total"`
		Pending []struct {
			AppID          string `json:"app_id"`
			Version        string `json:"version"`
			Publisher      string `json:"publisher"`
			CurrentVersion string `json:"current_version"`
			AgeSeconds     int64  `json:"age_seconds"`
		} `json:"pending"`
	}
	e.decodeJSON(w, http.StatusOK, &pending)
	if pending.Total != 2 || len(pending.Pending) != 2 {
		t.Fatalf("待审队列应有 2 条，得到 total=%d rows=%d", pending.Total, len(pending.Pending))
	}
	found := map[string]bool{}
	for _, p := range pending.Pending {
		found[p.AppID] = true
		if p.Publisher != "alice" {
			t.Fatalf("待审行必须带提交人（就地处置要用它判断归属），得到 %+v", p)
		}
	}
	if !found["q1-tool"] || !found["q2-tool"] {
		t.Fatalf("待审队列缺应用: %v", found)
	}

	// 管理面部署/历史：部署后 actor_role=admin_session。
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "q2-tool", e.h.now().UTC(), e.h.now().UTC().AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删 q2: %v", err)
	}
	w = e.req(http.MethodGet, adm+"/q1-tool/deployments", "", nil)
	e.decodeJSON(w, http.StatusOK, &struct{}{})
	w = e.req(http.MethodPost, adm+"/q1-tool/deployments", "", map[string]any{"version": "1.0.0"})
	var depOut struct {
		Deployment struct {
			ActorRole string `json:"actor_role"`
		} `json:"deployment"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &depOut)
	if !depOut.Changed || depOut.Deployment.ActorRole != serverstore.ActorRoleAdminSession {
		t.Fatalf("管理面部署 actor_role = %q changed=%v, want admin_session/true",
			depOut.Deployment.ActorRole, depOut.Changed)
	}

	// 管理面恢复：先真实软删一个应用（管理面 DELETE，验证快照前置），再恢复。
	e.seedLifecycleApp("adm-del", "alice")
	e.seedLifecycleRelease("adm-del", "1.0.0", serverstore.ReleaseStatusApproved, true)
	w = e.req(http.MethodDelete, adm+"/adm-del", "", nil)
	var delOut struct {
		App struct {
			Deleted bool `json:"deleted"`
		} `json:"app"`
	}
	e.decodeJSON(w, http.StatusOK, &delOut)
	if !delOut.App.Deleted {
		t.Fatal("管理面 DELETE 必须真的软删")
	}
	if app := e.appRow("adm-del"); app.DeletedAt == nil || app.SnapshotAt == nil {
		t.Fatal("管理面删除同样必须快照成功（fail-closed 两侧一致）")
	}
	// 已删除的应用再 DELETE ⇒ 404（重复删除不泄露状态）
	w = e.req(http.MethodDelete, adm+"/adm-del", "", nil)
	e.decodeErr(w, http.StatusNotFound)

	w = e.req(http.MethodPost, adm+"/adm-del/restore", "", nil)
	var restOut struct {
		App struct {
			Deleted bool `json:"deleted"`
			Enabled bool `json:"enabled"`
		} `json:"app"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &restOut)
	if !restOut.Changed || restOut.App.Deleted || restOut.App.Enabled {
		t.Fatalf("管理面恢复响应不对: %+v", restOut)
	}
	if app := e.appRow("adm-del"); app.DeletedAt != nil || app.Enabled {
		t.Fatalf("管理面恢复必须清 deleted_at 且保持下架: %+v", app)
	}

	// 管理面导出：JSON 与 zip 都要能走通，审计记 admin_session。
	w = e.req(http.MethodGet, adm+"/adm-del/export", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("管理面 JSON 导出失败: %d %s", w.Code, w.Body.String())
	}
	details := e.auditDetails("adm-del", "wasm_app_export")
	if len(details) == 0 || !strings.Contains(details[len(details)-1], "actor_role=admin_session") {
		t.Fatalf("管理面导出必须记 actor_role=admin_session；details=%v", details)
	}
	w = e.req(http.MethodGet, adm+"/adm-del/export?database=1", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("管理面 zip 导出失败: %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/zip") {
		t.Fatalf("管理面 zip 导出 Content-Type = %q", ct)
	}

	// 401 矩阵：无管理会话时六条端点都必须 401（不能靠 handler 内部兜底）。
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, adm + "/releases/pending"},
		{http.MethodGet, adm + "/q1-tool/deployments"},
		{http.MethodPost, adm + "/q1-tool/deployments"},
		{http.MethodPost, adm + "/q1-tool/restore"},
		{http.MethodDelete, adm + "/q1-tool"},
		{http.MethodGet, adm + "/q1-tool/export"},
	} {
		w := e.reqWithAdminHeader(tc.method, tc.path, "none", map[string]any{"version": "1.0.0"})
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 无会话 status = %d, want 401", tc.method, tc.path, w.Code)
		}
	}
}

// keysOfZip 返回 zip 条目名（失败信息可读）。
func keysOfZip(entries map[string]*zip.File) []string {
	out := make([]string, 0, len(entries))
	for name := range entries {
		out = append(out, name)
	}
	return out
}

// readZipEntry 读一个 zip 条目的全部内容。
func readZipEntry(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// TestAdminListCarriesLifecycleFields 钉住管理台（W 泳道）唯一的后端依赖：
// 列表行必须下发 purge_after / snapshot_at / snapshot_error / purged_at，
// 响应顶层必须下发退役保留期天数（冻结确认框要在动作**之前**算出到期日期）。
//
// 变异验证：把这几列从 adminList 的行组装里删掉 ⇒ 本用例红（前端会显示"服务端未下发"）；
// 把 retention_days 删掉 ⇒ 冻结确认框无法在动作前给出日期 ⇒ 本用例红。
func TestAdminListCarriesLifecycleFields(t *testing.T) {
	e := newTestEnv(t)
	const adm = "/api/server/admin/wasm-apps"
	e.seedLifecycleApp("list-tool", "alice")
	e.seedLifecycleRelease("list-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	// 用**生产动作**造生命周期状态（冻结会真的写 purge_after 并做快照）。
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/list-tool/freeze", e.tokens["alice"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %d %s", w.Code, w.Body.String())
	}

	w = e.req(http.MethodGet, adm, "", nil)
	var out struct {
		RetentionDays                   int              `json:"retention_days"`
		RetirementSnapshotRetentionDays int              `json:"retirement_snapshot_retention_days"`
		Apps                            []map[string]any `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.RetentionDays != limits.RetirementSnapshotRetentionDays {
		t.Fatalf("列表顶层 retention_days = %d, want %d（前端要靠它算冻结后的到期日）",
			out.RetentionDays, limits.RetirementSnapshotRetentionDays)
	}
	if out.RetirementSnapshotRetentionDays != limits.RetirementSnapshotRetentionDays {
		t.Fatalf("列表顶层 retirement_snapshot_retention_days = %d, want %d",
			out.RetirementSnapshotRetentionDays, limits.RetirementSnapshotRetentionDays)
	}
	var row map[string]any
	for _, a := range out.Apps {
		if a["app_id"] == "list-tool" {
			row = a
		}
	}
	if row == nil {
		t.Fatalf("列表里没有 list-tool: %+v", out.Apps)
	}
	for _, key := range []string{"purge_after", "snapshot_at", "snapshot_error", "purged_at", "current_deployment_id"} {
		if _, ok := row[key]; !ok {
			t.Fatalf("列表行缺字段 %q —— W 泳道的「生命周期」块只能显示「服务端未下发」: %+v", key, row)
		}
	}
	if row["purge_after"] == nil {
		t.Fatal("冻结后的行必须下发 purge_after 的具体时刻")
	}
	if row["snapshot_at"] == nil {
		t.Fatal("冻结成功后必须下发 snapshot_at（前端据此显示「快照已生成」而不是猜）")
	}
	if row["purged_at"] != nil {
		t.Fatal("未真删的行 purged_at 必须为 null")
	}
}

// TestReviewSwitchReportsPendingBacklog 钉住设计 §5.7：关闭审核开关时回待审积压数
// 与"将失去意义"的提示（服务端只回事实，前端负责展示）。
func TestReviewSwitchReportsPendingBacklog(t *testing.T) {
	e := newTestEnv(t)
	const adm = "/api/server/admin/wasm-apps"
	e.seedLifecycleApp("backlog-a", "alice")
	e.seedLifecycleRelease("backlog-a", "1.0.0", serverstore.ReleaseStatusPending, true)
	e.seedLifecycleApp("backlog-b", "alice")
	e.seedLifecycleRelease("backlog-b", "2.0.0", serverstore.ReleaseStatusPending, true)

	// 先打开审核开关（old=false → true），再关掉（true → false），后者要带提示。
	if w := e.req(http.MethodPut, adm+"/review", "", map[string]any{"required": true}); w.Code != http.StatusOK {
		t.Fatalf("开启审核失败: %d %s", w.Code, w.Body.String())
	}
	w := e.req(http.MethodPut, adm+"/review", "", map[string]any{"required": false})
	var out struct {
		ReviewRequired  bool   `json:"review_required"`
		PendingReleases int    `json:"pending_releases"`
		Note            string `json:"note"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.ReviewRequired {
		t.Fatal("关闭审核后 review_required 必须为 false")
	}
	if out.PendingReleases != 2 {
		t.Fatalf("pending_releases = %d, want 2（关闭开关时要把积压量说清）", out.PendingReleases)
	}
	if !strings.Contains(out.Note, "失去意义") {
		t.Fatalf("关闭审核开关且积压非空时必须提示「将失去意义」，得到 note=%q", out.Note)
	}
}

// TestCatalogDataSensitivityOnlyForOwner 钉住 C 泳道的发布表单预填依赖（F-02/F-03）：
// **发布者本人**的目录行下发 data_sensitivity（发新版时显示并沿用上次声明），
// 其他人的目录行**不下发**（数据敏感度是内部合规声明，目录对全员可见）。
//
// 变异验证：把该字段移出 `if isOwner` 分支 ⇒ 第二段断言红（全员可见内部声明）；
// 删掉该字段 ⇒ 第一段断言红（C 泳道的表单只能凭空重填）。
func TestCatalogDataSensitivityOnlyForOwner(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("sens-tool", "alice")
	e.seedLifecycleRelease("sens-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	// 目录只列"有生效版本"的应用 ⇒ 先真部署一次。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/sens-tool/deployments",
		e.tokens["alice"], map[string]any{"version": "1.0.0"}); w.Code != http.StatusOK {
		t.Fatalf("部署失败: %d %s", w.Code, w.Body.String())
	}

	rowFor := func(token string) map[string]any {
		w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", token, nil)
		var out struct {
			Apps []map[string]any `json:"apps"`
		}
		e.decodeJSON(w, http.StatusOK, &out)
		for _, a := range out.Apps {
			if a["app_id"] == "sens-tool" {
				return a
			}
		}
		e.t.Fatalf("目录里没有 sens-tool（token=%s）", token)
		return nil
	}

	ownerRow := rowFor(e.tokens["alice"])
	got, ok := ownerRow["data_sensitivity"]
	if !ok {
		t.Fatalf("发布者目录行必须下发 data_sensitivity（发新版表单的预填基线）: %+v", ownerRow)
	}
	if got != "internal" {
		t.Fatalf("data_sensitivity = %v, want internal（取自生效版本的 config_json）", got)
	}
	otherRow := rowFor(e.tokens["bob"])
	if _, ok := otherRow["data_sensitivity"]; ok {
		t.Fatalf("非发布者的目录行不得下发 data_sensitivity（内部合规声明不摊给全员）: %+v", otherRow)
	}
	// 同一条纪律的既有字段（purpose/whitelist）也仍然只对发布者下发。
	if _, ok := otherRow["purpose"]; ok {
		t.Fatalf("非发布者不得看到 purpose: %+v", otherRow)
	}
}

// TestFreezeUsesConfiguredRetention：保留期可由控制台限制项覆盖（2026-10-22 管理员 P2：
// 90 天不再是编译期常量）。冻结时 purge_after = 冻结时刻 + 当前生效值。
// 变异：lifecycle_actions 改回 limits.RetirementSnapshotRetentionDays 常量 ⇒ 本用例红。
func TestFreezeUsesConfiguredRetention(t *testing.T) {
	e := newTestEnv(t, func(o *Options) {
		o.Limits = func() applimits.Limits {
			l := applimits.Defaults()
			l.RetirementSnapshotRetentionDays = 30
			return l
		}
	})
	e.seedLifecycleApp("retained-tool", "alice")
	e.seedLifecycleRelease("retained-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/retained-tool/freeze", e.tokens["alice"], nil)
	var out struct {
		App struct {
			PurgeAfter string `json:"purge_after"`
			Frozen     bool   `json:"frozen"`
		} `json:"app"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	app := e.appRow("retained-tool")
	if app.FrozenAt == nil || app.PurgeAfter == nil {
		t.Fatalf("冻结时间线未落库: frozen=%v purge=%v", app.FrozenAt, app.PurgeAfter)
	}
	want := app.FrozenAt.AddDate(0, 0, 30)
	if d := app.PurgeAfter.Sub(want); d > time.Minute || d < -time.Minute {
		t.Fatalf("purge_after = %v，want 冻结+30 天 %v（配置未生效）", app.PurgeAfter, want)
	}
}
