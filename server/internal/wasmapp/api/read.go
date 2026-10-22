package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appcfg"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appdb"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/diag"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/registry"
)

// 本文件是 §8 的**只读面**：诊断 / 自省 / 应用中心目录 / 导出。
//
// 四条口径先写清（都是"会不会多给/少给信息"的问题）：
//   - diagnostics：失败记录 + 概览 + **可操作 hints**（§4.9：第一消费者是 AI）；
//   - schema：表结构 + 占用（**仅发布者**，且**每次调用写审计**）；
//   - catalog：按可见性过滤的目录（R34/R38；**不做安装语义、不显示额度/用量**，R36）；
//   - export：R37 的只读快照 —— 控制面元数据 + 获取说明，**不含任何使用者数据**。

// ---------------------------------------------------------------------------
// 诊断：GET .../wasm/:app_id/diagnostics
// ---------------------------------------------------------------------------

func (h *Handlers) diagnostics(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	// 只读动作 ⇒ 允许已退役（R37 的保留期内仍要能排障）。
	app, _, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	body, derr := h.diagnosticsPayload(c, appID, app)
	if derr != nil {
		writeErr(c, derr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"diagnostics": body})
}

// diagnosticsPayload 组装诊断响应体（**员工面与管理面共用**）。
//
// 抽出来的唯一理由：两份出口各拼一次必然漂移 —— 同一份 wasm_call_events 在两个
// 页面上给出不同的 hints/计数时，排障要先花时间吵"哪边是对的"。查询串
// （limit/minutes）与保留期语义在这里一次解释清楚。
//
// app 只用于 enabled/frozen/deleted 三个标记；归属校验由调用方完成
// （员工面 = ownedApp，管理面 = loadAdminApp）。
func (h *Handlers) diagnosticsPayload(c *gin.Context, appID string, app *serverstore.WasmApp) (gin.H, *apperr.Error) {
	limit := atoiDefault(c.Query("limit"), limits.DiagnosticsDefaultLimit)
	window := windowFromQuery(c.Query("minutes"))
	since := h.now().UTC().Add(-window)
	ctx := c.Request.Context()

	failures, err := diag.RecentFailures(ctx, h.opt.DB, appID, limit)
	if err != nil {
		return nil, internalErr("查询失败", err)
	}
	// 诊断里的内存数字必须跟随**生效**上限（R1-rt-25）：此前走 Summary/HintsFor 取的是
	// 编译期默认（恒 64 MiB），控制台把单实例上限改小/改大后，作者看到的建议数字与实际
	// 不符 —— 诊断的第一消费者是 AI，错误数字会把排查带偏。
	//
	// R2-DG-2 的加固：`h.instanceMemoryPages()` 取的是**已保存值**（控制台设置），
	// 而单实例上限要重启才生效 ⇒ 在"保存了但没重启"的窗口里它仍然不是生效值。
	// 这里统一走 effectiveMemoryPages()（运行时优先，见它的注释）。
	// 该应用**运行期生效**的并发四轴（全局 + per-app 覆盖）：
	// 429 类 hints 与响应里的 limits 段都必须用它，而不是全局默认值。
	axes, hasOverride := h.effectiveQueueAxes(appID)
	summary, err := diag.SummaryWithAppLimits(ctx, h.opt.DB, appID, since, h.effectiveMemoryPages(), h.budgets(), axes)
	if err != nil {
		return nil, internalErr("查询失败", err)
	}
	// hints 的来源有两条且都要给：
	//   - summary.Hints（按出现次数排序的失败码对应建议）；
	//   - 逐条 failure 的 HintsFor（时间线上"那一次"是什么错就说什么）。
	// 合并后保序去重（同一个 hint 不重复刷屏）。
	hints := append([]string{}, summary.Hints...)
	for _, f := range failures {
		hints = append(hints, diag.HintsForApp(f.ReasonCode, h.effectiveMemoryPages(), h.budgets(), axes)...)
	}

	// ---- A3（2026-10-22 功能合理性审计，P2）：把事件丢弃量交给作者 ----
	//
	// 现场：调用事件走**有界环形缓冲**，满了丢最旧并计数（events.Sink.Dropped），
	// 落库失败丢整批并计数（Failed）。管理面的 `/admin/wasm-apps/runtime` 一直能看到
	// 这两个数，**作者面诊断却一个字段都不给** —— 作者（第一消费者是 AI）看到
	// `summary.failed = 0` 会直接得出"没有问题"，而这段时间可能已经丢了几千条事件。
	// 丢弃本身是设计的一部分（§4.9「丢最旧并计数」），不是错误；但"统计可能不完整"
	// 必须写在响应里，且 **0 也要下发**（缺字段与 0 在 JSON 消费侧无法区分）。
	//
	// `events_available=false` 时那两个 0 **不是**"没丢过"而是"没在记"：未装配 sink
	// 时 failures 为空是另一回事，必须让作者能分辨这两种"看起来健康"。
	eventsAvailable := h.opt.Events != nil
	dropped, flushFailed := int64(0), int64(0)
	if eventsAvailable {
		dropped = h.opt.Events.Dropped()
		flushFailed = h.opt.Events.Failed()
	}
	if dropped+flushFailed > 0 {
		hints = append(hints, fmt.Sprintf("事件统计可能不完整：调用事件被丢弃 %d 条（环形缓冲满）/"+
			"落库失败 %d 条，本页的失败次数与占比可能低于真实值", dropped, flushFailed))
	}
	if !eventsAvailable {
		hints = append(hints, "调用事件通道未接线（events sink 未注入）：failures 为空不代表没有失败，"+
			"请以平台运行时水位（/admin/wasm-apps/runtime 的 events 段）与平台日志为准")
	}

	// ---- A6（2026-10-22 功能合理性审计，P2）：whitelist 是「假准入」必须说清 ----
	//
	// R24：`access=whitelist` 的名单**由应用自己判定**，平台不比对。发布/诊断此前
	// 零提示 ⇒ 作者以为平台在替它拦截，实际任何登录用户都能打开这个应用。
	// 这里**不改任何准入语义**（平台鉴权仍是"登录 + 归属"），只把事实与可操作做法下发：
	// `whitelist_enforced` 是恒为 false 的平台事实（写成字段而不是只在 hint 里提一次：
	// AI 消费方按字段判断比读自然语言可靠），hint 给出"应用自己怎么判"的落点。
	access := string(appcfg.AccessOfConfigJSON(app.ConfigJSON))
	if access == string(appcfg.AccessWhitelist) {
		hints = append(hints, "access=whitelist 只描述作者自判的名单：平台不比对白名单（R24），"+
			"任何登录用户都能打开本应用；需要真正限制时请应用前端读取随包 zeokeel.app.json 的 whitelist "+
			"自行判定，并对名单外用户给出明确的拒绝页（平台不会替应用做这一步）")
	}
	return gin.H{
		"app_id":              appID,
		"app_enabled":         app.Enabled,
		"app_frozen":          app.FrozenAt != nil,
		"app_deleted":         app.DeletedAt != nil,
		"access":              access,
		"whitelist_enforced":  false,
		"since":               summary.Since,
		"window_minutes":      int(window.Minutes()),
		"retention_days":      limits.CallEventRetentionDays,
		"events_dropped":      dropped,
		"events_flush_failed": flushFailed,
		"events_available":    eventsAvailable,
		"summary":             summary,
		"failures":            failures,
		"hints":               dedupeStrings(hints),
		// 本应用**生效**的并发四轴 + 来源（override/global）。作者/AI 不需要再猜
		// "我是被全局限的还是被单独降额了"（生产化评审：可解释性）。
		"limits": gin.H{
			"app_running":          axes.AppRunning,
			"app_queue":            axes.AppQueue,
			"user_per_app_running": axes.UserPerAppRunning,
			"user_per_app_queued":  axes.UserPerAppQueued,
			"source":               map[bool]string{true: "override", false: "global"}[hasOverride],
		},
	}, nil
}

