package marketplace

// 市场待审版本的审核面（2026-10-23）：`/api/server/admin/{skills,agents}/:name/:version/*`
// 的 approve / reject / preview / archive / file 十端点。
//
// 【为什么需要这一面】市场渠道此前只能管理端直发（发布即 approved），员工归属人
// 提交的新版本落在 `app_releases.status=pending` 之后**没有任何审核入口**：
// 审批队列只读组织库（sharedskills / agentshare），市场待审版本永远卡在 pending，
// 投影（apps.title/description）也永远停在旧版本。
//
// 【判据组织方式】每条用例只钉一条语义，注释写清「变异什么会红」。夹具刻意用
// **真实链路**造数据（管理端 HTTP 上传 v1、`appstore.Publish` 造员工 v2 pending），
// 不直写 `app_releases`：审核面的前置条件（pending + 归档字节存在 + 投影未动）
// 必须与生产落库形态一致，否则判据会在"夹具与生产分叉"的形态下假绿。
//
// 【与既有守卫的关系】渠道口径（org 行与不存在同形 404）的唯一实现在
// `channel.go` 的 `requireMarketAdminApp`；`agents` 那 5 条新路由同时登记进
// `marketAgentRoutePolicy`，由 `TestAgentAdminRoutesAreMarketOnlyOrRegistered`
// 与 `internal/router` 的生产树对拍双向判着。

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/agentshare"
	"github.com/zeokeel/zeokeel-harness/server/internal/appstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/sharedskills"
	"github.com/zeokeel/zeokeel-harness/server/internal/skillmanifest"
)

const (
	reviewSkillName = "review-skill"
	reviewAgentName = "review-agent"
	reviewOrgSkill  = "review-org-skill"
	reviewOrgAgent  = "review-org-agent"
	reviewMissing   = "review-absent"
	// reviewOwner 是市场行的归属人（员工）。员工发布（AdminPublish=false）要求
	// `apps.owner == Publisher`（appstore.Publish 的归属保护），因此 v2 pending
	// 必须由它发布。
	reviewOwner = "owner1"
	// reviewAuditor 是判据 6 的只读管理员（audit:read/usage:read/user:read，
	// 没有 capability:write）。
	reviewAuditor = "review-auditor"
)

// reviewSkillArchive 构造一个合规技能归档（SKILL.md + 一个可逐文件查看的条目）。
//
// 内容随 version/title 变化：v2 与 v1 必须在**归档字节**上不同，否则
// 「版本级取字节」与「name 级取当前 approved」两种实现会给出同一份内容，
// 判据就分辨不出实现是否按指定版本取值（假绿）。
func reviewSkillArchive(t *testing.T, name, version, title string) []byte {
	t.Helper()
	description := title + "：这是审核面判据使用的技能包，描述长度需要满足最短限制。"
	md := "---\nname: " + name + "\ntitle: " + title + "\nversion: " + version + "\n" +
		"description: " + description + "\nauthor: " + reviewOwner + "\ncategory: 测试\n" +
		"changelog: " + version + " 修复了一个问题\n---\n\n" +
		"本技能是市场审核面判据的夹具，正文需要足够长才能通过空壳校验，" +
		"因此补充这段说明文字，说明它的唯一用途。\n"
	return makeZip(t, map[string]string{
		"SKILL.md":        md,
		"docs/guide.md":   "# " + title + " 使用说明\n\n这是 " + version + " 版本文档。\n",
		"docs/example.md": "# " + title + " 示例\n\n只属于 " + version + " 的内容。\n",
	})
}

// publishSkillRelease 用**发布内核**（员工上传与管理端上架共用的唯一写入口）
// 造一个技能版本；admin=true 时即 approved（管理端直发），否则 pending（待审）。
func publishSkillRelease(t *testing.T, db *sql.DB, name, channel, publisher string, admin bool, archive []byte) error {
	t.Helper()
	checksum, err := sharedskills.ValidateSkillArchive(archive)
	if err != nil {
		t.Fatalf("夹具技能归档校验失败: %v", err)
	}
	entries, md, err := sharedskills.ListArchiveContents(archive)
	if err != nil {
		t.Fatalf("夹具技能归档解析失败: %v", err)
	}
	man, err := skillmanifest.Parse(entries, md, name)
	if err != nil {
		t.Fatalf("夹具 SKILL.md 解析失败: %v", err)
	}
	_, err = appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindSkill, AppID: name, Channel: channel, Archive: archive,
		Publisher: publisher, AdminPublish: admin,
		Manifest: appstore.FromSkillManifest(man), Checksum: checksum,
	})
	return err
}

// publishAgentRelease 是技能版的智能体孪生（同一发布内核，清单来自 preset.yml）。
func publishAgentRelease(t *testing.T, db *sql.DB, name, channel, publisher string, admin bool, archive []byte) error {
	t.Helper()
	checksum, err := agentshare.ValidatePresetArchive(archive)
	if err != nil {
		t.Fatalf("夹具智能体归档校验失败: %v", err)
	}
	entries, composition, err := agentshare.ListArchiveContents(archive)
	if err != nil {
		t.Fatalf("夹具智能体归档解析失败: %v", err)
	}
	if err := agentshare.ValidateAgentComposition(composition); err != nil {
		t.Fatalf("夹具智能体编排校验失败: %v", err)
	}
	presetYML, err := archEntryText(archive, skillmanifest.PresetMetaFile)
	if err != nil {
		t.Fatalf("夹具 preset.yml 读取失败: %v", err)
	}
	man, err := skillmanifest.ParseAgent(entries, presetYML, name)
	if err != nil {
		t.Fatalf("夹具 preset.yml 解析失败: %v", err)
	}
	_, err = appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindAgent, AppID: name, Channel: channel, Archive: archive,
		Publisher: publisher, AdminPublish: admin,
		Manifest: appstore.FromSkillManifest(man), Checksum: checksum,
	})
	return err
}

