// 本文件是 `wasm_app_limits`（迁移 0087）的**唯一 DAO**：WASM 应用的
// **应用级限流覆盖**（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2）。
//
// 语义（与迁移正文、与 applimits.AppOverride 三处必须一致）：
//
//	没有这一行  ≡  四列全 NULL  ≡  **无覆盖**（全部继承全局 settings.wasm.limits）
//	某列为 NULL  ⇒  该轴继承全局；非空 ⇒ 该轴的显式覆盖
//
// 三条纪律：
//  1. **归一化只有一处**：`SetWasmAppLimitOverride` 在"四个字段全 nil"时**删行**
//     （等价于 `ClearWasmAppLimitOverride`），读面因此永远看不到"全 NULL 的行"。
//     两个入口各写一份归一化，迟早出现"库里有一行全 NULL、而某个读面把它当成有覆盖"。
//  2. **本包不校验应用存在性**（无外键，见迁移注释）：写面"已删除/不存在 ⇒ 404"是
//     **管理 API 的职责**（它在写之前用 GetWasmApp 判定），DAO 只表达存储事实。
//     DAO 里再查一次会造出第二个判据，而"哪个先跑"决定错误码 —— 那是 API 的事。
//  3. **读面把"无覆盖"表达成 `(nil, nil)`**，不是 ErrNotFound：没有覆盖是这个表的
//     **常态**（99% 的应用都没有），把它当错误会让每个调用点写一段"这不是错误"的
//     分支，而真正该 fail-loud 的是数据库错误 —— 两者必须可区分。
package serverstore

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// WasmAppLimitOverride 是 `wasm_app_limits` 的一行：四个**可空**并发轴 + 写入证据。
//
// 指针语义即 SQL 语义（nil = 该轴继承全局）。零值 `WasmAppLimitOverride{}` 因此等于
// "无覆盖"，`IsEmpty()` 是它的唯一判据（不要在别处再写一遍四连判空）。
type WasmAppLimitOverride struct {
	// AppID 是应用域名标签（`apps.app_id`，小写）。
	AppID string `json:"app_id"`
	// AppRunning 是单应用同时运行数覆盖（nil = 继承全局）。
	AppRunning *int `json:"app_running"`
	// AppQueue 是单应用队列长度覆盖（nil = 继承全局）。
	AppQueue *int `json:"app_queue"`
	// UserPerAppRunning 是单用户单应用在跑覆盖（nil = 继承全局）。
	UserPerAppRunning *int `json:"user_per_app_running"`
	// UserPerAppQueued 是单用户单应用排队覆盖（nil = 继承全局）。
	UserPerAppQueued *int `json:"user_per_app_queued"`
	// UpdatedAt 是最近一次写入（或清空）的时刻。
	UpdatedAt time.Time `json:"updated_at"`
	// UpdatedBy 是最近一次写入的管理员用户名（空串 = 迁移/人工写入）。
	UpdatedBy string `json:"updated_by"`
}

// IsEmpty 报告这一行是否等于"无覆盖"（四轴全 nil）。
//
// 它是**归一化的唯一判据**：写入侧用它决定"删行"，读面用它把历史遗留的全 NULL 行
// 当成"没有覆盖"（迁移 0087 之前不可能有行，但人工/回滚写入不保证）。
func (o WasmAppLimitOverride) IsEmpty() bool {
	return o.AppRunning == nil && o.AppQueue == nil && o.UserPerAppRunning == nil && o.UserPerAppQueued == nil
}

// wasmAppLimitColumns 是读面投影的**唯一**列清单（列表与单查共用：两处各写一份，
// 加列时必然漏一处 —— 而漏的那一列会被静默读成 nil，看起来像"继承全局"）。
const wasmAppLimitColumns = `app_id, app_running, app_queue, user_per_app_running, user_per_app_queued, updated_at, updated_by`