// effectiveQueueAxes 返回某应用运行期生效的并发四轴与"是否有显式覆盖"。
//
// 优先级：Options.AppLimitsEffective（生产装配注入 queue.Scheduler.EffectiveOptions）
// ⇒ 回落全局 Limits（最小装配/单测；来源恒为 global，绝不冒充 override）。
func (h *Handlers) effectiveQueueAxes(appID string) (limits.Axes, bool) {
	if h.opt.AppLimitsEffective != nil {
		axes, hasOverride := h.opt.AppLimitsEffective(appID)
		return axes, hasOverride
	}
	lim := h.budgets()
	return limits.Axes{
		AppRunning:        lim.AppRunning,
		AppQueue:          lim.AppQueue,
		UserPerAppRunning: lim.UserPerAppRunning,
		UserPerAppQueued:  lim.UserPerAppQueued,
	}, false
}

// effectiveMemoryPages 返回诊断面要用的单实例内存页数（R2-DG-2）。
//
// 来源优先级（**必须按这个顺序**）：
//  1. `Options.EffectiveMemoryPages`（运行时真正生效的值，装配注入 appserver.InstanceMemoryPages）；
//  2. `instanceMemoryPages()`（= `Options.Limits().InstanceMemoryPages()`，**已保存值**）。
//
// 为什么第 2 条只是兜底而不是主路径：单实例内存上限住在 wazero 的 RuntimeConfig 里，
// 控制台保存之后**要重启才生效** —— 在那个窗口里已保存值与生效值可以差出几十上百 MiB
// （审计实测：保存 32 MiB 未重启、实际按 128 MiB 跑），而诊断 hints 说的必须是"这次
// 运行的上限"，否则第一消费者（AI/作者）会按错的数字优化。
//
// 回落到第 2 条只在装配没接线时发生（测试/最小装配），语义与 R1-rt-25 之前一致。
func (h *Handlers) effectiveMemoryPages() uint32 {
	if h.opt.EffectiveMemoryPages != nil {
		if pages := h.opt.EffectiveMemoryPages(); pages != 0 {
			return pages
		}
	}
	return h.instanceMemoryPages()
}

// EffectiveMemoryPages 返回诊断面当前会使用的单实例内存页数（**装配自检/装配级判据用**）。
//
// 存在的理由与 appserver.CachedModuleCount 同类：装配点漏传 `Options.EffectiveMemoryPages`
// 时的失败形态是静默的（诊断悄悄退回"已保存值"），没有可观测出口就只能断言源码字符串
// （而字符串断言分不清"接上了但值是错的"）。生产装配的大小写判据在
// cmd/server 的 TestDiagnosticsMemoryHintUsesRuntimePagesAtAssembly。
func (h *Handlers) EffectiveMemoryPages() uint32 {
	return h.effectiveMemoryPages()
}

// windowFromQuery 解析诊断窗口（分钟）。缺省 24 h，上限 = 调用事件保留期
// （超过保留期的查询只会返回空，不如直接告诉调用方上限在哪）。
func windowFromQuery(raw string) time.Duration {
	const defMinutes = 24 * 60
	maxMinutes := limits.CallEventRetentionDays * 24 * 60
	m := atoiDefault(raw, defMinutes)
	if m <= 0 {
		m = defMinutes
	}
	if m > maxMinutes {
		m = maxMinutes
	}
	return time.Duration(m) * time.Minute
}

// atoiDefault 解析十进制整数，失败取缺省（查询参数不合法不该变成 500）。
func atoiDefault(raw string, def int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

// dedupeStrings 保序去重（空串丢弃）。
func dedupeStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// ---------------------------------------------------------------------------
// 自省：GET .../wasm/:app_id/schema
// ---------------------------------------------------------------------------

// schemaTable 是一张表的自省结果。
type schemaTable struct {
	Name    string      `json:"name"`
	Rows    int64       `json:"rows"`
	Columns []schemaCol `json:"columns"`
	Skipped bool        `json:"skipped,omitempty"`
	Reason  string      `json:"skip_reason,omitempty"`
}

// schemaCol 是一列的结构。
type schemaCol struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	NotNull bool   `json:"not_null"`
	PK      bool   `json:"pk"`
}