// reviewFixture 是一份市场技能 / 智能体各一行的现场：
//
//   - 管理端登记（归属 owner1）→ 管理端直发 v1（approved）
//   - 归属人（员工）发布 v2（pending，尚无审核入口时永远卡住）
//
// 同时挂上员工面（`/api/client/v2/marketplace`）路由，判据 1 的
// 「GET 客户端清单显示 v2」「员工归档下载 200」走真路由而不是直读 DAO。
type reviewFixture struct {
	r        *gin.Engine
	db       *sql.DB
	hdr      map[string]string // super_admin 管理端会话（含 CSRF）
	cacheDir string
	bearer   string // 管理员的客户端 bearer token（员工面判据用）
	skillV1  []byte
	skillV2  []byte
	agentV1  []byte
	agentV2  []byte
}

func newReviewFixture(t *testing.T) *reviewFixture {
	t.Helper()
	h, db, hdr, cacheDir := marketAdminSetupWithCache(t)
	t.Cleanup(func() { _ = db.Close() })
	eng, ok := h.(*gin.Engine)
	if !ok {
		t.Fatalf("marketAdminSetup 返回的不是 *gin.Engine（%T），无法再挂员工面路由", h)
	}
	// 员工安装通路（市场清单 + 归档下载）与审核面挂在同一棵树上。
	NewAPI(db, cacheDir).RegisterRoutes(eng)

	if _, err := serverstore.CreateUserWithPassword(db, reviewOwner, "ownerpw123"); err != nil {
		t.Fatalf("夹具归属人: %v", err)
	}
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatalf("夹具管理员: %v", err)
	}
	token, err := serverauth.IssueToken(db, boss.ID)
	if err != nil {
		t.Fatalf("夹具管理员 token: %v", err)
	}

	f := &reviewFixture{r: eng, db: db, hdr: hdr, cacheDir: cacheDir, bearer: token}

	// ---- 市场技能：登记 → 直发 v1 → 员工 v2 pending ----
	if w, _ := mreq(t, eng, "POST", "/api/server/admin/skills",
		`{"name":"`+reviewSkillName+`","author":"`+reviewOwner+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("夹具登记市场技能: %d %s", w.Code, w.Body.String())
	}
	f.skillV1 = reviewSkillArchive(t, reviewSkillName, "1.0.0", "技能 v1 标题")
	f.skillV2 = reviewSkillArchive(t, reviewSkillName, "2.0.0", "技能 v2 标题")
	uploadSkillVersion(t, f, "1.0.0", f.skillV1)
	if err := publishSkillRelease(t, db, reviewSkillName, serverstore.AppChannelMarket,
		reviewOwner, false, f.skillV2); err != nil {
		t.Fatalf("夹具员工上传待审 v2: %v", err)
	}

	// ---- 市场智能体：同构 ----
	if w, _ := mreq(t, eng, "POST", "/api/server/admin/agents",
		`{"name":"`+reviewAgentName+`","author":"`+reviewOwner+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("夹具登记市场智能体: %d %s", w.Code, w.Body.String())
	}
	f.agentV1 = agentArchive(t, "1.0.0", "智能体 v1 标题")
	f.agentV2 = agentArchive(t, "2.0.0", "智能体 v2 标题")
	uploadAgentVersion(t, f, "1.0.0", f.agentV1)
	if err := publishAgentRelease(t, db, reviewAgentName, serverstore.AppChannelMarket,
		reviewOwner, false, f.agentV2); err != nil {
		t.Fatalf("夹具员工上传待审智能体 v2: %v", err)
	}
	return f
}

// uploadSkillVersion 走管理端「上传新版」端点（AdminPublish ⇒ 立即 approved）。
func uploadSkillVersion(t *testing.T, f *reviewFixture, version string, archive []byte) {
	t.Helper()
	body := `{"version":"` + version + `","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	if w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/archive", body, f.hdr); w.Code != http.StatusOK {
		t.Fatalf("夹具上传技能 %s: %d %s", version, w.Code, w.Body.String())
	}
}

func uploadAgentVersion(t *testing.T, f *reviewFixture, version string, archive []byte) {
	t.Helper()
	body := `{"version":"` + version + `","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	if w, _ := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/archive", body, f.hdr); w.Code != http.StatusOK {
		t.Fatalf("夹具上传智能体 %s: %d %s", version, w.Code, w.Body.String())
	}
}

// seedOrgReviewRows 造**组织渠道**的技能与智能体各一行（approved，1.0.0），
// 用于"市场命名空间不服务 org 行"的判据。
func seedOrgReviewRows(t *testing.T, f *reviewFixture) {
	t.Helper()
	skill := reviewSkillArchive(t, reviewOrgSkill, "1.0.0", "组织技能标题")
	if err := publishSkillRelease(t, f.db, reviewOrgSkill, serverstore.AppChannelOrg,
		"boss", true, skill); err != nil {
		t.Fatalf("夹具组织技能: %v", err)
	}
	agent := agentArchive(t, "1.0.0", "组织智能体标题")
	if err := publishAgentRelease(t, f.db, reviewOrgAgent, serverstore.AppChannelOrg,
		"boss", true, agent); err != nil {
		t.Fatalf("夹具组织智能体: %v", err)
	}
}

