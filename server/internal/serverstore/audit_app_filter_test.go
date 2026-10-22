package serverstore

// 管理端按应用查审计（2026-10-22 生产评审管理员视角 P2）：DAO 早就有 app 维度，
// HTTP 面此前只透 action/username ⇒ "谁对这个应用做过什么"不可查。
//
// 变异：DAO 忽略 appID 过滤（退回 listAuditLogs 不传 appID）⇒ 本用例红。

import (
	"context"
	"testing"
)

func TestListAuditLogsPagedFilteredByApp(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	if err := AuditLogApp(db, "app-a", "alice", "wasm_app_purge", "a1"); err != nil {
		t.Fatalf("写 a1: %v", err)
	}
	if err := AuditLogApp(db, "app-b", "bob", "wasm_app_purge", "b1"); err != nil {
		t.Fatalf("写 b1: %v", err)
	}
	if err := AuditLogApp(db, "app-a", "carol", "wasm_app_release_approve", "a2"); err != nil {
		t.Fatalf("写 a2: %v", err)
	}

	logs, total, err := ListAuditLogsPagedFilteredByApp(db, 0, 100, "", "", "APP-A") // 大小写不敏感
	if err != nil {
		t.Fatalf("查询: %v", err)
	}
	if total != 2 || len(logs) != 2 {
		t.Fatalf("app-a 审计 = %d 条（total=%d），want 2", len(logs), total)
	}
	for _, l := range logs {
		if l.AppID != "app-a" {
			t.Fatalf("混入其他应用审计：%+v", l)
		}
	}

	// 带 action 过滤。
	logs, total, err = ListAuditLogsPagedFilteredByApp(db, 0, 100, "wasm_app_purge", "", "app-a")
	if err != nil {
		t.Fatalf("查询(action): %v", err)
	}
	if total != 1 || len(logs) != 1 || logs[0].Detail != "a1" {
		t.Fatalf("app-a + action 过滤 = %d 条（total=%d）：%+v", len(logs), total, logs)
	}

	// 空 app_id 必须拒（空串聚合全部 = 把 app 维度静默变成全局视图）。
	if _, _, err := ListAuditLogsPagedFilteredByApp(db, 0, 10, "", "", "  "); err == nil {
		t.Fatal("空 app_id 必须报错")
	}
	_ = ctx
}
