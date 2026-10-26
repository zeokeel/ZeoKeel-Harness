package marketplace

// F-03(能力中心审计 2026-10-26,P1):`normalize` 必须走**统一发布内核**。
//
// 缺陷现场(修前):normalizeSkillAdmin 绕过 appstore.Publish,直接
// `ReplaceSkillArchive → CreateRelease(status=approved)`,因此不判:
//   - 下架冻结(apps.enabled=0 时仍能产出新 approved 版本);
//   - 版本语义(同版本/必须递增);
//   - changelog(非首版必填);
//   - 官方/能力锁与跨渠道同名互斥(内核的其余硬规则)。
// 也就是说「规范化」是一条后门发布路径。
//
// 修法(本轮):落库改走 appstore.Publish(AdminPublish=true),包预处理逻辑保留。
// 本文件钉住四条判据:
//  1. 下架冻结:下架技能 normalize ⇒ 409 APP_DELISTED,且不产生新版本;
//  2. 版本重复:补发出去的 vX.Y.(Z+1) 已存在 ⇒ 409 VERSION_EXISTS(修前是
//     唯一约束穿出来的 500 INTERNAL);
//  3. 官方锁:normalize 是管理员动作,官方内容允许规范化(归属仍保持 official,
//     owner 仍为空,P2-21);同一内核的非管理员发布仍然 403 OFFICIAL_LOCKED ——
//     重构没有把官方锁弄丢;
//  4. changelog:规范化产出的新版本必须带更新说明(写成本次真实改动清单),
//     不能像修前那样留下空 changelog。

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/appstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// legacySkillArchive 构造「线上那种不合规存量包」:frontmatter name 是中文
// 展示名(不等于 App ID)、带 BOM、没有 changelog。这种包过不了严格清单校验,
// 因此 normalize 不会走 already_compliant 分支。
func legacySkillArchive(t *testing.T) []byte {
	t.Helper()
	legacy := "\ufeff---\nname: 团队知识库助手\ncategory: 通用\nversion: 1.0.0\n" +
		"description: 员工日常咨询知识库的索引与强制读取规则,覆盖人事行政与报销制度。\n" +
		"tags: [example-org, HR]\nauthor: zhangsan\n---\n\n# 知识库\n\n" +
		"本技能提供员工日常咨询知识库的索引与强制读取规则,覆盖人事、行政、商业保险与财务报销等高频问题的查询路径。\n"
	return makeZip(t, map[string]string{"SKILL.md": legacy, "references/wiki.md": "参考\n"})
}

// TestNormalizeRespectsDelistedFreeze:下架(apps.enabled=0)期间内容冻结 ——
// 规范化不得产出"已批准但任何人看不见"的新版本。
func TestNormalizeRespectsDelistedFreeze(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"frozen-skill","version":"1.0.0","author":"zhangsan"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create = %d", w.Code)
	}
	if err := serverstore.ReplaceSkillArchive(db, "frozen-skill", "1.0.0", "deadbeef", legacySkillArchive(t)); err != nil {
		t.Fatal(err)
	}
	// 下架 = 冻结(管理端「下架」端点);之后 normalize 必须被拒。
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/frozen-skill", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable = %d", w.Code)
	}

	w, out := mreq(t, r, "POST", "/api/server/admin/skills/frozen-skill/normalize", "", hdr)
	t.Logf("normalize(已下架) -> %d %v", w.Code, out)
	if w.Code != http.StatusConflict {
		t.Fatalf("下架期间 normalize = %d, want 409 APP_DELISTED;body=%s", w.Code, w.Body.String())
	}
	errObj, _ := out["error"].(map[string]any)
	if got, _ := errObj["code"].(string); got != appstore.CodeAppDelisted {
		t.Fatalf("error.code = %v, want %s", errObj["code"], appstore.CodeAppDelisted)
	}
	// 没有产生新版本(冻结是硬规则,不是"发布后再隐藏")。
	list, err := serverstore.ListReleases(db, serverstore.AppKindSkill, "frozen-skill")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("下架期间仍产出了新版本: %d 条", len(list))
	}
}