// reviewErrorEnvelope 取出错误信封的 code/message（拿不到就判失败）。
func reviewErrorEnvelope(t *testing.T, w *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	out := map[string]any{}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应 JSON 解析失败: %v (%s)", err, w.Body.String())
	}
	env, ok := out["error"].(map[string]any)
	if !ok {
		t.Fatalf("响应不是错误信封: %s", w.Body.String())
	}
	code, _ := env["code"].(string)
	msg, _ := env["message"].(string)
	return code, msg
}

// reviewBearGet 发一个带 bearer 的员工面请求。
func reviewBearGet(t *testing.T, r http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// ---------------------------------------------------------------------------
// 判据 1：approve 让待审 v2 生效（状态 + 投影 + 客户端清单 + 员工归档下载 + 审计）
// ---------------------------------------------------------------------------

// TestMarketSkillApprovePublishesPendingVersion 钉住 approve 的**全部可观测效果**：
//
//	变异 1：只改 app_releases.status 不重算投影 ⇒ apps.title/description 仍是 v1、客户端
//	        清单版本号不变 ⇒ 红（投影重算由 serverstore.ReviewPending 负责，本用例守着它没被绕过）；
//	变异 2：approve 改成"批准当前 approved"而不是路径里的 version ⇒ 版本号断言红；
//	变异 3：生成 200 但不写库 ⇒ 状态/清单断言红；
//	变异 4：漏审计 ⇒ market_skill_approve 断言红。
func TestMarketSkillApprovePublishesPendingVersion(t *testing.T) {
	f := newReviewFixture(t)

	// 前提自证：v2 目前是 pending，投影还没动（否则后面的断言可能"本来就这样"）。
	pre, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0")
	if err != nil || pre.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("夹具前提不成立：v2 状态 = %v (%v)", pre, err)
	}

	w, out := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	if out["ok"] != true {
		t.Fatalf("approve 响应 = %s, want {ok:true}", w.Body.String())
	}

	// ① 版本状态
	rel, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0")
	if err != nil || rel.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("approve 后 v2 状态 = %v (%v), want approved", rel, err)
	}
	// ② 投影（apps 是目录对全员下发的投影，app_releases 才是真相）
	app, err := serverstore.GetApp(f.db, serverstore.AppKindSkill, reviewSkillName)
	if err != nil {
		t.Fatalf("读取 apps 行: %v", err)
	}
	wantTitle, wantDesc := "技能 v2 标题", "技能 v2 标题：这是审核面判据使用的技能包，描述长度需要满足最短限制。"
	if app.Title != wantTitle || app.Description != wantDesc {
		t.Fatalf("投影未切到 v2: title=%q description=%q", app.Title, app.Description)
	}
	// ③ 客户端清单（员工面真路由）
	w = reviewBearGet(t, f.r, "/api/client/v2/marketplace/skills", f.bearer)
	if w.Code != http.StatusOK {
		t.Fatalf("客户端清单 = %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"version":"2.0.0"`) || !strings.Contains(w.Body.String(), wantDesc) {
		t.Fatalf("客户端清单没有切到 v2: %s", w.Body.String())
	}
	// ④ 员工安装通路：归档下载 200 且字节 = v2 归档
	w = reviewBearGet(t, f.r, "/api/client/v2/marketplace/skills/"+reviewSkillName+"/archive", f.bearer)
	if w.Code != http.StatusOK {
		t.Fatalf("员工归档下载 = %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Skill-Version"); got != "2.0.0" {
		t.Fatalf("员工归档 X-Skill-Version = %q, want 2.0.0", got)
	}
	if !bytes.Equal(w.Body.Bytes(), f.skillV2) {
		t.Fatalf("员工归档字节不是 v2 归档（len=%d want %d）", w.Body.Len(), len(f.skillV2))
	}
	// ⑤ 审计
	logs, _, err := serverstore.ListAuditLogsPagedFiltered(f.db, 0, 20, "", "")
	if err != nil {
		t.Fatalf("审计: %v", err)
	}
	if !hasAudit(logs, "market_skill_approve", reviewSkillName+"@2.0.0") {
		t.Fatalf("缺少 market_skill_approve 审计（detail=%s@2.0.0）", reviewSkillName)
	}
}

// hasAudit 判定审计里是否存在「动作 + 详情」逐字匹配的一条。
func hasAudit(logs []serverstore.AuditLogEntry, action, detail string) bool {
	for _, l := range logs {
		if l.Action == action && l.Detail == detail {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 判据 2：reject 释放归档、版本号仍占位、理由必填
// ---------------------------------------------------------------------------

// TestMarketSkillRejectPendingVersion 钉住 reject 的可观测语义：
//
//	变异 1：拒绝却不释放归档字节（archive 仍在）⇒ 红（存储上界 + "拒绝即释放"契约）；
//	变异 2：拒绝后版本号可复用（再发同版本成功）⇒ 红（版本号一经使用永久占位）；
//	变异 3：理由校验被去掉（空理由 / 超 500 字仍 200）⇒ 红；
//	变异 4：拒绝后投影被清空/切到被拒版本 ⇒ 红（投影必须仍指向 v1）。
func TestMarketSkillRejectPendingVersion(t *testing.T) {
	f := newReviewFixture(t)

	// 理由必填 + 长度上限：两者都必须先被拒，且**零副作用**（v2 仍是 pending）。
	for _, tc := range []struct{ label, body string }{
		{"空理由", `{"reason":"   "}`},
		{"超长理由", `{"reason":"` + strings.Repeat("拒", 501) + `"}`},
		{"坏 body", `{"reason":`},
	} {
		w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/reject", tc.body, f.hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: reject = %d %s, want 400", tc.label, w.Code, w.Body.String())
		}
		if code, _ := reviewErrorEnvelope(t, w); code != "VALIDATION" {
			t.Fatalf("%s: code = %q, want VALIDATION", tc.label, code)
		}
		if rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0"); rel.Status != serverstore.ReleaseStatusPending {
			t.Fatalf("%s: 被拒的请求改了状态（%s）—— 校验必须在落定之前", tc.label, rel.Status)
		}
	}

	w, out := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/reject",
		`{"reason":"包内容不符合规范"}`, f.hdr)
	if w.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("reject = %d %s", w.Code, w.Body.String())
	}

	rel, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0")
	if err != nil {
		t.Fatalf("读取被拒版本: %v", err)
	}
	if rel.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("reject 后状态 = %q, want rejected", rel.Status)
	}
	if rel.Reason != "包内容不符合规范" {
		t.Fatalf("拒绝理由未落库: %q", rel.Reason)
	}
	if len(rel.Archive) != 0 {
		t.Fatalf("拒绝后归档仍占存储（%d 字节）—— 拒绝即释放", len(rel.Archive))
	}
	// 投影仍指向 v1（拒绝让被拒版本永不生效）。
	app, _ := serverstore.GetApp(f.db, serverstore.AppKindSkill, reviewSkillName)
	if app.Title != "技能 v1 标题" {
		t.Fatalf("拒绝后投影 = %q, want 仍为 v1 标题", app.Title)
	}
	// 版本号永久占位：同一版本再发一次 ⇒ 409 VERSION_EXISTS。
	err = publishSkillRelease(t, f.db, reviewSkillName, serverstore.AppChannelMarket,
		reviewOwner, false, f.skillV2)
	var ae *appstore.Error
	if !errors.As(err, &ae) || ae.Code != appstore.CodeVersionExists {
		t.Fatalf("拒绝后重发同版本 = %v, want 409 %s", err, appstore.CodeVersionExists)
	}
	// 审计
	logs, _, _ := serverstore.ListAuditLogsPagedFiltered(f.db, 0, 20, "", "")
	if !hasAudit(logs, "market_skill_reject", reviewSkillName+"@2.0.0") {
		t.Fatal("缺少 market_skill_reject 审计")
	}
}

