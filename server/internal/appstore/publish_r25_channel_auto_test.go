package appstore

// 2026-10-23「已上架技能无法更新」修复（C1）：发布内核的渠道解析。
//
// PublishRequest.Channel 的语义从「调用方必须知道渠道」变成「必须 / 可以自动」：
//   - "" = 按现有 App 的渠道自动（App 不存在时默认组织渠道 org）；
//   - 非空且与现有 App 的渠道不一致 ⇒ 仍然是 409 NAME_TAKEN（市场命名空间与
//     组织命名空间互斥的既有边界，不得因为本次修复而放开）。
//
// 每条用例的注释写明「变异什么会红」，改动判据前先读。

import (
	"database/sql"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// autoReq 与 req 同构，仅把渠道置空（= 自动解析）。测试用它区分「显式 org」
// 与「自动」，否则两件事在夹具上无法分辨。
func autoReq(appID, version, checksum, publisher string) PublishRequest {
	r := req(appID, version, checksum, publisher)
	r.Channel = ""
	return r
}

func autoAgentReq(appID, version, checksum, publisher string) PublishRequest {
	r := agentReq(appID, version, checksum, publisher)
	r.Channel = ""
	return r
}

// seedPublished 用发布内核以**显式渠道**落一条 approved 行（模拟「已上架」的
// 现有 App），返回发布者（= apps.owner）。
func seedPublished(t *testing.T, db *sql.DB, r PublishRequest) {
	t.Helper()
	r.AdminPublish = true
	if _, err := Publish(db, r); err != nil {
		t.Fatalf("夹具发布 %s(%s) 失败: %v", r.AppID, r.Channel, err)
	}
}

func mustApp(t *testing.T, db *sql.DB, kind, appID string) *serverstore.App {
	t.Helper()
	a, err := serverstore.GetApp(db, kind, appID)
	if err != nil {
		t.Fatalf("读 apps 行 %s/%s: %v", kind, appID, err)
	}
	return a
}

// C1-a：员工对**已上架市场技能**（本人归属）发新版本，渠道留空 ⇒ 自动沿用
// market，发布成功、状态 pending，且 apps 投影一字不动。
//
// 变异会红：把 "" 当成「新建 org 行」/直接跳过渠道解析 → 现有 market 行的
// existingApp.Channel != "" 会让请求走进 409 NAME_TAKEN 分支（这正是本次
// 修复的原始缺陷）；把解析结果写成 org → apps.channel 变了（市场列表里
// 整条消失）。
func TestPublishChannelAutoFollowsMarketApp(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	seedPublished(t, db, func() PublishRequest {
		r := req("auto-market", "1.0.0", "m1", "alice")
		r.Channel = serverstore.AppChannelMarket
		r.Manifest.Title = "市场技能标题 1.0"
		return r
	}())
	before := mustApp(t, db, serverstore.AppKindSkill, "auto-market")

	res, err := Publish(db, autoReq("auto-market", "2.0.0", "m2", "alice"))
	if err != nil {
		t.Fatalf("自动渠道续发 market 技能: %v（原缺陷形态：409 NAME_TAKEN）", err)
	}
	if res.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("员工发布 status = %q, want pending", res.Status)
	}
	after := mustApp(t, db, serverstore.AppKindSkill, "auto-market")
	if after.Channel != serverstore.AppChannelMarket {
		t.Fatalf("apps.channel = %q, want market（解析必须沿用现有渠道）", after.Channel)
	}
	// 待审版本的投影冻结（审计 G-P2-3）：标题/描述必须还是 1.0.0 的。
	if after.Title != before.Title || after.Description != before.Description {
		t.Fatalf("投影被待审版本改写: before=(%q,%q) after=(%q,%q)",
			before.Title, before.Description, after.Title, after.Description)
	}
	r, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "auto-market", "2.0.0")
	if err != nil || r.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("v2 行 = %+v err=%v, want pending", r, err)
	}
}

