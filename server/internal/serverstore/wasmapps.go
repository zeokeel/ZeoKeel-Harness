// ---- WASM 应用平台 DAO(迁移 0069)----
//
// 设计基线 docs/planning/2026-09-17-wasm-app-platform.md:
//
//	§4.1 命名与标识(域名标签就是 app_id,不新增标识列)
//	§4.8 Host 第一级标签 → app_id,查不到直接 404、绝不回落主站
//	§5.3 保留最近 3 个曾生效版本 / 每用户 1 GiB 制品
//	§8   发布者即管理员(归属首占)、上下架、冻结/导出/删除
//
// 本文件**只做数据访问**:权限、审批、版本号递增、冻结期策略等业务判断在
// 各自的业务包里;这里只保证落库的语义与不变量(归属首占、版本号永久占位、
// 软删不释放版本号、GC 不碰当前生效版本)。
//
// 约定:
//   - 一律 `$N` 占位(PG-only;连接层虽有 `?`→`$N` 重写,但新代码直接用 `$N`)。
//   - app_id 是域名标签 ⇒ **一律小写入库、小写查询**(域名不区分大小写)。
//   - 软删只置 deleted_at:行还在,**版本号/名字永久占位**(§4.1 防抢占)。
package serverstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AppKindWasmApp / AppChannelWasm 是 wasm 应用在统一应用模型里的取值
// (迁移 0069 放开了 apps.kind / apps.channel 的 CHECK)。
//
// 渠道刻意取**独立值** wasm,而不是复用 market/org:既有按 channel 过滤的
// 查询(marketplace / agentshare / capabilities / sharedskills 全部显式传
// market|org)因此天然不会把 wasm 应用当成技能/智能体展示;wasm 应用的分发面
// 是 <app_id>.<基域> 应用子域(§4.8),与能力中心两个渠道正交。
const (
	AppKindWasmApp = "wasm_app"
	AppChannelWasm = "wasm"
)

// WasmApp 是一个 wasm 应用的长期身份 + **当前生效状态**。
//
// DeletedAt 是只读投影,由 SoftDeleteWasmApp 写;访问模式(access)不再有独立投影列
// (0071 起 apps.visible 已删):目录与运维面要显示访问级别时从 ConfigJSON 现解
// (appcfg.AccessOfConfigJSON)。2026-09-18 收敛为 access 三模式后,目录**不按**访问
// 级别过滤 —— 所有应用都展示,访问级别只是条目上的一个字段。
type WasmApp struct {
	AppID            string
	Title            string
	Description      string
	Owner            string
	Channel          string
	Enabled          bool
	Purpose          string
	DataSensitivity  string
	ConfigJSON       string
	CurrentReleaseID int64
	// Official 是"归属官方"标记(迁移 0059 的 apps.official)。
	//
	// 为什么 wasm 面也必须读得见它(R3-A A-9):官方归属的**唯一合法形态**是
	// `official=1 ∧ owner=''`(SetAppOfficial 显式拒绝其它组合)。发布路径要能像
	// appstore.Publish 那样"官方应用发版不改写归属",前提就是看得见这一列 ——
	// 此前 DTO 列集里没有它,于是出现了"共享端点写得出、wasm 面读不到"的错位。
	Official  int
	FrozenAt  *time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
	// DeletedAt 非空 = 已软删(退役)。GetWasmApp 仍返回该行(R37 冻结期还要
	// 导出),GetWasmAppByHost 则必须查不到。
	DeletedAt *time.Time

	// ---- 生命周期重设计(迁移 0086,设计 2026-10-22 §4)----
	//
	// CurrentDeploymentID 是**历史链指针**(= 最近一次生效部署的
	// wasm_app_deployments.id)。运行期唯一真源仍是 CurrentReleaseID —— 本字段只回答
	// "谁在什么时候把哪一版放上线",不参与任何执行判定。
	CurrentDeploymentID int64
	// SnapshotAt 非空 = 只读快照**成功**落盘(真删的前置条件,fail-closed)。
	SnapshotAt *time.Time
	// SnapshotPath 是快照目录(<data_root>/apps/<app_id>/snapshots/<RFC3339>)。
	SnapshotPath string
	// SnapshotError 是最近一次快照失败的原因(空串 = 无失败);不阻断冻结,阻断真删。
	SnapshotError string
	// PurgeAfter = 冻结时刻 + 保留期;真删调度器的唯一到期判据。
	PurgeAfter *time.Time
	// PurgedAt 非空 = 数据已真删(元数据与部署历史保留作审计 tombstone)。
	PurgedAt *time.Time
	// DataCleanedAt 非空 = **数据目录真的删掉了**（两阶段真删的第二阶段，迁移 0088）。
	// PurgedAt 是终态（不可恢复），但删盘可能失败/重试 ⇒ 两者必须分开读：
	// PurgedAt 非空且 DataCleanedAt 为空 = "已不可恢复，但盘上可能还有残留，调度器在重试"。
	DataCleanedAt *time.Time
}

// WasmRelease 是一个不可变的 wasm 版本快照。
//
// 制品字节复用 app_releases.archive(BYTEA):审核不变量 N-4(「approved 必须
// 有归档字节」)对 wasm 版本同样成立,PruneWasmReleases 置空该列即释放配额。
type WasmRelease struct {
	ID          int64
	AppID       string
	Version     string
	Title       string
	Description string
	Changelog   string
	Publisher   string
	Checksum    string
	Size        int64
	Status      string
	// Reason 是**审核结论的理由**（审核不通过时管理员写下的那段话，≤200 字）。
	//
	// 为什么它必须在这里（R1-pm-3）：写入侧一直是通的（SetReleaseStatusForReview
	// 的 rejected 分支把 reason 与"释放归档"写在同一条 UPDATE 里），但读取侧从缺
	// —— 列集不含 reason、结构体也没有这个字段 ⇒ 作者永远看不到被拒理由，"审核"
	// 在作者侧退化成掷骰子。反过来，`reason` 只在 rejected 行上有内容：approved
	// 时被显式清成空串、pending 行从未写过，所以它对"通过/待审"两态恒为空。
	//
	// 与 Wasm 的关系：它是**小文本**（≤200 字，非 TOAST），因此清单列集可以带着
	// 它跑；archive(BYTEA) 才是那个"绝不能被清单查询顺手拉出来"的重量级列。
	Reason     string
	Wasm       []byte
	ConfigJSON string
	AssetsDir  string
	DeletedAt  *time.Time
	CreatedAt  time.Time
}

