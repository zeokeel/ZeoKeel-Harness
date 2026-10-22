package serverstore

// 0086（WASM 应用平台生命周期重设计：部署历史 + apps 时间线列 + withdrawn 终态）
// 的回归。手法与 migration_0075_0076_test.go 一致：先只应用到 0085 造"升级前"的库，
// 再应用 0086，逐条断言**数据改写**（回填恰好一条 legacy 部署 / 指针补齐）与**结构**
// （新列、CHECK 放宽、无外键）。
//
// 为什么这条迁移必须单独钉住（设计 docs/planning/2026-10-22-wasm-lifecycle-redesign.md §9.1）：
//   - 回填的判据是 `NOT EXISTS`，**每应用至多一条**；漏了这个谓词，重放会追加第二条 →
//     "每个应用的历史里有两行完全相同的 legacy 部署"（审计面永久错数）；
//   - `current_deployment_id` 的回填是**幂等 UPDATE**（只写 0 值行）；漏了
//     `current_deployment_id = 0` 谓词会把手工修过的指针覆盖掉；
//   - 版本状态 CHECK 必须真的放宽到包含 withdrawn（否则撤回路径运行期 500）；
//     同时必须**仍然拒绝**未知状态（放宽 ≠ 取消约束）。
//
// 变异验证（每条都对应一条会让本文件变红的改动）：
//   - 删掉回填 INSERT 的 `NOT EXISTS (...)` ⇒ TestMigration0086BackfillsLegacyDeployment
//     的"重放后仍然恰好一条"断言红；
//   - 删掉 UPDATE 的 `AND a.current_deployment_id = 0` ⇒
//     TestMigration0086PointerBackfillTakesLatestAndSkipsPurged 的"手工修过的指针不被覆盖"红；
//   - 把 UPDATE 的 `ORDER BY app_id, id DESC` 改回升序（最早一条）⇒ 同一用例的
//     "指向最近一条"红；
//   - 删掉 UPDATE 的 `AND a.purged_at IS NULL` ⇒ 同一用例的"已真删应用指针保持 0"红；
//   - 把 `ADD CONSTRAINT ... status IN (...)` 里的 withdrawn 删掉 ⇒
//     TestMigration0086ReleaseStatusAllowsWithdrawn 红（withdrawn 写入被 CHECK 拒）；
//   - 把 CHECK 换成无条件 `CHECK (true)` ⇒ TestMigration0086ReleaseStatusAllowsWithdrawn
//     的"未知状态被拒"断言红；
//   - 给 wasm_app_deployments 加外键 ⇒ TestMigration0086DeploymentsHaveNoForeignKey 红。

import (
	"context"
	"database/sql"
	"testing"
)

// countDeployments 统计某应用的部署历史行数（迁移回填的判据）。
func countDeployments(t *testing.T, db *sql.DB, appID string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM wasm_app_deployments WHERE app_id = $1`, appID).Scan(&n); err != nil {
		t.Fatalf("统计部署历史失败: %v", err)
	}
	return n
}

// constraintExists 判定某个约束是否存在。
func constraintExists(t *testing.T, db *sql.DB, table, name string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM pg_constraint
		WHERE conrelid = $1::regclass AND conname = $2)`, table, name).Scan(&ok); err != nil {
		t.Fatalf("查约束 %s.%s: %v", table, name, err)
	}
	return ok
}

