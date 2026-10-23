package serverstore

// WASM 应用平台**生命周期** DAO（迁移 0086；设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §3–§5）。
//
// 模型（借 Cloudflare Workers 的版本/部署语义，执行面仍是 Go wasi32 + wazero）：
//
//	version（app_releases）= 不可变的 wasm 制品 + 随包配置；
//	deployment（wasm_app_deployments）= 把某个 version 指为线上版本的一次**不可变动作**；
//	current（apps.current_release_id）= 最近一次 deployment 的指针（运行期唯一真源）。
//
// 本文件只做数据访问与**事务内不变量**（与 wasmapps.go 的分工一致）：权限、错误码映射、
// 审计文案在 wasmapp/api；快照/导出/真删的磁盘动作在 wasmapp/lifecycle。
//
// 三条不变量写在**唯一写入口**里（调用点无法绕过）：
//  1. 只有 status='approved' 且仍有字节的版本可被部署（`DeployWasmRelease`）；
//  2. 冻结/已删/已清除的应用不可部署（同上，事务内 `SELECT … FOR UPDATE` 之后判定）；
//  3. 部署指针与投影列在**同一个事务**里一起改 —— 不存在"指针切了、投影没切"的窗口。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 部署 kind（= wasm_app_deployments.kind 的取值；迁移 0086 的 CHECK 与之同源）。
const (
	// DeployKindPublish 审核关闭时发布成功 / 显式部署**最新** approved 版本。
	DeployKindPublish = "publish"
	// DeployKindReview 管理员审批通过（部署 max(id) approved；审批更旧版本不降级）。
	DeployKindReview = "review"
	// DeployKindRollback 显式部署一个**非最新** approved 版本（不重审、不重传）。
	DeployKindRollback = "rollback"
	// DeployKindSeed 内置演示应用播种。
	DeployKindSeed = "seed"
	// DeployKindLegacy 迁移回填（只为存量应用补一条历史）。
	DeployKindLegacy = "legacy"
)

// 部署 actor_role（= wasm_app_deployments.actor_role 的取值；审计可辨"谁以什么身份做的"）。
const (
	ActorRoleOwner        = "owner"
	ActorRoleSuperAdmin   = "super_admin"
	ActorRoleAdminSession = "admin_session"
	ActorRoleSystem       = "system"
	ActorRoleSeed         = "seed"
	ActorRoleLegacy       = "legacy"
)

// ReleaseStatusWithdrawn 是作者撤回后的**终态**（迁移 0086 放宽了 CHECK）。
//
// 语义：字节已释放、版本号永久占用（与 rejected 同口径）；与 rejected 的区别只在
// "谁做的决定"（作者 vs 审核）—— 因此它同样不可再部署、不可再审批。
const ReleaseStatusWithdrawn = "withdrawn"

// 生命周期相关错误码（HTTP 状态由 api 层映射；错误码字面值是跨端契约，见设计 §6.2）。
const (
	// CodeReleaseNotDeployable 版本不可部署（非 approved / 已撤回 / 不存在于可部署集合）。
	CodeReleaseNotDeployable = "RELEASE_NOT_DEPLOYABLE"
	// CodeReleaseNotPending 撤回只允许 pending（approved/rejected/withdrawn 一律拒）。
	CodeReleaseNotPending = "RELEASE_NOT_PENDING"
	// CodeAppDeleted 应用已删除：先恢复（restore）再部署。
	CodeAppDeleted = "APP_DELETED"
	// CodeAppPurged 数据已清除（真删完成）：任何数据面动作一律 410。
	CodeAppPurged = "APP_PURGED"
	// CodeReleaseBytesReleased 版本字节已释放（被拒/撤回/软删/回收）⇒ 不可再部署。
	CodeReleaseBytesReleased = "RELEASE_BYTES_RELEASED"
)

// 生命周期 sentinel（api 层据此映射错误码；DAO 不产生 HTTP 语义）。
var (
	// ErrReleaseNotDeployable 版本不能被部署（非 approved，或不属于该应用）。
	ErrReleaseNotDeployable = errors.New("washer: release not deployable")
	// ErrReleaseNotPending 撤回前置条件不满足（版本不是 pending）。
	ErrReleaseNotPending = errors.New("washer: release not pending")
	// ErrAppDeleted 应用已软删（部署/写动作被拒；只读与恢复仍可用）。
	ErrAppDeleted = errors.New("washer: app deleted")
	// ErrAppPurged 应用数据已真删（数据面一律 410；控制面元数据仍可读）。
	ErrAppPurged = errors.New("washer: app purged")
	// ErrReleaseBytesReleased 版本行还在但没有制品字节（不可部署）。
	ErrReleaseBytesReleased = errors.New("washer: release bytes released")
	// ErrAppFrozen 应用已冻结（部署被拒；解冻后可再部署）。
	ErrAppFrozen = errors.New("washer: app frozen")
)

// WasmDeployment 是一条**不可变**部署历史（wasm_app_deployments 的一行）。
//
// 行一旦写入永不更新、永不删除（真删应用也不删：审计 tombstone）。
// actor_role 让审计回答"谁以什么身份做的"（owner / super_admin / admin_session /
// system / seed / legacy）—— 这是审计 2026-10-22 C-15 的直接要求。
type WasmDeployment struct {
	ID        int64
	AppID     string
	ReleaseID int64
	Version   string
	Kind      string
	Actor     string
	ActorRole string
	Message   string
	CreatedAt time.Time
}

