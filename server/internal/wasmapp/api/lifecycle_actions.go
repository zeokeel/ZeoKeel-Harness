package api

// 本文件是**冻结 / 解冻 / 删除 / 恢复 / 导出**的共享实现（员工面与管理面共用）。
//
// 为什么要抽出一层共享实现（审计 2026-10-22 C-01/C-02/C-11 的共同形态）：
// 同一条生命周期语义此前在员工面与管理面各写一份 —— 冻结在两边都只写 frozen_at
// （谁都没写 purge_after、谁都没做快照），导出只在员工面存在，删除只在员工面存在。
// 两份实现必然漂移，而漂移的表现是"管理端按下冻结时承诺的东西和作者端不一样"。
//
// 语义全部来自设计契约 docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.4–§5.6：
//
//	冻结 = 停服 + 记冻结时刻 + purge_after（+ 保留期）+ **立即尝试快照**
//	       （快照失败不阻断冻结，但落 snapshot_error 且**阻断真删**）；
//	解冻 = 清冻结时间线 + 尽力删快照目录 + **不自动上架**；
//	删除 = 先冻结 → **快照必须成功**（fail-closed）→ 软删 + 时间线；
//	恢复 = 清 deleted/frozen + enabled 保持 0（不自动上架）；purged 之后 410；
//	导出 = JSON（默认，向后兼容）或 `?database=1&assets=1` 的 zip。
//
// 磁盘动作全部在 internal/wasmapp/lifecycle（快照 / VACUUM INTO / 真删），本文件只
// 做编排与审计 —— 两份磁盘实现会写出"快照里有一份、导出里少一份"的分叉。

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/lifecycle"
)

// snapshotApp 立即尝试一次只读快照，并把**结果**落库（成功/失败都记）。
//
// 返回 (快照结果, 失败文案)。失败文案非空 = 快照没做成：
//   - 冻结路径：不阻断冻结（响应里带 snapshot_error，运维面可见，调度器**不会**删没快照的应用）；
//   - 删除路径：**必须**阻断删除（fail-closed，见 retireForApp）。
func (h *Handlers) snapshotApp(ctx context.Context, appID string, now time.Time) (*lifecycle.SnapshotResult, string) {
	if strings.TrimSpace(h.opt.DataRoot) == "" {
		return nil, "平台数据根未配置（DataRoot 为空），无法生成快照"
	}
	res, err := lifecycle.Snapshot(ctx, h.opt.DB, h.opt.DataRoot, appID, now)
	if err != nil {
		msg := err.Error()
		_ = serverstore.SetWasmAppSnapshot(ctx, h.opt.DB, appID, serverstore.WasmSnapshotRecord{Error: msg})
		return nil, msg
	}
	// 成功：写 snapshot_at/snapshot_path，并由 SetWasmAppSnapshot 清掉上次的失败原因
	// （留着一个陈旧错误会让运维面一直显示"快照失败"）。
	at := now.UTC()
	_ = serverstore.SetWasmAppSnapshot(ctx, h.opt.DB, appID, serverstore.WasmSnapshotRecord{
		At: &at, Path: res.Dir,
	})
	return res, ""
}

// remainingRetentionDays 返回"从 now 到 purgeAfter 还剩几天"（向上取整，最小 0）。
//
// 响应与审计必须报**实际剩余**保留期：已冻结 89 天后再删除，真实剩余是 1 天。
// 用 ceil 而不是截断：不到一天也算"还有一天"，把 0.4 天渲染成 0 会让运维以为"已经到期"。
func remainingRetentionDays(now, purgeAfter time.Time) int {
	days := int(purgeAfter.Sub(now).Hours()/24 + 0.999)
	if days < 0 {
		return 0
	}
	return days
}

// retentionDays 返回**当前生效**的退役快照保留天数（控制台可调，默认 90）。
// 写冻结/删除时间线、审计与响应都必须用它，否则管理员改了保留期、界面仍按 90 天承诺。
func (h *Handlers) retentionDays() int {
	if h.opt.Limits != nil {
		if v := h.opt.Limits().RetirementSnapshotRetentionDays; v > 0 {
			return v
		}
	}
	return limits.RetirementSnapshotRetentionDays
}

// retentionDeadline 返回"冻结时刻 + 保留期"（默认 R37 的 90 天，可由控制台覆盖）。
func (h *Handlers) retentionDeadline(frozenAt time.Time) time.Time {
	return frozenAt.AddDate(0, 0, h.retentionDays())
}