// ---------------------------------------------------------------------------
// 判据 4（技能侧）：下架冻结 + 已生效版本不可拒绝 + 归档释放后不可再通过
// ---------------------------------------------------------------------------

// TestMarketSkillReviewDelistedFreezesApprove 钉住"下架期间不得把待审版本置为 approved"：
//
//	变异 1：approve 不查 Distribution.Writable() ⇒ 返回 200、产出「已批准但任何人
//	        都看不见」的版本 ⇒ 红；
//	变异 2：审批时"顺手自动上架"（把 enabled 置回 1）⇒ enabled 断言红
//	        （出口必须只有管理员显式重新上架，它带审计）。
func TestMarketSkillReviewDelistedFreezesApprove(t *testing.T) {
	f := newReviewFixture(t)
	// 下架（enabled=0）
	if w, _ := mreq(t, f.r, "DELETE", "/api/server/admin/skills/"+reviewSkillName, "", f.hdr); w.Code != http.StatusOK {
		t.Fatalf("下架: %d %s", w.Code, w.Body.String())
	}
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("下架中 approve = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, _ := reviewErrorEnvelope(t, w); code != appstore.CodeAppDelisted {
		t.Fatalf("下架中 approve code = %q, want %s", code, appstore.CodeAppDelisted)
	}
	if rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0"); rel.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("被拒的 approve 改了状态: %s", rel.Status)
	}
	app, _ := serverstore.GetApp(f.db, serverstore.AppKindSkill, reviewSkillName)
	if app.Enabled != 0 {
		t.Fatal("审批不得自动上架（出口只能是管理员的显式重新上架）")
	}
	// 出口：显式重新上架后同一请求成功。
	if w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/enable", "", f.hdr); w.Code != http.StatusOK {
		t.Fatalf("重新上架: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr); w.Code != http.StatusOK {
		t.Fatalf("重新上架后 approve = %d %s", w.Code, w.Body.String())
	}
}

// TestMarketSkillReviewRejectCannotDestroyApprovedVersion 钉住"已生效版本不可拒绝"：
//
// 变异：reject 去掉 DAO 的 `status <> 'approved'` 前置条件（或改用无条件 UPDATE）
// ⇒ 正在服务的 v1 归档字节被永久释放、版本号被烧掉 ⇒ 本用例红（409 + 归档仍在）。
func TestMarketSkillReviewRejectCannotDestroyApprovedVersion(t *testing.T) {
	f := newReviewFixture(t)
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/1.0.0/reject",
		`{"reason":"想删掉"}`, f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("reject 已 approve 版本 = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, msg := reviewErrorEnvelope(t, w); code != serverstore.CodeReleaseNotRejectable {
		t.Fatalf("code = %q, want %s（文案=%q）", code, serverstore.CodeReleaseNotRejectable, msg)
	}
	v1, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "1.0.0")
	if err != nil {
		t.Fatalf("读取 v1: %v", err)
	}
	if v1.Status != serverstore.ReleaseStatusApproved || len(v1.Archive) == 0 {
		t.Fatalf("被拒的 reject 破坏了正在服务的版本: status=%q archive=%d 字节", v1.Status, len(v1.Archive))
	}
}