func (h *Handlers) schema(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	// §8：自省"仅发布者 + 审计" —— 每次**成功**调用留痕（自省面会暴露应用的数据规模）。
	//
	// 审计必须写在**读成功之后**（2026-09-21 独立审计 P3-⑧）：三个自省面
	//（`schema` / `adminSchema` / `rows`）此前不一致 —— `rows` 读成功才写，两个
	// schema 在读之前就写。后果不是安全问题而是**审计语义被污染**：库损坏、连接失败、
	// 应用不存在时也会留下一条"查看了表结构"，事后对账会看到根本没发生的读取。
	// 统一为"读成功才记账"：审计行 = 真的发生过一次成功读取。
	report, serr := h.inspectAppDB(c.Request.Context(), appID)
	if serr != nil {
		writeErr(c, serr)
		return
	}
	h.auditApp(appID, u.Username, "wasm_app_schema_view",
		auditDetail(appID, auditTitleOf(app), "查看表结构与占用"))
	c.JSON(http.StatusOK, gin.H{"schema": report})
}

// inspectAppDB 只读打开应用库并自省（表 / 列 / 行数 / 占用）。
//
// 为什么在 api 层直连 SQLite（而不是复用 appdb 的加固连接）：`appdb` 的连接面向
// **应用请求**（query_only/rw 两条 + 语句白名单），它明确拒绝 `sqlite_` 前缀的引擎
// 内部对象（sqlgate.go 的 internal_object），而自省正是要读 sqlite_master。
// 这里的连接是"平台读自己的文件"：只读（mode=ro + query_only）、不执行任何**应用
// 提供的** SQL、表名先过平台规则再进语句，风险面与 appdb 的只读连接同级。
// 库路径仍由 appdb 权威给出（不在本包复制"<data_root>/apps/<app_id>/app.db"的布局）。
func (h *Handlers) inspectAppDB(ctx context.Context, appID string) (gin.H, *apperr.Error) {
	db, path, size, exists, oerr := h.appDBReadOnly(ctx, appID)
	if oerr != nil {
		return nil, oerr
	}
	// 库还不存在：**返回空结构而不是建库**（"这个应用还没写过任何数据"是状态，
	// 不是错误；但也不能让一次读取把库建出来 —— 那会让"没被用过"这个事实消失）。
	if !exists {
		return gin.H{
			"app_id":           appID,
			"db":               logicalUnderDataRoot(h.opt.DataRoot, path),
			"size_bytes":       int64(0),
			"max_bytes":        int64(limits.AppDBMaxBytes),
			"max_tables":       limits.MaxTablesPerApp,
			"max_columns":      limits.MaxColumnsPerTable,
			"column_types":     limits.SQLColumnTypes,
			"reserved_columns": []string{limits.ReservedRowIDColumn},
			"tables":           []schemaTable{},
			"table_count":      0,
			"usage_percent":    float64(0),
			"initialized":      false,
			"page_size":        int64(0),
			"page_count":       int64(0),
		}, nil
	}
	defer db.Close()

	report := gin.H{
		"app_id":           appID,
		"db":               logicalUnderDataRoot(h.opt.DataRoot, path),
		"size_bytes":       size,
		"max_bytes":        int64(limits.AppDBMaxBytes),
		"max_tables":       limits.MaxTablesPerApp,
		"max_columns":      limits.MaxColumnsPerTable,
		"column_types":     limits.SQLColumnTypes,
		"reserved_columns": []string{limits.ReservedRowIDColumn},
		"tables":           []schemaTable{},
		"table_count":      0,
		"usage_percent":    float64(0),
	}
	report["initialized"] = size > 0
	report["page_size"] = pragmaInt(ctx, db, "page_size")
	report["page_count"] = pragmaInt(ctx, db, "page_count")
	report["usage_percent"] = usagePercent(size, int64(limits.AppDBMaxBytes))

	tables, terr := listAppTables(ctx, db)
	if terr != nil {
		return nil, internalErr("读取表清单失败", terr)
	}
	report["tables"] = tables
	report["table_count"] = len(tables)
	return report, nil
}

// appDBReadOnly 以**只读**方式打开应用库：库文件不存在时返回 `exists=false`，
// **不建目录、不建库**（只读端点不得有写副作用）。
//
// 为什么不用 `appdb.Open`（2026-09-21 独立审计 P2-1）：`Open` 会 MkdirAll 并以 rwc
// 打开 ⇒ "读一次就把库建出来"。此前只有 `/rows` 靠调用方自己的 `os.Stat` 挡住了，
// 而同一个 helper 服务的 `/schema` 实测有写副作用 —— 两个兄弟端点语义不一致，
// 未来复用者会静默继承。现在路径解析走 `appdb.SafePath`（纯解析 + 符号链接拒绝），
// 连接用 `mode=ro`，写副作用在结构上不可能。
//
// 调用方负责 Close（只读连接）。
func (h *Handlers) appDBReadOnly(ctx context.Context, appID string) (db *sql.DB, path string, size int64, exists bool, oerr *apperr.Error) {
	path, exists, oerr = appdb.SafePath(h.opt.DataRoot, appID)
	if oerr != nil {
		return nil, "", 0, false, oerr
	}
	if !exists {
		return nil, path, 0, false, nil
	}
	dsn := "file:" + path + "?mode=ro&_pragma=query_only(1)"
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, "", 0, false, internalErr("应用库只读打开失败", err)
	}
	if err := conn.PingContext(ctx); err != nil {
		_ = conn.Close()
		return nil, "", 0, false, internalErr("应用库只读连接失败", err)
	}
	return conn, path, fileSize(path), true, nil
}