// freezeForApp 冻结应用（员工面/管理面共用；设计 §5.4）。
//
// 失败语义：冻结本身失败 → 500（状态没变）；快照失败 → 冻结**成功**（200），
// 但响应带 snapshot_error 且 note 明确说明"快照失败 ⇒ 不会自动真删，需重试"。
func (h *Handlers) freezeForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	ctx := c.Request.Context()
	if app.FrozenAt != nil {
		// 幂等：已冻结 ⇒ 不重复写快照、不写审计。
		c.JSON(http.StatusOK, gin.H{"app": frozenAppJSON(app, false)})
		return
	}
	now := h.now().UTC()
	purgeAfter := h.retentionDeadline(now)
	if err := serverstore.FreezeWasmAppWithRetention(ctx, h.opt.DB, app.AppID, now, purgeAfter); err != nil {
		writeErr(c, internalErr("冻结失败", err))
		return
	}
	snap, snapErr := h.snapshotApp(ctx, app.AppID, now)
	h.auditApp(app.AppID, actor, "wasm_app_freeze",
		auditDetail(app.AppID, auditTitleOf(app), "冻结（停止服务；快照保留 "+
			strconv.Itoa(h.retentionDays())+" 天，到期由 wasm_retirement 真删；"+
			"actor_role="+role+"；快照"+
			map[bool]string{true: "成功", false: "失败(" + snapErr + ")"}[snapErr == ""]+"）"))
	// 冻结 = 停止服务 ⇒ 进程内驻留（编译模块 + 库句柄）没有留着的理由。
	h.evictApp(app.AppID)

	// 重新读一次：快照结果与 purge_after 都已经落库，响应必须与库一致。
	fresh, ferr := serverstore.GetWasmApp(ctx, h.opt.DB, app.AppID)
	if ferr != nil || fresh == nil {
		fresh = app
	}
	out := frozenAppJSON(fresh, true)
	out["frozen_at"] = now
	out["purge_after"] = purgeAfter
	if snap != nil {
		out["snapshot_ok"] = true
		out["snapshot_path"] = snap.Dir
		out["snapshot_has_database"] = snap.HasDatabase
	} else {
		// **不要**在快照失败时说"到期会自动删"：调度器的前置条件没有满足，
		// 它不会删这个应用。响应必须把这个反直觉的事实说清。
		out["snapshot_ok"] = false
		out["snapshot_error"] = snapErr
	}
	resp := gin.H{"app": out}
	if snapErr != "" {
		resp["note"] = "冻结已生效（应用已停止服务），但快照失败：" + snapErr +
			"；没有成功快照的应用**不会**被自动真删（fail-closed），请重试冻结或排查数据目录/磁盘后重试导出"
	} else {
		resp["note"] = "冻结已生效；只读快照已生成，保留期结束后由 wasm_retirement 调度器真删（不可恢复）"
	}
	c.JSON(http.StatusOK, resp)
}

// unfreezeForApp 解冻（设计 §5.4）：清时间线 + 尽力删快照目录 + **不自动上架**。
func (h *Handlers) unfreezeForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	ctx := c.Request.Context()
	if app.FrozenAt == nil {
		c.JSON(http.StatusOK, gin.H{"app": frozenAppJSON(app, false)})
		return
	}
	if err := serverstore.UnfreezeWasmApp(ctx, h.opt.DB, app.AppID); err != nil {
		writeErr(c, internalErr("解冻失败", err))
		return
	}
	// 快照目录没有消费者了（purge_after 已清空 ⇒ 该应用不可能被真删），尽力删除。
	// 残留快照 = 残留数据，删不掉要在响应里如实报，但**不阻断解冻**（解冻是恢复服务的动作）。
	snapshotCleanupError := ""
	if h.opt.DataRoot != "" {
		if derr := lifecycle.DeleteSnapshots(h.opt.DataRoot, app.AppID); derr != nil {
			snapshotCleanupError = derr.Error()
		}
	}
	h.auditApp(app.AppID, actor, "wasm_app_freeze",
		auditDetail(app.AppID, auditTitleOf(app),
			"解冻（清冻结时间线与快照状态；enabled 保持 "+boolWord(app.Enabled)+
				"，不自动上架；actor_role="+role+"）"))
	resp := gin.H{
		"app":  frozenAppJSON(&serverstore.WasmApp{AppID: app.AppID, Enabled: app.Enabled}, true),
		"note": "解冻不会自动上架：请显式调用 publish",
	}
	if snapshotCleanupError != "" {
		resp["snapshot_cleanup_error"] = snapshotCleanupError
	}
	c.JSON(http.StatusOK, resp)
}

