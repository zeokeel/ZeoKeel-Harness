package serverstore

// 迁移 0087 / wasm_app_limits DAO 的判据（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2.1）。
//
// 变异验证（改回危险实现时哪条用例必红）：
//   - SetWasmAppLimitOverride 的四轴全 nil **不删行**（写一行全 NULL）⇒
//     TestWasmAppLimitOverrideAllNilDeletesRow / TestListWasmAppLimitOverridesSkipsEmptyRows 红；
//   - GetWasmAppLimitOverride 不把"全 NULL 行"归一成无覆盖 ⇒
//     TestWasmAppLimitOverrideLegacyAllNullRowReadsAsNoOverride 红；
//   - ListWasmAppLimitOverrides 去掉空行过滤 ⇒ TestListWasmAppLimitOverridesSkipsEmptyRows 红；
//   - ClearWasmAppLimitOverride 恒返回 true（不看影响行数）⇒
//     TestClearWasmAppLimitOverrideIsIdempotent 的第二次断言红；
//   - 迁移写成"先 DROP TABLE 再建"（丢配置）⇒ TestMigration0087IsReplayable 红
//     （第二次重放后第一行的覆盖不见了）。
//
// 这些用例走**真 PG**（`go test ./...` 在没有数据库的环境里会 Skip，见 dbtest.go）。

import (
	"context"
	"testing"
)

// mustOverride 构一份四轴齐全的覆盖（测试夹具）。
func mustOverride(appID string, appRunning, appQueue, perAppRunning, perAppQueued int) WasmAppLimitOverride {
	return WasmAppLimitOverride{
		AppID:             appID,
		AppRunning:        intPtr(appRunning),
		AppQueue:          intPtr(appQueue),
		UserPerAppRunning: intPtr(perAppRunning),
		UserPerAppQueued:  intPtr(perAppQueued),
	}
}

// TestMigration0087IsReplayable 证明 0087 可重放且**不丢已有配置**。
//
// 为什么判据是"重放两次之后那一行还在"：测试夹具会把库退回旧版本再整段重放
// （0080/0081/0082/0085/0086 同口径），如果迁移里出现 `DROP TABLE` / 无
// `IF NOT EXISTS` 的建表，第二次重放要么报错、要么把管理员配好的覆盖清空。
func TestMigration0087IsReplayable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	var m87 *migration
	for _, m := range migrationsFor() {
		if m.version == 87 {
			mm := m
			m87 = &mm
		}
	}
	if m87 == nil {
		t.Fatal("找不到 0087 迁移")
	}
	if _, err := SetWasmAppLimitOverride(ctx, db, mustOverride("probe-app", 1, 2, 1, 1), "admin"); err != nil {
		t.Fatalf("写入覆盖: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := db.Exec(m87.sql); err != nil {
			t.Fatalf("重放 0087（第 %d 次）: %v", i+1, err)
		}
	}
	ov, err := GetWasmAppLimitOverride(ctx, db, "probe-app")
	if err != nil {
		t.Fatalf("重放后读取覆盖: %v", err)
	}
	if ov == nil || ov.AppRunning == nil || *ov.AppRunning != 1 {
		t.Fatalf("重放后覆盖丢了（迁移不是幂等/不动数据）：%+v", ov)
	}
}

// TestMigration0087RejectsNonPositive 证明 CHECK 真的挡住"0 或负数"这类必然无意义的落库值
// （绝对上界仍在 Go 侧判：DB 只挡"连语义都不成立"的值）。
func TestMigration0087RejectsNonPositive(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	for _, col := range []string{"app_running", "app_queue", "user_per_app_running", "user_per_app_queued"} {
		if _, err := db.Exec(`INSERT INTO wasm_app_limits (app_id, ` + col + `) VALUES ('probe-zero', 0)`); err == nil {
			t.Fatalf("%s = 0 必须被 CHECK 拒绝", col)
		}
		if _, err := db.Exec(`INSERT INTO wasm_app_limits (app_id, ` + col + `) VALUES ('probe-negative', -3)`); err == nil {
			t.Fatalf("%s = -3 必须被 CHECK 拒绝", col)
		}
	}
}

// TestWasmAppLimitOverrideRoundTrip 覆盖"部分覆盖"的读写：只有 app_running 有值时，
// 其余三轴必须是 nil（= 继承），否则生效值会被静默钉死在 0。
func TestWasmAppLimitOverrideRoundTrip(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := SetWasmAppLimitOverride(ctx, db, WasmAppLimitOverride{
		AppID: "App-With-Partial", AppRunning: intPtr(1),
	}, "admin"); err != nil {
		t.Fatalf("写入部分覆盖: %v", err)
	}
	ov, err := GetWasmAppLimitOverride(ctx, db, "app-with-partial") // 大小写不敏感（归一化）
	if err != nil {
		t.Fatalf("读取: %v", err)
	}
	if ov == nil {
		t.Fatal("刚写入的覆盖读不到")
	}
	if ov.AppID != "app-with-partial" {
		t.Fatalf("app_id = %q，want 归一化后的小写", ov.AppID)
	}
	if ov.AppRunning == nil || *ov.AppRunning != 1 {
		t.Fatalf("app_running = %v，want 1", ov.AppRunning)
	}
	if ov.AppQueue != nil || ov.UserPerAppRunning != nil || ov.UserPerAppQueued != nil {
		t.Fatalf("未提供的三轴必须为 nil（继承），得到 %+v", ov)
	}
	if ov.UpdatedBy != "admin" || ov.UpdatedAt.IsZero() {
		t.Fatalf("写入证据缺失：%q / %v", ov.UpdatedBy, ov.UpdatedAt)
	}

	// upsert：第二次写入必须覆盖而不是新增（主键约束）。
	if _, err := SetWasmAppLimitOverride(ctx, db, mustOverride("app-with-partial", 2, 4, 2, 2), "ops"); err != nil {
		t.Fatalf("第二次写入: %v", err)
	}
	ov, err = GetWasmAppLimitOverride(ctx, db, "app-with-partial")
	if err != nil || ov == nil {
		t.Fatalf("第二次写入后读取: %v / %+v", err, ov)
	}
	if *ov.AppRunning != 2 || *ov.AppQueue != 4 || ov.UpdatedBy != "ops" {
		t.Fatalf("upsert 没覆盖旧值：%+v", ov)
	}
}