// deployColumns 是部署历史的显式列集（顺序与 scanWasmDeployment 一致）。
const deployColumns = `id, app_id, release_id, version, kind, actor, actor_role, message, created_at`

// scanWasmDeployment 读一行部署历史。
func scanWasmDeployment(row interface{ Scan(...any) error }) (*WasmDeployment, error) {
	var d WasmDeployment
	var created any
	if err := row.Scan(&d.ID, &d.AppID, &d.ReleaseID, &d.Version, &d.Kind, &d.Actor,
		&d.ActorRole, &d.Message, &created); err != nil {
		return nil, err
	}
	d.CreatedAt = parseSQLTime(created)
	return &d, nil
}

// DeployWasmReleaseInput 是一次部署/回滚的输入。
//
// Kind 为空时由 DAO **按事实判定**（releaseID == 最新 approved ? publish : rollback）：
// "这次动作是发布还是回滚"不该由每个调用点各判一次 —— 两处判定必然漂移，而漂移的
// 表现是历史行写着 publish、实际却回滚了。审批（review）与播种（seed）显式传 Kind。
type DeployWasmReleaseInput struct {
	AppID     string
	ReleaseID int64
	Kind      string
	Actor     string
	ActorRole string
	Message   string
	// Now 缺省 time.Now()（测试注入固定时钟）。
	Now time.Time
}

