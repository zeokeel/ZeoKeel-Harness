package marketplace

import (
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// TestSkillJSONDisplayFields（2026-10-26 D 系列显示修复）:
// skillJSON 必须下发 display_name（展示名回退链的 DTO 出口）与
// quality/source/channel（webadmin 的「精选」「上传包」徽章数据源）。
//
// 缺陷形态：接口只有 name（英文目录名），管理端卡片只能拿它当标题 ——
// 中文展示名在整个管理面不可达。
func TestSkillJSONDisplayFields(t *testing.T) {
	s := serverstore.Skill{
		ID: 7, Name: "ppt-gen", DisplayName: "PPT 生成", Enabled: 1,
		Version: "1.0.0", Quality: "featured", Source: "upload", Channel: serverstore.AppChannelMarket,
	}
	out := skillJSON(s)
	if out["display_name"] != "PPT 生成" {
		t.Fatalf("display_name = %v, want PPT 生成", out["display_name"])
	}
	// API 兼容:既有 name 键保持目录名不变(客户端按 name 安装/寻址)。
	if out["name"] != "ppt-gen" {
		t.Fatalf("name = %v, want ppt-gen", out["name"])
	}
	if out["quality"] != "featured" {
		t.Fatalf("quality = %v, want featured(精选徽章)", out["quality"])
	}
	if out["source"] != "upload" {
		t.Fatalf("source = %v, want upload(上传包徽章)", out["source"])
	}
	if out["channel"] != serverstore.AppChannelMarket {
		t.Fatalf("channel = %v, want market", out["channel"])
	}
	// id 等既有键不能被本轮新增挤掉。
	if out["version"] != "1.0.0" || out["enabled"] != true {
		t.Fatalf("既有字段漂移: %+v", out)
	}
}

// TestSkillJSONDisplayNameFallsBackToName：展示名空时 DTO 自己也要回退 name，
// 不能把空串发给前端（前端虽会兜底，但契约应始终给非空展示名）。
func TestSkillJSONDisplayNameFallsBackToName(t *testing.T) {
	out := skillJSON(serverstore.Skill{Name: "legacy-skill"})
	if out["display_name"] != "legacy-skill" {
		t.Fatalf("display_name = %v, want legacy-skill", out["display_name"])
	}
	if out["channel"] != serverstore.AppChannelMarket {
		t.Fatalf("缺省 channel = %v, want market", out["channel"])
	}
}

// TestAgentJSONDisplayNameFallback：市场智能体同样要下发 display_name，
// 并保留 title 作为兼容别名（旧前端只读 title）。
func TestAgentJSONDisplayNameFallback(t *testing.T) {
	// 1) apps.title 有中文名 → display_name / title 都是它。
	out := agentJSON(
		serverstore.App{Kind: serverstore.AppKindAgent, AppID: "agent-a", Title: "组织智能体"},
		&serverstore.Release{Kind: serverstore.AppKindAgent, AppID: "agent-a", Version: "1.0.0", Title: "包内旧标题", Quality: "featured"},
	)
	if out["display_name"] != "组织智能体" {
		t.Fatalf("display_name = %v, want 组织智能体", out["display_name"])
	}
	if out["title"] != "组织智能体" {
		t.Fatalf("title 兼容别名 = %v, want 组织智能体", out["title"])
	}
	if out["quality"] != "featured" {
		t.Fatalf("quality = %v, want featured", out["quality"])
	}

	// 2) apps.title 空 → 回退展示版本 title。
	out = agentJSON(
		serverstore.App{Kind: serverstore.AppKindAgent, AppID: "agent-b"},
		&serverstore.Release{Kind: serverstore.AppKindAgent, AppID: "agent-b", Version: "2.0.0", Title: "包内中文名"},
	)
	if out["display_name"] != "包内中文名" || out["title"] != "包内中文名" {
		t.Fatalf("回退展示版本 title 失败: %+v", out)
	}

	// 3) 两处都空 → 回落 name。
	out = agentJSON(serverstore.App{Kind: serverstore.AppKindAgent, AppID: "agent-c"}, nil)
	if out["display_name"] != "agent-c" {
		t.Fatalf("空展示名回落 = %v, want agent-c", out["display_name"])
	}
}

// TestAdminDisplayNameEditable：管理端可改展示名（`title` 字段），
// 且空 title 不得清空既有展示名、不得触碰 owner（归属只走「转移归属」）。
func TestAdminDisplayNameEditable(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	// --- 技能 ---
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"cn-skill","title":"中文技能名","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	s, err := serverstore.GetSkill(db, "cn-skill")
	if err != nil {
		t.Fatal(err)
	}
	if s.DisplayName != "中文技能名" {
		t.Fatalf("创建后的展示名 = %q, want 中文技能名", s.DisplayName)
	}
	// 改展示名 + 描述。
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/cn-skill",
		`{"title":"  新中文名  ","description":"新描述","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update title: %d %s", w.Code, w.Body.String())
	}
	s, _ = serverstore.GetSkill(db, "cn-skill")
	if s.DisplayName != "新中文名" {
		t.Fatalf("更新后的展示名 = %q, want 新中文名(trim)", s.DisplayName)
	}
	if s.Description != "新描述" {
		t.Fatalf("描述 = %q, want 新描述", s.Description)
	}
	// 空 title 保持既有展示名（绝不回落成英文目录名）。
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/cn-skill",
		`{"title":"   ","description":"再改描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update with empty title: %d %s", w.Code, w.Body.String())
	}
	s, _ = serverstore.GetSkill(db, "cn-skill")
	if s.DisplayName != "新中文名" {
		t.Fatalf("空 title 清空了展示名: %q", s.DisplayName)
	}
	// owner 不随元数据 PUT 变化。
	app, _ := serverstore.GetApp(db, serverstore.AppKindSkill, "cn-skill")
	if app.Owner != "boss" {
		t.Fatalf("owner = %q, want boss(元数据 PUT 不得改归属)", app.Owner)
	}

	// --- 智能体 ---
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents",
		`{"name":"cn-agent","title":"中文智能体","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create agent: %d %s", w.Code, w.Body.String())
	}
	// 只改描述:展示名必须保持(旧实现会把请求体 name 当 title 写回)。
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/cn-agent",
		`{"description":"新描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update agent desc: %d %s", w.Code, w.Body.String())
	}
	a, _ := serverstore.GetApp(db, serverstore.AppKindAgent, "cn-agent")
	if a.Title != "中文智能体" {
		t.Fatalf("只改描述后展示名 = %q, want 中文智能体", a.Title)
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/cn-agent",
		`{"title":"新中文智能体"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update agent title: %d %s", w.Code, w.Body.String())
	}
	a, _ = serverstore.GetApp(db, serverstore.AppKindAgent, "cn-agent")
	if a.Title != "新中文智能体" {
		t.Fatalf("智能体展示名 = %q, want 新中文智能体", a.Title)
	}
	if a.Owner != "boss" {
		t.Fatalf("智能体 owner = %q, want boss(元数据 PUT 不得改归属)", a.Owner)
	}
}
