package serverstore

// 迁移 0089（诊断版本维度）判据：可重放、列存在、索引存在、老行不丢。
// 变异：迁移退化成 `DROP TABLE`/无 IF NOT EXISTS ⇒ 重放报错或丢事件行。

import (
	"context"
	"testing"
)

func TestMigration0089IsReplayable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	var m89 *migration
	for _, m := range migrationsFor() {
		if m.version == 89 {
			mm := m
			m89 = &mm
		}
	}
	if m89 == nil {
		t.Fatal("找不到 0089 迁移")
	}
	if _, err := db.Exec(`INSERT INTO wasm_call_events (app_id, version, user_id, outcome)
		VALUES ('m89-app', '1.2.3', 7, 'ok')`); err != nil {
		t.Fatalf("写事件: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := db.Exec(m89.sql); err != nil {
			t.Fatalf("重放 0089（第 %d 次）: %v", i+1, err)
		}
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM wasm_call_events
		WHERE app_id = 'm89-app' AND version = '1.2.3'`).Scan(&n); err != nil {
		t.Fatalf("查事件: %v", err)
	}
	if n != 1 {
		t.Fatalf("重放 0089 不得丢失既有事件行（得到 %d 行）", n)
	}
	var col int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_name = 'wasm_call_events' AND column_name = 'version'`).Scan(&col); err != nil {
		t.Fatalf("查列: %v", err)
	}
	if col != 1 {
		t.Fatal("version 列不存在")
	}
	var idx int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_indexes
		WHERE tablename = 'wasm_call_events' AND indexname = 'idx_wasm_call_events_app_version'`).Scan(&idx); err != nil {
		t.Fatalf("查索引: %v", err)
	}
	if idx != 1 {
		t.Fatal("idx_wasm_call_events_app_version 不存在")
	}
}