// TestNormalizeRespectsVersionDuplicate:规范化产物是 patch+1;当那个版本号已经
// 存在(待审/被拒/已批准)时,发布内核必须按 VERSION_EXISTS 拒绝 —— 而不是
// 落到 DB 唯一约束变成 500。
func TestNormalizeRespectsVersionDuplicate(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"dup-version","version":"1.0.0","author":"zhangsan"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create = %d", w.Code)
	}
	if err := serverstore.ReplaceSkillArchive(db, "dup-version", "1.0.0", "deadbeef", legacySkillArchive(t)); err != nil {
		t.Fatal(err)
	}
	// 先占住 1.0.1(BumpPatch 的目标版本),状态 pending。
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: "dup-version", Version: "1.0.1",
		Title: "占位", Publisher: "alice", Checksum: "sum-101",
		Archive: []byte("placeholder"), Status: serverstore.ReleaseStatusPending,
	}); err != nil {
		t.Fatal(err)
	}

	w, out := mreq(t, r, "POST", "/api/server/admin/skills/dup-version/normalize", "", hdr)
	t.Logf("normalize(1.0.1 已存在) -> %d %v", w.Code, out)
	if w.Code != http.StatusConflict {
		t.Fatalf("版本重复时 normalize = %d, want 409 VERSION_EXISTS;body=%s", w.Code, w.Body.String())
	}
	errObj, _ := out["error"].(map[string]any)
	if got, _ := errObj["code"].(string); got != appstore.CodeVersionExists {
		t.Fatalf("error.code = %v, want %s", errObj["code"], appstore.CodeVersionExists)
	}
	// 占位版本保持原样(pending),规范化不得静默覆盖它。
	if rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "dup-version", "1.0.1"); err != nil ||
		rel.Status != serverstore.ReleaseStatusPending || rel.Publisher != "alice" {
		t.Fatalf("占位版本被改写: %+v err=%v", rel, err)
	}
}

// TestNormalizeOfficialAppKeepsInvariants:官方内容允许管理员规范化(admin 是
// 唯一有权的角色),但 P2-21 不变量必须保持:official=1 且 owner=”;同时内核的
// OFFICIAL_LOCKED 对非管理员仍然生效(证明重构没有把官方锁弄丢)。
func TestNormalizeOfficialAppKeepsInvariants(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"official-skill","version":"1.0.0","author":"zhangsan"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create = %d", w.Code)
	}
	if err := serverstore.ReplaceSkillArchive(db, "official-skill", "1.0.0", "deadbeef", legacySkillArchive(t)); err != nil {
		t.Fatal(err)
	}
	// 归属官方:唯一合规入口是 appstore 的 PUT /apps/:kind/:app_id/owner(生产树);
	// 本镜像树只建市场路由,因此直接调 DAO 的等价写入(SetAppOfficial)。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "official-skill", true, ""); err != nil {
		t.Fatalf("set official = %v", err)
	}

	w, out := mreq(t, r, "POST", "/api/server/admin/skills/official-skill/normalize", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("normalize(官方) = %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "1.0.1") {
		t.Fatalf("normalize 应产出 patch+1: %v", out)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "official-skill")
	if err != nil {
		t.Fatal(err)
	}
	if app.Official != 1 {
		t.Fatalf("官方归属丢失: official=%d", app.Official)
	}
	if app.Owner != "" {
		t.Fatalf("official=1 ∧ owner≠'' 是禁止状态: owner=%q", app.Owner)
	}
	// 内核的官方锁对非管理员仍然生效(与 normalize 走同一个 Publish)。
	perr := publishAsNonAdmin(t, db, "official-skill", "1.0.9")
	var ae *appstore.Error
	if !errors.As(perr, &ae) || ae.Code != appstore.CodeOfficialLocked {
		t.Fatalf("非管理员发布官方内容 = %v, want %s", perr, appstore.CodeOfficialLocked)
	}
}

// publishAsNonAdmin 在同一内核上模拟「员工发布官方内容」,用于证明 normalize
// 改走 Publish 之后,OFFICIAL_LOCKED 这条硬规则仍然生效(而不是被管理员路径的
// AdminPublish 顺带放开给所有人)。
func publishAsNonAdmin(t *testing.T, db *sql.DB, name, version string) error {
	t.Helper()
	_, err := appstore.Publish(db, appstore.PublishRequest{
		Kind:      serverstore.AppKindSkill,
		AppID:     name,
		Channel:   serverstore.AppChannelMarket,
		Archive:   []byte("not-a-real-archive"),
		Publisher: "zhangsan",
		Manifest: appstore.Manifest{Version: version, Title: "x", Description: "x",
			Author: "zhangsan", Changelog: "x"},
		Checksum: "sum-" + version,
	})
	return err
}

// TestNormalizeWritesChangelog:非首版必须填 changelog(内核硬规则)。规范化不能
// 绕过它,也不能凭空编造语义 —— 写进去的是本次规范化的真实改动清单。
func TestNormalizeWritesChangelog(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"changelog-skill","version":"1.0.0","author":"zhangsan"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create = %d", w.Code)
	}
	if err := serverstore.ReplaceSkillArchive(db, "changelog-skill", "1.0.0", "deadbeef", legacySkillArchive(t)); err != nil {
		t.Fatal(err)
	}
	if w, out := mreq(t, r, "POST", "/api/server/admin/skills/changelog-skill/normalize", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("normalize = %d %v", w.Code, out)
	}
	rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "changelog-skill", "1.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(rel.Changelog) == "" {
		t.Fatal("规范化产出的版本没有 changelog:内核的「非首版必须写更新说明」被绕过")
	}
	if !strings.Contains(rel.Changelog, "规范化") {
		t.Fatalf("changelog 应是本次真实改动说明, got %q", rel.Changelog)
	}
	if rel.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("规范化的产物必须是 approved(管理员直发), got %s", rel.Status)
	}
}
