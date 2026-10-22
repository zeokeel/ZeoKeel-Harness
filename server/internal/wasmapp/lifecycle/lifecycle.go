// Package lifecycle 收敛 WASM 应用平台**退役生命周期**的磁盘与导出实现
// （设计契约 docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.4–§5.6）。
//
// 存在的理由（审计 2026-10-22 C-01/C-02 的同一条教训）：快照、导出、真删三件事此前
// 要么没有实现、要么只在员工 Bearer 面有一个"只含控制面元数据"的 JSON 导出。三件事
// 共用同一份**制品口径**（哪些字段算控制面、哪些算使用者数据、快照落在哪、一个应用
// 的数据目录是什么形状），所以只允许一份实现 —— 两份实现必然漂移，而漂移的表现是
// "快照里有一份、导出里少一份"。
//
// 依赖方向：本包 import serverstore / limits / appdb / registry（下层），api 与
// retirement import 本包。本包**不** import api / appserver（避免成环）。
//
// 执行面一字未动：本包只做文件与 SQL 快照，不碰 wazero / ABI / 沙箱。
package lifecycle

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	// modernc.org/sqlite 是应用库（`<data_root>/apps/<app_id>/app.db`）的驱动
	// （唯一真源 appdb 也是它）。快照用 `VACUUM INTO` 生成**只读、无 WAL 尾巴**的
	// 单文件副本，必须走同一个驱动。
	_ "modernc.org/sqlite"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appcfg"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appdb"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/registry"
)

// 导出/快照的文件名（唯一真源：导出 zip 与快照目录共用同一组名字）。
const (
	// ExportFileName 是控制面导出体（`zeokeel.wasm-app-export/1`）。
	ExportFileName = "export.json"
	// DatabaseFileName 是应用库只读快照（`VACUUM INTO` 产物）。
	DatabaseFileName = "app.db"
	// SnapshotsDirName 是快照根（`<apps>/<app_id>/snapshots/`）。
	SnapshotsDirName = "snapshots"
	// AssetsDirName 是**历史**按版本资源目录名（2026-09-20 起随包资源在内存里构造，
	// 磁盘上不再有它；`assets=1` 导出只在存量目录存在时才带上，见 ExportZip）。
	AssetsDirName = "assets"
)

// ExportOptions 是导出参数（设计 §5.6）。
type ExportOptions struct {
	// Database = true ⇒ 打包应用库的 `VACUUM INTO` 只读快照（zip 才有意义）。
	Database bool
	// Assets = true ⇒ 打包磁盘上**存在的**历史按版本资源目录（见 AssetsDirName）。
	Assets bool
}

// SnapshotResult 是一次快照尝试的成功结果。
type SnapshotResult struct {
	// Dir 是快照目录（`<data_root>/apps/<app_id>/snapshots/<RFC3339>`）。
	Dir string
	// ExportBytes 是 export.json 的字节数（响应里可回报，便于运维核对）。
	ExportBytes int64
	// HasDatabase 报告是否拿到了 app.db 快照（应用还没被用过 ⇒ 没有库文件 ⇒ false）。
	HasDatabase bool
}

// AppDir 返回某应用的数据目录（`<data_root>/apps/<app_id>`）。
//
// app_id 必须先过**形状判据**（fail-closed）：拼路径前的唯一防线，接受空串/`../`
// 会把 RemoveAll 变成删别人的目录。
func AppDir(dataRoot, appID string) (string, error) {
	dataRoot = strings.TrimSpace(dataRoot)
	if dataRoot == "" {
		return "", errors.New("lifecycle: 数据根为空")
	}
	if aerr := registry.CheckAppIDShape(appID); aerr != nil {
		return "", fmt.Errorf("lifecycle: 非法 app_id %q: %w", appID, aerr)
	}
	return filepath.Join(dataRoot, limits.AppsDirName, appID), nil
}

// SnapshotsDir 返回某应用的快照根目录（`<apps>/<app_id>/snapshots`）。
func SnapshotsDir(dataRoot, appID string) (string, error) {
	dir, err := AppDir(dataRoot, appID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, SnapshotsDirName), nil
}

