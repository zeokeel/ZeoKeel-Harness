package serverstore

// 2026-10-23「已上架技能无法更新」修复（C4）：作者面（「我的」）改为**全渠道**。
//
// 缺陷现场：ListOwnedSharedSkills / ListOwnedAgentPresets 此前只取
// channel='org' 的 release —— 归属人自己的**市场**内容（含 pending/rejected
// 与下架行）在作者面完全不可见，作者既看不到自己已上架的市场内容，也没有
// 任何入口续发新版本。修复后作者面的取数是「apps.owner == viewer 的任意渠道、
// 忽略上下架」，并把行渠道（apps.channel）投影进 DTO，让消费方（能力中心
// 「我的」分区）能按行下发 source。
//
// 分发面**不得**跟着扩大：ListVisibleSharedSkills / ListSharedSkills 仍是
// org only（市场行由 marketplace 的端点服务，混进来会让组织库的审批/删除
// 按钮作用于市场内容）。
//
// 每条用例的注释写明「变异什么会红」。

import (
	"database/sql"
	"testing"
)

// seedFaceApp 落一条 apps + 一条 approved release（不经过 appstore 发布内核，
// 避免 serverstore → appstore 的循环依赖）；渠道、归属、上下架由参数指定。
func seedFaceApp(t *testing.T, db *sql.DB, kind, appID, channel, owner string, enabled int, status string) {
	t.Helper()
	if err := UpsertApp(db, &App{
		Kind: kind, AppID: appID, Title: appID + " 标题", Description: "夹具描述",
		Channel: channel, Owner: owner, Enabled: enabled,
	}); err != nil {
		t.Fatalf("夹具 apps 行 %s: %v", appID, err)
	}
	if _, err := CreateRelease(db, &Release{
		Kind: kind, AppID: appID, Version: "1.0.0", Title: appID + " 标题",
		Description: "夹具描述", Publisher: owner, Status: status, Archive: []byte("zip"),
	}); err != nil {
		t.Fatalf("夹具 release %s: %v", appID, err)
	}
}

// namesOfSkills / namesOfPresets 只用于失败信息（按名称列出实际行）。
func namesOfSkills(rows []SharedSkill) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Name+"@"+r.Version+"("+r.Channel+")")
	}
	return out
}

func namesOfPresets(rows []AgentPreset) []string {
	out := make([]string, 0, len(rows))
	for _, p := range rows {
		out = append(out, p.Name+"@"+p.Version+"("+p.Channel+")")
	}
	return out
}

