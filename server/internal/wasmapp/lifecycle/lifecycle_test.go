package lifecycle

// 生命周期共享实现的**行为级**用例（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.4–§5.6）。
//
// 为什么这一层必须单独有判据（而不是只靠 api 用例）：本包是**快照 / 导出 / 真删**三件事
// 的唯一磁盘实现。api 的用例证明"端点走通了这条链"，但证明不了"快照目录里的 app.db
// 是一份**可打开的** SQLite 副本"与"真删的路径不可能越界"—— 那两条正是本包的存在理由。
//
// 变异验证：
//   - 把 Snapshot 里的 `VACUUM INTO` 换成 `os.WriteFile` 空文件 ⇒
//     TestSnapshotCarriesOpenableDatabase 的"能打开并读到行"断言红；
//   - 删掉 AppDir 里 app_id 的形状判据 ⇒ TestRemoveAppDataRejectsTraversal 红
//     （`../` 会把 RemoveAll 指向数据根之外）；
//   - 删掉 Snapshot 失败时的半成品清理 ⇒ TestSnapshotFailureLeavesNoPartialDir 红。

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// newLifecycleFixture 建一个真应用（PG）+ 真数据根。
func newLifecycleFixture(t *testing.T) (*sql.DB, string, context.Context) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	ctx := context.Background()
	if err := serverstore.UpsertWasmApp(ctx, db, serverstore.WasmApp{
		AppID: "lc-app", Title: "lc-app", Owner: "alice", Enabled: true,
	}); err != nil {
		t.Fatalf("建应用: %v", err)
	}
	if _, err := serverstore.CreateWasmRelease(ctx, db, serverstore.WasmRelease{
		AppID: "lc-app", Version: "1.0.0", Title: "lc-app", Publisher: "alice",
		Checksum: "sum", Size: 4, Status: serverstore.ReleaseStatusApproved,
		Wasm: []byte("wasm"), ConfigJSON: `{"access":"login","data_sensitivity":"internal"}`,
	}); err != nil {
		t.Fatalf("建版本: %v", err)
	}
	return db, t.TempDir(), ctx
}

// writeSQLite 在 dataRoot 下造真应用库（表 + 两行）。
func writeSQLite(t *testing.T, dataRoot, appID string) {
	t.Helper()
	dir := filepath.Join(dataRoot, limits.AppsDirName, appID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建应用目录: %v", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatalf("打开库: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`); err != nil {
		t.Fatalf("建表: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO notes (body) VALUES ('a'), ('b')`); err != nil {
		t.Fatalf("插行: %v", err)
	}
}

// TestSnapshotCarriesOpenableDatabase：快照目录 = export.json + **可打开的** app.db。
func TestSnapshotCarriesOpenableDatabase(t *testing.T) {
	db, dataRoot, ctx := newLifecycleFixture(t)
	writeSQLite(t, dataRoot, "lc-app")
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

	res, err := Snapshot(ctx, db, dataRoot, "lc-app", now)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	// 目录名 = RFC3339（设计 §5.4），这样多份历史快照互不覆盖。
	wantDir := filepath.Join(dataRoot, limits.AppsDirName, "lc-app", SnapshotsDirName, now.Format(time.RFC3339))
	if res.Dir != wantDir {
		t.Fatalf("快照目录 = %q, want %q（RFC3339 命名的唯一真源）", res.Dir, wantDir)
	}
	if !res.HasDatabase {
		t.Fatal("应用库存在时快照必须带 app.db（HasDatabase=true）")
	}
	// export.json 必须是合法 JSON 且带 lifecycle 段（退役后回看的第一现场）。
	raw, err := os.ReadFile(filepath.Join(res.Dir, ExportFileName))
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
		t.Fatalf("format = %q", doc.Export.Format)
	}
	for _, key := range []string{"frozen_at", "deleted_at", "purge_after", "purged_at", "snapshot_at"} {
		if _, ok := doc.Export.Lifecycle[key]; !ok {
			t.Fatalf("lifecycle 段缺 %q: %v", key, doc.Export.Lifecycle)
		}
	}
	// app.db 必须是**可打开的 SQLite 副本**（判据不是"文件非空"）。
	conn, err := sql.Open("sqlite", "file:"+filepath.Join(res.Dir, DatabaseFileName)+"?mode=ro")
	if err != nil {
		t.Fatalf("打开快照库: %v", err)
	}
	defer conn.Close()
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&n); err != nil {
		t.Fatalf("快照库不可读（VACUUM INTO 没写成可用副本）: %v", err)
	}
	if n != 2 {
		t.Fatalf("快照库 notes 行数 = %d, want 2", n)
	}
	// 第二份快照不覆盖第一份（同一个应用可以有多次冻结）。
	later := now.Add(time.Hour)
	res2, err := Snapshot(ctx, db, dataRoot, "lc-app", later)
	if err != nil {
		t.Fatalf("第二份快照: %v", err)
	}
	if res2.Dir == res.Dir {
		t.Fatal("两次快照的目录必须不同（否则第二次会覆盖第一次的现场）")
	}
	if _, err := os.Stat(filepath.Join(res.Dir, ExportFileName)); err != nil {
		t.Fatalf("第二份快照不得删掉第一份: %v", err)
	}
}