// wasmAppColumns 是 apps 上 wasm 应用用到的列(显式列名:既有 skill/agent
// 代码用 appColumns,互不影响)。
const wasmAppColumns = `app_id, title, description, owner, channel, enabled, purpose,
	data_sensitivity, config_json, current_release_id, official, frozen_at, deleted_at,
	created_at, updated_at, current_deployment_id, snapshot_at, snapshot_path, snapshot_error,
	purge_after, purged_at, data_cleaned_at`

// wasmReleaseListColumns 不含 archive blob:清单查询绝不加载全部制品。
//
// 含 reason(≤200 字的小文本):它是"审核结论"的唯一读路径(R1-pm-3),作者面与管理
// 面的审批清单都要显示它。它与 archive 的区别是量级 —— 后者是 ≤32 MiB 的 TOAST
// 大字段,拉一次就是一份制品常驻内存;reason 只是随行的小列。
const wasmReleaseListColumns = `id, app_id, version, title, description, changelog, publisher,
	checksum, size, status, reason, config_json, assets_dir, deleted_at, created_at`

// wasmReleaseServeColumns 是**应用子域请求路径**用的列:与清单列相同,即不含 archive。
//
// 为什么要显式命名(P0-3,2026-09-19):执行侧每请求都要取"当前生效版本",而模块缓存
// 命中(暖机常态)时 rel.Wasm **没有任何读者** —— 唯一读者是冷编译
// (appserver.compileRelease)。用 wasmReleaseFullColumns 查这一行,等于每个请求都从
// PostgreSQL 拉一份 ≤32 MiB 的 TOAST 大字段再丢掉:单请求瞬时堆可达 `并发 × 制品`,
// 默认档 32 并发下约 1 GiB,而 §4.3 的四笔账里**没有这一笔**。
//
// 所以:请求路径一律用本常量(+ **CurrentWasmReleaseMeta**,即 apps.current_release_id
// 指向的那一版);需要字节时在冷编译那一刻调 GetWasmRelease 按需加载。改这一行之前
// 先回答"谁要在请求路径上读制品字节"。
//
// ⚠️ 2026-10-22 反证审计（P0）：上面的注释在生命周期重设计之前写的是
// "LatestApprovedWasmReleaseMeta(max(id) approved)"。**那是错的**：回滚 = 用旧版本
// 再部署一次，它只改指针与部署历史、不改 id 顺序 ⇒ 按 max(id) 取版本会让回滚在
// 管理台成功、在用户侧无效。请求路径一律用 CurrentWasmReleaseMeta。
const wasmReleaseServeColumns = wasmReleaseListColumns

const wasmReleaseFullColumns = wasmReleaseListColumns + ", archive"

// normalizeWasmAppID 把 app_id(= 域名标签,§4.1)统一为小写。
// 域名不区分大小写 ⇒ 入库与查询必须同口径,否则同一个应用会出现两个身份。
func normalizeWasmAppID(appID string) string {
	return strings.ToLower(strings.TrimSpace(appID))
}

// nullableSQLTime 把可空时间列(NULL 或零值)映射成 *time.Time。
func nullableSQLTime(v any) *time.Time {
	if v == nil {
		return nil
	}
	t := parseSQLTime(v)
	if t.IsZero() {
		return nil
	}
	return &t
}

