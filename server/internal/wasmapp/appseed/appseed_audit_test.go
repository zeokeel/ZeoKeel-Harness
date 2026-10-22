package appseed_test

// 播种的**部署审计**判据（2026-10-22 反证 P2-2）。
//
// 现场：播种已经走部署事务（历史行 `actor_role=seed`），但审计走的是
// `Options.Audit` → `serverstore.AuditLog` —— 那一入口写 `app_id=NULL` +
// `hash_version=1`，而应用维度审计读面是 `ListAuditLogsByApp`（按 app_id 过滤）
// ⇒ 播种的"谁把哪一版上线"在该应用的审计列表里**查不到**；`appseed_test.go`
// 也完全没有审计断言（删掉那段审计预计零红）。
//
// 本用例钉两件事：
//  1. 每个被播种的应用都有一条 `wasm_app_deploy` 审计，且带 **app_id 维度**（可从
//     `ListAuditLogsByApp` 读到）；
//  2. detail 含 `deployment_id/version/kind/actor_role`（与其它部署路径同口径）。
//
// 变异验证：
//   - 删掉 `pointSeedRelease` 里的审计调用 ⇒ 本用例红；
//   - 把 `AuditApp` 换成 `Audit`（app_id=NULL）⇒ 第 1 条红（按 app_id 查不到）。

import (
	"context"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appseed"
)

func TestSeedWritesAppScopedDeployAudit(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	var deployAudits []string
	s, err := appseed.New(appseed.Options{
		DB:       db,
		DataRoot: t.TempDir(),
		Dir:      writeDemoDir(t),
		Owner:    "admin",
		// AuditApp 是**应用维度**入口（生产装配见 cmd/server/wasmapp_demo.go）。
		AuditApp: func(appID, username, action, detail string) {
			if action == "wasm_app_deploy" {
				deployAudits = append(deployAudits, appID+"|"+detail)
			}
			_ = serverstore.AuditLogApp(db, appID, username, action, detail)
		},
	})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if len(res.Seeded) != 3 {
		t.Fatalf("应播种 3 个演示，得到 %v（跳过：%+v）", res.Seeded, res.Skipped)
	}

	// ① 每个播种出来的应用：按 app_id 查得到一条部署审计。
	for _, appID := range []string{"demo-public", "demo-login", "demo-whitelist"} {
		logs, lerr := serverstore.ListAuditLogsByApp(db, appID, 100)
		if lerr != nil {
			t.Fatalf("读 %s 的应用维度审计: %v", appID, lerr)
		}
		var detail string
		for _, l := range logs {
			if l.Action == "wasm_app_deploy" {
				detail = l.Detail
			}
		}
		if detail == "" {
			t.Fatalf("%s 没有 app_id 维度的 wasm_app_deploy 审计（播种的部署在应用审计里查不到）", appID)
		}
		// ② detail 四项齐全（与员工面/管理面部署审计同口径）。
		for _, want := range []string{"deployment_id=", "version=", "kind=seed", "actor_role=seed"} {
			if !strings.Contains(detail, want) {
				t.Fatalf("%s 的播种部署审计缺 %q；detail=%q", appID, want, detail)
			}
		}
	}
	if len(deployAudits) != 3 {
		t.Fatalf("AuditApp 收到的部署审计条数 = %d, want 3（每个演示一条）", len(deployAudits))
	}

	// ③ 幂等：再播种一次（已存在 ⇒ 跳过）不得重复写部署审计。
	res2, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("第二次 Seed: %v", err)
	}
	if len(res2.Seeded) != 0 {
		t.Fatalf("第二次播种不该新增应用（幂等），得到 %v", res2.Seeded)
	}
	if len(deployAudits) != 3 {
		t.Fatalf("第二次播种重复写了部署审计：%d → %d", 3, len(deployAudits))
	}
}