// TestMarketSkillReviewApproveRejectedVersionIsConflict 钉住"拒绝即释放存储"：
//
// 变异：approve 不看归档是否已释放（只改状态）⇒ 产出 approved 但 archive_bytes=0
// 的坏行（员工可见、下载 500）⇒ 本用例要求 409 ARCHIVE_CLEARED 且状态仍是 rejected。
func TestMarketSkillReviewApproveRejectedVersionIsConflict(t *testing.T) {
	f := newReviewFixture(t)
	if w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/reject",
		`{"reason":"不符合规范"}`, f.hdr); w.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", w.Code, w.Body.String())
	}
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("approve 已拒绝版本 = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, _ := reviewErrorEnvelope(t, w); code != "ARCHIVE_CLEARED" {
		t.Fatalf("code = %q, want ARCHIVE_CLEARED", code)
	}
	rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0")
	if rel.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("approve 失败后状态 = %q, want rejected", rel.Status)
	}
}

// ---------------------------------------------------------------------------
// 判据 3：渠道守卫（org 行与不存在同形）+ 版本必须存在
// ---------------------------------------------------------------------------

// TestMarketSkillReviewGuards 钉住两道前置守卫：
//
//  1. org 行 ⇒ 404，且与「该名字不存在」**逐字节同形**（不泄露存在性）；
//     变异：去掉 requireMarketAdminApp 的渠道判断 ⇒ org 行会被审核（200/409），红；
//  2. 不存在的版本 / 已软删的版本 ⇒ 404 同文案；
//     变异：跳过 GetRelease 直接 ReviewPending ⇒ 不存在的版本走 DAO 的 ErrNotFound
//     （仍 404，但**软删版本**会被 200 通过）⇒ 软删断言红。
func TestMarketSkillReviewGuards(t *testing.T) {
	f := newReviewFixture(t)
	seedOrgReviewRows(t, f)

	// org 行 vs 不存在的名字：逐字节同形
	for _, tc := range []struct{ label, method, pattern, body string }{
		{"approve", "POST", "/api/server/admin/skills/%s/1.0.0/approve", ""},
		{"reject", "POST", "/api/server/admin/skills/%s/1.0.0/reject", `{"reason":"不符合规范"}`},
		{"preview", "GET", "/api/server/admin/skills/%s/1.0.0/preview", ""},
		{"archive", "GET", "/api/server/admin/skills/%s/1.0.0/archive", ""},
		{"file", "GET", "/api/server/admin/skills/%s/1.0.0/file?path=SKILL.md", ""},
	} {
		orgW, _ := mreq(t, f.r, tc.method, strings.Replace(tc.pattern, "%s", reviewOrgSkill, 1), tc.body, f.hdr)
		missW, _ := mreq(t, f.r, tc.method, strings.Replace(tc.pattern, "%s", reviewMissing, 1), tc.body, f.hdr)
		if orgW.Code != http.StatusNotFound {
			t.Fatalf("%s: org 行 = %d %s, want 404", tc.label, orgW.Code, orgW.Body.String())
		}
		if orgW.Body.String() != missW.Body.String() {
			t.Fatalf("%s: org 行与不存在的名字可区分（存在性泄露）\n  org: %s\n  不存在: %s",
				tc.label, orgW.Body.String(), missW.Body.String())
		}
	}
	// org 行零副作用
	orgRel, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewOrgSkill, "1.0.0")
	if err != nil || orgRel.Status != serverstore.ReleaseStatusApproved || len(orgRel.Archive) == 0 {
		t.Fatalf("org 行被市场命名空间改了: %v (%v)", orgRel, err)
	}

	// 不存在的版本 ⇒ 404 同文案（与未知名字同形：路径里名字存在但版本不存在）。
	missVer, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/9.9.9/approve", "", f.hdr)
	if missVer.Code != http.StatusNotFound {
		t.Fatalf("不存在的版本 = %d %s, want 404", missVer.Code, missVer.Body.String())
	}
	if _, msg := reviewErrorEnvelope(t, missVer); msg != "技能不存在" {
		t.Fatalf("不存在的版本文案 = %q, want 技能不存在", msg)
	}
	// 软删的版本 ⇒ 也 404（版本"不存在"的另一个形态）
	if err := serverstore.SoftDeleteRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0"); err != nil {
		t.Fatalf("软删 v2: %v", err)
	}
	deleted, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr)
	if deleted.Code != http.StatusNotFound {
		t.Fatalf("软删版本 approve = %d %s, want 404", deleted.Code, deleted.Body.String())
	}
	if rel, err := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0"); err != nil ||
		rel.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("软删版本被 approve 改了状态 —— 版本存在性守卫失效: %v (%v)", rel, err)
	}
}

// ---------------------------------------------------------------------------
// 判据 1/2 的技能侧对称面：**按指定版本取字节**的 preview/archive/file
// ---------------------------------------------------------------------------