// C1-b：员工对**已上架组织技能**（本人归属）发新版本，渠道留空 ⇒ 沿用 org。
//
// 变异会红：解析出 org 却把 release/app 写到别的渠道、或对 org 行误报 409。
func TestPublishChannelAutoFollowsOrgApp(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	seedPublished(t, db, func() PublishRequest {
		r := req("auto-org", "1.0.0", "o1", "alice")
		r.Channel = serverstore.AppChannelOrg
		return r
	}())
	if _, err := Publish(db, autoReq("auto-org", "1.1.0", "o2", "alice")); err != nil {
		t.Fatalf("自动渠道续发 org 技能: %v", err)
	}
	if a := mustApp(t, db, serverstore.AppKindSkill, "auto-org"); a.Channel != serverstore.AppChannelOrg {
		t.Fatalf("apps.channel = %q, want org", a.Channel)
	}
	// 智能体同构（同一发布内核）。
	seedPublished(t, db, func() PublishRequest {
		r := agentReq("auto-agent-org", "1.0.0", "ao1", "alice")
		r.Channel = serverstore.AppChannelOrg
		return r
	}())
	if _, err := Publish(db, autoAgentReq("auto-agent-org", "1.1.0", "ao2", "alice")); err != nil {
		t.Fatalf("自动渠道续发 org 智能体: %v", err)
	}
}

// C1-c：App **不存在** + 渠道留空 ⇒ 默认组织渠道（员工上传的语义）。
//
// 变异会红：留空落库 → apps.channel 为空串，0053 的 CHECK 约束当场拒写
// （500），或写进 market 把员工内容暴露到市场命名空间。
func TestPublishChannelAutoDefaultsToOrgForNewApp(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, autoReq("auto-new", "1.0.0", "n1", "alice")); err != nil {
		t.Fatalf("新 App 自动渠道发布: %v", err)
	}
	if a := mustApp(t, db, serverstore.AppKindSkill, "auto-new"); a.Channel != serverstore.AppChannelOrg {
		t.Fatalf("新 App 的 apps.channel = %q, want org", a.Channel)
	}
}

// C1-d（回归，判据 4）：**显式**渠道错配仍然 409 NAME_TAKEN。
//
// 市场命名空间不得写 org 行、反之亦然 —— 这条边界是本次修复**刻意保留**的。
// 变异会红：把渠道校验整个删掉（让显式错配也「沿用现有渠道」）→ 这里变成
// 201，等于允许一条请求跨命名空间改写既有 App 的渠道。
func TestPublishExplicitChannelMismatchStillNameTaken(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	seedPublished(t, db, func() PublishRequest {
		r := req("mismatch-org", "1.0.0", "x1", "alice")
		r.Channel = serverstore.AppChannelOrg
		return r
	}())

	// 管理员显式把目标渠道写成 market，实际是 org 行 ⇒ 409。
	adminReq := req("mismatch-org", "2.0.0", "x2", "boss")
	adminReq.AdminPublish = true
	adminReq.Channel = serverstore.AppChannelMarket
	if _, err := Publish(db, adminReq); code(t, err) != CodeNameTaken {
		t.Fatalf("显式渠道错配（管理员）= %v, want %s", err, CodeNameTaken)
	}
	// 员工显式写错同理（渠道校验先于归属校验，两处都是 409）。
	empReq := req("mismatch-org", "2.0.0", "x3", "alice")
	empReq.Channel = serverstore.AppChannelMarket
	if _, err := Publish(db, empReq); code(t, err) != CodeNameTaken {
		t.Fatalf("显式渠道错配（员工）= %v, want %s", err, CodeNameTaken)
	}
	// 显式同渠道照旧放行（不得为了拦错配而误伤正常路径）。
	if _, err := Publish(db, req("mismatch-org", "2.0.0", "x4", "alice")); err != nil {
		t.Fatalf("显式同渠道续发: %v", err)
	}
}