// WasmAppCurrentVersions 取一组应用"当前生效版本"的版本号。
//
// 管理面列表要显示「当前版本」，而 apps 行上只有 current_release_id（版本号在
// app_releases 上）。用一条 `= ANY(?::bigint[])` 批量取（同 balance.go 的用法），
// 不做 N+1；空入参直接返回空 map（避免给 PG 传空数组）。
// 版本行被软删/已被回收时该 id 查不到 ⇒ 调用方拿到零值（列表里显示空），不报错。
// @param ids - current_release_id 集合。
// @returns id → version。
func WasmAppCurrentVersions(ctx context.Context, db *sql.DB, ids []int64) (map[int64]string, error) {
	out := make(map[int64]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := db.QueryContext(ctx, `SELECT id, version FROM app_releases WHERE id = ANY(?::bigint[])`, pgInt64Array(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var version string
		if err := rows.Scan(&id, &version); err != nil {
			return nil, err
		}
		out[id] = version
	}
	return out, rows.Err()
}

// isForeignKeyViolation 报告 PG 的外键冲突(23503):CreateWasmRelease 用它
// 把"应用不存在"翻译成 ErrNotFound,而不是让调用方拿到裸驱动错误。
//
// SQLSTATE 判定走 pg.go 的 pgErrorCode（`errors.As` 优先，回落错误串）；末尾那条
// **文本**判定是 SQLite 时代的回落（PG-only 迁移后已无生产者），它比 `errors.As`
// 更宽，删掉属于行为收紧、不是重构，故保留并在此标明来源。
func isForeignKeyViolation(err error) bool {
	if err == nil {
		return false
	}
	if pgErrorCodeIs(err, pgSQLStateForeignKeyViolation) {
		return true
	}
	return strings.Contains(err.Error(), "foreign key constraint")
}

func scanWasmApp(row interface{ Scan(...any) error }) (*WasmApp, error) {
	var a WasmApp
	var enabled int
	var frozen, deleted, created, updated any
	var snapshotAt, purgeAfter, purgedAt, dataCleanedAt any
	if err := row.Scan(&a.AppID, &a.Title, &a.Description, &a.Owner, &a.Channel, &enabled,
		&a.Purpose, &a.DataSensitivity, &a.ConfigJSON, &a.CurrentReleaseID, &a.Official,
		&frozen, &deleted, &created, &updated,
		// 迁移 0086 的生命周期列:顺序必须与 wasmAppColumns 逐字一致(扫描错位是
		// 静默的数据损坏,而这里的列集只有一个常量,故只要两边同源就不会漂移)。
		&a.CurrentDeploymentID, &snapshotAt, &a.SnapshotPath, &a.SnapshotError,
		&purgeAfter, &purgedAt, &dataCleanedAt); err != nil {
		return nil, err
	}
	a.Enabled = enabled == 1
	a.FrozenAt = nullableSQLTime(frozen)
	a.DeletedAt = nullableSQLTime(deleted)
	a.CreatedAt, a.UpdatedAt = parseSQLTime(created), parseSQLTime(updated)
	a.SnapshotAt = nullableSQLTime(snapshotAt)
	a.PurgeAfter = nullableSQLTime(purgeAfter)
	a.PurgedAt = nullableSQLTime(purgedAt)
	a.DataCleanedAt = nullableSQLTime(dataCleanedAt)
	return &a, nil
}

func scanWasmRelease(row interface{ Scan(...any) error }, withWasm bool) (*WasmRelease, error) {
	var r WasmRelease
	var deleted, created any
	dest := []any{&r.ID, &r.AppID, &r.Version, &r.Title, &r.Description, &r.Changelog,
		&r.Publisher, &r.Checksum, &r.Size, &r.Status, &r.Reason, &r.ConfigJSON, &r.AssetsDir,
		&deleted, &created}
	if withWasm {
		dest = append(dest, &r.Wasm)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	r.DeletedAt = nullableSQLTime(deleted)
	r.CreatedAt = parseSQLTime(created)
	return &r, nil
}

// wasmAppRowsAffected 把"条件 UPDATE 影响 0 行"翻译成 ErrNotFound(其余错误原样)。
func wasmAppRowsAffected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, nerr := res.RowsAffected(); nerr == nil && n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpsertWasmApp 建立或更新一个 wasm 应用身份(幂等)。
//
// 归属语义与 UpsertApp 完全一致(0053/2026-09-02 决策):**owner 一经写入不可被
// 后续发布改写**(`COALESCE(NULLIF(apps.owner,”), excluded.owner)`),首个成功
// 发布者永久占名,被拒/软删也不释放 —— 否则任何人都能靠"重新发布"接管他人应用。
//
// 冲突分支**只**更新 title/description/owner/updated_at:
//   - enabled 只由 SetWasmAppEnabled 改(上下架是独立动作,不该被一次发布静默改写);
//   - config_json / purpose / data_sensitivity 只由 SetWasmAppConfig 改
//     (它们的真源是随包的应用配置文件,一次只带标题的 upsert 不该抹掉配置);
//   - current_release_id 只由 SetWasmAppCurrentRelease 改(§8 待审期间线上仍旧版本)。
//
// **官方归属守卫**(R3-A A-9):`official=1 ⇒ owner=”` 是迁移 0059/P2-21 的不变量,
// `SetAppOfficial` 对"official=1 ∧ owner≠”"直接返回 ErrValidation。而本函数的
// COALESCE 分支恰好能造出那个禁止状态:官方行的 owner 本来就是空串,于是
// `COALESCE(NULLIF(”,”), excluded.owner)` 把归属填成发布者 —— 一次普通的管理员
// 发版(以及每次启动的 appseed 播种)就能把"官方"改写成个人。
//
// 守卫放在 DAO 而不是只放在调用点,与 SetAppOfficial 的守卫同一条理由:
// **未来的调用者无论怎么传都造不出禁止状态**(不变量必须在唯一写入口成立)。
// 调用点(wasmapp/api 的 commitRelease)另有同形分支,那是"显式表达意图"的那一层。
func UpsertWasmApp(ctx context.Context, db *sql.DB, app WasmApp) error {
	appID := normalizeWasmAppID(app.AppID)
	if appID == "" {
		return errors.New("wasm app: app_id 不能为空")
	}
	_, err := db.ExecContext(ctx, `INSERT INTO apps
		(kind, app_id, title, description, owner, channel, enabled, purpose, data_sensitivity, config_json)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (kind, app_id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			owner = CASE WHEN apps.official = 1 THEN ''
				ELSE COALESCE(NULLIF(apps.owner, ''), excluded.owner) END,
			updated_at = now()`,
		AppKindWasmApp, appID, app.Title, app.Description, app.Owner, AppChannelWasm,
		boolToInt(app.Enabled), app.Purpose, app.DataSensitivity, app.ConfigJSON)
	return err
}

// GetWasmApp 按 app_id 取应用;不存在返回 ErrNotFound。
// **软删的行同样返回**(DeletedAt 非空)—— R37 的"冻结 → 90 天内可导出"必须
// 还能读到已退役的行(与 GetRelease 的既有口径一致:由调用方据 DeletedAt 判断)。
func GetWasmApp(ctx context.Context, db *sql.DB, appID string) (*WasmApp, error) {
	a, err := scanWasmApp(db.QueryRowContext(ctx, `SELECT `+wasmAppColumns+`
		FROM apps WHERE kind = $1 AND app_id = $2`, AppKindWasmApp, normalizeWasmAppID(appID)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return a, err
}

// 管理列表的状态筛选取值（`/admin/wasm-apps?status=` 的合法取值）。
//
// 为什么词表住在 serverstore 而不是 api：这些取值在 SQL 侧有**同一个语义的唯一实现**
// （`pending` 需要 EXISTS 子查询，其余四个映射到 apps 的列），api 只做"取值是否合法"
// 的校验与回显。两处各写一份词表 = 迟早出现"能校验、筛不出"的组合。
const (
	// WasmAppListStatusPending 有未处置的待审版本（且应用未被删除/清除 —— 与徽标
	// `CountPendingReleases` 同一判据集合，否则页头 N 与筛出来的行数会分叉）。
	WasmAppListStatusPending = "pending"
	// WasmAppListStatusPublished 在线（未删除、未冻结、已上架）。
	WasmAppListStatusPublished = "published"
	// WasmAppListStatusUnpublished 下架（未删除、未冻结、未上架）。
	WasmAppListStatusUnpublished = "unpublished"
	// WasmAppListStatusFrozen 冻结（frozen_at 非空）。
	WasmAppListStatusFrozen = "frozen"
	// WasmAppListStatusDeleted 已软删（deleted_at 非空；含已清除的行）。
	WasmAppListStatusDeleted = "deleted"
)

// WasmAppFilter 是 ListWasmApps / ListWasmAppsPage 的过滤条件(零值 = 全部未删除的应用)。
type WasmAppFilter struct {
	// Owner 非空 = 只列该发布者的应用(管理平面按发布者过滤)。
	Owner string
	// Enabled 非 nil = 只看上/下架状态为该值的应用。
	Enabled *bool
	// IncludeDeleted = true 时把已软删(退役)的应用也列出来(R37 运维面)。
	IncludeDeleted bool
	// Query 是大小写不敏感的子串搜索（app_id / title / owner）。
	//
	// 必须在 **SQL 里**过滤（P1-7 的核心判据）：先分页再从本页里搜，会让"第 201 个
	// 应用"永远搜不到。`%`/`_`/`\` 按 LIKE 字面量转义（用户的搜索词不是通配符）。
	Query string
	// Status 是列表状态筛选（取值见 WasmAppListStatus*；""/"all" = 不筛）。
	//
	// 未知取值**报错而不是静默不筛**：静默会让管理员以为筛过了（与 `?status=bogus`
	// 在 api 层被拒同一条纪律，这里兜住"绕过 api 直接调 DAO"的调用方）。
	Status string
	// Limit/Offset 是 SQL 分页（Limit<=0 = 不分页，保持旧行为）。
	//
	// 推下 SQL 的理由（审计 2026-10-22 C-13）：此前每次打开管理列表都把**全部**
	// wasm 应用读进内存再分页，几百/几千应用时是"每页 200 行却扫全表"。
	Limit int
	// Offset 是跳过的行数（仅在 Limit>0 时有意义）。
	Offset int
}

// wasmAppWhere 把过滤条件编成 WHERE 子句（args 已含 kind 参数）。
//
// 唯一的 WHERE 构造点：列表、计数、分页三处必须用**同一份谓词**，否则 total 与
// 本页行数会来自两个不同的集合（C-13 要消灭的正是这种"两个真源"）。
func wasmAppWhere(opts WasmAppFilter) (string, []any, error) {
	where := ` WHERE kind = $1`
	args := []any{AppKindWasmApp}
	// `status=deleted` **蕴含** include_deleted：否则基础谓词 `deleted_at IS NULL` 与
	// 状态谓词 `deleted_at IS NOT NULL` 互斥 ⇒ 永远 0 行（2026-10-22 反证 F-1 同族形态：
	// 筛选器给得出、结果永远空）。两处必须同源，所以在这里一次性收敛。
	includeDeleted := opts.IncludeDeleted ||
		strings.EqualFold(strings.TrimSpace(opts.Status), WasmAppListStatusDeleted)
	if !includeDeleted {
		where += ` AND deleted_at IS NULL`
	}
	if opts.Owner != "" {
		args = append(args, opts.Owner)
		where += fmt.Sprintf(` AND owner = $%d`, len(args))
	}
	if opts.Enabled != nil {
		args = append(args, boolToInt(*opts.Enabled))
		where += fmt.Sprintf(` AND enabled = $%d`, len(args))
	}
	if q := strings.TrimSpace(opts.Query); q != "" {
		args = append(args, "%"+escapeLikePattern(q)+"%")
		n := len(args)
		// ILIKE 本身大小写不敏感（与 api 层此前的 strings.ToLower + Contains 等价）；
		// ESCAPE 让搜索词里的 % / _ 按字面量匹配。
		where += fmt.Sprintf(` AND (app_id ILIKE $%d ESCAPE '\' OR title ILIKE $%d ESCAPE '\'`+
			` OR owner ILIKE $%d ESCAPE '\')`, n, n, n)
	}
	switch status := strings.ToLower(strings.TrimSpace(opts.Status)); status {
	case "", "all":
		// 不筛
	case WasmAppListStatusPending:
		// 与 CountPendingReleases / PendingWasmReleases 同一判据集合（排除已删除/已清除
		// 的应用）：那两处是页头徽标的真源，筛出来的行必须与那个数字对得上。
		args = append(args, ReleaseStatusPending)
		n := len(args)
		where += ` AND deleted_at IS NULL AND purged_at IS NULL AND EXISTS (SELECT 1 FROM app_releases r
			WHERE r.kind = apps.kind AND r.app_id = apps.app_id AND r.status = $` + strconv.Itoa(n) +
			` AND r.deleted_at IS NULL)`
	case WasmAppListStatusPublished:
		where += ` AND deleted_at IS NULL AND frozen_at IS NULL AND enabled = 1`
	case WasmAppListStatusUnpublished:
		where += ` AND deleted_at IS NULL AND frozen_at IS NULL AND enabled = 0`
	case WasmAppListStatusFrozen:
		where += ` AND frozen_at IS NOT NULL`
	case WasmAppListStatusDeleted:
		where += ` AND deleted_at IS NOT NULL`
	default:
		return "", nil, fmt.Errorf("wasm app: status 取值不合法: %q", opts.Status)
	}
	return where, args, nil
}

// escapeLikePattern 把 LIKE 模式里的元字符转成字面量（与 ESCAPE '\' 配合）。
//
// 顺序要紧：先转义反斜杠本身，否则后两步产生的反斜杠会被二次转义。
func escapeLikePattern(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// ListWasmApps 列出 wasm 应用。默认**不含**软删行；Limit>0 时按 SQL 分页。
func ListWasmApps(ctx context.Context, db *sql.DB, opts WasmAppFilter) ([]WasmApp, error) {
	where, args, err := wasmAppWhere(opts)
	if err != nil {
		return nil, err
	}
	q := `SELECT ` + wasmAppColumns + ` FROM apps` + where + ` ORDER BY app_id`
	if opts.Limit > 0 {
		args = append(args, opts.Limit)
		q += fmt.Sprintf(` LIMIT $%d`, len(args))
		if opts.Offset > 0 {
			args = append(args, opts.Offset)
			q += fmt.Sprintf(` OFFSET $%d`, len(args))
		}
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WasmApp{}
	for rows.Next() {
		a, err := scanWasmApp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// CountWasmApps 返回与 ListWasmApps **同一谓词**的行数（分页的 total 真源）。
//
// 为什么必须有它（审计 2026-10-22 C-13）：分页后的 total 只能是 COUNT(*)，不能是
// `len(本页)`（那会把 total 变成"这页有几行"，正是 F-1 的"两个待审数"同族缺陷）。
func CountWasmApps(ctx context.Context, db *sql.DB, opts WasmAppFilter) (int, error) {
	where, args, err := wasmAppWhere(opts)
	if err != nil {
		return 0, err
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM apps`+where, args...).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// WasmAppPage 是分页查询的结果：本页行 + 同一谓词的全量计数。
type WasmAppPage struct {
	Apps  []WasmApp
	Total int
}

// ListWasmAppsPage 一次给出"本页行 + total"（管理列表的唯一读路径）。
//
// 两条查询共用 wasmAppWhere 的谓词 ⇒ total 恒等于同一筛选条件下的行数，
// 与 Limit/Offset 无关（这正是"分页元数据可信"的前提）。
func ListWasmAppsPage(ctx context.Context, db *sql.DB, opts WasmAppFilter) (*WasmAppPage, error) {
	total, err := CountWasmApps(ctx, db, opts)
	if err != nil {
		return nil, err
	}
	apps, err := ListWasmApps(ctx, db, opts)
	if err != nil {
		return nil, err
	}
	return &WasmAppPage{Apps: apps, Total: total}, nil
}

// SetWasmAppEnabled 上下架(§8;复用 apps.enabled,与审核开关无关)。
func SetWasmAppEnabled(ctx context.Context, db *sql.DB, appID string, enabled bool) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET enabled = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		boolToInt(enabled), AppKindWasmApp, normalizeWasmAppID(appID)))
}

// TransferWasmAppOwner 转移归属(§11 第 17 项:离职/接管)。空 owner 直接拒:
// 归属悬空正是"发布者离职后应用无人能改"的病根。
func TransferWasmAppOwner(ctx context.Context, db *sql.DB, appID, newOwner string) error {
	if strings.TrimSpace(newOwner) == "" {
		return errors.New("wasm app: 新归属不能为空")
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET owner = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		newOwner, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// FreezeWasmApp 冻结(只读快照,R37)。at 为零值 = 解冻(frozen_at 置 NULL)——
// 冻结是"冻结时刻 + 保留期"的判定依据,解冻必须能显式表达。
func FreezeWasmApp(ctx context.Context, db *sql.DB, appID string, at time.Time) error {
	var frozen any
	if !at.IsZero() {
		frozen = at.UTC()
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps SET frozen_at = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL`,
		frozen, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SoftDeleteWasmApp 软删(退役):行仍在、名字与版本号永久占位(§4.1 防抢占),
// 同时下架(下架与删除是两件事,但"已删仍上架"没有意义)。
//
// 2026-09-25(R15C-G-03):退役必须**同时释放该应用名下全部版本的制品字节** ——
// 这是配额闸门在用户可见面上唯一的恢复路径(见 SoftDeleteWasmRelease 的注释:
// 闸门在发布最前面、GC 只在发布成功之后跑,所以"配额用尽"等于"再也发不出东西",
// 用户必须有一个自己能按的动作把占用降下来;DELETE /apps/wasm/:app_id 就是它)。
// 之前退役一字节不减 ⇒ 用户把应用删光了配额仍然是满的。
//
// 两件事在**同一个事务**里完成(与其它"多表一起改"的 DAO 同范式):只软删应用而
// 没有释放字节,或反过来,都会留下"应用已退役但配额仍被它占着"的分叉。
// 覆盖**全部**版本行(含此前已软删、但字节还没被回收的历史行):退役之后它们都
// 不可能再被服务,留着只是占库占配额。元数据行一字不删(R37 冻结期的导出快照
// 只读 title/status/size 这些列,读不到字节;size 归零与"字节已释放"同义)。
func SoftDeleteWasmApp(ctx context.Context, db *sql.DB, appID string) error {
	id := normalizeWasmAppID(appID)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op
	res, err := tx.ExecContext(ctx, `UPDATE apps
		SET deleted_at = now(), enabled = 0, updated_at = now()
		WHERE kind = $1 AND app_id = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// R16A-17(审计 2026-09-25,P2) + 本次修正:**只清字节,不置 deleted_at**。
	//
	// 缺陷形态:`SetReleaseStatusForReview` 的 approve 谓词是
	// `deleted_at IS NULL AND (archive IS NOT NULL OR status <> 'rejected')`,
	// 第二个析取项对 **pending** 行恒真 ⇒ 只清字节时,审核通过会**成功返回**并产出
	// `approved + archive IS NULL` 的坏行 —— 而 apps.go 里那句"任何交错都产不出
	// `approved + archive IS NULL` 的坏行"正是 N-4(P0 级)修复的判据本体。
	//
	// R16A-17 的第一版修法是"清字节时同时置 deleted_at"。**但它把退役做成了
	// 版本级删除**,与退役自己的产品契约冲突:退役后的**保留期内**,作者与管理员
	// 仍要能读版本清单(`GET …/:app_id/releases`、管理端同名端点、导出快照)——
	// 那是"作者能拿到被拒理由"这条承诺(R1-pm-3)在删除之后的唯一落点,也正是
	// `TestMyReleasesSurvivesRetirement` 逐字钉住的语义。置了 deleted_at 之后,
	// 一切 `deleted_at IS NULL` 的读面(作者面 **与管理面**)都看不见这些行 ⇒
	// 退役 = 版本历史凭空消失。
	//
	// 所以坏行改由**谓词**收口(见 `SetReleaseStatusForReview` 的 approve 分支:
	// 加"应用未退役"条件),这里只清字节 —— `deleted_at` 于是回到它本来的语义:
	// "这个版本被显式删掉了"(版本级软删 / GC),而不是"它的应用退役了"。
	//
	// 为什么这不会重新打开 R16A-17:清字节的路径只有三条,各自都被谓词覆盖 ——
	//   ① 应用退役:apps.deleted_at 非空 ⇒ 新增的 EXISTS 条件挡下;
	//   ② 版本级软删(SoftDeleteWasmRelease / GC):本行 deleted_at 非空 ⇒ 挡下;
	//   ③ 审核拒绝:status='rejected' ⇒ 第二个析取项挡下。
	// 三条之外不存在把 archive 清空的写点(全仓 grep `archive = NULL`)。
	if _, err := tx.ExecContext(ctx, `UPDATE app_releases
		SET archive = NULL, size = 0, updated_at = now()
		WHERE kind = $1 AND app_id = $2 AND archive IS NOT NULL`,
		AppKindWasmApp, id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetWasmAppConfig 写入**当前生效**的应用配置(§4.2 的 zeokeel.app.json 投影)。
//
// 投影列只有 config_json / purpose / data_sensitivity:访问模式(access)不再单列
// (0071 删掉了 apps.visible),要显示时由调用方从 configJSON 现解
// (appcfg.AccessOfConfigJSON)。configJSON 为空表示"只改用途/敏感性"。
// JSON 非法即拒 —— 存进去的配置将来要投影与展示,落库前失败好过之后静默漂移。
func SetWasmAppConfig(ctx context.Context, db *sql.DB, appID, configJSON, purpose, sensitivity string) error {
	if configJSON != "" && !json.Valid([]byte(configJSON)) {
		return fmt.Errorf("wasm app 配置不是合法 JSON")
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET config_json = $1, purpose = $2, data_sensitivity = $3, updated_at = now()
		WHERE kind = $4 AND app_id = $5 AND deleted_at IS NULL`,
		configJSON, purpose, sensitivity, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SetWasmAppDisplay 写入 apps 行的**显示面两列**(title/description)。
//
// 真源是 app_releases 里**最新 approved 版本**的那一行(R2-1,2026-09-19 第二轮审计
// §1.1):这两列与 config_json/purpose/data_sensitivity 一样是"目录对全员下发的投影",
// 只有审核落定的那一刻才允许随生效版本切走 —— 待审版本曾直接经 UpsertWasmApp 的无条件
// 写入改掉它们,作者不需要过审就能把已上线应用改名/换描述(点进去执行的仍是旧代码)。
//
// 与 SetWasmAppConfig 同样只对未软删的行生效(影响 0 行 = ErrNotFound)。
func SetWasmAppDisplay(ctx context.Context, db *sql.DB, appID, title, description string) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET title = $1, description = $2, updated_at = now()
		WHERE kind = $3 AND app_id = $4 AND deleted_at IS NULL`,
		title, description, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// SetWasmAppCurrentRelease 把某个版本置为**当前生效版本**(§8:开启审核时新版进
// 待审队列,线上仍旧版本 ⇒ 生效版本必须显式落库)。
//
// ⚠️ **生产写点已全部收敛到 DeployWasmRelease**(迁移 0086,设计 2026-10-22 §5.1):
// publish / 审批 / 内置应用播种三条路径都改走部署事务(插部署历史 + 切指针 + 写投影
// 一起提交)。本函数**不再被任何生产代码调用**,只留给测试夹具与存量数据修复:
// 直接用它改指针会留下"生效版本变了、部署历史里没有这一条"的绕过点 —— 新代码请用
// DeployWasmRelease。
//
// 条件里带 EXISTS 校验:该 release 必须属于本应用且未被软删。否则一次写错的
// id 会让应用指向别人的版本 —— 应用子域直接交付错误内容,属于越权级事故。
func SetWasmAppCurrentRelease(ctx context.Context, db *sql.DB, appID string, releaseID int64) error {
	if releaseID <= 0 {
		return errors.New("wasm app: release id 必须为正")
	}
	id := normalizeWasmAppID(appID)
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET current_release_id = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND deleted_at IS NULL
		  AND EXISTS (SELECT 1 FROM app_releases r
		              WHERE r.id = $1 AND r.kind = $2 AND r.app_id = $3 AND r.deleted_at IS NULL)`,
		releaseID, AppKindWasmApp, id))
}

// CreateWasmRelease 写入一个不可变的版本快照。
//
// 版本号**永久占位**(§4.1):(kind, app_id, version) 唯一冲突返回 ErrDuplicate,
// 被拒/软删的版本同样不可复用(软删行还在,唯一约束照旧生效)。应用不存在时
// 外键冲突翻译成 ErrNotFound。状态缺省 pending(§4.2 审核态由业务层决定)。
func CreateWasmRelease(ctx context.Context, db *sql.DB, rel WasmRelease) (int64, error) {
	appID := normalizeWasmAppID(rel.AppID)
	if appID == "" {
		return 0, errors.New("wasm release: app_id 不能为空")
	}
	if strings.TrimSpace(rel.Version) == "" {
		return 0, errors.New("wasm release: version 不能为空")
	}
	status := rel.Status
	if status == "" {
		status = ReleaseStatusPending
	}
	var id int64
	err := db.QueryRowContext(ctx, `INSERT INTO app_releases
		(kind, app_id, version, title, description, changelog, publisher, checksum,
		 size, archive, status, config_json, assets_dir)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id`,
		AppKindWasmApp, appID, rel.Version, rel.Title, rel.Description, rel.Changelog,
		rel.Publisher, rel.Checksum, int64(len(rel.Wasm)), rel.Wasm, status,
		rel.ConfigJSON, rel.AssetsDir).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		if isForeignKeyViolation(err) {
			return 0, fmt.Errorf("%w: wasm 应用 %q 不存在", ErrNotFound, appID)
		}
		return 0, err
	}
	return id, nil
}

// ListWasmReleases 列出一个应用的版本(不含制品字节),按写入顺序升序。
// 默认不含软删行;includeDeleted=true 用于"版本号永久占位"的判重与审计。
func ListWasmReleases(ctx context.Context, db *sql.DB, appID string, includeDeleted bool) ([]WasmRelease, error) {
	q := `SELECT ` + wasmReleaseListColumns + ` FROM app_releases WHERE kind = $1 AND app_id = $2`
	if !includeDeleted {
		q += ` AND deleted_at IS NULL`
	}
	q += ` ORDER BY created_at, id`
	rows, err := db.QueryContext(ctx, q, AppKindWasmApp, normalizeWasmAppID(appID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WasmRelease{}
	for rows.Next() {
		r, err := scanWasmRelease(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetWasmRelease 取一个版本(含制品字节)。软删的版本同样返回,调用方据
// DeletedAt 判断(与被拒/软删版本号永久占位的语义配套)。
func GetWasmRelease(ctx context.Context, db *sql.DB, appID, version string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseFullColumns+`
		FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
		AppKindWasmApp, normalizeWasmAppID(appID), version), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// GetWasmReleaseMeta 取一个版本的**元数据**(不含制品字节)。
//
// 与 GetWasmRelease 的分工:审核/清单/诊断只关心状态与体积,不需要字节。
// 判定"待审⇒通过"这类动作先读它拿状态(友好的幂等响应),真正的不变量仍由
// SetReleaseStatusForReview 的条件 UPDATE 在写入时保证(check-then-act 只是文案)。
func GetWasmReleaseMeta(ctx context.Context, db *sql.DB, appID, version string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseServeColumns+`
		FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
		AppKindWasmApp, normalizeWasmAppID(appID), version), false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// LatestApprovedWasmReleaseMeta 取最新的**已批准且未软删**版本的元数据 ——
// **应用子域请求路径的唯一入口**(不含制品字节)。版本号严格递增 ⇒ id 顺序即版本
// 顺序,取 max(id) 即可。
//
// 字节按需加载:冷编译那一刻由调用方调 GetWasmRelease(P0-3)。模块缓存命中时
// 没有任何人需要字节,因此这里**绝不**能换成全列查询。
func LatestApprovedWasmReleaseMeta(ctx context.Context, db *sql.DB, appID string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseServeColumns+`
		FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND status = $3 AND deleted_at IS NULL
		ORDER BY id DESC LIMIT 1`,
		AppKindWasmApp, normalizeWasmAppID(appID), ReleaseStatusApproved), false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// CurrentWasmReleaseMeta 取**当前部署指针**（`apps.current_release_id`）指向的版本元数据
// —— 应用请求路径 / 打开端点 / 发布继承基线的**唯一入口**（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §3.3：current = 最近一次
// deployment 的指针，运行期唯一真源）。
//
// 为什么不能继续用 max(id) approved（2026-10-22 反证审计 P0，最严重的一条）：
// 回滚 = "用旧版本再部署一次"，它只改 `current_release_id`/`current_deployment_id`
// 与部署历史，**不改 id 顺序**。请求路径按 `ORDER BY id DESC` 取版本 ⇒ 回滚后
// 管理台/部署历史显示 v1、用户实际拿到 v2 ⇒ "回滚"是一次只改数据库记账的假动作。
// 三个"权威源"（执行面 / 审核面 / GC）必须收敛到指针，否则 GC 保护的是 v1、
// 服务交付的是 v2，且两者都"看起来正常"。
//
// 语义（与 LatestApprovedWasmReleaseMeta 逐条对齐：同一列集、同样不含制品字节）：
//   - 应用行不存在 / 已软删（含真删）⇒ ErrNotFound；
//   - `current_release_id = 0`（从未部署过）⇒ ErrNotFound（与"还没有可用版本"同义）；
//   - 指针指向的版本行必须 `status='approved'` 且未软删，否则 ErrNotFound ——
//     **绝不回落到 max(id) approved**：静默回落会把"数据不一致"变成"看起来正常的
//     另一个版本"，而那正是本条要消灭的形态（第 8 条"双源"）。
//
// 调用方（serve / open / inheritBase）都把 ErrNotFound 解释成"没有可用版本"，
// 行为与旧口径在"从未部署/无 approved"场景下完全一致。
func CurrentWasmReleaseMeta(ctx context.Context, db *sql.DB, appID string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseServeColumns+`
		FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND status = $3 AND deleted_at IS NULL
		  AND id = (SELECT a.current_release_id FROM apps a
		            WHERE a.kind = $1 AND a.app_id = $2
		              AND a.deleted_at IS NULL AND a.current_release_id > 0)`,
		AppKindWasmApp, normalizeWasmAppID(appID), ReleaseStatusApproved), false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// LatestApprovedWasmReleaseFull 取最新已批准版本的**全部字段(含 archive 字节)**。
//
// 名字里的 Full 是**成本提示**,不是风格:这个函数会把整份 ≤32 MiB 的制品从
// PostgreSQL 拉进内存。允许的调用点只有"本来就要字节"的地方 —— 发布/播种期的
// 校验与离线诊断;**请求路径一律用 CurrentWasmReleaseMeta**(P0-3 + 2026-10-22 反证 P0)。
func LatestApprovedWasmReleaseFull(ctx context.Context, db *sql.DB, appID string) (*WasmRelease, error) {
	r, err := scanWasmRelease(db.QueryRowContext(ctx, `SELECT `+wasmReleaseFullColumns+`
		FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND status = $3 AND deleted_at IS NULL
		ORDER BY id DESC LIMIT 1`,
		AppKindWasmApp, normalizeWasmAppID(appID), ReleaseStatusApproved), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// PendingWasmReleases 返回全组织**待审版本**的 app_id → 版本号(按写入顺序)。
//
// 用途:管理面列表的"积压"视图(P0-1)——审核开关打开后新版本停在 pending,
// 管理员必须一眼看到"有多少个版本在等审批"。一次查询取全量待审行(待审是**小集合**:
// 每个应用同时最多积压用户提交的那些版本),调用方按自己列出的 app_id 过滤,
// 因此不需要 (N 个应用 → N 次查询) 的 N+1。
func PendingWasmReleases(ctx context.Context, db *sql.DB) (map[string][]string, error) {
	// 2026-10-22 反证 F-1：必须与「跨应用待审队列」同一判据集合（排除已删除/已清除
	// 的应用）。此前只查 app_releases、不 join apps ⇒ 应用在 pending 期间被删除后，
	// 它的待审版本仍被页头徽标计数，而队列里看不到、approve/reject 又一律 404
	// ⇒ 这个数字在 UI 里没有任何途径清掉（两个"待审数"来源分叉且不自愈）。
	rows, err := db.QueryContext(ctx, `SELECT r.app_id, r.version FROM app_releases r
		JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
		WHERE r.kind = $1 AND r.status = $2 AND r.deleted_at IS NULL
		  AND a.deleted_at IS NULL AND a.purged_at IS NULL
		ORDER BY r.app_id, r.id`, AppKindWasmApp, ReleaseStatusPending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var appID, version string
		if err := rows.Scan(&appID, &version); err != nil {
			return nil, err
		}
		out[appID] = append(out[appID], version)
	}
	return out, rows.Err()
}

// SoftDeleteWasmRelease 软删一个版本(按 id)。版本号仍永久占位(行保留),
// **制品字节同步释放**。
//
// 2026-09-25(R15C-G-03):本函数此前只置 deleted_at,字节留给 PruneWasmReleases ——
// 而 GC 的候选集是 `status='approved' AND deleted_at IS NULL`,**永远拿不到软删行**。
// 于是"发布失败后的补偿软删"(wasmapp/api 的 compensate 闭包)会把最多 32 MiB 的
// 制品永久计入用户配额,且没有任何解除路径(没有版本级删除端点、退役不释放、
// 真删任务未实现)⇒ 配额用尽 ⇒ 发布永远在闸门处失败 ⇒ 唯一会释放字节的 GC
// (只在发布成功之后跑)永远不运行 —— 一道**无恢复路径的 fail-closed 闸门**
// (与第四轮现场 P0「编译缓存超限 ⇒ 发布面永久 503」同形)。
//
// 现在与"审核拒绝"同一口径(SetReleaseStatusForReview 的 reject 分支一直是
// `archive = NULL, size = 0`):**版本一旦对所有人不可见,字节就没有任何消费者**
// —— 没有任何路径会把 deleted_at 置回 NULL(全仓无 restore;版本号也永久占位,
// 不可能重发)。因此软删即释放:配额口径 = "已发布(可见)版本的字节"。
// 行仍保留 ⇒ my_releases / 导出(R37 冻结期快照)的元数据一字不少。
func SoftDeleteWasmRelease(ctx context.Context, db *sql.DB, id int64) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE app_releases
		SET deleted_at = now(), archive = NULL, size = 0, updated_at = now()
		WHERE id = $1 AND kind = $2 AND deleted_at IS NULL`, id, AppKindWasmApp))
}

// CountUserArtifactBytes 统计某发布者的 wasm 制品总量(§5.3 每用户 1 GiB 配额,
// PG BYTEA 口径)。
//
// 2026-09-25(R15C-G-03):口径 = **未软删(即仍在版本清单里可见)的版本**。
// 之前统计全部版本,包括已软删的行 —— 那些行的字节既不会被 GC 回收(候选集排除
// 软删),也没有任何可见性,却一直占着配额(历史遗留的补偿软删行就是这样把用户
// 永久锁死的)。软删行今天已由 SoftDeleteWasmRelease / SoftDeleteWasmApp 置空
// archive,这里再按可见性收口一次:口径本身就不该依赖"字节有没有被清"。
func CountUserArtifactBytes(ctx context.Context, db *sql.DB, username string) (int64, error) {
	var n int64
	err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(octet_length(archive)), 0)
		FROM app_releases WHERE kind = $1 AND publisher = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, username).Scan(&n)
	return n, err
}

// PruneWasmReleases 版本 GC(§5.3 / §11 第 16 项):**保留最近 keep 个曾生效
// (approved)版本**,更早的软删并置空制品字节;返回被回收的 release id。
//
// 不变量:
//   - 保留窗口只作用于 approved(曾生效)版本 —— pending 还在等审核、rejected 的
//     字节已由审核路径释放,GC 不该碰它们;
//   - **绝不软删 apps.current_release_id 指向的版本**:回滚会让"当前生效"
//     早于最近 3 个版本,若一并回收就等于把线上版本删掉;
//   - 软删不删行 ⇒ 版本号永久占位(§4.1),size 归零与 archive 置空同步,
//     保持"size == 字节长度"这条 createRelease 建立的不变量;
//   - 幂等:重复调用返回空切片(没有可回收的行)。
//
// 2026-09-25(R15C-G-03):候选集增加**"已软删但仍占字节"**的行(第二个 UNION 分支)。
// 这类行不可能再被服务(没有任何 restore 路径),此前却因为"候选集排除软删行"而
// 永远留在库里占字节 —— 补偿软删留下的行就是这样。今天软删已经自己清字节,
// 这个分支是给**历史遗留行**兜底(修复上线前写入的行不会自己消失),同时让
// "GC 回收一切不可达字节"这句话在 SQL 层成立,而不是靠调用点自觉。
//
// keep ≤ 0 直接报错而不是"全部回收":一次传错 0 就抹掉全部制品字节,代价不可逆。
func PruneWasmReleases(ctx context.Context, db *sql.DB, appID string, keep int) ([]int64, error) {
	if keep <= 0 {
		return nil, errors.New("wasm release prune: keep 必须 > 0")
	}
	id := normalizeWasmAppID(appID)
	if id == "" {
		return nil, errors.New("wasm release prune: app_id 不能为空")
	}
	rows, err := db.QueryContext(ctx, `
		WITH doomed AS (
			(SELECT r.id FROM app_releases r
			 WHERE r.kind = $1 AND r.app_id = $2
			   AND r.status = $3 AND r.deleted_at IS NULL
			   AND r.id <> COALESCE((SELECT a.current_release_id FROM apps a
			                         WHERE a.kind = $1 AND a.app_id = $2), 0)
			 ORDER BY r.id DESC OFFSET $4)
			UNION
			(SELECT r.id FROM app_releases r
			 WHERE r.kind = $1 AND r.app_id = $2
			   AND r.deleted_at IS NOT NULL AND r.archive IS NOT NULL)
		)
		UPDATE app_releases
		SET deleted_at = now(), archive = NULL, size = 0, updated_at = now()
		WHERE id IN (SELECT id FROM doomed)
		RETURNING id`, AppKindWasmApp, id, ReleaseStatusApproved, keep)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pruned []int64
	for rows.Next() {
		var rid int64
		if err := rows.Scan(&rid); err != nil {
			return nil, err
		}
		pruned = append(pruned, rid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(pruned, func(i, j int) bool { return pruned[i] < pruned[j] })
	return pruned, nil
}

// GetWasmAppByHost 按 Host 的第一级标签反查应用(§4.8)。
//
// 三条硬要求:
//   - 只认 kind=wasm_app(技能/智能体同名行绝不能被当应用命中);
//   - **已软删的应用查不到**(退役即停止路由);
//   - 查不到返回明确的 not-found(ErrNotFound),调用方据此 **404 且绝不回落
//     主站内容** —— 回落会让任意未登记子域变成钓鱼页(§4.8 域名安全)。
//
// hostLabel 做防御性规范化:域名不区分大小写,端口与末尾根点不属于标签。
func GetWasmAppByHost(ctx context.Context, db *sql.DB, hostLabel string) (*WasmApp, error) {
	label := normalizeHostLabel(hostLabel)
	if label == "" {
		return nil, fmt.Errorf("%w: 空主机名", ErrNotFound)
	}
	a, err := scanWasmApp(db.QueryRowContext(ctx, `SELECT `+wasmAppColumns+`
		FROM apps WHERE kind = $1 AND app_id = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, label))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: 未登记的 wasm 应用主机名 %q", ErrNotFound, label)
	}
	return a, err
}

// normalizeHostLabel 取主机名的**第一级标签**并小写化(§4.8:「Host 的第一级
// 标签 → apps.app_id」)。传裸标签("my-app")与传完整主机名
// ("my-app.example.com")都得到同一结果 —— app_id 是 DNS label、不含点,
// 所以按第一个点切分不会误伤。端口只在形如 "<host>:<数字>" 时剥离,
// 避免把 IPv6 字面量切坏(切坏了也只是查不到,不会误命中)。
func normalizeHostLabel(host string) string {
	h := strings.TrimSpace(host)
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		if _, err := strconv.Atoi(h[i+1:]); err == nil {
			h = h[:i]
		}
	}
	h = strings.TrimSuffix(h, ".") // DNS 根点
	h = strings.ToLower(h)
	if i := strings.IndexByte(h, '.'); i >= 0 {
		h = h[:i]
	}
	return h
}
