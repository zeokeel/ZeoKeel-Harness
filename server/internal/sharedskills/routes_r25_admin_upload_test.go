package sharedskills

// 2026-10-23「已上架技能无法更新」修复（C2 / C3）：员工上传的渠道自动化
// 与管理员「组织渠道发新版本」端点。
//
// 三条判据（每条用例的注释写明「变异什么会红」）：
//   1. 员工对**已上架**的技能（本人归属，market 或 org）发新版本 ⇒ 201 pending，
//      apps.channel 不变、待审版本的投影不动；
//   2. 管理员端点 POST /api/server/admin/shared-skills/:name/archive ⇒ 201 approved、
//      投影切到新版、员工侧可下载；
//   3. 上传必留审计（shared_skill_upload）。

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// skillMdCustom 是 skillMd 的可定制版（标题/描述由调用方指定，用于验证
// 「投影切到新版」这类需要区分新旧元数据的判据）。约束与 skillMd 一致：
// description ≥ 10 字、正文 ≥ 50 字（skillmanifest 的发布闸门）。
func skillMdCustom(name, version, title, description string) string {
	return "---\n" +
		"name: " + name + "\n" +
		"title: " + title + "\n" +
		"version: " + version + "\n" +
		"description: " + description + "\n" +
		"author: tester\n" +
		"category: 测试\nchangelog: 测试夹具的更新说明。\n" +
		"---\n\n# " + name + "\n\n本技能是服务端集成测试使用的夹具包,正文需要足够长才能通过空壳校验,因此这里补充了一段用于说明用途的文字。\n"
}

// customUpload 是一个元数据可定制的上传请求体（archive 由 SKILL.md 生成）。
func customUpload(t *testing.T, name, version, title, description string) string {
	t.Helper()
	raw := makeSkillArchive(t, map[string]string{
		"SKILL.md": skillMdCustom(name, version, title, description),
	})
	return uploadBody(name, version, description, raw)
}

// adminArchiveBody 是管理员发新版端点的请求体：只有 archive（版本以包内为准）。
func adminArchiveBody(t *testing.T, entries map[string]string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"archive": base64.StdEncoding.EncodeToString(makeSkillArchive(t, entries)),
	})
	return string(body)
}

// postJSON 发一个带指定请求头的 JSON POST，返回响应记录器。
func postJSON(t *testing.T, h http.Handler, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(w, req)
	return w
}

// getArchive 发一个带指定请求头的 GET，返回响应记录器。
func getArchive(t *testing.T, h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(w, req)
	return w
}

// seedPublishedMarketSkill 用 DAO 造一条「已上架的市场技能」（apps.channel=
// market + 一条 approved v1），归属 owner。等价于管理员在市场命名空间上架后
// 的现场；刻意不经 HTTP（市场命名空间的端点在 marketplace 包，不属本包判据面）。
func seedPublishedMarketSkill(t *testing.T, db *sql.DB, name, owner, title, version string, raw []byte) {
	t.Helper()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: name, Title: title, Description: "市场渠道夹具描述",
		Owner: owner, Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatalf("夹具 apps 行: %v", err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: name, Version: version, Title: title,
		Description: "市场渠道夹具描述", Publisher: owner, Status: serverstore.ReleaseStatusApproved,
		Archive: raw, Checksum: "seed-" + version,
	}); err != nil {
		t.Fatalf("夹具 release: %v", err)
	}
}