// C1-e（判据 3 回归）：自动渠道不得绕过任何既有守卫。
// 每条都单独断言，避免「其中一个还绿就以为全绿」。
//
// 变异会红：在渠道解析的某个提前 return 里顺手短路掉后续检查（把
// resolvedChannel 的计算挪到仓库检查之后、或复用一个只做渠道的函数）。
func TestPublishChannelAutoKeepsGuards(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 非归属人发同名 ⇒ 409 NAME_TAKEN。
	seedPublished(t, db, func() PublishRequest {
		r := req("guard-owned", "1.0.0", "g1", "alice")
		r.Channel = serverstore.AppChannelMarket
		return r
	}())
	if _, err := Publish(db, autoReq("guard-owned", "2.0.0", "g2", "bob")); code(t, err) != CodeNameTaken {
		t.Fatalf("非归属人同名 = %v, want %s", err, CodeNameTaken)
	}

	// 官方行非管理员 ⇒ 403 OFFICIAL_LOCKED。
	// 注意 official 不经 UpsertApp 写入（SetAppOfficial 是唯一入口，0059 的
	// 不变量守卫在那边），夹具必须走同一个写入口。
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "guard-official", Title: "官方技能",
		Channel: serverstore.AppChannelOrg, Enabled: 1, Owner: "",
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "guard-official", true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, autoReq("guard-official", "1.0.0", "g3", "alice")); code(t, err) != CodeOfficialLocked {
		t.Fatalf("官方行非管理员 = %v, want %s", err, CodeOfficialLocked)
	}

	// 被锁能力 ⇒ 403 APP_LOCKED。
	if err := serverstore.LockCapability(db, serverstore.AppKindSkill, "guard-locked", "官方维护", "boss"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, autoReq("guard-locked", "1.0.0", "g4", "alice")); code(t, err) != CodeAppLocked {
		t.Fatalf("锁定能力 = %v, want %s", err, CodeAppLocked)
	}

	// 下架冻结 ⇒ 409 APP_DELISTED（管理员直发同样被挡）。
	seedPublished(t, db, func() PublishRequest {
		r := req("guard-delisted", "1.0.0", "g5", "alice")
		r.Channel = serverstore.AppChannelOrg
		return r
	}())
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, "guard-delisted", false); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, autoReq("guard-delisted", "2.0.0", "g6", "alice")); code(t, err) != CodeAppDelisted {
		t.Fatalf("下架中自动发布 = %v, want %s", err, CodeAppDelisted)
	}
	adminDel := autoReq("guard-delisted", "2.0.0", "g7", "boss")
	adminDel.AdminPublish = true
	if _, err := Publish(db, adminDel); code(t, err) != CodeAppDelisted {
		t.Fatalf("下架中管理员直发 = %v, want %s", err, CodeAppDelisted)
	}

	// 待审配额（仅非管理员）⇒ 429 PENDING_LIMIT。
	if _, err := Publish(db, autoReq("guard-quota", "1.0.0", "q1", "carol")); err != nil {
		t.Fatalf("配额夹具首次发布: %v", err)
	}
	quotaReq := autoReq("guard-quota-2", "1.0.0", "q2", "carol")
	quotaReq.PendingCap = 1
	if _, err := Publish(db, quotaReq); code(t, err) != CodePendingLimit {
		t.Fatalf("待审配额满 = %v, want %s", err, CodePendingLimit)
	}
}

// C1-f（判据 5 回归）：自动渠道下版本语义三条规则一条都不能松。
//
// 变异会红：解析渠道时提前 return、或把历史版本查询挪到渠道解析之前用错
// 渠道过滤（会把「同版本已存在」判成 VERSION_NOT_INCREASING 之外的码）。
func TestPublishChannelAutoKeepsVersionSemantics(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, autoReq("auto-ver", "1.0.0", "v1", "alice")); err != nil {
		t.Fatalf("首版: %v", err)
	}
	if _, err := Publish(db, autoReq("auto-ver", "1.0.0", "v2", "alice")); code(t, err) != CodeVersionExists {
		t.Fatalf("同版本 = %v, want %s", err, CodeVersionExists)
	}
	if _, err := Publish(db, autoReq("auto-ver", "2.0.0", "v1", "alice")); code(t, err) != CodeContentUnchanged {
		t.Fatalf("内容未变 = %v, want %s", err, CodeContentUnchanged)
	}
	if _, err := Publish(db, autoReq("auto-ver", "0.9.0", "v3", "alice")); code(t, err) != CodeVersionNotIncreasing {
		t.Fatalf("版本倒挂 = %v, want %s", err, CodeVersionNotIncreasing)
	}
	// 非首版必须带 changelog（与渠道无关）。
	noCL := autoReq("auto-ver", "1.1.0", "v4", "alice")
	noCL.Manifest.Changelog = ""
	if _, err := Publish(db, noCL); code(t, err) != "MISSING_FIELD" {
		t.Fatalf("缺 changelog = %v, want MISSING_FIELD", err)
	}
}