// listAppTables 列出库里**平台看得懂**的表（表名 / 列结构 / 行数）。
//
// 表名先过平台自己的规则：sqlite_master 的内容是**应用可控**的（正常由 db.define 建，
// 但文件可能被篡改），拼进 SQL 前必须校验；不合规的表被标成 skipped 而不是让整个
// 自省失败 —— 一条脏表名不该让作者看不到其余的表。
func listAppTables(ctx context.Context, db *sql.DB) ([]schemaTable, error) {
	names, err := appTableNames(ctx, db)
	if err != nil {
		return nil, err
	}
	tables := make([]schemaTable, 0, len(names))
	for _, name := range names {
		t := schemaTable{Name: name}
		if !validateTableName(name) {
			t.Skipped, t.Reason = true, "表名不符合平台规则（不是 db.define 建的）"
			tables = append(tables, t)
			continue
		}
		cols, cerr := tableColumns(ctx, db, name)
		if cerr != nil {
			return nil, cerr
		}
		t.Columns = cols
		if n, cerr := tableRowCount(ctx, db, name); cerr == nil {
			t.Rows = n
		}
		tables = append(tables, t)
	}
	return tables, nil
}

// logicalUnderDataRoot 把宿主绝对路径渲染成"数据根之下的相对路径"（对外只暴露
// 逻辑位置，不暴露服务器的目录布局）。不在数据根之下时返回空串。
func logicalUnderDataRoot(dataRoot, path string) string {
	root := strings.TrimSuffix(filepath.Clean(dataRoot), string(os.PathSeparator))
	clean := filepath.Clean(path)
	if root == "" || !strings.HasPrefix(clean, root+string(os.PathSeparator)) {
		return ""
	}
	return filepath.ToSlash(strings.TrimPrefix(clean, root+string(os.PathSeparator)))
}

// fileSize 返回库的**磁盘占用**字节数：主库 + WAL（不可读时按 0 计）。
//
// 为什么要算上 `-wal`（2026-09-19，库切到 WAL 之后）：WAL 下已提交的数据可能还躺在
// `app.db-wal` 里（未检查点），只 stat 主库会系统性低估用量 —— 自省面报的
// size_bytes / usage_percent 是给管理员看"这个应用占了多少"的，低估会把
// "快到 100 MB 了"显示成"还很小"。主库的 page_count 口径本来就把 WAL 里的逻辑页
// 算进去，两边因此一致。
//
// 不可读时返回 0：自省面不回错误码，占用为 0 已经足够表达"这个库还没有内容"。
func fileSize(path string) int64 {
	var total int64
	for _, p := range []string{path, path + "-wal"} {
		if st, err := os.Stat(p); err == nil {
			total += st.Size()
		}
	}
	return total
}

func usagePercent(used, max int64) float64 {
	if max <= 0 {
		return 0
	}
	return float64(used) * 100 / float64(max)
}

// validateTableName 复用 limits 的规则（唯一真源是 limits.TableNamePattern /
// ColumnNamePattern = `^[a-z][a-z0-9_]{0,30}$`），手写一遍是为了避免为一次自省
// 引入正则编译；两条规则当前逐字相同，测试（read_test.go）对拍它们的一致性。
func validateTableName(name string) bool {
	if name == "" || len(name) > 31 {
		return false
	}
	if name[0] < 'a' || name[0] > 'z' {
		return false
	}
	for _, r := range name[1:] {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			continue
		}
		return false
	}
	return true
}