// C4-a：作者面返回 market + org 两行，且 Channel 如实填 "market"/"org"。
//
// 变异会红：
//   - 把 ListOwnedSharedSkills 换回 org-only 取数（orgSkillReleases）⇒ 市场行
//     缺失、作者永远发不出新版本（本次修复的原始缺陷）；
//   - 渠道投影漏填（releaseToShared 不接 channel）⇒ 所有行 Channel 为空，
//     能力中心「我的」分区会把市场行标成「组织」。
func TestListOwnedSharedSkillsSpansChannels(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	seedFaceApp(t, db, AppKindSkill, "face-org", AppChannelOrg, "alice", 1, ReleaseStatusApproved)
	seedFaceApp(t, db, AppKindSkill, "face-market", AppChannelMarket, "alice", 1, ReleaseStatusApproved)
	// 作者自己的待审市场行同样必须在「我的」里（否则提交后无从跟踪）。
	seedFaceApp(t, db, AppKindSkill, "face-market-pending", AppChannelMarket, "alice", 1, ReleaseStatusPending)
	// 别人的行一律不出现。
	seedFaceApp(t, db, AppKindSkill, "face-other", AppChannelMarket, "bob", 1, ReleaseStatusApproved)

	owned, err := ListOwnedSharedSkills(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range owned {
		got[r.Name] = r.Channel
	}
	want := map[string]string{
		"face-org": AppChannelOrg, "face-market": AppChannelMarket, "face-market-pending": AppChannelMarket,
	}
	if len(got) != len(want) {
		t.Fatalf("作者面行数 = %d (%v), want %d", len(got), got, len(want))
	}
	for name, ch := range want {
		if got[name] != ch {
			t.Fatalf("%s 的 Channel = %q, want %q（作者面必须如实投影 apps.channel）", name, got[name], ch)
		}
	}

	// 收敛的「作者面」与分发面同一个归属判据：转移归属后旧作者立刻看不到
	// 市场行（与 org 行同语义）。
	if err := SetAppOfficial(db, AppKindSkill, "face-market", false, "carol"); err != nil {
		t.Fatal(err)
	}
	owned, err = ListOwnedSharedSkills(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range owned {
		if r.Name == "face-market" {
			t.Fatal("归属转移后旧作者的「我的」里仍有该市场行（R5-B-2 回归）")
		}
	}
}

// C4-b：分发面仍是 org only —— 市场行不得因为作者面变宽而混进组织库清单。
//
// 变异会红：把 listSharedSkillsByFace 的两条取数都换成全渠道 ⇒ 市场行从
// /api/client/v2/shared-skills 泄出（客户端按 org 来源渲染、也是审批队列与
// 授权面的唯一取数口）；同时 ListSharedSkills（审批队列）也变宽。
func TestListVisibleSharedSkillsStaysOrgOnly(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	seedFaceApp(t, db, AppKindSkill, "vis-org", AppChannelOrg, "alice", 1, ReleaseStatusApproved)
	seedFaceApp(t, db, AppKindSkill, "vis-market", AppChannelMarket, "alice", 1, ReleaseStatusApproved)

	visible, err := ListVisibleSharedSkills(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].Name != "vis-org" {
		t.Fatalf("分发面 = %+v, want 仅 vis-org（市场行归 marketplace 端点）", namesOfSkills(visible))
	}
	if visible[0].Channel != AppChannelOrg {
		t.Fatalf("分发面行的 Channel = %q, want org", visible[0].Channel)
	}

	adminList, err := ListSharedSkills(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(adminList) != 1 || adminList[0].Name != "vis-org" {
		t.Fatalf("组织库管理端清单 = %v, want 仅 vis-org", namesOfSkills(adminList))
	}
}

// C4-c：智能体侧逐条同形（同一份判据、同一种投影）。
//
// 变异会红：只改技能侧的取数/投影，漏掉 agent 孪生函数 ⇒ 市场智能体在
// 作者面消失、或 Channel 恒空。
func TestListOwnedAgentPresetsSpansChannels(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	seedFaceApp(t, db, AppKindAgent, "face-agent-org", AppChannelOrg, "alice", 1, ReleaseStatusApproved)
	seedFaceApp(t, db, AppKindAgent, "face-agent-market", AppChannelMarket, "alice", 1, ReleaseStatusRejected)
	seedFaceApp(t, db, AppKindAgent, "face-agent-other", AppChannelOrg, "bob", 1, ReleaseStatusApproved)

	owned, err := ListOwnedAgentPresets(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, p := range owned {
		got[p.Name] = p.Channel
	}
	want := map[string]string{
		"face-agent-org": AppChannelOrg, "face-agent-market": AppChannelMarket,
	}
	if len(got) != len(want) {
		t.Fatalf("智能体作者面 = %v, want %v", got, want)
	}
	for name, ch := range want {
		if got[name] != ch {
			t.Fatalf("%s 的 Channel = %q, want %q", name, got[name], ch)
		}
	}

	// 分发面（组织）仍只 org。
	visible, err := ListVisibleAgentPresets(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(visible) != 1 || visible[0].Name != "face-agent-org" {
		t.Fatalf("智能体分发面 = %+v, want 仅 face-agent-org", namesOfPresets(visible))
	}
	adminList, err := ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(adminList) != 2 { // face-agent-org（alice）+ face-agent-other（bob），market 行不进
		t.Fatalf("组织预设管理端清单 = %v, want 2 条 org 行", namesOfPresets(adminList))
	}
	for _, p := range adminList {
		if p.Channel != AppChannelOrg {
			t.Fatalf("组织预设清单里出现非 org 行 %s(%q)", p.Name, p.Channel)
		}
	}
}

// 单行 getter 也要如实投影渠道（DTO 字段不得在两条取数路径上语义不同）。
//
// 变异会红：只给 list 路径填 Channel、getter 留空 ⇒ 客户端从
// GET …/:name/:version 拿到的行没有渠道，与列表行的 source 判据分叉。
func TestSharedSkillGettersProjectChannel(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	seedFaceApp(t, db, AppKindSkill, "get-market", AppChannelMarket, "alice", 1, ReleaseStatusApproved)
	seedFaceApp(t, db, AppKindAgent, "get-agent-market", AppChannelMarket, "alice", 1, ReleaseStatusApproved)

	s, err := GetSharedSkill(db, "get-market", "1.0.0")
	if err != nil || s.Channel != AppChannelMarket {
		t.Fatalf("GetSharedSkill = %+v err=%v, want channel=market", s, err)
	}
	p, err := GetAgentPresetByVersion(db, "get-agent-market", "1.0.0")
	if err != nil || p.Channel != AppChannelMarket {
		t.Fatalf("GetAgentPresetByVersion = %+v err=%v, want channel=market", p, err)
	}
}