// scanWasmAppLimitOverride 把一行解码成结构体（两份读面共用，见上面的列清单）。
func scanWasmAppLimitOverride(scan func(dest ...any) error) (*WasmAppLimitOverride, error) {
	var (
		ov                                  WasmAppLimitOverride
		appRunning, appQueue                sql.NullInt64
		userPerAppRunning, userPerAppQueued sql.NullInt64
	)
	if err := scan(&ov.AppID, &appRunning, &appQueue, &userPerAppRunning, &userPerAppQueued,
		&ov.UpdatedAt, &ov.UpdatedBy); err != nil {
		return nil, err
	}
	if appRunning.Valid {
		ov.AppRunning = intPtr(int(appRunning.Int64))
	}
	if appQueue.Valid {
		ov.AppQueue = intPtr(int(appQueue.Int64))
	}
	if userPerAppRunning.Valid {
		ov.UserPerAppRunning = intPtr(int(userPerAppRunning.Int64))
	}
	if userPerAppQueued.Valid {
		ov.UserPerAppQueued = intPtr(int(userPerAppQueued.Int64))
	}
	return &ov, nil
}

// intPtr 返回 v 的指针（DAO 内部用；不导出 —— 调用方不该在别处构造坐标）。
func intPtr(v int) *int { return &v }