// TestMigration0086BackfillsLegacyDeployment 覆盖迁移 §4 的第 3/4 段：
// 存量应用补**恰好一条** legacy 部署、指针补齐、重放幂等。
func TestMigration0086BackfillsLegacyDeployment(t *testing.T) {
	post := applyPreThen(t, 85)
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	// 前置：0085 时目标表/列都不存在（证明这个用例真的在测迁移）。
	if tableExists(t, db, "wasm_app_deployments") {
		t.Fatal("前置条件失败：0085 时不该有 wasm_app_deployments")
	}
	if scalarInt(t, db, `SELECT COUNT(*) FROM information_schema.columns
		WHERE table_name = 'apps' AND column_name = 'current_deployment_id'`) != 0 {
		t.Fatal("前置条件失败：0085 时 apps 不该有 current_deployment_id")
	}

	// 升级前的存量数据：两个应用（一个带生效版本、一个全新无版本），一个 channel 行。
	mustExec(t, db, `INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled, purpose,
		data_sensitivity, config_json, current_release_id, official, created_at, updated_at)
		VALUES ('wasm_app','legacy-a','旧应用A','描述A','alice','wasm',1,'演示','internal','{"access":"login"}',0,0,
		        '2026-09-01 00:00:00+08','2026-09-02 00:00:00+08')`)
	mustExec(t, db, `INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled, purpose,
		data_sensitivity, config_json, current_release_id, official, created_at, updated_at)
		VALUES ('wasm_app','legacy-b','旧应用B','','alice','wasm',1,'','','',0,0,now(),now())`)
	mustExec(t, db, `INSERT INTO app_releases (kind, app_id, version, title, description, changelog, publisher,
		checksum, size, archive, status)
		VALUES ('wasm_app','legacy-a','1.0.0','旧应用A','描述A','首版','alice','sum-a',3,decode('000102','hex'),'approved')`)
	mustExec(t, db, `UPDATE apps SET current_release_id = (SELECT id FROM app_releases WHERE app_id = 'legacy-a')
		WHERE app_id = 'legacy-a'`)

	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0086: %v", err)
	}
	if !tableExists(t, db, "wasm_app_deployments") {
		t.Fatal("0086 之后部署历史表必须存在")
	}

	// ① 回填：**恰好一条**、kind/actor_role=legacy、指向该应用的生效版本。
	if n := countDeployments(t, db, "legacy-a"); n != 1 {
		t.Fatalf("带生效版本的存量应用应回填恰好 1 条 legacy 部署，得到 %d", n)
	}
	if n := countDeployments(t, db, "legacy-b"); n != 0 {
		t.Fatalf("没有生效版本的存量应用不该被回填任何部署，得到 %d", n)
	}
	var (
		kind, actorRole, version string
		releaseID                int64
	)
	if err := db.QueryRow(`SELECT kind, actor_role, version, release_id FROM wasm_app_deployments
		WHERE app_id = 'legacy-a'`).Scan(&kind, &actorRole, &version, &releaseID); err != nil {
		t.Fatalf("读回填行: %v", err)
	}
	if kind != DeployKindLegacy || actorRole != ActorRoleLegacy {
		t.Fatalf("回填行 kind/actor_role = %q/%q, want legacy/legacy", kind, actorRole)
	}
	if version != "1.0.0" {
		t.Fatalf("回填行 version = %q, want 1.0.0（必须取 app_releases.version，不能编）", version)
	}
	// ② 指针补齐：apps.current_deployment_id 必须**逐字等于**那条回填行的 id。
	// 这里刻意写成"与实际行 id 比较"：(ptr != releaseID && ptr == 0) 那样的写法等价于
	// 只判 0，**从不验证它指向谁**（2026-10-22 反证 P1-1）—— 指到别的应用的行、或
	// 取到最早而不是最近一条，都能蒙混过去。
	var legacyID int64
	if err := db.QueryRow(`SELECT id FROM wasm_app_deployments WHERE app_id = 'legacy-a'`).Scan(&legacyID); err != nil {
		t.Fatalf("读回填行 id: %v", err)
	}
	var ptr int64
	if err := db.QueryRow(`SELECT current_deployment_id FROM apps WHERE app_id = 'legacy-a'`).Scan(&ptr); err != nil {
		t.Fatalf("读 current_deployment_id: %v", err)
	}
	if ptr != legacyID {
		t.Fatalf("current_deployment_id = %d, want %d（必须指向该应用回填的那条 legacy 部署，release_id=%d）",
			ptr, legacyID, releaseID)
	}

	// ③ 幂等重放：删掉版本行（**不删库对象**）后再应用一次 0086 —— 与真实重放同形。
	if _, err := db.ExecContext(ctx, `DELETE FROM schema_migrations WHERE version = 86`); err != nil {
		t.Fatalf("删版本行: %v", err)
	}
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("重放 0086 必须幂等（真实失败形态：列/表/约束已存在）: %v", err)
	}
	if n := countDeployments(t, db, "legacy-a"); n != 1 {
		t.Fatalf("重放后 legacy-a 的部署历史 = %d 条，want 1（回填缺 NOT EXISTS 谓词会在这里翻倍）", n)
	}
	if n := countDeployments(t, db, "legacy-b"); n != 0 {
		t.Fatalf("重放后 legacy-b 的部署历史 = %d 条，want 0", n)
	}
	if err := db.QueryRow(`SELECT current_deployment_id FROM apps WHERE app_id = 'legacy-a'`).Scan(&ptr); err != nil {
		t.Fatalf("重放后读 current_deployment_id: %v", err)
	}
	if ptr != legacyID {
		t.Fatalf("重放后 current_deployment_id = %d, want %d（幂等 UPDATE 必须收敛到同一条）", ptr, legacyID)
	}
}