// Snapshot 生成一次只读快照：`export.json`（控制面 + lifecycle 字段）+ `app.db`
// （`VACUUM INTO`）。
//
// 语义（设计 §5.4）：
//   - 目录名 = **RFC3339**（`<data_root>/apps/<app_id>/snapshots/<RFC3339>/`），
//     同一个应用可以有多份历史快照（冻结 → 解冻 → 再冻结）；
//   - 应用库**不存在**不是失败：应用可能从未被打开过。此时只写 export.json，
//     并在结果里 HasDatabase=false（导出体自己也如实写 `database.included=false`）；
//   - 任何一步失败都**清理半成品目录**并把错误返回给调用方 —— 冻结路径据此只写
//     snapshot_error（不阻断冻结），删除路径据此**拒绝删除**（fail-closed）。
func Snapshot(ctx context.Context, db *sql.DB, dataRoot, appID string, now time.Time) (*SnapshotResult, error) {
	base, err := SnapshotsDir(dataRoot, appID)
	if err != nil {
		return nil, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	dir := filepath.Join(base, now.UTC().Format(time.RFC3339))
	// 先**读**（构建导出体，不碰磁盘）再建目录：应用不存在/读库失败时不该在数据根下
	// 留下 `<apps>/<app_id>/snapshots/` 这种"看起来像有快照"的空壳（真删的前置条件
	// 只看 DB 的 snapshot_at，而人看的是磁盘 —— 空壳会让排障者误判）。
	doc, err := BuildExport(ctx, db, appID, now)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}
	// 只在**成功**时保留目录；任何失败都把半成品删掉（否则下次重试会撞同名目录，
	// 而"有目录但缺文件"是最危险的状态：purge 前置条件只看 DB 的 snapshot_at）。
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(dir)
		}
	}()

	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("序列化导出体失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ExportFileName), raw, limits.DataDirMode); err != nil {
		return nil, fmt.Errorf("写 export.json 失败: %w", err)
	}

	res := &SnapshotResult{Dir: dir, ExportBytes: int64(len(raw))}
	appDBPath, hasDB, aerr := appdb.SafePath(dataRoot, appID)
	if aerr != nil {
		return nil, fmt.Errorf("解析应用库路径失败: %w", aerr)
	}
	if hasDB {
		if err := VacuumInto(ctx, appDBPath, filepath.Join(dir, DatabaseFileName)); err != nil {
			return nil, err
		}
		res.HasDatabase = true
	}
	ok = true
	return res, nil
}

// VacuumInto 用 SQLite 的 `VACUUM INTO` 生成**只读单文件快照**。
//
// 为什么是 VACUUM INTO（而不是复制文件）：应用库在运行期可能有 WAL 尾巴与未回写的页，
// 直接 `cp` 拿到的是"看起来能开、内容不完整"的库。VACUUM INTO 在一个读事务里导出，
// 不锁写、不留 WAL 尾巴，产物是完整一致的单文件（SQLite 3.27+）。
//
// 连接用 `mode=rw`（**不是** rwc）：应用库必须已经存在；不存在的路径绝不能被"顺手建出来"
// （那会把"从未使用过"这个事实抹掉 —— 与 appdb.Open 的副作用纪律同源）。
// 调用方保证 dstPath 的父目录已存在。
func VacuumInto(ctx context.Context, srcPath, dstPath string) error {
	if _, err := os.Stat(srcPath); err != nil {
		return fmt.Errorf("应用库不可读: %w", err)
	}
	conn, err := sql.Open("sqlite", "file:"+srcPath+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("打开应用库失败: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `VACUUM INTO ?`, dstPath); err != nil {
		return fmt.Errorf("VACUUM INTO 快照失败: %w", err)
	}
	if info, statErr := os.Stat(dstPath); statErr != nil || info.Size() == 0 {
		return fmt.Errorf("快照产物不存在或为空: %v", statErr)
	}
	return nil
}

// DeleteSnapshots **尽力**删除该应用的全部快照目录（解冻/恢复时调用）。
//
// 失败不阻断调用方：解冻是"恢复服务"的动作，磁盘故障不该把它拦住；但调用方应把错误
// 写进响应/日志（残留快照=残留数据，运维需要知道）。
func DeleteSnapshots(dataRoot, appID string) error {
	dir, err := SnapshotsDir(dataRoot, appID)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("删除快照目录失败: %w", err)
	}
	return nil
}