// TestSnapshotWithoutDatabaseIsStillValid：应用还没被使用过（没有 app.db）时
// 快照仍然成功，只是 HasDatabase=false（App 从未打开过是正常形态，不是错误）。
func TestSnapshotWithoutDatabaseIsStillValid(t *testing.T) {
	db, dataRoot, ctx := newLifecycleFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	res, err := Snapshot(ctx, db, dataRoot, "lc-app", now)
	if err != nil {
		t.Fatalf("Snapshot（无库）: %v", err)
	}
	if res.HasDatabase {
		t.Fatal("没有 app.db 时 HasDatabase 必须为 false（不伪造空库）")
	}
	if _, err := os.Stat(filepath.Join(res.Dir, DatabaseFileName)); !os.IsNotExist(err) {
		t.Fatalf("没有源库时不得产出空 app.db（会让下游以为账号数据为空）: %v", err)
	}
	if _, err := os.Stat(filepath.Join(res.Dir, ExportFileName)); err != nil {
		t.Fatalf("没有库也必须写 export.json: %v", err)
	}
}

// TestSnapshotFailureLeavesNoPartialDir：快照失败（应用不存在）⇒ 不留下半成品目录。
//
// 半成品目录是最危险的状态：真删的前置条件只看 DB 的 snapshot_at，而人看的是磁盘 ——
// "有目录但缺文件"会让排障者以为快照已在。
func TestSnapshotFailureLeavesNoPartialDir(t *testing.T) {
	db, dataRoot, ctx := newLifecycleFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	if _, err := Snapshot(ctx, db, dataRoot, "no-such-app", now); err == nil {
		t.Fatal("不存在的应用快照必须失败（fail-closed）")
	}
	if _, err := os.Stat(filepath.Join(dataRoot, limits.AppsDirName, "no-such-app")); !os.IsNotExist(err) {
		t.Fatalf("失败必须清理半成品目录: %v", err)
	}
}

// TestRemoveAppDataRejectsTraversal：真删路径只由 AppDir 拼出，而 AppDir 对 app_id
// 做形状判据 —— 越界输入必须在拼路径之前被拒（这是全仓唯一的 os.RemoveAll）。
func TestRemoveAppDataRejectsTraversal(t *testing.T) {
	dataRoot := t.TempDir()
	// 数据根之外放一个"受害者"目录，用来证明越界路径真的没有被删。
	victim := filepath.Join(filepath.Dir(dataRoot), "victim-"+filepath.Base(dataRoot))
	if err := os.MkdirAll(victim, 0o700); err != nil {
		t.Fatalf("造受害者目录: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(victim) })

	for _, bad := range []string{"", "../victim", "..", "a/b", "-bad", "UPPER", strings.Repeat("x", 200)} {
		if _, err := RemoveAppData(dataRoot, bad); err == nil {
			t.Fatalf("非法 app_id %q 必须被拒（否则 RemoveAll 会删到数据根之外）", bad)
		}
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("受害者目录不该被动过: %v", err)
	}
	// 合法 app_id：目录被删、返回被删路径（审计要写它）。
	dir := filepath.Join(dataRoot, limits.AppsDirName, "ok-app")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建目录: %v", err)
	}
	removed, err := RemoveAppData(dataRoot, "ok-app")
	if err != nil {
		t.Fatalf("合法 app_id 删除失败: %v", err)
	}
	if removed != dir {
		t.Fatalf("返回路径 = %q, want %q（审计用它说明删了什么）", removed, dir)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("目录应被删除: %v", err)
	}
	// 幂等：目录已不存在时再删仍然成功（真删重试必须能收敛）。
	if _, err := RemoveAppData(dataRoot, "ok-app"); err != nil {
		t.Fatalf("删除已不存在的目录必须幂等成功: %v", err)
	}
}

// TestExportZipWithoutDatabaseStillZips：`database=1` 但应用没有库 ⇒ zip 里只有
// export.json，且 export.database.included 如实为 false（不伪造库文件）。
func TestExportZipWithoutDatabaseStillZips(t *testing.T) {
	db, dataRoot, ctx := newLifecycleFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	path, cleanup, err := ExportZip(ctx, db, dataRoot, "lc-app", ExportOptions{Database: true}, now)
	if err != nil {
		t.Fatalf("ExportZip: %v", err)
	}
	defer cleanup()
	if path == "" {
		t.Fatal("ExportZip 必须返回可下载的临时文件路径")
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("打开 zip: %v", err)
	}
	defer zr.Close()
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
		if f.Name == DatabaseFileName {
			t.Fatal("没有源库时不得在 zip 里放 app.db（会让运维以为账号数据为空）")
		}
		if f.Name == ExportFileName {
			rc, rerr := f.Open()
			if rerr != nil {
				t.Fatalf("读 export.json: %v", rerr)
			}
			raw, _ := io.ReadAll(rc)
			rc.Close()
			var doc struct {
				Export struct {
					Database struct {
						Included bool `json:"included"`
					} `json:"database"`
				} `json:"export"`
			}
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatalf("zip 内 export.json 非法: %v", err)
			}
			if doc.Export.Database.Included {
				t.Fatal("没有库时 database.included 必须如实为 false")
			}
		}
	}
	if !names[ExportFileName] {
		t.Fatalf("zip 必须含 export.json，条目=%v", names)
	}
}