// DeployWasmRelease 在一个事务里把某个版本指为线上版本（设计 §5.1）。
//
// 步骤（顺序即 fail-closed 顺序）：
//  1. `SELECT … FROM apps WHERE kind='wasm_app' AND app_id=$1 FOR UPDATE`（应用行锁；
//     并发的两次部署因此串行化，后到者要么幂等返回、要么在"目标即当前"处收敛）；
//  2. purged → ErrAppPurged；deleted → ErrAppDeleted；frozen → ErrAppFrozen
//     （顺序有意：purged 蕴含 deleted，先报更终态的那个）；
//  3. 版本行必须存在、属本应用、status='approved'、deleted_at IS NULL 且**仍有字节**；
//  4. 目标版本 == 当前生效版本 ⇒ changed=false（不插历史、不写审计 —— 幂等）；
//  5. 插 deployment + 更新 current_release_id/current_deployment_id + 投影（同事务）。
//
// 返回 (deployment, changed, error)。changed=false 时返回的是**当前那次**部署行
// （迁移回填的 legacy 应用也能拿到它）；若历史链为空（存量库且未回填），返回 id=0 的空行。
//
// 投影语义与 syncAppProjection 一致：title/description 取目标版本行的值（空串不覆盖），
// config_json/purpose/data_sensitivity 只在目标版本的 config_json 非空时写 —— 存量行
// 没有配置时不能拿"没有配置"去清掉现有投影。
func DeployWasmRelease(ctx context.Context, db *sql.DB, in DeployWasmReleaseInput) (*WasmDeployment, bool, error) {
	appID := normalizeWasmAppID(in.AppID)
	if appID == "" {
		return nil, false, errors.New("wasm deploy: app_id 不能为空")
	}
	if in.ReleaseID <= 0 {
		return nil, false, errors.New("wasm deploy: release_id 必须为正")
	}
	role := strings.TrimSpace(in.ActorRole)
	if role == "" {
		role = ActorRoleOwner
	}
	kind := strings.TrimSpace(in.Kind)
	now := in.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op

	// ① 应用行锁：所有部署动作在这里串行化（与 PruneWasmReleases / 退役调度器竞争时
	// 同样安全 —— 它们要么拿 apps 行锁，要么只改 release 行）。
	app, err := scanWasmApp(tx.QueryRowContext(ctx, `SELECT `+wasmAppColumns+`
		FROM apps WHERE kind = $1 AND app_id = $2 FOR UPDATE`, AppKindWasmApp, appID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	// ② 终态判定（fail-closed 顺序：purged 蕴含 deleted）。
	if app.PurgedAt != nil {
		return nil, false, ErrAppPurged
	}
	if app.DeletedAt != nil {
		return nil, false, ErrAppDeleted
	}
	if app.FrozenAt != nil {
		return nil, false, ErrAppFrozen
	}

	// ③ 版本行：属本应用、approved、未软删、仍有字节。
	var (
		relID                          int64
		version, status                string
		title, description, configJSON string
		hasBytes                       bool
		relDeleted                     any
	)
	err = tx.QueryRowContext(ctx, `SELECT id, version, status, title, description, config_json,
			(archive IS NOT NULL), deleted_at
		FROM app_releases WHERE kind = $1 AND app_id = $2 AND id = $3`,
		AppKindWasmApp, appID, in.ReleaseID).
		Scan(&relID, &version, &status, &title, &description, &configJSON, &hasBytes, &relDeleted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if status != ReleaseStatusApproved || nullableSQLTime(relDeleted) != nil {
		return nil, false, ErrReleaseNotDeployable
	}
	if !hasBytes {
		return nil, false, ErrReleaseBytesReleased
	}

	// ④ 幂等：目标 == 当前 ⇒ 不追加历史、不改行。
	//
	// 返回的是**当前那次部署的历史行**（不是空占位）：客户端靠 deployment.version/kind
	// 渲染"当前是 vX、由一次 publish/rollback 上线"，返回 `id=0/version=""` 会让它
	// 退化成猜（2026-10-22 反证 1c）。真查不到历史行时（存量库未回填/手工修过指针）
	// 至少把 version 填对。
	if app.CurrentReleaseID == relID {
		cur, changed, cerr := currentDeploymentTx(ctx, tx, app, version)
		if cerr != nil {
			return nil, false, cerr
		}
		return cur, changed, nil
	}

	// kind 判定（未显式指定时）：目标是最新 approved 版本 = publish，否则 rollback。
	if kind == "" {
		var latestID int64
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM app_releases
			WHERE kind = $1 AND app_id = $2 AND status = $3 AND deleted_at IS NULL`,
			AppKindWasmApp, appID, ReleaseStatusApproved).Scan(&latestID); err != nil {
			return nil, false, err
		}
		if latestID == relID {
			kind = DeployKindPublish
		} else {
			kind = DeployKindRollback
		}
	}

	// ⑤ 追加历史。
	dep := WasmDeployment{
		AppID: appID, ReleaseID: relID, Version: version, Kind: kind,
		Actor: strings.TrimSpace(in.Actor), ActorRole: role,
		Message: strings.TrimSpace(in.Message), CreatedAt: now,
	}
	if err := tx.QueryRowContext(ctx, `INSERT INTO wasm_app_deployments
		(app_id, release_id, version, kind, actor, actor_role, message, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`,
		dep.AppID, dep.ReleaseID, dep.Version, dep.Kind, dep.Actor, dep.ActorRole,
		dep.Message, dep.CreatedAt).Scan(&dep.ID); err != nil {
		return nil, false, err
	}

	if _, err := tx.ExecContext(ctx, `UPDATE apps SET
			current_release_id = $1,
			current_deployment_id = $2,
			title = CASE WHEN $3 <> '' THEN $3 ELSE title END,
			description = CASE WHEN $4 <> '' THEN $4 ELSE description END,
			config_json = CASE WHEN $5 <> '' THEN $5 ELSE config_json END,
			purpose = CASE WHEN $5 <> '' THEN $6 ELSE purpose END,
			data_sensitivity = CASE WHEN $5 <> '' THEN $7 ELSE data_sensitivity END,
			updated_at = now()
		WHERE kind = $8 AND app_id = $9`,
		relID, dep.ID, title, description, configJSON,
		purposeOfConfigJSON(configJSON), sensitivityOfConfigJSON(configJSON),
		AppKindWasmApp, appID); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return &dep, true, nil
}

// currentDeploymentTx 返回"当前这次部署"的历史行（幂等分支用），changed 恒为 false。
//
// 三级取法（每一级都只在**确实存在**时才返回行）：
//  1. `apps.current_deployment_id` 指向的行（正常路径，迁移 0086 回填后恒可用）；
//  2. 该应用 + 该版本**最新**的一条历史行（指针被手工清零/迁移前的库）；
//  3. 都没有 ⇒ 合成一行：只填 app_id/release_id/version，id=0。
//     幂等是把"已经是目标版本"当作成功，**不是**当作数据损坏 —— 但 version 必须填对，
//     否则客户端拿到的"当前版本"是空串（2026-10-22 反证 1c）。
func currentDeploymentTx(ctx context.Context, tx *sql.Tx, app *WasmApp, version string) (*WasmDeployment, bool, error) {
	if app.CurrentDeploymentID > 0 {
		d, err := scanWasmDeployment(tx.QueryRowContext(ctx, `SELECT `+deployColumns+`
			FROM wasm_app_deployments WHERE id = $1 AND app_id = $2`,
			app.CurrentDeploymentID, app.AppID))
		switch {
		case err == nil && d.ReleaseID == app.CurrentReleaseID:
			return d, false, nil
		case err != nil && !errors.Is(err, sql.ErrNoRows):
			return nil, false, err
		}
	}
	d, err := scanWasmDeployment(tx.QueryRowContext(ctx, `SELECT `+deployColumns+`
		FROM wasm_app_deployments WHERE app_id = $1 AND release_id = $2
		ORDER BY id DESC LIMIT 1`, app.AppID, app.CurrentReleaseID))
	switch {
	case err == nil:
		return d, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return nil, false, err
	}
	return &WasmDeployment{
		AppID: app.AppID, ReleaseID: app.CurrentReleaseID, Version: version,
	}, false, nil
}

// ListWasmDeployments 返回某应用的部署历史（**新的在前**），limit ≤ 0 时用缺省 50。
//
// 已删除/已清除的应用同样可读（只读历史；真删也不删历史行）。
func ListWasmDeployments(ctx context.Context, db *sql.DB, appID string, limit int) ([]WasmDeployment, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := db.QueryContext(ctx, `SELECT `+deployColumns+`
		FROM wasm_app_deployments WHERE app_id = $1 ORDER BY id DESC LIMIT $2`,
		normalizeWasmAppID(appID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// 刻意**不按 `limit` 预分配容量**（CodeQL `go/slice-memory-allocation`）：
	// limit 来自 HTTP 查询参数，上面虽然已经钳到 500，但静态扫描沿两条 if 赋值
	// 无法完成边界推断，会把这里的 `make(..., 0, limit)` 报成"用户可控的过量分配"。
	// 列表上限 500 条，预分配本来就只是微优化 —— 去掉容量参数既消除告警，也避免
	// 将来有人放宽钳位时，这里跟着静默放大一次分配。
	out := make([]WasmDeployment, 0)
	for rows.Next() {
		d, err := scanWasmDeployment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// WithdrawWasmRelease 把**待审**版本撤回为终态 withdrawn（设计 §5.3）。
//
// 与"审核拒绝"同一口径（SetReleaseStatusForReview 的 rejected 分支）：置状态与释放
// 归档字节在**同一条 UPDATE** 里完成，否则中间那段窗口恰好就是被并发 approve 穿过的窗口。
// 前置条件写在 WHERE 里（`status='pending'`），不进 WHERE 的写法在并发下必被绕过。
//
// 版本号**永久占用**：行保留（不写 deleted_at），只清 archive/size —— 与"删除占号"的
// 产品语义一致（设计 §2「版本不可变、版本号不复用」）。
//
// 返回 ErrReleaseNotPending（版本存在但不是 pending）与 ErrNotFound（版本不存在）。
func WithdrawWasmRelease(ctx context.Context, db *sql.DB, appID, version, reason string) error {
	appID = normalizeWasmAppID(appID)
	version = strings.TrimSpace(version)
	if appID == "" || version == "" {
		return errors.New("wasm withdraw: app_id/version 不能为空")
	}
	if strings.TrimSpace(reason) == "" {
		reason = "作者撤回"
	}
	res, err := db.ExecContext(ctx, `UPDATE app_releases
		SET status = $1, archive = NULL, size = 0, reason = $2, updated_at = now()
		WHERE kind = $3 AND app_id = $4 AND version = $5
		  AND status = $6 AND deleted_at IS NULL`,
		ReleaseStatusWithdrawn, reason, AppKindWasmApp, appID, version, ReleaseStatusPending)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	// 0 行只有两种可能：行不存在（404），或行存在但不在 pending（409）。
	// 这条解释性查询在**已经判定更新失败之后**执行，不构成 check-then-act。
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND version = $3)`,
		AppKindWasmApp, appID, version).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return ErrReleaseNotPending
}

// StalePendingPurgeReason 是管理面批量清理积压待审版本时写进 `app_releases.reason` 的
// **固定文案**（设计 §5.7：「purge-stale 标 withdrawn，reason='审核关闭后清理'」）。
//
// 为什么是常量而不是调用方传字符串：这条 reason 是审计/作者面能看到的**归因**
// （"为什么我的版本没了"），写成调用方自由文本就会变成"批量清理"/"管理端操作"/
// 空串三四种说法，事后无法用一条 SQL 统计"因为审核关闭被清掉的有多少"。
const StalePendingPurgeReason = "审核关闭后清理"

// PurgeStalePendingReleases 把**审核开关关闭后失去意义**的积压待审版本批量标成
// `withdrawn`（设计 §5.7 的可选清理动作；审计 2026-10-22 C-08）。
//
// 语义与单条撤回（WithdrawWasmRelease）**逐字一致**：置状态 + 释放归档字节 +
// 版本号永久占用（行保留、不写 deleted_at）、reason 固定为 StalePendingPurgeReason。
// 与撤回的唯一差别是**批量**且以应用为范围（已删除/已清除应用的待审行不进候选 ——
// 它们本来就不在管理面的待审队列与徽标里，见 CountPendingReleases 的判据）。
//
// 幂等：判据 `status='pending'` 在 WHERE 里，重复执行第二次影响 0 行（返回 0）。
// 返回**受影响行数**（= 本次真正清理掉的版本数），调用方据此如实回报。
func PurgeStalePendingReleases(ctx context.Context, db *sql.DB, reason string) (int, error) {
	if strings.TrimSpace(reason) == "" {
		reason = StalePendingPurgeReason
	}
	res, err := db.ExecContext(ctx, `UPDATE app_releases r
		SET status = $1, archive = NULL, size = 0, reason = $2, updated_at = now()
		FROM apps a
		WHERE a.kind = r.kind AND a.app_id = r.app_id
		  AND r.kind = $3 AND r.status = $4 AND r.deleted_at IS NULL
		  AND a.deleted_at IS NULL AND a.purged_at IS NULL`,
		ReleaseStatusWithdrawn, reason, AppKindWasmApp, ReleaseStatusPending)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// FreezeWasmAppWithRetention 冻结应用：停止服务（enabled=0）+ 记冻结时刻 + 保留期到期时刻
// （设计 §5.4：三者是同一个动作的三个列，分成三次 UPDATE 会留下"已停服但没有到期时刻"
// 的窗口，而真删调度器的唯一判据就是 purge_after）。
//
// at/purgeAfter 由调用方算（保留期常量在 limits 包；DAO 不引 limits 的语义常量）。
func FreezeWasmAppWithRetention(ctx context.Context, db *sql.DB, appID string, at, purgeAfter time.Time) error {
	if at.IsZero() || purgeAfter.IsZero() {
		return errors.New("wasm freeze: 冻结时刻与到期时刻都不能为空")
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET frozen_at = $1, enabled = 0, purge_after = $2, updated_at = now()
		WHERE kind = $3 AND app_id = $4 AND deleted_at IS NULL`,
		at.UTC(), purgeAfter.UTC(), AppKindWasmApp, normalizeWasmAppID(appID)))
}

// UnfreezeWasmApp 解冻：清冻结时刻/到期时刻/快照状态（**不**自动上架）。
//
// 快照状态必须一起清：解冻后应用回到可服务状态，留着 snapshot_at 会让下一次删除
// 误以为"快照已经做过了"而跳过删除前快照（fail-closed 的关键一步）。
// 快照目录的物理删除由调用方**尽力**执行（磁盘失败不阻断解冻 —— 解冻是恢复服务的动作）。
func UnfreezeWasmApp(ctx context.Context, db *sql.DB, appID string) error {
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET frozen_at = NULL, purge_after = NULL,
		    snapshot_at = NULL, snapshot_path = '', snapshot_error = '', updated_at = now()
		WHERE kind = $1 AND app_id = $2 AND deleted_at IS NULL`,
		AppKindWasmApp, normalizeWasmAppID(appID)))
}

// WasmSnapshotRecord 是一次快照尝试的结果（成功/失败共用一条写入口）。
type WasmSnapshotRecord struct {
	// At 非 nil = 快照成功落盘（写真删前置条件 snapshot_at）。
	At *time.Time
	// Path 是快照目录（成功时非空）。
	Path string
	// Error 是失败原因（成功时为空串）。
	Error string
}

// SetWasmAppSnapshot 记录一次快照尝试的**结果**（成功或失败）。
//
// 失败**不清**掉此前成功的 snapshot_at：一次临时磁盘故障不该把"已经有可用快照"降级成
// "没有快照"（那会让真删永久被阻断）。只把失败原因写进 snapshot_error，运维面可见。
func SetWasmAppSnapshot(ctx context.Context, db *sql.DB, appID string, rec WasmSnapshotRecord) error {
	var at any
	var path, errText = strings.TrimSpace(rec.Path), strings.TrimSpace(rec.Error)
	if rec.At != nil && !rec.At.IsZero() {
		at = rec.At.UTC()
		errText = "" // 成功即清掉上次失败原因（否则运维面会一直看到陈旧错误）
	} else {
		// 失败分支：不清 snapshot_at/path，只写错误。
		return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
			SET snapshot_error = $1, updated_at = now()
			WHERE kind = $2 AND app_id = $3`,
			errText, AppKindWasmApp, normalizeWasmAppID(appID)))
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET snapshot_at = $1, snapshot_path = $2, snapshot_error = $3, updated_at = now()
		WHERE kind = $4 AND app_id = $5`,
		at, path, errText, AppKindWasmApp, normalizeWasmAppID(appID)))
}

// RestoreWasmApp 恢复软删（设计 §5.5）：清 deleted_at/frozen_at/purge_after、快照状态与
// **部署指针**，**enabled 保持 0**（不自动上架 —— 与解冻同一条 fail-closed 理由）。
//
// 清指针的理由见函数内注释（反证 P2-4）：软删已释放全部版本字节，恢复后指针指向的行
// 不可交付 —— 留着指针会让"上架"变成"上架即 500"。
//
// purged_at 非空 ⇒ ErrAppPurged（数据已清除，恢复没有意义；API 映射 410）。
// 版本号占位语义不变（release 行不动）。
func RestoreWasmApp(ctx context.Context, db *sql.DB, appID string) error {
	appID = normalizeWasmAppID(appID)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op
	var purged any
	if err := tx.QueryRowContext(ctx, `SELECT purged_at FROM apps
		WHERE kind = $1 AND app_id = $2 FOR UPDATE`, AppKindWasmApp, appID).Scan(&purged); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if nullableSQLTime(purged) != nil {
		return ErrAppPurged
	}
	// 清删除/冻结时间线 + 快照状态 + **部署指针**。
	//
	// 为什么必须清指针（2026-10-22 反证 P2-4）：软删时 `SoftDeleteWasmApp` 会释放该应用
	// **全部版本**的制品字节（配额口径），因此恢复后"当前部署版本"指向的是一行没有字节的
	// 版本 —— 而 `setPublished`（上架）不校验"是否存在可交付版本"，管理员照 UI 文案去点
	// 「上架」，应用立刻进入 `enabled=1` 但请求路径拿不到字节 ⇒ 500。正确动作是
	// "发/部署一个仍有字节的版本"，所以恢复必须把指针复位，让"没有生效版本"这个事实
	// 如实可见（open/目录/show 都会给出"还没有可用版本"而不是 500）。
	// 历史行（wasm_app_deployments）**不动**：谁在什么时候上线过什么是审计事实。
	if _, err := tx.ExecContext(ctx, `UPDATE apps
		SET deleted_at = NULL, frozen_at = NULL, purge_after = NULL,
		    snapshot_at = NULL, snapshot_path = '', snapshot_error = '',
		    current_release_id = 0, current_deployment_id = 0,
		    enabled = 0, updated_at = now()
		WHERE kind = $1 AND app_id = $2`, AppKindWasmApp, appID); err != nil {
		return err
	}
	return tx.Commit()
}

// SoftDeleteWasmAppWithTimeline 软删 + 记保留期时间线（设计 §5.5 第 2 步）。
//
// 与 SoftDeleteWasmApp 的关系：后者是"只软删"的最小语义（其它泳道/测试在用），本函数在
// 同一事务里额外保证 `purge_after` 非空（真删调度器的唯一判据）。**删除前必须已经快照成功**
// —— 那是调用方（api/lifecycle）的责任，DAO 不检查快照：快照状态是跨系统事实（磁盘），
// 放在这里会让"已快照但 DB 写入失败"的恢复路径变复杂。
//
// purgeAfter 为零值时用 at + 保留期语义无法在 DAO 内表达 ⇒ 调用方必须给值（fail-closed）。
func SoftDeleteWasmAppWithTimeline(ctx context.Context, db *sql.DB, appID string, at, purgeAfter time.Time) error {
	if at.IsZero() || purgeAfter.IsZero() {
		return errors.New("wasm soft delete: 删除时刻与到期时刻都不能为空")
	}
	appID = normalizeWasmAppID(appID)
	// 复用既有软删（它已经包含"释放全部版本字节"的语义与理由），再补时间线。
	// 两步不在同一事务里:SoftDeleteWasmApp 自己开事务；这里补写的两条列是幂等的，
	// 且真删调度器要求 deleted_at 非空 + purge_after 非空**同时**成立,所以中间态
	// （已软删、purge_after 为空）的后果只是"本轮不选中",不是"提前真删"。
	if err := SoftDeleteWasmApp(ctx, db, appID); err != nil {
		return err
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET frozen_at = COALESCE(frozen_at, $1), purge_after = $2, updated_at = now()
		WHERE kind = $3 AND app_id = $4`,
		at.UTC(), purgeAfter.UTC(), AppKindWasmApp, appID))
}

// WasmAppPurgeCandidate 是一条**可以真删**的候选（deleted + 到期 + 有成功快照）。
type WasmAppPurgeCandidate struct {
	AppID        string
	SnapshotAt   time.Time
	SnapshotPath string
	PurgeAfter   time.Time
}

// PurgeCandidates 返回可执行真删的应用（设计 §5.5）：kind='wasm_app' AND deleted_at IS NOT NULL
// AND purged_at IS NULL AND purge_after <= now AND **snapshot_at IS NOT NULL**。
//
// snapshot_at 是硬条件（不是调用方二次过滤）：设计原话「必须 snapshot_at IS NOT NULL，
// 否则本轮跳过并记错误（不删数据）」。把它写进 SQL 让"没有快照"永远进不了删除路径，
// 调用方拿到的每一行都是可删的。
func PurgeCandidates(ctx context.Context, db *sql.DB, now time.Time, limit int) ([]WasmAppPurgeCandidate, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx, `SELECT app_id, snapshot_at, snapshot_path, purge_after
		FROM apps
		WHERE kind = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL
		  AND purge_after IS NOT NULL AND purge_after <= $2
		  AND snapshot_at IS NOT NULL
		ORDER BY purge_after, app_id LIMIT $3`,
		AppKindWasmApp, now.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WasmAppPurgeCandidate, 0, limit)
	for rows.Next() {
		var c WasmAppPurgeCandidate
		var snapAt, purgeAfter any
		if err := rows.Scan(&c.AppID, &snapAt, &c.SnapshotPath, &purgeAfter); err != nil {
			return nil, err
		}
		c.SnapshotAt = parseSQLTime(snapAt)
		c.PurgeAfter = parseSQLTime(purgeAfter)
		out = append(out, c)
	}
	return out, rows.Err()
}

// PurgeBlockedWasmApps 返回"到期但**没有成功快照**"的应用（本轮跳过、必须记错误）。
//
// 与 PurgeCandidates 互补且**判据唯一**（同一段 WHERE 的取反），所以"候选 ∪ 被拒 =
// 全部到期"这条恒等式在 SQL 层成立 —— 不会出现既不在候选、也不报错的静默漏项。
func PurgeBlockedWasmApps(ctx context.Context, db *sql.DB, now time.Time) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT app_id FROM apps
		WHERE kind = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL
		  AND purge_after IS NOT NULL AND purge_after <= $2
		  AND snapshot_at IS NULL
		ORDER BY app_id`, AppKindWasmApp, now.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var appID string
		if err := rows.Scan(&appID); err != nil {
			return nil, err
		}
		out = append(out, appID)
	}
	return out, rows.Err()
}

// MarkWasmAppPurged 标记真删完成：purged_at=now、enabled=0、清当前指针（历史行保留）。
//
// ⚠️ 2026-10-23 起**生产路径不再调用本函数**（真删走 `BeginWasmAppPurge` + 两阶段清理）；
// 它保留给测试/历史工具直接构造"已清除"状态。它的 WHERE 不校验 deleted_at：拿它当生产
// 写入口会把一个**未删除**的应用直接置成不可恢复 —— 新代码请勿使用。
//
// 清 current_release_id 是"数据已清除"的一部分：制品字节已经不存在，留着指针会让任何
// 按指针取版本的读面拿到一行没有字节的版本（并在恢复/导出等 410 路径之前"看起来正常"）。
// 部署历史（wasm_app_deployments）**一字不动** —— 它回答"谁何时把哪一版上线"，
// 而这个问题在数据清除之后才更需要答案。
func MarkWasmAppPurged(ctx context.Context, db *sql.DB, appID string, at time.Time) error {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	return wasmAppRowsAffected(db.ExecContext(ctx, `UPDATE apps
		SET purged_at = $1, enabled = 0, current_release_id = 0, current_deployment_id = 0,
		    updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND purged_at IS NULL`,
		at.UTC(), AppKindWasmApp, normalizeWasmAppID(appID)))
}

// BeginWasmAppPurge 是真删的**第一阶段**：在事务内锁行、重校验资格、置 purged_at。
//
// 返回 true = 本次已把该应用标记为"数据已清除"（终态，restore 之后一律 410）；
// false = 已被并发恢复/本就不满足条件（调用方跳过，不做任何磁盘操作）。
//
// 与 restore 的互斥性来自同一行上的 `FOR UPDATE`：
//   - restore 先拿到锁并提交（清 deleted_at）⇒ 这里重校验失败 ⇒ false，不删数据；
//   - 这里先拿到锁并提交（置 purged_at）⇒ restore 的 SELECT 看到 purged_at ⇒ ErrAppPurged。
//
// 旧实现是"先删盘、后置 purged_at 且 Mark 不校验 deleted_at"，两者并发时会出现
// "恢复成功 + 数据被删 + 不可再恢复"（2026-10-22 生产评审 P0）。
//
// purged_at 一旦提交就**不可回滚**；数据目录清理由 `data_cleaned_at` 单独记账、可重试，
// 因此清理失败不会被误报成"数据已清除"。
func BeginWasmAppPurge(ctx context.Context, db *sql.DB, appID string, at time.Time) (bool, error) {
	appID = normalizeWasmAppID(appID)
	if at.IsZero() {
		at = time.Now().UTC()
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck // Commit 之后是 no-op

	var deletedAt, purgedAt, snapshotAt, purgeAfter any
	if err := tx.QueryRowContext(ctx, `SELECT deleted_at, purged_at, snapshot_at, purge_after
		FROM apps WHERE kind = $1 AND app_id = $2 FOR UPDATE`,
		AppKindWasmApp, appID).Scan(&deletedAt, &purgedAt, &snapshotAt, &purgeAfter); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if nullableSQLTime(deletedAt) == nil { // 已被恢复
		return false, nil
	}
	if nullableSQLTime(purgedAt) != nil { // 已清除
		return false, nil
	}
	if nullableSQLTime(snapshotAt) == nil { // fail-closed：没有成功快照不删
		return false, nil
	}
	due := parseSQLTime(purgeAfter)
	if due.IsZero() || due.After(at.UTC()) { // 未到期
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE apps
		SET purged_at = $1, enabled = 0, current_release_id = 0, current_deployment_id = 0,
		    updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND purged_at IS NULL`,
		at.UTC(), AppKindWasmApp, appID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// MarkWasmAppDataCleaned 记录"数据目录真的删掉了"（第二阶段）。幂等：已记录则 no-op。
//
// 与 purged_at 分开的理由见 BeginWasmAppPurge：清理可能失败/重试，不能因为 purged_at
// 已置位就宣称数据已清除（生产评审 P0 的另一半是"承诺与事实不一致"）。
func MarkWasmAppDataCleaned(ctx context.Context, db *sql.DB, appID string, at time.Time) error {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	_, err := db.ExecContext(ctx, `UPDATE apps SET data_cleaned_at = $1, updated_at = now()
		WHERE kind = $2 AND app_id = $3 AND purged_at IS NOT NULL AND data_cleaned_at IS NULL`,
		at.UTC(), AppKindWasmApp, normalizeWasmAppID(appID))
	return err
}

// PurgeCleanupCandidates 返回"已 purged、但数据目录还没清干净"的应用（清理重试）。
//
// 这是两阶段真删的自愈口：第一阶段提交后进程崩溃/磁盘删除失败，下一轮从这里继续，
// 直到 data_cleaned_at 置位；不会出现"元数据说清了、盘上还在"的永久不一致。
func PurgeCleanupCandidates(ctx context.Context, db *sql.DB, limit int) ([]string, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx, `SELECT app_id FROM apps
		WHERE kind = $1 AND purged_at IS NOT NULL AND data_cleaned_at IS NULL
		ORDER BY purged_at, app_id LIMIT $2`, AppKindWasmApp, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var appID string
		if err := rows.Scan(&appID); err != nil {
			return nil, err
		}
		out = append(out, appID)
	}
	return out, rows.Err()
}

// SnapshotRetryCandidates 返回"已冻结/已删除但没有成功快照"的应用（设计 §5.4 的
// 「快照失败 → 调度器重试」的唯一取数口）。
//
// 为什么必须由调度器重试（而不是只在冻结那一刻试一次）：冻结路径**不阻断**快照失败
// （磁盘抖动时不能把管理员挡在门外），但"没有成功快照"会**阻断真删**（fail-closed）
// ⇒ 如果没有人重试，那个应用就永久停在"到期但删不掉"的状态，而 UI/审计/limits 表
// 承诺的"到期平台回收"又一次落空（C-01 的原形态）。重试是这条链的自愈路径。
//
// 条件里带 purged_at IS NULL（已清除的不再需要快照）与 snapshot_at IS NULL
// （已有快照的不重复做 —— 快照是文件操作，没必要每轮重写）。
func SnapshotRetryCandidates(ctx context.Context, db *sql.DB, limit int) ([]string, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := db.QueryContext(ctx, `SELECT app_id FROM apps
		WHERE kind = $1 AND purged_at IS NULL AND snapshot_at IS NULL
		  AND (frozen_at IS NOT NULL OR deleted_at IS NOT NULL)
		ORDER BY COALESCE(frozen_at, deleted_at), app_id LIMIT $2`,
		AppKindWasmApp, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var appID string
		if err := rows.Scan(&appID); err != nil {
			return nil, err
		}
		out = append(out, appID)
	}
	return out, rows.Err()
}

// WasmPendingRelease 是跨应用待审队列的一行（设计 §5.7）。
//
// 字段集与 webadmin 的契约表（`apps-lifecycle.ts` 的 pending 列）对齐：管理台在
// 队列里要显示"多大 / 改了什么 / 描述"以便就地决策，只有 app_id/version 时那几列
// 只能空着（2026-10-22 反证 8b-①）。ID/Size/Changelog/Description 就是为此下发的。
type WasmPendingRelease struct {
	ID             int64
	AppID          string
	Title          string
	Version        string
	Publisher      string
	Changelog      string
	Description    string
	Size           int64
	CreatedAt      time.Time
	CurrentVersion string
}

// PendingReleaseQueue 返回**跨应用**的待审清单（管理面 §6.2 的 `releases/pending`）。
//
// 与 PendingWasmReleases 的分工：那个函数返回 app_id → 版本号（列表页只用来数积压），
// 本函数返回**可处置清单**（含标题/提交人/时长/当前线上版本），是"看到积压 → 直接处置"
// 那条断头路（审计 C-07）的服务端落点。
//
// 已软删应用 / 已清除应用的待审行不进队列（它们不可处置：审批路径要求应用未退役）。
// CountPendingReleases 返回**跨应用待审版本总数**（与 PendingReleaseQueue 同一判据集合）。
//
// 2026-10-22 反证 F-1：队列此前用 `total = len(rows)`，而 rows 有 200 硬上限 ⇒
// 待审超过 200 时页头 N 与队列 total 必然分叉。计数必须单独走 COUNT(*)。
func CountPendingReleases(ctx context.Context, db *sql.DB) (int, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT count(*)
		FROM app_releases r
		JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
		WHERE r.kind = $1 AND r.status = $2 AND r.deleted_at IS NULL
		  AND a.deleted_at IS NULL AND a.purged_at IS NULL`,
		AppKindWasmApp, ReleaseStatusPending).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func PendingReleaseQueue(ctx context.Context, db *sql.DB, limit int) ([]WasmPendingRelease, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := db.QueryContext(ctx, `SELECT r.id, r.app_id, a.title, r.version, r.publisher,
			r.changelog, r.description, r.size, r.created_at, COALESCE(cur.version, '')
		FROM app_releases r
		JOIN apps a ON a.kind = r.kind AND a.app_id = r.app_id
		LEFT JOIN app_releases cur ON cur.id = a.current_release_id
		WHERE r.kind = $1 AND r.status = $2 AND r.deleted_at IS NULL
		  AND a.deleted_at IS NULL AND a.purged_at IS NULL
		ORDER BY r.created_at, r.id LIMIT $3`,
		AppKindWasmApp, ReleaseStatusPending, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WasmPendingRelease, 0, limit)
	for rows.Next() {
		var p WasmPendingRelease
		var created any
		if err := rows.Scan(&p.ID, &p.AppID, &p.Title, &p.Version, &p.Publisher,
			&p.Changelog, &p.Description, &p.Size, &created, &p.CurrentVersion); err != nil {
			return nil, err
		}
		p.CreatedAt = parseSQLTime(created)
		out = append(out, p)
	}
	return out, rows.Err()
}

// purposeOfConfigJSON / sensitivityOfConfigJSON 从 config_json 现解投影两列。
//
// 为什么不用 appcfg.DeclarationsOfConfigJSON：serverstore 不引 wasmapp 包（依赖方向
// serverstore ← wasmapp）。解析失败回空串与 appcfg 的宽容口径同向（脏配置不该阻断部署，
// 但它本来也不会被写进来 —— 只有合法 JSON 才落库）。
func purposeOfConfigJSON(configJSON string) string {
	purpose, _ := configDeclarations(configJSON)
	return purpose
}

func sensitivityOfConfigJSON(configJSON string) string {
	_, sensitivity := configDeclarations(configJSON)
	return sensitivity
}

// configDeclarations 从 app 配置里取 purpose / data_sensitivity（缺失 = 空串）。
//
// 只解两个字段、忽略其余（与 appcfg.DeclarationsOfConfigJSON 同口径）：配置里还有
// access/whitelist 等字段，解析失败时回空串 —— 这里的产物只用于**投影列**，脏配置
// 不该阻断一次部署（它本来也不会落库，写入侧只收合法 JSON）。
func configDeclarations(configJSON string) (purpose, sensitivity string) {
	if strings.TrimSpace(configJSON) == "" {
		return "", ""
	}
	var raw struct {
		Purpose         string `json:"purpose"`
		DataSensitivity string `json:"data_sensitivity"`
	}
	if err := json.Unmarshal([]byte(configJSON), &raw); err != nil {
		return "", ""
	}
	return strings.TrimSpace(raw.Purpose), strings.TrimSpace(raw.DataSensitivity)
}

// WasmAppSnapshotSummary 把生命周期字段整理成稳定的对下面（导出/响应共用）。
func (a *WasmApp) WasmAppSnapshotSummary() map[string]any {
	if a == nil {
		return map[string]any{}
	}
	out := map[string]any{
		"current_deployment_id": a.CurrentDeploymentID,
		"snapshot_path":         a.SnapshotPath,
		"snapshot_error":        a.SnapshotError,
	}
	// 设计 §5.6 要求导出/快照的 `lifecycle` 段补齐五项：frozen_at / deleted_at /
	// purge_after / purged_at / snapshot_at。为 nil 的项照样下发 null —— 下游不必
	// 区分"字段缺失"与"这个时刻不存在"（后者本身是事实：没冻结过）。
	for key, v := range map[string]*time.Time{
		"frozen_at":  a.FrozenAt,
		"deleted_at": a.DeletedAt,
	} {
		if v != nil {
			out[key] = v
		} else {
			out[key] = nil
		}
	}
	if a.SnapshotAt != nil {
		out["snapshot_at"] = a.SnapshotAt
	} else {
		out["snapshot_at"] = nil
	}
	if a.PurgeAfter != nil {
		out["purge_after"] = a.PurgeAfter
	} else {
		out["purge_after"] = nil
	}
	if a.PurgedAt != nil {
		out["purged_at"] = a.PurgedAt
	} else {
		out["purged_at"] = nil
	}
	return out
}

// String 让部署历史在日志里可读（不用反射，字段顺序稳定）。
func (d *WasmDeployment) String() string {
	if d == nil {
		return "<nil>"
	}
	return fmt.Sprintf("deployment#%d app=%s v%s kind=%s role=%s", d.ID, d.AppID, d.Version, d.Kind, d.ActorRole)
}