// TestMigration0086PointerBackfillTakesLatestAndSkipsPurged 钉住回填 UPDATE 的三条硬要求
// （2026-10-22 反证 7e / P1-1 的 M11、M12 判据）：
//
//	① 取**最近一条**部署（ORDER BY id DESC）—— 改成升序（最早一条）本用例红；
//	② 只写 0 值（手工修过的指针不被迁移覆盖）—— 删掉 `current_deployment_id = 0` 本用例红；
//	③ 不碰已真删的应用（purged_at IS NOT NULL）—— 删掉该谓词本用例红。
//
// 构造手法：先让 0086 正常落地（此时应用有 1 条 legacy 历史），再手工追加两条更新的
// 历史行并把指针清零，然后**重放** 0086 —— 与真实"补数后重跑迁移"的形态一致。
func TestMigration0086PointerBackfillTakesLatestAndSkipsPurged(t *testing.T) {
	post := applyPreThen(t, 85)
	db, cleanup := newTestDB(t)
	defer cleanup()

	mustExec(t, db, `INSERT INTO apps (kind, app_id, title, owner, channel, enabled, current_release_id)
		VALUES ('wasm_app','ptr-app','指针应用','alice','wasm',1,0)`)
	mustExec(t, db, `INSERT INTO app_releases (kind, app_id, version, title, publisher, checksum, size, archive, status)
		VALUES ('wasm_app','ptr-app','1.0.0','指针应用','alice','sum',3,decode('000102','hex'),'approved')`)
	mustExec(t, db, `UPDATE apps SET current_release_id = (SELECT id FROM app_releases WHERE app_id = 'ptr-app')
		WHERE app_id = 'ptr-app'`)

	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0086: %v", err)
	}
	// 追加两条"更新"的历史行（模拟 0086 之后又发生过部署），并把指针清零 —— 重放时
	// 必须把指针补到**最近一条**（id 最大的那条），而不是最早那条 legacy。
	mustExec(t, db, `INSERT INTO wasm_app_deployments (app_id, release_id, version, kind, actor_role, created_at)
		VALUES ('ptr-app', (SELECT id FROM app_releases WHERE app_id='ptr-app'), '1.0.0', 'publish', 'owner', now()),
		       ('ptr-app', (SELECT id FROM app_releases WHERE app_id='ptr-app'), '1.0.0', 'rollback', 'owner', now())`)
	mustExec(t, db, `UPDATE apps SET current_deployment_id = 0 WHERE app_id = 'ptr-app'`)
	var newestID int64
	if err := db.QueryRow(`SELECT MAX(id) FROM wasm_app_deployments WHERE app_id = 'ptr-app'`).Scan(&newestID); err != nil {
		t.Fatalf("读最近部署 id: %v", err)
	}

	mustExec(t, db, `DELETE FROM schema_migrations WHERE version = 86`)
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("重放 0086: %v", err)
	}
	var ptr int64
	if err := db.QueryRow(`SELECT current_deployment_id FROM apps WHERE app_id = 'ptr-app'`).Scan(&ptr); err != nil {
		t.Fatalf("读 current_deployment_id: %v", err)
	}
	if ptr != newestID {
		t.Fatalf("重放后 current_deployment_id = %d, want %d（最近一条；取最早一条说明 ORDER BY 方向反了）",
			ptr, newestID)
	}

	// ② 手工修过的指针不得被覆盖：把它指向最早一条，重放后必须原样保留。
	var oldestID int64
	if err := db.QueryRow(`SELECT MIN(id) FROM wasm_app_deployments WHERE app_id = 'ptr-app'`).Scan(&oldestID); err != nil {
		t.Fatalf("读最早部署 id: %v", err)
	}
	mustExec(t, db, `UPDATE apps SET current_deployment_id = $1 WHERE app_id = 'ptr-app'`, oldestID)
	mustExec(t, db, `DELETE FROM schema_migrations WHERE version = 86`)
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("重放 0086（第二次）: %v", err)
	}
	if err := db.QueryRow(`SELECT current_deployment_id FROM apps WHERE app_id = 'ptr-app'`).Scan(&ptr); err != nil {
		t.Fatalf("读 current_deployment_id（第二次）: %v", err)
	}
	if ptr != oldestID {
		t.Fatalf("重放覆盖了手工修正的指针：%d → %d（迁移只该补 0 值行，不该重新裁决现状）", oldestID, ptr)
	}

	// ③ 已真删的应用：指针清零后重放不得把它指回去。
	mustExec(t, db, `UPDATE apps SET current_deployment_id = 0, purged_at = now() WHERE app_id = 'ptr-app'`)
	mustExec(t, db, `DELETE FROM schema_migrations WHERE version = 86`)
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("重放 0086（第三次）: %v", err)
	}
	if err := db.QueryRow(`SELECT current_deployment_id FROM apps WHERE app_id = 'ptr-app'`).Scan(&ptr); err != nil {
		t.Fatalf("读 current_deployment_id（第三次）: %v", err)
	}
	if ptr != 0 {
		t.Fatalf("重放把已真删应用的指针指回 %d（purged 的应用不该再有生效版本）", ptr)
	}
}

