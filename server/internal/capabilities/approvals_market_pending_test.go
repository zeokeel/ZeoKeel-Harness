package capabilities

// 2026-10-23「已上架技能无法更新」修复：审批队列必须能表达 **market 渠道的待审
// 版本**。
//
// 修前形态：市场技能只能由管理端直发（AdminPublish ⇒ 恒 approved），审批队列读
// 的是 sharedskills/agentshare 的组织共享库（`ListSharedSkills` / `ListAgentPresets`
// 自带 channel='org' 过滤），所以市场渠道**根本没有待审行这个概念**。修复后员工
// 归属人可以对已上架的市场技能提交新版本（落 pending），管理员必须能在同一个
// 队列里审它 —— 且 approve/reject/preview/archive 要打**市场命名空间**的端点
// （/api/server/admin/skills|agents/:name/:version…），而不是组织库的
// /shared-skills|/agent-presets（那两个命名空间对 market 行一律 404）。
//
// 变异验证：
//   - 删掉 listApprovals 里的 market pending 取数块 ⇒ TestApprovalsIncludeMarketPending* 红；
//   - 把 market 行的 BasePath 写成 /api/server/admin/shared-skills/… ⇒ 红；
//   - 把 `marketPendingIncluded` 改成恒 true ⇒ 「已通过 tab 不混市场行」断言红；
//   - 去掉渠道过滤（不判 channels[appID] == market）⇒ org 待审行会被再发一遍到
//     市场命名空间，行数断言红。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// seedApprovalApp 播种一个 App + 若干版本（不经发布内核：本文件只验证审批队列的
// 投影，版本语义由 appstore / sharedskills 的用例覆盖）。
func seedApprovalApp(t *testing.T, db *sql.DB, kind, name, channel, owner string, releases ...serverstore.Release) {
	t.Helper()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: kind, AppID: name, Title: "标题-" + name, Description: "描述-" + name,
		Owner: owner, Channel: channel, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	for _, r := range releases {
		rel := r
		rel.Kind, rel.AppID = kind, name
		if _, err := serverstore.CreateRelease(db, &rel); err != nil {
			t.Fatal(err)
		}
	}
}

// approvalsRows 取审批队列（query 形如 "" 或 "?status=approved"）。
func approvalsRows(t *testing.T, r *gin.Engine, adminHdr map[string]string, query string) []ApprovalRow {
	t.Helper()
	w := doGet(t, r, "/api/server/admin/capabilities/approvals"+query, adminHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("approvals%s = %d %s", query, w.Code, w.Body.String())
	}
	var resp struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Approvals
}

func TestApprovalsIncludeMarketPendingSkill(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()
	seedApprovalApp(t, db, serverstore.AppKindSkill, "m1", serverstore.AppChannelMarket, "alice",
		serverstore.Release{Version: "1.0.0", Title: "市场技能 v1", Publisher: "alice", Status: serverstore.ReleaseStatusApproved, Archive: []byte("PK")},
		// 归属人提交的新版本（新契约：market = 管理端直发 + 归属人可提交待审）。
		serverstore.Release{Version: "2.0.0", Title: "市场技能 v2", Publisher: "alice", Status: serverstore.ReleaseStatusPending, Archive: []byte("PK")},
	)
	rows := approvalsRows(t, r, adminHdr, "")
	var got *ApprovalRow
	for i := range rows {
		if rows[i].Name == "m1" && rows[i].Version == "2.0.0" {
			got = &rows[i]
		}
	}
	if got == nil {
		t.Fatalf("market 待审行不在审批队列里: %+v", rows)
	}
	// 渠道 + 状态
	if got.Channel != serverstore.AppChannelMarket || got.Status != "pending" || got.Kind != KindSkill {
		t.Fatalf("market 待审行投影错误: %+v", *got)
	}
	// 命名空间必须是市场（组织命名空间对 market 行 404）
	if got.BasePath != "/api/server/admin/skills/m1/2.0.0" {
		t.Fatalf("base_path=%s", got.BasePath)
	}
	if got.GrantsBase != "/api/server/admin/skills/m1" {
		t.Fatalf("grants_base=%s", got.GrantsBase)
	}
	if got.PreviewPath != "/api/server/admin/skills/m1/2.0.0/preview" {
		t.Fatalf("preview_path=%s", got.PreviewPath)
	}
	// 归属人是 apps.owner（续传权判据），作者是本行上传者。
	if got.Owner != "alice" || got.Author != "alice" {
		t.Fatalf("owner=%q author=%q", got.Owner, got.Author)
	}
	// 已通过 tab 不混市场行（市场已通过行归市场页口径）。
	for _, row := range approvalsRows(t, r, adminHdr, "?status=approved") {
		if row.Channel == serverstore.AppChannelMarket {
			t.Fatalf("已通过 tab 混入了市场行: %+v", row)
		}
	}
	// org 待审行不能被当成 market 行再发一遍（渠道过滤）。
	seedApprovalApp(t, db, serverstore.AppKindSkill, "o1", serverstore.AppChannelOrg, "alice",
		serverstore.Release{Version: "1.0.0", Title: "组织技能", Publisher: "alice", Status: serverstore.ReleaseStatusPending, Archive: []byte("PK")},
	)
	marketRows, orgRows := 0, 0
	for _, row := range approvalsRows(t, r, adminHdr, "") {
		switch row.Name {
		case "m1":
			marketRows++
		case "o1":
			orgRows++
			if row.Channel != serverstore.AppChannelOrg {
				t.Fatalf("org 行渠道投影错误: %+v", row)
			}
			if row.BasePath != "/api/server/admin/shared-skills/o1/1.0.0" {
				t.Fatalf("org base_path=%s", row.BasePath)
			}
		}
	}
	if marketRows != 1 || orgRows != 1 {
		t.Fatalf("期望 market=1 org=1, got market=%d org=%d", marketRows, orgRows)
	}
}

func TestApprovalsIncludeMarketPendingAgent(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()
	seedApprovalApp(t, db, serverstore.AppKindAgent, "ma1", serverstore.AppChannelMarket, "alice",
		serverstore.Release{Version: "1.0.0", Title: "市场智能体 v1", Publisher: "alice", Status: serverstore.ReleaseStatusApproved, Archive: []byte("PK")},
		serverstore.Release{Version: "1.1.0", Title: "市场智能体 v2", Publisher: "alice", Status: serverstore.ReleaseStatusPending, Archive: []byte("PK")},
	)
	rows := approvalsRows(t, r, adminHdr, "?type=agent")
	var got *ApprovalRow
	for i := range rows {
		if rows[i].Name == "ma1" && rows[i].Version == "1.1.0" {
			got = &rows[i]
		}
	}
	if got == nil {
		t.Fatalf("market 待审智能体不在审批队列里: %+v", rows)
	}
	if got.Channel != serverstore.AppChannelMarket || got.BasePath != "/api/server/admin/agents/ma1/1.1.0" {
		t.Fatalf("market 待审智能体投影错误: %+v", *got)
	}
	if got.PreviewPath != "/api/server/admin/agents/ma1/1.1.0/preview" {
		t.Fatalf("preview_path=%s", got.PreviewPath)
	}
}