// TestWasmAppLimitOverrideAllNilDeletesRow 钉住"四轴全 nil = 无覆盖"的归一化：
// 写入侧必须**删行**（而不是留一行全 NULL），否则库里出现两种"没有覆盖"的形态。
func TestWasmAppLimitOverrideAllNilDeletesRow(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := SetWasmAppLimitOverride(ctx, db, mustOverride("app-x", 2, 8, 2, 2), "admin"); err != nil {
		t.Fatalf("先写一条覆盖: %v", err)
	}
	cleared, err := SetWasmAppLimitOverride(ctx, db, WasmAppLimitOverride{AppID: "app-x"}, "admin")
	if err != nil {
		t.Fatalf("写入空覆盖: %v", err)
	}
	if !cleared {
		t.Fatal("四轴全 nil 必须等价于清空覆盖（删行），返回 cleared=true")
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_limits WHERE app_id = 'app-x'`).Scan(&n); err != nil {
		t.Fatalf("计数: %v", err)
	}
	if n != 0 {
		t.Fatalf("全 nil 覆盖必须删行，得到 %d 行", n)
	}
	ov, gerr := GetWasmAppLimitOverride(ctx, db, "app-x")
	if gerr != nil || ov != nil {
		t.Fatalf("删除后读取应为 (nil,nil)，得到 %v / %+v", gerr, ov)
	}
}

// TestWasmAppLimitOverrideLegacyAllNullRowReadsAsNoOverride 证明**历史遗留的全 NULL 行**
// 读面归一成"无覆盖"（迁移语义：没有这一行 ≡ 四列全 NULL）。
func TestWasmAppLimitOverrideLegacyAllNullRowReadsAsNoOverride(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	mustExec(t, db, `INSERT INTO wasm_app_limits (app_id) VALUES ('legacy-nulls')`)
	ov, err := GetWasmAppLimitOverride(ctx, db, "legacy-nulls")
	if err != nil {
		t.Fatalf("读取: %v", err)
	}
	if ov != nil {
		t.Fatalf("全 NULL 行必须读成「无覆盖」(nil)，得到 %+v", ov)
	}
}

// TestClearWasmAppLimitOverrideIsIdempotent：清空是幂等的，但返回值必须如实报告
// "这次到底删没删到东西"（API 靠它决定"无变化不写审计"）。
func TestClearWasmAppLimitOverrideIsIdempotent(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := SetWasmAppLimitOverride(ctx, db, mustOverride("app-clear", 1, 4, 1, 1), "admin"); err != nil {
		t.Fatalf("写入覆盖: %v", err)
	}
	cleared, err := ClearWasmAppLimitOverride(ctx, db, "app-clear")
	if err != nil || !cleared {
		t.Fatalf("第一次清空：cleared=%v err=%v，want true/nil", cleared, err)
	}
	cleared, err = ClearWasmAppLimitOverride(ctx, db, "app-clear")
	if err != nil || cleared {
		t.Fatalf("第二次清空（幂等）：cleared=%v err=%v，want false/nil", cleared, err)
	}
}

// TestListWasmAppLimitOverridesSkipsEmptyRows：启动期装载只拿"真有覆盖"的应用。
//
// 混入一行全 NULL（模拟人工/回滚写入）后，列表必须仍然只有两条真实覆盖 ——
// 把空行塞进调度器会让"有没有覆盖"这个内存判据永远为真。
func TestListWasmAppLimitOverridesSkipsEmptyRows(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	if _, err := SetWasmAppLimitOverride(ctx, db, mustOverride("app-a", 1, 4, 1, 1), "admin"); err != nil {
		t.Fatalf("写入 app-a: %v", err)
	}
	if _, err := SetWasmAppLimitOverride(ctx, db, WasmAppLimitOverride{
		AppID: "app-b", UserPerAppQueued: intPtr(2),
	}, "admin"); err != nil {
		t.Fatalf("写入 app-b: %v", err)
	}
	mustExec(t, db, `INSERT INTO wasm_app_limits (app_id) VALUES ('app-empty')`)

	list, err := ListWasmAppLimitOverrides(ctx, db)
	if err != nil {
		t.Fatalf("列表: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("列表长度 = %d，want 2（全 NULL 行必须被过滤）：%+v", len(list), list)
	}
	if list[0].AppID != "app-a" || list[1].AppID != "app-b" {
		t.Fatalf("列表顺序/内容 = %+v，want app-a、app-b（按 app_id 排序）", list)
	}
	if list[1].UserPerAppQueued == nil || *list[1].UserPerAppQueued != 2 {
		t.Fatalf("app-b 的覆盖读错了：%+v", list[1])
	}
}