// frozenAppJSON 是冻结面响应的公共部分（两条面共用，字段名稳定）。
func frozenAppJSON(app *serverstore.WasmApp, changed bool) gin.H {
	out := gin.H{"app_id": app.AppID, "changed": changed, "enabled": app.Enabled}
	if app.FrozenAt != nil {
		out["frozen"] = true
		out["frozen_at"] = app.FrozenAt
	} else {
		out["frozen"] = false
		// 解冻分支里 app 是本地构造的（只有 AppID/Enabled）⇒ 时间线字段如实给 null。
		out["frozen_at"] = nil
	}
	if app.PurgeAfter != nil {
		out["purge_after"] = app.PurgeAfter
	}
	if app.SnapshotAt != nil {
		out["snapshot_at"] = app.SnapshotAt
		out["snapshot_path"] = app.SnapshotPath
	}
	if app.SnapshotError != "" {
		out["snapshot_error"] = app.SnapshotError
	}
	return out
}

// boolWord 把 bool 渲染成"上架/下架"（审计明细里给人读）。
func boolWord(enabled bool) string {
	if enabled {
		return "1（已上架）"
	}
	return "0（已下架）"
}

// retireForApp 删除应用（设计 §5.5）：先冻结 → **快照必须成功** → 软删 + 时间线。
//
// fail-closed 的关键一段：快照失败 ⇒ 删除失败（HTTP 500 + 可操作提示），**不**软删。
// 理由：软删会立刻释放全部版本的制品字节（SoftDeleteWasmApp），一旦释放就再也没有
// 任何路径能把应用恢复成"原来那样" —— 而删除承诺的正是"保留期后可从快照回看"。
func (h *Handlers) retireForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	ctx := c.Request.Context()
	now := h.now().UTC()
	// ① 未冻结则先冻结（同一时刻）：purge_after 的锚点必须是冻结时刻。
	purgeAfter := h.retentionDeadline(now)
	retentionDays := h.retentionDays()
	if app.FrozenAt == nil {
		if err := serverstore.FreezeWasmAppWithRetention(ctx, h.opt.DB, app.AppID, now, purgeAfter); err != nil {
			writeErr(c, internalErr("删除前冻结失败", err))
			return
		}
	} else {
		// 已经冻结过：**沿用原 purge_after**（保留期从冻结时刻算，不是从删除时刻重算）。
		// 2026-10-22 反证 P2-3：此前响应/审计照样写"保留期 90 天"，而冻结 89 天后再删
		// 实际只剩 1 天 —— 那是把承诺写成比实际更宽松的假陈述。这里按**实际剩余天数**写。
		purgeAfter = h.retentionDeadline(*app.FrozenAt)
		if app.PurgeAfter != nil {
			purgeAfter = *app.PurgeAfter
		}
		retentionDays = remainingRetentionDays(now, purgeAfter)
	}
	// ② 删除前的快照是**硬前置条件**（fail-closed）。
	snap, snapErr := h.snapshotApp(ctx, app.AppID, now)
	if snapErr != "" || snap == nil {
		e := internalErr("删除失败：删除前的只读快照未生成", errors.New(snapErr)).
			WithHint("快照是删除的前置条件（保留期内要能回看）：请检查数据目录/磁盘余量后重试删除。" +
				"本次未做任何删除，应用仍是冻结状态")
		e.WithDetail("app_id", app.AppID).WithDetail("snapshot_error", snapErr)
		writeErr(c, e)
		return
	}
	// ③ 软删（同时释放全部版本的制品字节）+ 记时间线。
	if err := serverstore.SoftDeleteWasmAppWithTimeline(ctx, h.opt.DB, app.AppID, now, purgeAfter); err != nil {
		writeErr(c, internalErr("删除失败", err))
		return
	}
	h.auditApp(app.AppID, actor, "wasm_app_delete",
		auditDetail(app.AppID, auditTitleOf(app), "软删（标识与版本号永久占位；制品字节已释放；"+
			"保留期剩余 "+strconv.Itoa(retentionDays)+" 天（到期 "+purgeAfter.Format("2006-01-02")+
			" 由 wasm_retirement 真删）；purge_after="+purgeAfter.Format("2006-01-02")+
			"；snapshot="+snap.Dir+"; actor_role="+role+"）"))
	h.evictApp(app.AppID)
	c.JSON(http.StatusOK, gin.H{
		"app": gin.H{
			"app_id":        app.AppID,
			"deleted":       true,
			"frozen_at":     now,
			"deleted_at":    now,
			"purge_after":   purgeAfter,
			"snapshot_at":   now,
			"snapshot_path": snap.Dir,
		},
		// retention_days = **实际剩余**保留天数（已冻结很久再删除时 < 90；反证 P2-3）。
		"retention_days": retentionDays,
		"snapshot": gin.H{
			"path":         snap.Dir,
			"has_database": snap.HasDatabase,
		},
		"note": "已软删：只读快照已生成；保留期结束后由 wasm_retirement 调度器真删数据目录" +
			"（不可恢复）。恢复可用 POST …/restore（保留期内有效，恢复后需重新上架）",
	})
}