// TestMarketSkillVersionScopedBytesAreNotTheCurrentRelease 是这 10 条端点里最容易被
// "复用 name 级实现"蒙混过去的三条（preview/archive/file）的判据。
//
// 变异 1：版本级端点里用 `CurrentMarketReleaseFor`（当前 approved = v1）取字节 ⇒
//
//	preview 的 version/skill_md、archive 的字节、file 的内容全部是 v1 ⇒ 红；
//
// 变异 2：版本号从 app 投影取（s.Version）而不是路径参数 ⇒ 同上；
// 变异 3：file 端点忽略 ?path（返回 SKILL.md）⇒ 逐文件内容断言红。
func TestMarketSkillVersionScopedBytesAreNotTheCurrentRelease(t *testing.T) {
	f := newReviewFixture(t)

	// preview：路径里的 2.0.0（pending）必须被预览到，而 name 级仍是 v1 的投影。
	w, out := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/preview", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 preview = %d %s", w.Code, w.Body.String())
	}
	if out["version"] != "2.0.0" {
		t.Fatalf("版本级 preview version = %v, want 2.0.0", out["version"])
	}
	skillMD, _ := out["skill_md"].(string)
	if !strings.Contains(skillMD, "技能 v2 标题") || strings.Contains(skillMD, "技能 v1 标题") {
		t.Fatalf("版本级 preview 取到的不是 v2 的 SKILL.md: %s", skillMD)
	}
	files, _ := out["files"].([]any)
	if len(files) == 0 {
		t.Fatalf("版本级 preview 没有文件清单: %s", w.Body.String())
	}
	nameW, nameOut := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/preview", "", f.hdr)
	if nameW.Code != http.StatusOK || nameOut["version"] != "1.0.0" {
		t.Fatalf("name 级 preview 应仍指向已生效的 v1: %d %v", nameW.Code, nameOut["version"])
	}

	// file：按 ?path 逐文件取 v2 的字节
	w, out = mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/file?path=docs/guide.md", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 file = %d %s", w.Code, w.Body.String())
	}
	content, _ := out["content"].(string)
	if !strings.Contains(content, "2.0.0 版本文档") || strings.Contains(content, "1.0.0 版本文档") {
		t.Fatalf("版本级 file 取到的不是 v2 的条目: %q", content)
	}
	// 版本内条目集合：存在的条目 200、不存在的 404
	if w, _ := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/file?path=docs/example.md", "", f.hdr); w.Code != http.StatusOK {
		t.Fatalf("版本级 file 已知条目 = %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/file?path=docs/missing.md", "", f.hdr); w.Code != http.StatusNotFound {
		t.Fatalf("版本级 file 未知条目 = %d, want 404", w.Code)
	}
	// 缺 path / 非法 path ⇒ 400（沿用归档读取的既有契约）
	if w, _ := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/file", "", f.hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("版本级 file 缺 path = %d, want 400", w.Code)
	}
	if w, _ := mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/file?path=../etc/passwd", "", f.hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("版本级 file 越界 path = %d, want 400", w.Code)
	}

	// archive：字节 = v2 归档（不是当前 approved 的 v1）
	w, _ = mreq(t, f.r, "GET", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/archive", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 archive = %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Skill-Version"); got != "2.0.0" {
		t.Fatalf("版本级 archive X-Skill-Version = %q, want 2.0.0", got)
	}
	if !bytes.Equal(w.Body.Bytes(), f.skillV2) {
		t.Fatalf("版本级 archive 字节不是 v2（len=%d，v2=%d，v1=%d）",
			w.Body.Len(), len(f.skillV2), len(f.skillV1))
	}
}

// ---------------------------------------------------------------------------
// 判据 5：智能体同构（approve / reject / 下架冻结 / 不可拒 / 按版本取字节 / 渠道守卫）
// ---------------------------------------------------------------------------

// TestMarketAgentApprovePublishesPendingVersion 是技能侧判据 1 的智能体孪生。
//
// 变异：approve 只写 kind 之外的渠道、或投影重算用错 kind ⇒ apps 投影不切、客户端
// 智能体目录（capabilities / CurrentMarketReleaseFor(agent)）不切 ⇒ 红。
func TestMarketAgentApprovePublishesPendingVersion(t *testing.T) {
	f := newReviewFixture(t)
	w, out := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("agent approve = %d %s", w.Code, w.Body.String())
	}
	rel, err := serverstore.GetRelease(f.db, serverstore.AppKindAgent, reviewAgentName, "2.0.0")
	if err != nil || rel.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("agent v2 状态 = %v (%v), want approved", rel, err)
	}
	app, _ := serverstore.GetApp(f.db, serverstore.AppKindAgent, reviewAgentName)
	if app.Title != "智能体 v2 标题" {
		t.Fatalf("智能体投影未切到 v2: title=%q", app.Title)
	}
	// 员工安装通路（市场智能体下载走 name 级的 archive 端点）
	cur, err := serverstore.CurrentMarketReleaseFor(f.db, serverstore.AppKindAgent, reviewAgentName, true)
	if err != nil || cur == nil || cur.Version != "2.0.0" || !bytes.Equal(cur.Archive, f.agentV2) {
		t.Fatalf("展示版本没有切到 v2: %v (%v)", cur, err)
	}
	logs, _, _ := serverstore.ListAuditLogsPagedFiltered(f.db, 0, 20, "", "")
	if !hasAudit(logs, "market_agent_approve", reviewAgentName+"@2.0.0") {
		t.Fatal("缺少 market_agent_approve 审计")
	}
}

// TestMarketAgentRejectAndNotRejectable 是判据 2 + 4 的智能体孪生。
func TestMarketAgentRejectAndNotRejectable(t *testing.T) {
	f := newReviewFixture(t)
	// 已生效的 v1 不可拒绝
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/1.0.0/reject",
		`{"reason":"想删掉"}`, f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("reject 已 approve 智能体版本 = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, _ := reviewErrorEnvelope(t, w); code != serverstore.CodeReleaseNotRejectable {
		t.Fatalf("code = %q, want %s", code, serverstore.CodeReleaseNotRejectable)
	}
	// 待审 v2 拒绝：状态 + 归档释放 + 审计
	w, out := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/reject",
		`{"reason":"编排不符合规范"}`, f.hdr)
	if w.Code != http.StatusOK || out["ok"] != true {
		t.Fatalf("agent reject = %d %s", w.Code, w.Body.String())
	}
	rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindAgent, reviewAgentName, "2.0.0")
	if rel.Status != serverstore.ReleaseStatusRejected || len(rel.Archive) != 0 {
		t.Fatalf("agent 拒绝语义不对: status=%q archive=%d", rel.Status, len(rel.Archive))
	}
	// 拒绝后不可再通过（归档已释放）
	w, _ = mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("approve 已拒绝的智能体版本 = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, _ := reviewErrorEnvelope(t, w); code != "ARCHIVE_CLEARED" {
		t.Fatalf("code = %q, want ARCHIVE_CLEARED", code)
	}
	logs, _, _ := serverstore.ListAuditLogsPagedFiltered(f.db, 0, 20, "", "")
	if !hasAudit(logs, "market_agent_reject", reviewAgentName+"@2.0.0") {
		t.Fatal("缺少 market_agent_reject 审计")
	}
}