// GetWasmAppLimitOverride 返回某应用当前的覆盖。
//
// 返回 `(nil, nil)` 表示**没有覆盖**（无行，或历史遗留的四列全 NULL 行）——
// 这不是错误（见包注释第 3 条）；`err != nil` 只表示数据库读失败。
func GetWasmAppLimitOverride(ctx context.Context, db *sql.DB, appID string) (*WasmAppLimitOverride, error) {
	var ov *WasmAppLimitOverride
	// 族内关系（见 searchPathRelations 的登记）：读面必须与写面一样在**已钉 search_path**
	// 的只读事务里读 —— 否则"shadow 同名表"会让覆盖静默读错对象（错误的上限生效，
	// 而所有健康出口报绿）。
	err := withUsageSearchPathRead(db, func(tx *sql.Tx) error {
		row := tx.QueryRowContext(ctx, `SELECT `+wasmAppLimitColumns+`
			FROM wasm_app_limits WHERE app_id = ?`, normalizeWasmAppID(appID))
		scanned, serr := scanWasmAppLimitOverride(row.Scan)
		if serr == sql.ErrNoRows {
			return nil
		}
		if serr != nil {
			return serr
		}
		ov = scanned
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("读取应用级限流覆盖: %w", err)
	}
	if ov == nil || ov.IsEmpty() {
		// 人工/回滚写入可能造出"全 NULL 的行"：它与"没有这一行"同义（迁移注释的语义），
		// 在**读面**归一，写面由 Set 的删行保证不再产生。
		return nil, nil
	}
	return ov, nil
}

// ListWasmAppLimitOverrides 返回**全部**有覆盖的应用（启动期装载进调度器用）。
//
// 只返回非空行（四列全 NULL 的历史行被过滤）：调度器里塞一条"没有覆盖的覆盖"
// 会让"有没有覆盖"这个判据在内存态里失效，而它正是"清空后回落到全局"的判据。
func ListWasmAppLimitOverrides(ctx context.Context, db *sql.DB) ([]WasmAppLimitOverride, error) {
	var out []WasmAppLimitOverride
	// 同 Get：已钉 search_path 的只读事务（族内关系，见 searchPathRelations）。
	err := withUsageSearchPathRead(db, func(tx *sql.Tx) error {
		rows, qerr := tx.QueryContext(ctx, `SELECT `+wasmAppLimitColumns+`
			FROM wasm_app_limits
			WHERE app_running IS NOT NULL OR app_queue IS NOT NULL
			   OR user_per_app_running IS NOT NULL OR user_per_app_queued IS NOT NULL
			ORDER BY app_id`)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			ov, serr := scanWasmAppLimitOverride(rows.Scan)
			if serr != nil {
				return serr
			}
			out = append(out, *ov)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("列出应用级限流覆盖: %w", err)
	}
	return out, nil
}

// SetWasmAppLimitOverride 写入/覆盖某应用的覆盖（upsert）。
//
// **四轴全 nil ⇒ 删行**（归一化，见包注释第 1 条）：这样"清空"在库里只有一种形态，
// 读面与调度器的"无覆盖"判据不会因为"一行全 NULL"而分叉。返回值报告是否真的删了行
// （调用方据此判定"这次是不是一次清空动作"，与 Clear 的返回值同义）。
//
// updatedBy 截断到审计/展示同量级（128 字节）：它是管理员用户名，超长只可能来自走样输入。
func SetWasmAppLimitOverride(ctx context.Context, db *sql.DB, ov WasmAppLimitOverride, updatedBy string) (cleared bool, err error) {
	appID := normalizeWasmAppID(ov.AppID)
	if appID == "" {
		return false, fmt.Errorf("写入应用级限流覆盖: app_id 为空")
	}
	if ov.IsEmpty() {
		return ClearWasmAppLimitOverride(ctx, db, appID)
	}
	// 族内关系的写面同样必须钉 search_path（`withUsageSearchPath` 是唯一实现）：
	// 未钉时 shadow 同名表会**静默吞掉**这次写入（管理端看到保存成功、审计也写了，
	// 而真实表一行不动 ⇒ 重启后覆盖消失）。
	err = withUsageSearchPath(db, func(tx *sql.Tx) error {
		_, eerr := tx.ExecContext(ctx, `INSERT INTO wasm_app_limits
			(app_id, app_running, app_queue, user_per_app_running, user_per_app_queued, updated_at, updated_by)
			VALUES (?, ?, ?, ?, ?, now(), ?)
			ON CONFLICT (app_id) DO UPDATE SET
				app_running          = EXCLUDED.app_running,
				app_queue            = EXCLUDED.app_queue,
				user_per_app_running = EXCLUDED.user_per_app_running,
				user_per_app_queued  = EXCLUDED.user_per_app_queued,
				updated_at           = EXCLUDED.updated_at,
				updated_by           = EXCLUDED.updated_by`,
			appID, nullableIntPtr(ov.AppRunning), nullableIntPtr(ov.AppQueue),
			nullableIntPtr(ov.UserPerAppRunning), nullableIntPtr(ov.UserPerAppQueued),
			clipBytes(updatedBy, 128))
		return eerr
	})
	if err != nil {
		return false, fmt.Errorf("写入应用级限流覆盖: %w", err)
	}
	return false, nil
}

// ClearWasmAppLimitOverride 删除某应用的覆盖（幂等：没有行也算成功）。
//
// 返回是否**真的**删掉了一行 —— 审计判据要它（"无变化重复清空不写审计"）。
func ClearWasmAppLimitOverride(ctx context.Context, db *sql.DB, appID string) (bool, error) {
	var removed int64
	// 同 Set：写面必须钉 search_path（否则删的是 shadow 行，真实覆盖永远清不掉）。
	err := withUsageSearchPath(db, func(tx *sql.Tx) error {
		res, eerr := tx.ExecContext(ctx, `DELETE FROM wasm_app_limits WHERE app_id = ?`, normalizeWasmAppID(appID))
		if eerr != nil {
			return eerr
		}
		n, aerr := res.RowsAffected()
		if aerr != nil {
			return aerr
		}
		removed = n
		return nil
	})
	if err != nil {
		return false, fmt.Errorf("清空应用级限流覆盖: %w", err)
	}
	return removed > 0, nil
}

// nullableIntPtr 把 *int 折成 pgx 接受的 NULL 或整数（`nullableInt64` 的 int 版本）。
//
// 为什么单独写而不是传 `*int`：pgx 对 `*int` 的支持依赖驱动版本，而本包既有的可空
// 整数写入统一走"nil 或值"这条路径（见 nullableInt64 的注释）—— 同一口气，不引入
// 第二种可空写法。
func nullableIntPtr(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
