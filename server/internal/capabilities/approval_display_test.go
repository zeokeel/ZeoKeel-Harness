package capabilities

import (
	"encoding/json"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// approvalRowDisplay 从审批队列响应里按 name 取 display_name。
func approvalRowDisplay(t *testing.T, body []byte, name string) string {
	t.Helper()
	var out struct {
		Approvals []struct {
			Name        string `json:"name"`
			DisplayName string `json:"display_name"`
			Owner       string `json:"owner"`
		} `json:"approvals"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode approvals: %v (%s)", err, string(body))
	}
	for _, row := range out.Approvals {
		if row.Name == name {
			return row.DisplayName
		}
	}
	t.Fatalf("审批队列里没有 %q: %s", name, string(body))
	return ""
}

// TestApprovalsDisplayNameFallsBackToAppTitle（2026-10-26 D 系列显示修复）:
// 审批行的 DisplayName 为空时,服务端必须回退 App 级 title,而不是把空串发给
// 管理端（webadmin 只能拿英文目录名当标题）。市场待审行（版本 title 常为空）
// 与组织行（包内 title 缺失）两条来源都要覆盖。
func TestApprovalsDisplayNameFallsBackToAppTitle(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()

	// --- 市场渠道:App 展示名在 apps.title,待审版本 title 为空 ---
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "market-skill", Title: "市场中文名",
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: "market-skill", Version: "1.1.0",
		Title: "", Author: "boss", Publisher: "boss",
		Status: serverstore.ReleaseStatusPending, Archive: []byte("PK\x03\x04"),
	}); err != nil {
		t.Fatal(err)
	}

	// --- 组织渠道:共享技能行 display_name 为空,App 级 title 有中文名 ---
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{
		Name: "org-skill", Version: "1.0.0", Author: "alice",
		Status: serverstore.SharedSkillPending,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppTitle(db, serverstore.AppKindSkill, "org-skill", "组织中文名"); err != nil {
		t.Fatal(err)
	}

	w := doGet(t, r, "/api/server/admin/capabilities/approvals?status=pending&type=skill", adminHdr)
	if w.Code != 200 {
		t.Fatalf("approvals status=%d body=%s", w.Code, w.Body.String())
	}
	if got := approvalRowDisplay(t, w.Body.Bytes(), "market-skill"); got != "市场中文名" {
		t.Fatalf("市场待审行 display_name = %q, want 市场中文名(App 级 title 回退)", got)
	}
	if got := approvalRowDisplay(t, w.Body.Bytes(), "org-skill"); got != "组织中文名" {
		t.Fatalf("组织待审行 display_name = %q, want 组织中文名(App 级 title 回退)", got)
	}

	// 行级展示名(版本/共享行 title)非空时优先于 App 级 title —— 回退只在空值发生。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{
		Name: "org-named", Version: "1.0.0", Author: "alice",
		DisplayName: "行级中文名", Status: serverstore.SharedSkillPending,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppTitle(db, serverstore.AppKindSkill, "org-named", "App 级名字"); err != nil {
		t.Fatal(err)
	}
	w = doGet(t, r, "/api/server/admin/capabilities/approvals?status=pending&type=skill", adminHdr)
	if got := approvalRowDisplay(t, w.Body.Bytes(), "org-named"); got != "行级中文名" {
		t.Fatalf("display_name = %q, want 行级中文名(行级优先)", got)
	}
}