// 判据 1：员工对**已上架市场技能**（本人归属）发新版本 ⇒ 201 pending；
// apps.channel 仍 market；市场分发面仍只见旧 approved 版本；投影不变。
//
// 变异会红：
//   - 把 sharedskills.Upload 的 Channel 写回 AppChannelOrg（本次修复前的形态）
//     ⇒ 内核的跨渠道判据回 409 NAME_TAKEN（「已上架技能无法更新」原始缺陷）；
//   - 内核把自动渠道解析成 org ⇒ apps.channel 变成 org，市场面整条消失；
//   - 待审版本改写 apps 投影 ⇒ title/description 与 v1 不同（审计 G-P2-3）。
func TestEmployeeUploadAutoChannelFollowsMarketSkill(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	const name = "market-upd"
	rawV1 := makeSkillArchive(t, map[string]string{"SKILL.md": skillMdCustom(name, "1.0.0", "市场旧标题", "市场渠道的旧版描述内容。")})
	seedPublishedMarketSkill(t, db, name, "alice", "市场旧标题", "1.0.0", rawV1)
	before, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil {
		t.Fatal(err)
	}

	w := postJSON(t, r, "/api/client/v2/shared-skills",
		customUpload(t, name, "2.0.0", "市场新标题", "市场渠道的新版描述内容。"), userHdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("员工续发已上架市场技能 = %d %s（want 201；409 NAME_TAKEN 即原始缺陷）", w.Code, w.Body.String())
	}
	var out struct {
		Skill struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Status  string `json:"status"`
		} `json:"skill"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Skill.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("上传响应 = %s(解析 %v), want skill.status=pending", w.Body.String(), err)
	}

	after, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil {
		t.Fatal(err)
	}
	if after.Channel != serverstore.AppChannelMarket {
		t.Fatalf("apps.channel = %q, want market（自动渠道必须沿用现有 App 的渠道）", after.Channel)
	}
	if after.Title != before.Title || after.Description != before.Description {
		t.Fatalf("待审版本改写了投影: before=(%q,%q) after=(%q,%q)",
			before.Title, before.Description, after.Title, after.Description)
	}
	// 市场分发面：仍是 1.0.0（待审的 2.0.0 不能生效）。
	cur, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindSkill, name, false)
	if err != nil {
		t.Fatal(err)
	}
	if cur == nil || cur.Version != "1.0.0" {
		t.Fatalf("市场展示版本 = %+v, want 1.0.0（待审版本不得生效）", cur)
	}
	v2, err := serverstore.GetRelease(db, serverstore.AppKindSkill, name, "2.0.0")
	if err != nil || v2.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("v2 行 = %+v err=%v, want pending", v2, err)
	}
}

// 判据 2：员工对**已上架组织技能**（本人归属）发新版本 ⇒ 201 pending。
//
// 变异会红：把 Upload 的渠道硬编码回 org 后，若内核仍然按
// `existingApp.Channel != req.Channel` 判 409，这里同样变红（org 与 org 相等时
// 不会红 —— 所以本用例的变异面是「新 App 默认渠道」那一支，见下一条）。
func TestEmployeeUploadAutoChannelFollowsOrgSkill(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	const name = "org-upd"
	if w := postJSON(t, r, "/api/client/v2/shared-skills", skillUpload(t, name, "1.0.0", "组织旧描述够长"), userHdr); w.Code != http.StatusCreated {
		t.Fatalf("v1 上传 = %d %s", w.Code, w.Body.String())
	}
	// 首次发布：Apps 行不存在 + 渠道自动 ⇒ 落到 org。
	if app, err := serverstore.GetApp(db, serverstore.AppKindSkill, name); err != nil || app.Channel != serverstore.AppChannelOrg {
		t.Fatalf("首版 apps = %+v err=%v, want channel=org", app, err)
	}
	if w := postJSON(t, r, "/api/server/admin/shared-skills/"+name+"/1.0.0/approve", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	if w := postJSON(t, r, "/api/client/v2/shared-skills", skillUpload(t, name, "1.1.0", "组织新版描述够长"), userHdr); w.Code != http.StatusCreated {
		t.Fatalf("员工续发已上架组织技能 = %d %s", w.Code, w.Body.String())
	}
	if app, _ := serverstore.GetApp(db, serverstore.AppKindSkill, name); app.Channel != serverstore.AppChannelOrg {
		t.Fatalf("apps.channel = %q, want org", app.Channel)
	}
}

// 判据 6：管理员端点给已上架组织技能发新版本 ⇒ 201 approved、投影切新版、
// 员工侧（归属人）下载 200；判据 9：审计留行。
//
// 变异会红：
//   - UploadAdmin 忘传 AdminPublish ⇒ 状态是 pending（不是「管理端上架=已审」）；
//   - 忘传 Channel=org ⇒ 已存在的 org 行 + 自动渠道虽然也能落对渠道，但显式
//     声明是契约（本用例同时断言 admin 端点在 Apps 行**不存在**时也落 org）；
//   - 解析段被复制粘贴后与员工上传分叉 ⇒ 归档校验/清单解析的错误码不同
//     （由下一个用例覆盖）；
//   - 不写审计 ⇒ shared_skill_upload 计数不足。
func TestAdminUploadArchivePublishesOrgVersion(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	const name = "admin-org-upd"
	// 注意：本用例**先**由管理员直接建首版（Apps 行不存在），验证管理端
	// 上传的显式 org 渠道；员工上传的「新 App 默认 org」由上一个用例覆盖。
	v1 := adminArchiveBody(t, map[string]string{"SKILL.md": skillMdCustom(name, "1.0.0", "组织旧标题", "管理员首版的描述内容。")})
	w := postJSON(t, r, "/api/server/admin/shared-skills/"+name+"/archive", v1, adminHdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("管理员首版上传 = %d %s", w.Code, w.Body.String())
	}
	var first struct {
		Skill struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Status  string `json:"status"`
		} `json:"skill"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatalf("响应解析: %v (%s)", err, w.Body.String())
	}
	if first.Skill.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("管理员上传 status = %q, want approved（管理端上架等价已审核）", first.Skill.Status)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil || app.Channel != serverstore.AppChannelOrg {
		t.Fatalf("apps = %+v err=%v, want channel=org", app, err)
	}
	if app.Title != "组织旧标题" {
		t.Fatalf("首版投影 title = %q, want 组织旧标题", app.Title)
	}

	// 第二版：投影必须切到新版（approve 语义 = 立即生效）。
	v2 := adminArchiveBody(t, map[string]string{"SKILL.md": skillMdCustom(name, "2.0.0", "组织新标题", "管理员第二版的描述内容。")})
	w2 := postJSON(t, r, "/api/server/admin/shared-skills/"+name+"/archive", v2, adminHdr)
	if w2.Code != http.StatusCreated {
		t.Fatalf("管理员续发 = %d %s", w2.Code, w2.Body.String())
	}
	var second struct {
		Skill struct {
			Version string `json:"version"`
			Status  string `json:"status"`
		} `json:"skill"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &second)
	if second.Skill.Version != "2.0.0" || second.Skill.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("第二版响应 = %s, want version=2.0.0 status=approved", w2.Body.String())
	}
	app, err = serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil || app.Title != "组织新标题" {
		t.Fatalf("投影 title = %q err=%v, want 组织新标题（approved 版本立即生效）", app.Title, err)
	}
	if app.Channel != serverstore.AppChannelOrg {
		t.Fatalf("apps.channel = %q, want org（显式渠道声明）", app.Channel)
	}

	// 员工侧下载：投影已切到 2.0.0，但组织库仍是「严格默认拒绝」——
	// 未授权的员工与「不存在」同形 404；授权后才 200（且版本头 = 2.0.0）。
	// 这一步同时证明「管理员发版 ⇒ 员工侧真能装到」，而不只是库里多一行。
	if wD := getArchive(t, r, "/api/client/v2/shared-skills/"+name+"/2.0.0/archive", userHdr); wD.Code != http.StatusNotFound {
		t.Fatalf("未授权员工下载 = %d %s, want 404（严格默认拒绝）", wD.Code, wD.Body.String())
	}
	if err := serverstore.GrantSharedResource(db, serverstore.SharedSkillGrantTable, name, "alice", serverstore.GranteeUser); err != nil {
		t.Fatalf("授权 alice: %v", err)
	}
	wD := getArchive(t, r, "/api/client/v2/shared-skills/"+name+"/2.0.0/archive", userHdr)
	if wD.Code != http.StatusOK {
		t.Fatalf("授权员工下载 v2 = %d %s", wD.Code, wD.Body.String())
	}
	if wD.Header().Get("X-Skill-Version") != "2.0.0" {
		t.Fatalf("下载版本头 = %q, want 2.0.0", wD.Header().Get("X-Skill-Version"))
	}
	if wD.Body.Len() == 0 {
		t.Fatal("下载归档为空")
	}

	// 判据 9：两条上传各留一行 shared_skill_upload 审计。
	_, total, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "shared_skill_upload", "")
	if err != nil {
		t.Fatal(err)
	}
	if total < 2 {
		t.Fatalf("shared_skill_upload 审计 = %d 行, want ≥2（员工与管理员上传都必须留痕）", total)
	}
}

// 判据 6 的负向面：解析/校验与员工上传**同一套**（共享实现，不是复制粘贴）。
// 归档缺 SKILL.md ⇒ 422 ARCHIVE_INVALID；请求体坏 ⇒ 400 VALIDATION；
// 名字与路径不一致 ⇒ 包内清单错误码（MANIFEST_MISMATCH 系）。
//
// 变异会红：管理员端点自写一份「宽松解析」（跳过 ValidateSkillArchive 或
// skillmanifest.Parse 的 name 校验）⇒ 这些用例拿到 201 或错误码漂移。
func TestAdminUploadArchiveReusesEmployeeValidation(t *testing.T) {
	r, db, adminHdr, _, _ := setup(t)
	defer db.Close()

	// 坏 JSON。
	if w := postJSON(t, r, "/api/server/admin/shared-skills/bad-body/archive", "{", adminHdr); w.Code != http.StatusBadRequest {
		t.Fatalf("坏请求体 = %d, want 400", w.Code)
	}
	// 缺归档。
	if w := postJSON(t, r, "/api/server/admin/shared-skills/no-archive/archive", `{}`, adminHdr); w.Code != http.StatusBadRequest {
		t.Fatalf("缺归档 = %d %s, want 400", w.Code, w.Body.String())
	}
	// 归档里没有 SKILL.md。
	noSkill := adminArchiveBody(t, map[string]string{"README.md": "只有说明文件"})
	if w := postJSON(t, r, "/api/server/admin/shared-skills/no-skill/archive", noSkill, adminHdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("缺 SKILL.md = %d %s, want 422", w.Code, w.Body.String())
	}
	// 包内 name 与路径 name 不一致：与员工上传同样由清单校验拦截（非 201）。
	mismatch := adminArchiveBody(t, map[string]string{"SKILL.md": skillMdCustom("other-name", "1.0.0", "标题", "包内名字与路径不一致的描述。")})
	if w := postJSON(t, r, "/api/server/admin/shared-skills/path-name/archive", mismatch, adminHdr); w.Code == http.StatusCreated {
		t.Fatalf("包内 name 不一致竟然 201: %s", w.Body.String())
	}
	// 路径里的名字不合法：名字面闸门由「归档清单的身份校验」+「发布内核的
	// IsAppID」承担（本包不重复预检，理由见 uploadAdmin 注释），因此这里拿到
	// 的是 422 而不是 201 —— 关键是它**不能落库**，且错误是统一 JSON 信封。
	badName := adminArchiveBody(t, map[string]string{"SKILL.md": skillMdCustom("BadName", "1.0.0", "非法名夹具", "非法名字的夹具描述内容。")})
	if w := postJSON(t, r, "/api/server/admin/shared-skills/BadName/archive", badName, adminHdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("非法路径名 = %d %s, want 422（名字面闸门必须拒绝）", w.Code, w.Body.String())
	} else if !strings.Contains(w.Body.String(), `"error"`) {
		t.Fatalf("非法路径名的响应不是统一错误信封: %s", w.Body.String())
	}
}