// boolQuery 解析布尔型查询参数（`?database=1|true|yes`）。
//
// 只认明确的真值；未出现的参数 = false。非法值按 false 处理而不是 400：
// 导出的主用法是默认 JSON，多打一个错字不该让运维拿不到数据（**不**静默改变语义：
// zip 需要显式真值）。
func boolQuery(c *gin.Context, name string) bool {
	raw := strings.TrimSpace(strings.ToLower(c.Query(name)))
	switch raw {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// exportForApp 导出（设计 §5.6）：默认 JSON（向后兼容）；`?database=1&assets=1` ⇒ zip。
//
// 审计口径：动作 `wasm_app_export`，detail 含 database/assets/actor_role 与**不含行内容**
// （审计面是运维可读的，不是内容仓库）。
func (h *Handlers) exportForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	ctx := c.Request.Context()
	withDatabase := boolQuery(c, "database")
	withAssets := boolQuery(c, "assets")
	// 设计 §3.1：purged 之后**数据面**（库/资源）一律 410 APP_PURGED ——
	// 那些字节已经被真删，继续回 200 只会在 zip 里放一份"库不存在"的说明，
	// 让运维误以为"导出成功 = 数据还在"。控制面元数据（默认 JSON）仍可导出。
	if (withDatabase || withAssets) && app.PurgedAt != nil {
		e := apperr.New(apperr.Code(serverstore.CodeAppPurged),
			"应用数据已清除（保留期到期后真删），没有可导出的库或资源").
			WithDetail("app_id", app.AppID).
			WithHint("控制面元数据（GET …/export，不带参数）仍可导出，用于审计留档")
		e.HTTP = http.StatusGone
		writeErr(c, e)
		return
	}
	scope := "metadata"
	if withDatabase || withAssets {
		scope = "archive"
	}
	// 审计**在导出成功之后**写（2026-10-22 反证 P2-6）：此前写在导出之前，导出失败时
	// 审计仍声称"导出成功"，而运维会据此认为数据已经拿到。两条成功出口各自写一条。
	auditExport := func() {
		h.auditApp(app.AppID, actor, "wasm_app_export",
			auditDetail(app.AppID, auditTitleOf(app), "导出 database="+strconv.FormatBool(withDatabase)+
				" assets="+strconv.FormatBool(withAssets)+" scope="+scope+" actor_role="+role))
	}

	if !withDatabase && !withAssets {
		doc, err := lifecycle.BuildExport(ctx, h.opt.DB, app.AppID, h.now().UTC())
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				writeErr(c, notFoundApp(app.AppID))
				return
			}
			writeErr(c, internalErr("导出失败", err))
			return
		}
		auditExport()
		c.Header("Content-Disposition", `attachment; filename="`+app.AppID+`-export.json"`)
		c.JSON(http.StatusOK, doc)
		return
	}

	zipPath, cleanup, err := lifecycle.ExportZip(ctx, h.opt.DB, h.opt.DataRoot, app.AppID,
		lifecycle.ExportOptions{Database: withDatabase, Assets: withAssets}, h.now().UTC())
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			writeErr(c, notFoundApp(app.AppID))
			return
		}
		writeErr(c, internalErr("导出失败（zip）", err))
		return
	}
	defer cleanup()
	auditExport()
	c.Header("Content-Disposition", `attachment; filename="`+app.AppID+`-export.zip"`)
	c.Header("Content-Type", "application/zip")
	c.File(zipPath)
}

// deleteSnapshotsForApp 是"尽力删快照目录"的薄封装（employee/admin 恢复共用）。
func deleteSnapshotsForApp(dataRoot, appID string) error {
	if strings.TrimSpace(dataRoot) == "" {
		return errors.New("平台数据根未配置，未清理快照目录")
	}
	return lifecycle.DeleteSnapshots(dataRoot, appID)
}