// TestMarketAgentReviewDelistedFreezesApprove：智能体侧的下架冻结。
func TestMarketAgentReviewDelistedFreezesApprove(t *testing.T) {
	f := newReviewFixture(t)
	if w, _ := mreq(t, f.r, "DELETE", "/api/server/admin/agents/"+reviewAgentName, "", f.hdr); w.Code != http.StatusOK {
		t.Fatalf("下架智能体: %d %s", w.Code, w.Body.String())
	}
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("下架中 approve 智能体 = %d %s, want 409", w.Code, w.Body.String())
	}
	if code, _ := reviewErrorEnvelope(t, w); code != appstore.CodeAppDelisted {
		t.Fatalf("code = %q, want %s", code, appstore.CodeAppDelisted)
	}
	if rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindAgent, reviewAgentName, "2.0.0"); rel.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("被拒的 approve 改了状态: %s", rel.Status)
	}
}

// TestMarketAgentVersionScopedBytes：智能体侧「按指定版本取字节」（preview/archive/file）。
//
// 变异：三条版本级端点复用 name 级实现（CurrentMarketReleaseFor = v1）⇒ 内容、
// 版本号、归档字节全部是 v1 ⇒ 红。
func TestMarketAgentVersionScopedBytes(t *testing.T) {
	f := newReviewFixture(t)

	w, out := mreq(t, f.r, "GET", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/preview", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 agent preview = %d %s", w.Code, w.Body.String())
	}
	if out["version"] != "2.0.0" {
		t.Fatalf("版本级 agent preview version = %v, want 2.0.0", out["version"])
	}
	if files, _ := out["files"].([]any); len(files) == 0 {
		t.Fatalf("版本级 agent preview 没有文件清单: %s", w.Body.String())
	}
	nameW, nameOut := mreq(t, f.r, "GET", "/api/server/admin/agents/"+reviewAgentName+"/preview", "", f.hdr)
	if nameW.Code != http.StatusOK || nameOut["version"] != "1.0.0" {
		t.Fatalf("name 级 agent preview 应仍指向 v1: %d %v", nameW.Code, nameOut["version"])
	}

	// file：v2 的 preset.yml（title 不同 ⇒ 能区分版本）
	w, out = mreq(t, f.r, "GET", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/file?path=preset.yml", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 agent file = %d %s", w.Code, w.Body.String())
	}
	content, _ := out["content"].(string)
	if !strings.Contains(content, "智能体 v2 标题") {
		t.Fatalf("版本级 agent file 不是 v2 的 preset.yml: %q", content)
	}
	if w, _ := mreq(t, f.r, "GET", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/file?path=missing.yml", "", f.hdr); w.Code != http.StatusNotFound {
		t.Fatalf("版本级 agent file 未知条目 = %d, want 404", w.Code)
	}

	// archive：字节 = v2
	w, _ = mreq(t, f.r, "GET", "/api/server/admin/agents/"+reviewAgentName+"/2.0.0/archive", "", f.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("版本级 agent archive = %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Preset-Version"); got != "2.0.0" {
		t.Fatalf("版本级 agent archive X-Preset-Version = %q, want 2.0.0", got)
	}
	if !bytes.Equal(w.Body.Bytes(), f.agentV2) {
		t.Fatalf("版本级 agent archive 字节不是 v2（len=%d，v2=%d）", w.Body.Len(), len(f.agentV2))
	}
}

// TestMarketAgentReviewGuards：智能体侧的渠道守卫 + 版本存在性（同技能侧判据 3）。
//
// 变异：去掉 requireMarketAdminApp 的渠道判断（改用 GetApp 只看存在）⇒ org 行可被
// approve/reject/预览/下载/逐文件读出 ⇒ 红。
func TestMarketAgentReviewGuards(t *testing.T) {
	f := newReviewFixture(t)
	seedOrgReviewRows(t, f)
	for _, tc := range []struct{ label, method, pattern, body string }{
		{"approve", "POST", "/api/server/admin/agents/%s/1.0.0/approve", ""},
		{"reject", "POST", "/api/server/admin/agents/%s/1.0.0/reject", `{"reason":"不符合规范"}`},
		{"preview", "GET", "/api/server/admin/agents/%s/1.0.0/preview", ""},
		{"archive", "GET", "/api/server/admin/agents/%s/1.0.0/archive", ""},
		{"file", "GET", "/api/server/admin/agents/%s/1.0.0/file?path=preset.yml", ""},
	} {
		orgW, _ := mreq(t, f.r, tc.method, strings.Replace(tc.pattern, "%s", reviewOrgAgent, 1), tc.body, f.hdr)
		missW, _ := mreq(t, f.r, tc.method, strings.Replace(tc.pattern, "%s", reviewMissing, 1), tc.body, f.hdr)
		if orgW.Code != http.StatusNotFound {
			t.Fatalf("%s: org 智能体 = %d %s, want 404", tc.label, orgW.Code, orgW.Body.String())
		}
		if orgW.Body.String() != missW.Body.String() {
			t.Fatalf("%s: org 智能体与不存在的名字可区分（存在性泄露）\n  org: %s\n  不存在: %s",
				tc.label, orgW.Body.String(), missW.Body.String())
		}
	}
	orgRel, err := serverstore.GetRelease(f.db, serverstore.AppKindAgent, reviewOrgAgent, "1.0.0")
	if err != nil || orgRel.Status != serverstore.ReleaseStatusApproved || len(orgRel.Archive) == 0 {
		t.Fatalf("org 智能体被市场命名空间改了: %v (%v)", orgRel, err)
	}
	// 不存在的版本 ⇒ 404 同文案
	w, _ := mreq(t, f.r, "POST", "/api/server/admin/agents/"+reviewAgentName+"/9.9.9/approve", "", f.hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("不存在的智能体版本 = %d %s, want 404", w.Code, w.Body.String())
	}
	if _, msg := reviewErrorEnvelope(t, w); msg != "智能体不存在" {
		t.Fatalf("文案 = %q, want 智能体不存在", msg)
	}
}