// TestMigration0086ReleaseStatusAllowsWithdrawn 钉住版本状态机：withdrawn 可以落库，
// 未知状态被 CHECK 拒（放宽 ≠ 取消约束）。
func TestMigration0086ReleaseStatusAllowsWithdrawn(t *testing.T) {
	post := applyPreThen(t, 85)
	db, cleanup := newTestDB(t)
	defer cleanup()

	mustExec(t, db, `INSERT INTO apps (kind, app_id, title, owner, channel, enabled)
		VALUES ('wasm_app','status-app','状态应用','alice','wasm',1)`)
	mustExec(t, db, `INSERT INTO app_releases (kind, app_id, version, title, publisher, checksum, size, archive, status)
		VALUES ('wasm_app','status-app','1.0.0','状态应用','alice','sum',3,decode('000102','hex'),'pending')`)

	// 迁移前：withdrawn 不是合法状态（证明下面的通过是**迁移**带来的）。
	if _, err := db.Exec(`UPDATE app_releases SET status = 'withdrawn' WHERE app_id = 'status-app'`); err == nil {
		t.Fatal("前置条件失败：0085 的 CHECK 不该允许 withdrawn（否则本用例测不到迁移的放宽）")
	}

	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0086: %v", err)
	}
	// 迁移后：withdrawn 可写入（撤回路径依赖它）。
	if _, err := db.Exec(`UPDATE app_releases SET status = 'withdrawn' WHERE app_id = 'status-app'`); err != nil {
		t.Fatalf("0086 之后 withdrawn 必须被接受（否则「作者撤回」运行期 500）: %v", err)
	}
	// 未知状态仍然被拒（CHECK 被放宽而不是被取消）。
	if _, err := db.Exec(`UPDATE app_releases SET status = 'bogus' WHERE app_id = 'status-app'`); err == nil {
		t.Fatal("0086 的 CHECK 必须仍然拒绝未知状态（放宽 ≠ 取消约束）")
	}
	if !constraintExists(t, db, "app_releases", "app_releases_status_check") {
		t.Fatal("约束名 app_releases_status_check 必须保留（下一次放宽要靠它 DROP）")
	}
}

// TestMigration0086DeploymentsHaveNoForeignKey 钉住"部署历史不加外键"这条决定。
//
// 两个方向都会坏：ON DELETE CASCADE ⇒ 真删/清库时历史被连带删掉（历史永不删除的承诺
// 落空）；ON DELETE RESTRICT ⇒ purge 删不掉版本行。判据只能看结构（运行期两者都能跑通）。
func TestMigration0086DeploymentsHaveNoForeignKey(t *testing.T) {
	post := applyPreThen(t, 85)
	db, cleanup := newTestDB(t)
	defer cleanup()
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0086: %v", err)
	}
	var fkCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pg_constraint
		WHERE conrelid = 'wasm_app_deployments'::regclass AND contype = 'f'`).Scan(&fkCount); err != nil {
		t.Fatalf("查外键: %v", err)
	}
	if fkCount != 0 {
		t.Fatalf("wasm_app_deployments 不得有外键（真删后历史仍要留；且外键会阻塞 purge），实际 %d 个", fkCount)
	}
	// kind 的 CHECK 必须存在且覆盖五种 kind（写错 kind 的应用/回滚会被静默记成一种）。
	for _, kind := range []string{DeployKindPublish, DeployKindReview, DeployKindRollback, DeployKindSeed, DeployKindLegacy} {
		if _, err := db.Exec(`INSERT INTO wasm_app_deployments (app_id, release_id, version, kind, actor_role)
			VALUES ('fk-app', 1, '1.0.0', $1, 'owner')`, kind); err != nil {
			t.Fatalf("kind=%s 必须被接受: %v", kind, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO wasm_app_deployments (app_id, release_id, version, kind, actor_role)
		VALUES ('fk-app', 1, '1.0.0', 'canary', 'owner')`); err == nil {
		t.Fatal("kind 必须是封闭集合（未知 kind 会让'发布 vs 回滚'的统计静默错数）")
	}
}

// scalarInt 是本文件的极小读取夹具（与其它迁移用例一致的直接 SQL 风格）。
// mustExec 复用 migrate_lock_budget_test.go 的同名夹具（args 变参，已能覆盖本文件的用法）。
func scalarInt(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("查询失败 (%s): %v", query, err)
	}
	return n
}