func appTableNames(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func tableColumns(ctx context.Context, db *sql.DB, table string) ([]schemaCol, error) {
	// PRAGMA 不能用占位符；表名来自 sqlite_master 且已过 validateTableName
	//（只含 [a-z0-9_]）⇒ 没有注入面。
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+quoteIdent(table)+`)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []schemaCol{}
	for rows.Next() {
		var cid int
		var name, declType string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &declType, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		out = append(out, schemaCol{Name: name, Type: declType, NotNull: notNull == 1, PK: pk > 0})
	}
	return out, rows.Err()
}

func tableRowCount(ctx context.Context, db *sql.DB, table string) (int64, error) {
	var n int64
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+quoteIdent(table)).Scan(&n)
	return n, err
}

// quoteIdent 用双引号包裹标识符（内部的双引号翻倍）。表名在此前已过
// validateTableName，这一步是纵深防御而不是唯一防线。
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func pragmaInt(ctx context.Context, db *sql.DB, name string) int64 {
	var v int64
	if err := db.QueryRowContext(ctx, `PRAGMA `+name).Scan(&v); err != nil {
		return 0
	}
	return v
}

// ---------------------------------------------------------------------------
// 应用中心目录：GET /apps/wasm/catalog
// ---------------------------------------------------------------------------

// availability 回答**一个**问题："我现在能用这个 app_id 吗？"
//
// 发布表单在用户敲字时异步问它（防抖），提交前再问一次 —— 目的是让"这个名字被
// 占了"在**填表阶段**就可见，而不是让用户传完一整个 32 MiB 的包才在最后一步拿到
// 409。它只读：不编译、不写盘、不占版本号、不进审计、不消耗上传额度。
//
// # 为什么必须是一条独立端点（不能让表单去读 catalog）
//
// 目录**故意**不列冻结应用，也不列"占名但从未发布成功"的行 —— 而这两类都实打实
// 占着标识（R6/§4.1："发布即占名…被拒/软删也不释放"）。拿目录当唯一性判据会给出
// **反向**结论（"这个标识没人用"），把问题推到提交那一刻才爆发。
//
// # 判据与发布**同源**
//
// 存在性走 `serverstore.GetWasmApp`（**不过滤 deleted_at**：软删不释放标识），
// 归属走 `h.checkOwner` —— 与 `publishFromBytes` 用的是同两个原语。因此本端点的
// 结论与真正提交时的 409 必然同码（NAME_TAKEN）、同文案、同 hints，客户端不必为
// 两条链路维护两套提示。
//
// # 两条刻意的形态选择
//
//  1. **非法是判词，不是错误**：`valid=false` 走 200 而不是 400。客户端因此只有
//     一条解析路径，不必为"查重本身失败了"再写一套错误处理；而 `available` 在
//     非法时恒为 false —— fail-closed，非法名字绝不能报"可用"，否则表单会放行
//     一次注定失败的发布。
//  2. **不归一化输入**：用户敲的是 `My-Tool`，答案必须是"必须全小写"，而不是把它
//     偷偷小写之后说"这个名字可用"（见 validateRawAppID）。
//
// # 不泄露
//
// 只回"被占用了"，不回是谁占的、叫什么、什么状态 —— 与 docs/07 的 NAME_TAKEN
// 口径一致。存在性本身不是新增泄露：发布路径的 409 与目录都已经披露它。
func (h *Handlers) availability(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	// 查重是**员工面**：未登录不得回答，否则它就是一个免费的"标识是否被占用"探测器。
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	raw := strings.TrimSpace(c.Param("app_id"))
	appID, verr := h.validateRawAppID(raw)
	if verr != nil {
		c.JSON(http.StatusOK, gin.H{
			"app_id":       raw,
			"valid":        false,
			"exists":       false,
			"available":    false,
			"owned_by_you": false,
			"can_publish":  false,
			"reason":       "invalid",
			"code":         string(verr.Code),
			"message":      verr.Message,
			"hints":        verr.Hints,
		})
		return
	}
	app, err := serverstore.GetWasmApp(c.Request.Context(), h.opt.DB, appID)
	if err != nil && !errors.Is(err, serverstore.ErrNotFound) {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	out := gin.H{
		"app_id":       appID,
		"valid":        true,
		"exists":       app != nil,
		"available":    app == nil,
		"owned_by_you": app != nil && app.Owner == u.Username,
		"can_publish":  false,
		"reason":       "available",
		"code":         "",
		"message":      "",
		"hints":        []string{},
	}
	if app == nil {
		// 空闲标识：可以发首版。
		out["can_publish"] = true
		c.JSON(http.StatusOK, out)
		return
	}
	if oerr := h.checkOwner(u, appID, app); oerr != nil {
		// 与 publish 的 409 同一份文案与 hints（见 checkOwner 的注释）。
		out["reason"] = "taken"
		out["code"] = string(oerr.Code)
		out["message"] = oerr.Message
		out["hints"] = oerr.Hints
		c.JSON(http.StatusOK, out)
		return
	}
	// 终态闸门（冻结 / 退役）必须在"归属放行"之后、报"可以发"之前判（R3-A A-4）：
	// 判据与 publish **同一处**（publishBlockOf），code/message/hints 因此逐字相同，
	// 客户端只需要一套渲染分支。放在 checkOwner 之后是有意的 —— 归属是更外层的
	// 事实（"这不是你的应用"），只有归属放行的人才需要知道"你的应用处于哪个终态"。
	if blocked := publishBlockOf(app); blocked != nil {
		out["reason"] = blocked.Reason
		out["code"] = string(blocked.Err.Code)
		out["message"] = blocked.Err.Message
		out["hints"] = blocked.Err.Hints
		c.JSON(http.StatusOK, out)
		return
	}
	// checkOwner 放行 = "你可以对这个标识发布"：发布者本人，或管理员的兜底接管。
	// 注意它与 owned_by_you 不同物 —— 后者是**严格归属**（admin 接管时仍为 false），
	// 而表单要判的是"能不能发"，所以 reason 取宽松的那一个。
	out["reason"] = "yours"
	out["can_publish"] = true
	c.JSON(http.StatusOK, out)
}

// catalog 是应用中心目录（GET /apps/wasm/catalog）。
func (h *Handlers) catalog(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	// 目录是**登录后**的可见面（§8：客户端员工面）。不做匿名目录。
	viewer, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	// 目录**不过滤访问级别**（2026-09-18 用户拍板，R38 作废）：无论 public / login /
	// whitelist，也无论是否下架，都列出来 —— 使用者需要看见"有哪些应用"，
	// 能不能用由条目上的 access 与 enabled 提示、由应用自己判（R24）。
	apps, err := serverstore.ListWasmApps(c.Request.Context(), h.opt.DB, serverstore.WasmAppFilter{})
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	// 当前版本号（P1-4）：apps 行上只有 current_release_id，批量取一次 —— 与**管理面
	// 同一份**实现（admin.go 的 WasmAppCurrentVersions），因为它就是同一个问题的答案。
	//
	// 为什么目录必须下发它：`wasm_app_list` 的工具描述要求模型"发布前先确认当前版本，
	// 新版本号必须严格大于它"，而目录行原先**没有版本字段** ⇒ 模型只能猜；猜错的代价
	// 是一次完整上传（≤32 MiB）+ 审计拒绝 + 消耗上传额度。
	//
	// 取不到不算错 —— 版本行可能已被保留策略回收，那一行显示空串（客户端按"未知"渲染）。
	ids := make([]int64, 0, len(apps))
	for _, a := range apps {
		if a.CurrentReleaseID > 0 {
			ids = append(ids, a.CurrentReleaseID)
		}
	}
	versions, verr := serverstore.WasmAppCurrentVersions(c.Request.Context(), h.opt.DB, ids)
	if verr != nil {
		writeErr(c, internalErr("查询版本失败", verr))
		return
	}
	out := make([]gin.H, 0, len(apps))
	for _, a := range apps {
		// 目录条件（R34 + §8 + R6-B-3，收敛后**只剩三条**）：
		//   未删除（DAO 已保证）· 有生效版本（占名但从未发布成功的行不列）· 未冻结。
		//   - **下架（enabled=false）仍列出**：下架是**可逆的发布者动作**，应用与它的
		//     数据都还在（应用子域返回 410 Gone + "应用已下架，数据仍然保留，恢复后
		//     链接不变"，见 appserver/respond.go 的 writeGone）—— 直接隐去会让使用者
		//     以为应用被删了，还会让人以为标识空出来了（标识一经发布不能改名）。
		//     条目里给出 enabled，由 UI 标"已下架"并禁用打开按钮。
		//     ⚠️ 勘误（2026-09-18 独立审计）：此前这里写"子域照旧可访问"是**错的**
		//     —— serve.go 对 enabled=false 返回 410。列出它的理由是可逆与"仍在"，
		//     不是"还能用"。
		//   - **冻结仍不对其他人列**：冻结 = 停止服务（appserver 对 frozen 一律 404，
		//     R37），列给使用者只会给出一个死链接。
		//   - **冻结行对归属人本人列出**（2026-09-23 R6-B-3）：冻结是**可逆**动作，
		//     而解冻入口（`POST …/:app_id/freeze {"frozen":false}`）只有归属人/管理员
		//     能调 —— 对归属人也隐去，就等于"解冻这条路在员工产品里没有依附面"：
		//     面板每次重挂载/重启都会重新拉目录（唯一数据源），行一消失，界面上就没有
		//     任何东西可点，而文案仍在承诺"发布者本人在应用中心里就能解冻"。
		//     行里带 `frozen:true`（客户端据此标「已冻结」、禁用打开、给出解冻动作），
		//     其他人**看不到这一行**（与"不存在"同形，不泄露存在性）。
		//     归属判据用**严格归属**（a.Owner == 调用者），不含超管兜底：管理员面在
		//     webadmin（`?filter=frozen` + 管理端点），员工面不为他们扩面。
		ownedByViewer := a.Owner != "" && a.Owner == viewer.Username
		// 首版待审 / 被拒 / 已撤回（U-02，评审 2026-10-23 P1）。
		//
		// 现场：审核开关打开后作者发布的**第一个**版本落在 pending（publish.go 的
		// `review ⇒ status=pending`），而"生效"只发生在 approved 分支
		// （commitRelease 里 `in.status == ReleaseStatusApproved` 才部署）⇒ 首版待审
		// 期间 `apps.current_release_id` 恒为 0。本函数的目录条件（"有生效版本"）
		// 于是把这个应用**整行**跳过 —— 连归属人自己也看不到：作者无法确认审核状态、
		// 看不到被拒理由、点不到「撤回」（撤回入口挂在目录行的版本历史里），而同一时刻
		// 发布成功块还在承诺"线上仍是旧版本"并给出分享深链（同事点开得到"应用不存在"）。
		//
		// 定案（与"冻结行对归属人列出"同一条纪律，R6-B-3）：
		//   · **归属人**看得到自己"占着标识但还没有任何生效版本"的行，行里带
		//     `first_release:true` + `first_release_status`（pending/rejected/withdrawn）
		//     + `first_release_version`（撤回要按它发请求）+ rejected 行的
		//     `first_release_reason`（`app_releases.reason` 的读路径之一，R1-pm-3 的
		//     "被拒必须能看到理由"在这里也不能断）；
		//   · **其他人看不到这一行** —— 与"不存在"同形，不泄露存在性（R38/§8）；
		//   · 行的 `enabled` 下发 **false**：这个应用**打不开**（没有可交付版本），
		//     而 `enabled` 是"能不能用"的对外口径（客户端据此禁用打开、宿主工具面据此
		//     判断可用性）。真实上架状态由 `first_release` 回答，客户端据此渲染
		//     「待审/被拒（尚未上线）」而**不是**「已下架」；
		//   · 标题/说明/访问级别/负责人取**那一版自己的**内容（`app_releases` 的
		//     title/description/config_json）：发布路径对"待审"刻意不写投影列
		//     （publish.go 的 E1 注释），而作者在被拒后重填一整个表单是不必要的惩罚。
		//     未审核内容只随这一行下发给归属人本人，不会外泄给其他员工。
		var firstRelease *serverstore.WasmRelease
		if a.CurrentReleaseID <= 0 {
			if !ownedByViewer {
				continue
			}
			firstRelease, err = h.firstReleaseOf(c.Request.Context(), a.AppID)
			if err != nil {
				writeErr(c, internalErr("查询版本失败", err))
				return
			}
			if firstRelease == nil {
				// 占名但从未发布成功（没有版本行）/ 审核已通过但部署事务失败（瞬时异常，
				// 重试可自愈）：都不列 —— 见 firstReleaseOf 的注释。
				continue
			}
		}
		if a.FrozenAt != nil && !ownedByViewer {
			continue
		}
		// 负责人 = zeokeel.app.json 的 owner（§4.2 的"负责人"声明）；平台归属
		// （apps.owner）只是兜底 —— 两者同名不同物，不做互相推导（appcfg 包注释）。
		//
		// 首版行读**那一版**的配置（见上面的定案）：待审版本自己的 access/purpose/
		// whitelist/window 才是作者下一次发布要沿用的基线。
		cfgJSON := a.ConfigJSON
		if firstRelease != nil {
			cfgJSON = firstRelease.ConfigJSON
		}
		var cfg appcfg.Config
		if cfgJSON != "" {
			_ = json.Unmarshal([]byte(cfgJSON), &cfg)
		}
		responsible := strings.TrimSpace(cfg.Owner)
		if responsible == "" {
			responsible = a.Owner
		}
		isOwner := a.Owner == viewer.Username || isSuperAdmin(viewer)
		// 首版行列的显示面取那一版自己的值（理由见上面 firstRelease 的定案）。
		rowTitle, rowDescription := a.Title, a.Description
		enabled := a.Enabled
		if firstRelease != nil {
			if t := strings.TrimSpace(firstRelease.Title); t != "" {
				rowTitle = t
			}
			rowDescription = firstRelease.Description
			// 没有任何可交付版本 ⇒ 打不开。`enabled` 是"能不能用"的唯一对外口径
			// （客户端用它禁用打开、宿主工具面用它判断可用性）。
			enabled = false
		}
		row := gin.H{
			"app_id":      a.AppID,
			"title":       rowTitle,
			"description": rowDescription,
			"responsible": responsible,
			"owner":       a.Owner,
			// access 让应用中心能标出访问级别（public/login/whitelist）；
			// 它从 config_json 现解（旧 schema 由 appcfg 的兼容 shim 映射，
			// 解析失败回落 login —— 见 appcfg.AccessOfConfigJSON）。
			"access": string(appcfg.AccessOfConfigJSON(cfgJSON)),
			// enabled=false = 已下架：**不能**从 URL 直达（appserver 返回 410 Gone，
			// 见 writeGone），但它仍列在目录里（理由见上面的目录条件）。
			"enabled": enabled,
			// frozen=true = 已冻结（R6-B-3）：冻结**顺带下架**（release.go 的 freeze
			// 先置 frozen_at 再 enabled=0），所以只看 enabled 会把冻结显示成"已下架"
			// —— 两者的处置完全不同（下架可自己重新上架；冻结要先解冻，而解冻入口
			// 只对归属人开）。字段只在归属人自己的行上可能为 true（其他人的冻结行
			// 不进目录），客户端据此标「已冻结」、禁用打开、给出解冻动作。
			"frozen":     a.FrozenAt != nil,
			"updated_at": a.UpdatedAt,
			// 当前线上版本（可能为空串：版本行被保留策略回收）。
			"current_version": versions[a.CurrentReleaseID],
			// 调用者是不是发布者：客户端据此给出"发新版"入口（非发布者发布必然 404）。
			"is_owner": isOwner,
		}
		// 首版行（只可能是归属人自己的行，见上面 firstRelease 的定案）：把"为什么
		// 打不开"与"下一步能做什么"一并给出 —— 状态（pending/rejected/withdrawn）、
		// 版本号（撤回请求的路径参数）与被拒理由。
		//
		// 为什么用扁平的 `first_release_*` 而不是嵌套对象：目录行本来就是扁平契约
		// （客户端 `parseCatalogReport` 逐字段读、未知字段忽略），嵌套会让"哪一行是
		// 首版行"多一层形状判断。
		if firstRelease != nil {
			row["first_release"] = true
			row["first_release_status"] = firstRelease.Status
			row["first_release_version"] = firstRelease.Version
			if firstRelease.Status == serverstore.ReleaseStatusRejected {
				// 被拒理由：数据库保证 approved/pending 行的 reason 恒为空串，
				// 所以只在 rejected 行上下发（客户端据此渲染"理由 + 重发出路"）。
				row["first_release_reason"] = firstRelease.Reason
			}
		}
		// 窗口的默认尺寸与**强制宽高比**（§6 的 `window.*` 三个字段，R1-L3-9）：
		// F3 的"强制锁比例"要用它建窗，而目录是客户端在打开前唯一能读到应用配置的地方
		// （`open` 只回版本/标题/计数，不回配置）。缺席（作者没写）⇒ 整个键不出现，
		// 客户端按自己的缺省（1280×720 且不锁比例）处理 —— 与 §6 的"缺省 1280×720"一致。
		//
		// 归一化后的值（ratio 折算成浮点、尺寸按 ratio 校正）由 appcfg 一处算清：
		// 让客户端再算一遍 = 两套窗口尺寸口径（比例四舍五入的差异会让"锁定的比例"
		// 与作者写的对不上）。
		if cfg.Window != nil {
			width, height := cfg.ResolvedWindow()
			window := gin.H{"width": width, "height": height}
			if cfg.Window.Ratio > 0 {
				window["ratio"] = cfg.Window.Ratio
			}
			row["window"] = window
		}
		// ⚠️ `entry_url` 已随 W4 从两侧删除（总纲 §8.4 / §5.2 冻结契约）：服务端不再下发
		// 任何入口链接，客户端用 `<渠道 app scheme>://<app_id>` 自行构造打开地址。
		// 发布者本人额外拿到 purpose / whitelist：**发布表单的预填基线**（P1-3）。
		//
		// 为什么限定发布者本人：whitelist 是账号名单、purpose 是内部用途声明，而目录对
		// 全体员工可见（R38）—— 无条件下发等于把每个应用的准入名单摊开。发布新版只能由
		// 发布者本人做（ownedApp 对非发布者一律 404），所以"作者的发布表单要能预填"与
		// "名单不外泄"同时成立的唯一形态就是按调用者下发。
		//
		// 为什么必须有这两个字段：目录行是发布表单的预填基线。服务端在更新发布时
		// **会对缺席字段沿用上一版**（publish.go 的 prepare → appcfg.ParseUpdate），
		// 但作者仍要看得见"现在生效的是什么"才能有意识地改它（预填 + access 变更
		// 二次确认是人工表单那条路径的护栏）。whitelist 模式的应用若拿不到原名单，
		// 作者只能凭空重填，而 access=whitelist + 空名单会被服务端一律拒（appcfg.Validate）。
		if isOwner {
			row["purpose"] = cfg.Purpose
			whitelist := cfg.Whitelist
			if whitelist == nil {
				whitelist = []string{}
			}
			row["whitelist"] = whitelist
			// data_sensitivity：作者「发新版」时要**显示并沿用**上一次的声明
			// （C 泳道 F-02/F-03 的前端依赖；此前目录行只下发 purpose/whitelist，
			// 表单的数据敏感度只能凭空重填）。
			//
			// 真源是**生效版本的 config_json**（cfg 从 apps.config_json 现解，而那一列
			// 是生效版本的投影）；投影为空时回落到发布时随包声明的同名声明。
			// 与 purpose/whitelist 同一条纪律：**只对发布者本人下发** —— 数据敏感度
			// 是内部合规声明，目录对全体员工可见（R38），无条件下发等于把它摊开。
			sensitivity := strings.TrimSpace(cfg.DataSensitivity)
			if sensitivity == "" {
				sensitivity = strings.TrimSpace(a.DataSensitivity)
			}
			row["data_sensitivity"] = sensitivity
			// responsible 已在上方按"负责人声明优先、平台归属兜底"算好并**对所有行**
			// 下发（它是门面信息）；这里不再重复。
		}
		// R36：目录**不**显示额度/用量 —— 这里刻意不返回任何用量字段。
		out = append(out, row)
	}
	c.JSON(http.StatusOK, gin.H{"apps": out})
}