// ---------------------------------------------------------------------------
// 判据 6：权限点（approve/reject = capability:write，只读管理员 403）
// ---------------------------------------------------------------------------

// TestMarketReviewWriteNeedsCapabilityWrite 钉住写端点的权限申报：
//
// 变异：把 /skills|agents/:name/:version/{approve,reject} 的权限点写成 ""（登录即可）
// 或 capability:read ⇒ 只读 auditor 会话能审核 ⇒ 红（越权写）。
func TestMarketReviewWriteNeedsCapabilityWrite(t *testing.T) {
	f := newReviewFixture(t)
	uid, err := serverstore.CreateUserWithPassword(f.db, reviewAuditor, "audpw123")
	if err != nil {
		t.Fatalf("夹具 auditor: %v", err)
	}
	u, err := serverstore.GetUserByID(f.db, uid)
	if err != nil {
		t.Fatalf("夹具 auditor 读取: %v", err)
	}
	u.Role = serverstore.RoleAuditor
	if err := serverstore.UpdateUser(f.db, u); err != nil {
		t.Fatalf("夹具 auditor 角色: %v", err)
	}
	sess, csrf, err := serverauth.CreateAdminSession(f.db, uid)
	if err != nil {
		t.Fatalf("夹具 auditor 会话: %v", err)
	}
	auditorHdr := map[string]string{"Cookie": "zeokeel_session=" + sess.ID, "X-CSRF-Token": csrf}

	for _, path := range []string{
		"/api/server/admin/skills/" + reviewSkillName + "/2.0.0/approve",
		"/api/server/admin/skills/" + reviewSkillName + "/2.0.0/reject",
		"/api/server/admin/agents/" + reviewAgentName + "/2.0.0/approve",
		"/api/server/admin/agents/" + reviewAgentName + "/2.0.0/reject",
	} {
		w, _ := mreq(t, f.r, "POST", path, `{"reason":"x"}`, auditorHdr)
		if w.Code != http.StatusForbidden {
			t.Fatalf("auditor %s = %d %s, want 403", path, w.Code, w.Body.String())
		}
	}
	// 越权请求零副作用
	if rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0"); rel.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("auditor 的请求改了技能版本状态: %s", rel.Status)
	}
}

// ---------------------------------------------------------------------------
// 投影阶段失败 ⇒ 500 + 「审核结果已落库,但…更新失败(请重试一次)」
// ---------------------------------------------------------------------------

// TestMarketReviewProjectionFailureIsReportedAsCommitted 钉住"状态已落库、投影没跟上"
// 的可诊断文案：这不是"审核失败"，否则管理员会以为要等作者重传。
//
// 注入方式：在 apps 上加一个 BEFORE UPDATE 触发器（写库阶段失败），app_releases 的
// 状态写入已成功、投影 UPDATE 失败 —— 正是重复点审核会自愈的形态。
//
// 变异：把 RecomputeAppProjection 的错误与状态写错误混为一谈（统一回"更新失败"）⇒
// 文案断言红（管理员收不到"已落库,请重试"这个关键信息）。
func TestMarketReviewProjectionFailureIsReportedAsCommitted(t *testing.T) {
	f := newReviewFixture(t)
	if _, err := f.db.Exec(`CREATE OR REPLACE FUNCTION review_projection_boom() RETURNS trigger AS $$
		BEGIN RAISE EXCEPTION 'projection boom'; END $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("注入触发器函数: %v", err)
	}
	if _, err := f.db.Exec(`CREATE TRIGGER review_projection_boom BEFORE UPDATE ON apps
		FOR EACH ROW EXECUTE FUNCTION review_projection_boom()`); err != nil {
		t.Fatalf("注入触发器: %v", err)
	}
	t.Cleanup(func() {
		_, _ = f.db.Exec(`DROP TRIGGER IF EXISTS review_projection_boom ON apps`)
		_, _ = f.db.Exec(`DROP FUNCTION IF EXISTS review_projection_boom()`)
	})

	w, _ := mreq(t, f.r, "POST", "/api/server/admin/skills/"+reviewSkillName+"/2.0.0/approve", "", f.hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("投影失败 = %d %s, want 500", w.Code, w.Body.String())
	}
	if code, msg := reviewErrorEnvelope(t, w); code != "INTERNAL" || !strings.Contains(msg, "审核结果已落库") {
		t.Fatalf("文案 = %q/%q, want INTERNAL + 「审核结果已落库…请重试一次」", code, msg)
	}
	// 关键：状态**确实**已落库（这就是"重试可自愈"的前提，也是文案的依据）。
	rel, _ := serverstore.GetRelease(f.db, serverstore.AppKindSkill, reviewSkillName, "2.0.0")
	if rel.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("状态应为已落库 approved（投影失败不回滚状态），实际 %q", rel.Status)
	}
}