// RemoveAppData 真删一个应用的**全部磁盘数据**（db + assets + snapshots 一起）。
//
// 返回被删除的目录路径（审计要写"删了什么"）。目录不存在视为成功（幂等：上一轮
// 已删但元数据没更新时，重试必须能收敛）。
//
// ⚠️ 这是本平台唯一的 `os.RemoveAll`：路径只由 AppDir 拼出，而 AppDir 对 app_id
// 做过形状判据 —— 不接受空串、`..`、绝对路径、大写。
func RemoveAppData(dataRoot, appID string) (string, error) {
	dir, err := AppDir(dataRoot, appID)
	if err != nil {
		return "", err
	}
	if err := os.RemoveAll(dir); err != nil {
		return "", fmt.Errorf("删除应用数据目录失败: %w", err)
	}
	return dir, nil
}

// BuildExport 生成控制面导出体（`{"export": {...}}`，format = zeokeel.wasm-app-export/1）。
//
// 口径与历史实现（api/read.go 的 export）**逐字兼容**：只多不少 —— 新增的是设计 §5.6
// 要求的 `lifecycle` 段（frozen_at/deleted_at/purge_after/purged_at/snapshot_at）与
// 部署指针。改字段值会破坏 format /1 契约，因此加字段不改值。
//
// 使用者也包括管理面导出与快照（同一份实现）：`VACUUM INTO` 的 app.db 与 zip 里的
// export.json 必须与 `GET …/export` 的 JSON 逐字同源，否则"导出的是这份、快照的是那份"。
func BuildExport(ctx context.Context, db *sql.DB, appID string, now time.Time) (map[string]any, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	app, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		return nil, err
	}
	releases, err := serverstore.ListWasmReleases(ctx, db, appID, true)
	if err != nil {
		return nil, err
	}
	deployments, err := serverstore.ListWasmDeployments(ctx, db, appID, 200)
	if err != nil {
		return nil, err
	}
	rows := make([]map[string]any, 0, len(releases))
	var currentVersion string
	for _, r := range releases {
		row := map[string]any{
			"version":     r.Version,
			"title":       r.Title,
			"description": r.Description,
			"changelog":   r.Changelog,
			"publisher":   r.Publisher,
			"status":      r.Status,
			// 审核结论（被拒理由；通过/待审恒为空串）：导出的快照要能回答"这一版
			// 为什么没上线"，否则退役后的回看只剩一个 status。
			"reason":     r.Reason,
			"checksum":   r.Checksum,
			"size":       r.Size,
			"created_at": r.CreatedAt,
			"deleted":    r.DeletedAt != nil,
		}
		if r.ConfigJSON != "" {
			row["config"] = json.RawMessage(r.ConfigJSON)
		}
		if r.ID == app.CurrentReleaseID {
			currentVersion = r.Version
			row["current"] = true
		}
		rows = append(rows, row)
	}
	var appConfig json.RawMessage
	if app.ConfigJSON != "" {
		appConfig = json.RawMessage(app.ConfigJSON)
	}
	depRows := make([]map[string]any, 0, len(deployments))
	for _, d := range deployments {
		depRows = append(depRows, map[string]any{
			"id": d.ID, "version": d.Version, "kind": d.Kind,
			"actor": d.Actor, "actor_role": d.ActorRole, "message": d.Message,
			"created_at": d.CreatedAt, "current": d.ID == app.CurrentDeploymentID,
		})
	}
	return map[string]any{"export": map[string]any{
		"format":      "zeokeel.wasm-app-export/1",
		"exported_at": now.UTC(),
		"app": map[string]any{
			"app_id":             app.AppID,
			"title":              app.Title,
			"title_source":       titleSource(app),
			"description":        app.Description,
			"owner":              app.Owner,
			"channel":            app.Channel,
			"enabled":            app.Enabled,
			"access":             string(appcfg.AccessOfConfigJSON(app.ConfigJSON)),
			"purpose":            app.Purpose,
			"data_sensitivity":   app.DataSensitivity,
			"config":             appConfig,
			"current_version":    currentVersion,
			"current_release_id": app.CurrentReleaseID,
			// 迁移 0086：部署指针（历史链）。运行期真源仍是 current_release_id。
			"current_deployment_id": app.CurrentDeploymentID,
			"frozen_at":             app.FrozenAt,
			"deleted_at":            app.DeletedAt,
			"created_at":            app.CreatedAt,
			"updated_at":            app.UpdatedAt,
		},
		// lifecycle 段（设计 §5.6 要求补齐的五项；为 nil 的项照样下发 null，
		// 让下游不必区分"字段缺失"与"没有时刻"）。
		"lifecycle":   app.WasmAppSnapshotSummary(),
		"releases":    rows,
		"deployments": depRows,
		"assets": map[string]any{
			"layout": "<data_root>/apps/<app_id>/assets/<release_id>/",
			"note":   "静态资源在发布期已从 wasm 自定义段抽出；2026-09-20 起随包资源在内存里构造，磁盘上只保留历史目录（`?assets=1` 导出会在存在时打包它们）",
		},
		"database": map[string]any{
			"path_template": "<data_root>/apps/<app_id>/app.db",
			"included":      false,
			"why": "JSON 导出只含控制面元数据；要连使用者数据一起取，请用 `?database=1`（zip，" +
				"内含 `VACUUM INTO` 只读快照）—— 那属于独立的管理员运维动作",
			"snapshot_hint": "SQLite 单文件只读快照：`VACUUM INTO '<目标路径>'`（SQLite 3.27+；不锁写、不留 WAL 尾巴）",
		},
		"retention": map[string]any{
			"snapshot_days": limits.RetirementSnapshotRetentionDays,
			"note": "冻结 → 只读快照 → 保留期结束后由 `wasm_retirement` 调度器真删（数据目录整棵删除；" +
				"元数据与部署历史保留作审计 tombstone）",
		},
	}}, nil
}