// firstReleaseOf 返回"还没有生效版本"的归属人行所需的**最近一次**版本。
//
// 只取最近一版（`ListWasmReleases` 按 `(created_at, id)` 升序，取末元素）：全部
// 版本的读面仍然是 `GET …/:app_id/releases`（R1-pm-3）；目录行只需要回答"这一行
// 现在处于哪个状态、撤回该用哪个版本号"。
//
// 返回 nil 的两种情形（目录都不列这一行，与既有口径一致）：
//   - **一个版本行都没有**：占名但从未发布成功（发布失败不落行）；
//   - **最近一版是 approved 却没有生效指针**：这是"审核通过但部署事务失败"的
//     瞬时异常（admin.go 的 approve 路径重试会自愈，见 admin_review_repair_test）。
//     把一版"已通过却打不开"的行摆给作者，只会让作者以为审核结果丢了。
//
// 其余状态（pending / rejected / withdrawn）都要列：那正是作者**唯一**能看到"我的
// 首版卡在哪、被什么理由拒了、要不要撤回重发"的地方（U-02）。
func (h *Handlers) firstReleaseOf(ctx context.Context, appID string) (*serverstore.WasmRelease, error) {
	releases, err := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, false)
	if err != nil {
		return nil, err
	}
	if len(releases) == 0 {
		return nil, nil
	}
	latest := releases[len(releases)-1]
	if latest.Status == serverstore.ReleaseStatusApproved {
		return nil, nil
	}
	return &latest, nil
}