// titleSource 标注导出里 `app.title` 的来源（占位不是真实标题）。
//
// 与 api 层 auditTitleOf 同一口径（真实标题 = 生效版本的标题），只是导出面不能改字段值
// ⇒ 用**来源标注**把"这是占位"讲清楚：
//
//	release            = apps.title 是生效版本标题的投影（唯一可信来源）；
//	app_id_placeholder = 还没有生效版本，title 是 app_id 占位；
//	empty              = 没有生效版本且行里也没有标题（历史残渣）。
func titleSource(app *serverstore.WasmApp) string {
	switch {
	case app == nil:
		return "empty"
	case app.CurrentReleaseID > 0 && strings.TrimSpace(app.Title) != "":
		return "release"
	case strings.TrimSpace(app.Title) == "":
		return "empty"
	default:
		return "app_id_placeholder"
	}
}

// WriteExportJSON 把导出体写成缩进 JSON（快照与 `?database=` 的 zip 共用）。
func WriteExportJSON(w io.Writer, doc map[string]any) (int64, error) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return 0, err
	}
	if _, err := w.Write(raw); err != nil {
		return 0, err
	}
	return int64(len(raw)), nil
}

// ExportZip 生成**一份可下载的导出 zip**，返回临时文件路径与清理函数。
//
// 内容（设计 §5.6）：
//   - `export.json` —— 与 `GET …/export` 的 JSON 逐字同源（BuildExport）；
//   - `app.db` —— 仅 `opts.Database`：`VACUUM INTO` 只读快照（应用库不存在时跳过，
//     并在 export.json 的 database.included 里如实写 false）；
//   - `assets/<release_id>/…` —— 仅 `opts.Assets`：从磁盘**现存**的历史资源目录复制
//     （2026-09-20 起随包资源不再落盘，所以多数应用没有这一段；不伪造空目录）。
//
// 临时文件放在系统临时目录（不污染数据根）：导出是**读**动作，而数据根下的每一次写都
// 属于生命周期语义（快照目录的判据是 `<apps>/<app_id>/snapshots/<RFC3339>`，不能让
// 导出在半途造出看起来像快照的东西）。
func ExportZip(ctx context.Context, db *sql.DB, dataRoot, appID string, opts ExportOptions, now time.Time) (string, func(), error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	doc, err := BuildExport(ctx, db, appID, now)
	if err != nil {
		return "", nil, err
	}
	appDir, err := AppDir(dataRoot, appID)
	if err != nil {
		return "", nil, err
	}
	// 数据库快照先落在临时目录：VACUUM INTO 需要一个真实路径，之后再打进 zip。
	tmpDir, err := os.MkdirTemp("", "zeokeel-wasm-export-")
	if err != nil {
		return "", nil, fmt.Errorf("创建导出临时目录失败: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	fail := func(err error) (string, func(), error) {
		cleanup()
		return "", nil, err
	}

	// `database.included` 是**事实**而不是参数：只有真的拿到库快照才写 true。
	exportInner, _ := doc["export"].(map[string]any)
	var dbSnapshotPath string
	hasDB := false
	if opts.Database {
		appDBPath, exists, aerr := appdb.SafePath(dataRoot, appID)
		if aerr != nil {
			return fail(fmt.Errorf("解析应用库路径失败: %w", aerr))
		}
		if exists {
			dbSnapshotPath = filepath.Join(tmpDir, DatabaseFileName)
			if err := VacuumInto(ctx, appDBPath, dbSnapshotPath); err != nil {
				return fail(err)
			}
			hasDB = true
		}
	}
	if dbInfo, ok := exportInner["database"].(map[string]any); ok {
		dbInfo["included"] = hasDB
		if opts.Database && !hasDB {
			dbInfo["reason"] = "应用库文件不存在（该应用还没有被使用过），因此本 zip 只含控制面元数据"
		}
	}

	zipPath := filepath.Join(tmpDir, "export.zip")
	zf, err := os.Create(zipPath)
	if err != nil {
		return fail(fmt.Errorf("创建导出 zip 失败: %w", err))
	}
	zw := zip.NewWriter(zf)
	writeEntry := func(name string, fn func(w io.Writer) error) error {
		w, cerr := zw.Create(name)
		if cerr != nil {
			return cerr
		}
		return fn(w)
	}
	// export.json 必须**最后**写不了（zip 顺序无关），但内容要在 database.included
	// 定稿之后序列化 —— 所以先决定快照、再写 json、最后追加二进制。
	if err := writeEntry(ExportFileName, func(w io.Writer) error {
		_, werr := WriteExportJSON(w, doc)
		return werr
	}); err != nil {
		zf.Close()
		return fail(fmt.Errorf("写 export.json 失败: %w", err))
	}
	if hasDB {
		if err := appendFileToZip(zw, dbSnapshotPath, DatabaseFileName); err != nil {
			zf.Close()
			return fail(err)
		}
	}
	if opts.Assets {
		if err := appendDirToZip(zw, filepath.Join(appDir, AssetsDirName), AssetsDirName); err != nil {
			zf.Close()
			return fail(err)
		}
	}
	if err := zw.Close(); err != nil {
		zf.Close()
		return fail(fmt.Errorf("收尾导出 zip 失败: %w", err))
	}
	if err := zf.Close(); err != nil {
		return fail(fmt.Errorf("关闭导出 zip 失败: %w", err))
	}
	return zipPath, cleanup, nil
}

// appendFileToZip 把一个文件按 zip 内路径 name 追加进 zip。
func appendFileToZip(zw *zip.Writer, path, name string) error {
	src, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("读取 %s 失败: %w", path, err)
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return fmt.Errorf("读取 %s 元信息失败: %w", path, err)
	}
	hdr, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("构造 zip 条目失败: %w", err)
	}
	hdr.Name = name
	hdr.Method = zip.Deflate
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return fmt.Errorf("创建 zip 条目失败: %w", err)
	}
	if _, err := io.Copy(w, src); err != nil {
		return fmt.Errorf("写入 zip 条目失败: %w", err)
	}
	return nil
}

// appendDirToZip 把磁盘目录 rootDir 递归追加进 zip（zip 内前缀 prefix）。
//
// rootDir 不存在 = 什么都不加（不是错误）：2026-09-20 起随包资源在内存里构造，
// 磁盘上没有按版本的资源目录；`assets=1` 的语义是"有就带上"，不是"必须有"。
// 符号链接一律跳过（导出不能成为"把数据根以外的文件读出去"的通道）。
func appendDirToZip(zw *zip.Writer, rootDir, prefix string) error {
	entries, err := os.ReadDir(rootDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("读取资源目录失败: %w", err)
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		child := filepath.Join(rootDir, entry.Name())
		name := prefix + "/" + entry.Name()
		if entry.IsDir() {
			if err := appendDirToZip(zw, child, name); err != nil {
				return err
			}
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		if err := appendFileToZip(zw, child, name); err != nil {
			return err
		}
	}
	return nil
}