// ---------------------------------------------------------------------------
// 我的版本：GET /apps/wasm/:app_id/releases（R1-pm-3）
// ---------------------------------------------------------------------------

// myReleases 让**发布者本人**读到自己应用的版本历史与审核结论（含被拒理由）。
//
// 为什么必须有这条出口（R1-pm-3 / R1-uxw-4）：开启审核（`wasm.review_required`）之后
// 发布者的全部反馈只有发布那一刻的"待审核（线上仍是旧版本）"一句话 ——
// `app_releases.reason` 被管理员写进库、却**没有任何读路径**（DTO 无字段、员工面无
// 端点），而版本号一经提交就**永久占位**（§4.1，被拒也不释放）。结果是：作者收不到
// 结论、拿不到理由、只能盲升版本号重发；"审核"在作者侧退化成掷骰子。
//
// 鉴权沿用 ownedApp（与 publish/unpublish/freeze/export/diagnostics 同一份判定）：
// **非发布者一律 404「应用不存在」**，且与"应用真的不存在"逐字节同形（`notFoundApp`
// 对两种情况给出同一个 details/hints）—— 不泄露应用是否存在（R38/§8 的既有纪律）。
// 平台管理员（super_admin）照旧放行，与其余管理动作同口径。**allowDeleted=false**：
// 退役（软删）应用的只读面与 export/diagnostics 一致 —— 保留期内作者仍要能回看
// 「当初为什么被拒」（R1-pm-3 的承诺不能在删除那一刻断掉）。退役**只清制品字节**，
// 不把 release 行标成已删（见 serverstore.SoftDeleteWasmApp），所以缺省的
// `deleted_at IS NULL` 读面照样看得见它们；显式传 true 会把作者自己删掉的版本
// （SoftDeleteWasmRelease / GC）也一并列出来，那不是这个端点的语义。
//
// 返回每版 version / status / reason / created_at / current / checksum / size，
// **不含制品字节**（ListWasmReleases 走清单投影，archive 从不进内存）。
//
// 不写审计：与 adminReleases 同口径 —— 这是"读自己的版本清单"，发布者每次打开面板
// 都会调一次，逐次落审计只会把审计链淹掉；状态变更（发布/审批/上下架）仍然条条留痕。
func (h *Handlers) myReleases(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, _, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	ctx := c.Request.Context()
	releases, err := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, false)
	if err != nil {
		writeErr(c, internalErr("查询版本失败", err))
		return
	}
	// 当前生效版本号：apps 行上只有 current_release_id，翻译成版本号给作者看
	// （与目录行的 current_version 同一实现，避免两处口径分叉）。
	current := ""
	if app.CurrentReleaseID > 0 {
		if versions, verr := serverstore.WasmAppCurrentVersions(ctx, h.opt.DB, []int64{app.CurrentReleaseID}); verr == nil {
			current = versions[app.CurrentReleaseID]
		}
	}
	rows := make([]gin.H, 0, len(releases))
	for _, r := range releases {
		rows = append(rows, gin.H{
			"version": r.Version,
			"status":  r.Status,
			// 被拒理由：pending/approved 行恒为空串（数据库侧保证），界面据此只在
			// rejected 行上渲染它。
			"reason":     r.Reason,
			"created_at": r.CreatedAt,
			"current":    r.Version == current && current != "",
			"checksum":   r.Checksum,
			"size":       r.Size,
			// bytes_released（2026-10-22 终轮反证）：制品字节已释放（审核拒绝/作者撤回/
			// 退役/GC）时 `archive=NULL, size=0`。前端此前只能靠 `size<=0` 推断，而
			// `size` 缺失与"真的 0 字节"不可区分；给出显式事实字段，部署选择器据此
			// 排除不可部署的 approved 版本（服务端仍会 409 RELEASE_BYTES_RELEASED）。
			"bytes_released": r.Size <= 0,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"app_id":          appID,
		"current_version": current,
		"releases":        rows,
		// 审核开关：作者据此解释"为什么这一版还没生效"（关着还停在 pending 只可能是
		// 开关刚被打开，或这一版是在开关打开期间提交的）。
		"review_required": h.reviewRequired(),
	})
}

// ---------------------------------------------------------------------------
// 导出：GET .../wasm/:app_id/export（R37 只读快照）
// ---------------------------------------------------------------------------

// exportTitleSource 标注导出里 `app.title` 的来源（占位不是真实标题）。
//
// 与 auditTitleOf 同一口径（真实标题 = 生效版本的标题），只是导出面不能改字段值
// （format /1 的数据契约）⇒ 用**来源标注**把"这是占位"讲清楚。
func exportTitleSource(app *serverstore.WasmApp) string {
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

func (h *Handlers) export(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	// 实现收敛到 lifecycle_actions.go 的 exportForApp（设计 2026-10-22 §5.6）：
	// 默认 JSON（format /1，向后兼容）；`?database=1` / `?assets=1` ⇒ application/zip。
	// 快照目录（R37 的定期快照）与导出现在共用 internal/wasmapp/lifecycle 的同一份
	// BuildExport —— 两份实现必然漂移，而漂移的表现是"快照里有一份、导出里少一份"。
	role := serverstore.ActorRoleOwner
	if app.Owner != u.Username && isSuperAdmin(u) {
		role = serverstore.ActorRoleSuperAdmin
	}
	h.exportForApp(c, app, u.Username, role)
}
