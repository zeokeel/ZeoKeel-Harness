package agentshare

// 2026-10-23「已上架技能无法更新」修复（C2 / C3 / 判据 7）：智能体侧与技能侧
// 逐条同构 —— 员工上传的渠道自动化 + 管理员给组织渠道发新版本的端点。
//
// 智能体与技能共用同一个发布内核（appstore.Publish），但入口 handler 是两份
// 实现（归档格式不同：agent.cordis.yml + preset.yml）。本文件钉住：
//   1. 员工对**已上架**的预设（本人归属，market 或 org）发新版本 ⇒ 201 pending；
//   2. 管理员端点 POST /api/server/admin/agent-presets/:name/archive ⇒
//      201 approved、投影切新版、员工侧（授权后）可下载；
//   3. 解析段是**共享函数**（不是复制粘贴）：错误码与员工上传逐条一致；
//   4. 审计 agent_preset_upload 留行。
//
// 每条用例的注释写明「变异什么会红」。

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

// presetArchiveWith 生成一份合规预设归档（编排 + preset.yml），版本/展示名可定制。
//
// preset.yml 必须带 changelog：非首个版本缺它会被发布内核按「非首版必须写
// 更新说明」拒绝（决策 §5.2，与技能侧同一条规则），这里的夹具是 v2 上传。
func presetArchiveWith(t *testing.T, display, version string) []byte {
	t.Helper()
	meta := presetMeta(display, version) + "changelog: 测试夹具的更新说明。\n"
	return makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       meta,
	})
}

// adminArchiveBody 是管理员发新版端点的请求体：只有 archive（版本以包内为准）。
func adminArchiveBody(t *testing.T, archive []byte) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"archive": base64.StdEncoding.EncodeToString(archive),
	})
	return string(body)
}

// postJSON 发一个带指定请求头的 JSON POST。
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

// getPath 发一个带指定请求头的 GET。
func getPath(t *testing.T, h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(w, req)
	return w
}

// seedPublishedMarketPreset 造一条「已上架的市场预设」（apps.channel=market +
// approved v1），归属 owner。等价于管理员在市场命名空间上架后的现场。
func seedPublishedMarketPreset(t *testing.T, db *sql.DB, name, owner, display, version string, archive []byte) {
	t.Helper()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: display, Description: "市场渠道夹具描述",
		Owner: owner, Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatalf("夹具 apps 行: %v", err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: version, Title: display,
		Description: "市场渠道夹具描述", Publisher: owner, Status: serverstore.ReleaseStatusApproved,
		Archive: archive, Checksum: "seed-" + version,
	}); err != nil {
		t.Fatalf("夹具 release: %v", err)
	}
}

// 判据 7-a：员工对**已上架市场预设**（本人归属）发新版本 ⇒ 201 pending；
// apps.channel 仍 market；市场分发面仍见旧 approved 版本；投影不变。
//
// 变异会红：
//   - agentshare.Upload 的 Channel 写回 AppChannelOrg ⇒ 内核回 409 NAME_TAKEN
//     （「已上架技能无法更新」在智能体侧的孪生缺陷）；
//   - 自动渠道解析成 org ⇒ apps.channel 变化，市场面整条消失；
//   - 待审版本改写投影 ⇒ title 与 v1 不同。
func TestEmployeeUploadAutoChannelFollowsMarketPreset(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	const name = "market-agent-upd"
	seedPublishedMarketPreset(t, db, name, "alice", "市场旧展示名", "1.0.0", presetArchiveWith(t, "市场旧展示名", "1.0.0"))
	before, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		t.Fatal(err)
	}

	w := postJSON(t, r, "/api/client/v2/agent-presets",
		uploadBody(name, "新版描述", "市场新展示名", presetArchiveWith(t, "市场新展示名", "2.0.0")), userHdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("员工续发已上架市场预设 = %d %s（want 201；409 NAME_TAKEN 即原始缺陷）", w.Code, w.Body.String())
	}
	var out struct {
		Preset struct {
			Status string `json:"status"`
		} `json:"preset"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Preset.Status != serverstore.ReleaseStatusPending {
		t.Fatalf("上传响应 = %s(解析 %v), want preset.status=pending", w.Body.String(), err)
	}

	after, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		t.Fatal(err)
	}
	if after.Channel != serverstore.AppChannelMarket {
		t.Fatalf("apps.channel = %q, want market", after.Channel)
	}
	if after.Title != before.Title || after.Description != before.Description {
		t.Fatalf("待审版本改写了投影: before=(%q,%q) after=(%q,%q)",
			before.Title, before.Description, after.Title, after.Description)
	}
	cur, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, name, false)
	if err != nil {
		t.Fatal(err)
	}
	if cur == nil || cur.Version != "1.0.0" {
		t.Fatalf("市场展示版本 = %+v, want 1.0.0（待审版本不得生效）", cur)
	}
}

// 判据 7-b：员工对已上架**组织**预设续发 v2 ⇒ 201 pending（渠道自动落到 org）。
//
// 变异会红：自动渠道解析对 agent 侧漏接（只改了技能 handler）⇒ 这里仍回
// 409（若内核未解析）或 apps.channel 丢失 org。
func TestEmployeeUploadAutoChannelFollowsOrgPreset(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	const name = "org-agent-upd"
	if w := postJSON(t, r, "/api/client/v2/agent-presets",
		uploadBody(name, "首版描述", "组织首版展示名", presetArchiveWith(t, "组织首版展示名", "1.0.0")), userHdr); w.Code != http.StatusCreated {
		t.Fatalf("v1 上传 = %d %s", w.Code, w.Body.String())
	}
	if app, err := serverstore.GetApp(db, serverstore.AppKindAgent, name); err != nil || app.Channel != serverstore.AppChannelOrg {
		t.Fatalf("首版 apps = %+v err=%v, want channel=org", app, err)
	}
	if w := postJSON(t, r, "/api/server/admin/agent-presets/"+name+"/1.0.0/approve", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	if w := postJSON(t, r, "/api/client/v2/agent-presets",
		uploadBody(name, "新版描述", "组织新版展示名", presetArchiveWith(t, "组织新版展示名", "1.1.0")), userHdr); w.Code != http.StatusCreated {
		t.Fatalf("员工续发已上架组织预设 = %d %s", w.Code, w.Body.String())
	}
}

// 判据 7-c（判据 6 的智能体对偶）：管理员端点发新版 ⇒ 201 approved、投影切新版、
// 授权员工下载 200；审计 agent_preset_upload 留行。
//
// 变异会红：
//   - UploadAdmin 忘传 AdminPublish ⇒ status=pending（不是「管理端上架=已审」）；
//   - 忘传 Channel=org ⇒ 显式声明缺失（本用例断言 Apps 行不存在时也落 org）；
//   - 解析段被复制粘贴后与员工上传分叉 ⇒ 由下一条用例覆盖；
//   - 不写审计 ⇒ agent_preset_upload 计数不足。
func TestAdminUploadAgentArchivePublishesOrgVersion(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	const name = "admin-org-agent"
	w := postJSON(t, r, "/api/server/admin/agent-presets/"+name+"/archive",
		adminArchiveBody(t, presetArchiveWith(t, "组织旧展示名", "1.0.0")), adminHdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("管理员首版上传 = %d %s", w.Code, w.Body.String())
	}
	var first struct {
		Preset struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Status  string `json:"status"`
		} `json:"preset"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil || first.Preset.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("管理员上传 = %s(解析 %v), want status=approved", w.Body.String(), err)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil || app.Channel != serverstore.AppChannelOrg || app.Title != "组织旧展示名" {
		t.Fatalf("apps = %+v err=%v, want channel=org title=组织旧展示名", app, err)
	}

	// 第二版：投影立即切到新版（approved 即生效）。
	if w2 := postJSON(t, r, "/api/server/admin/agent-presets/"+name+"/archive",
		adminArchiveBody(t, presetArchiveWith(t, "组织新展示名", "2.0.0")), adminHdr); w2.Code != http.StatusCreated {
		t.Fatalf("管理员续发 = %d %s", w2.Code, w2.Body.String())
	}
	app, err = serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil || app.Title != "组织新展示名" {
		t.Fatalf("投影 title = %q err=%v, want 组织新展示名", app.Title, err)
	}

	// 员工侧：未授权 ⇒ 404（严格默认拒绝）；授权后 ⇒ 200。
	if wD := getPath(t, r, "/api/client/v2/agent-presets/"+name+"/2.0.0/archive", userHdr); wD.Code != http.StatusNotFound {
		t.Fatalf("未授权员工下载 = %d %s, want 404", wD.Code, wD.Body.String())
	}
	if err := serverstore.GrantSharedResource(db, serverstore.SharedPresetGrantTable, name, "alice", serverstore.GranteeUser); err != nil {
		t.Fatalf("授权 alice: %v", err)
	}
	wD := getPath(t, r, "/api/client/v2/agent-presets/"+name+"/2.0.0/archive", userHdr)
	if wD.Code != http.StatusOK || wD.Body.Len() == 0 {
		t.Fatalf("授权员工下载 v2 = %d (%d bytes)", wD.Code, wD.Body.Len())
	}

	// 判据 9：两次管理员上传各留一行 agent_preset_upload 审计。
	_, total, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "agent_preset_upload", "")
	if err != nil {
		t.Fatal(err)
	}
	if total < 2 {
		t.Fatalf("agent_preset_upload 审计 = %d 行, want ≥2", total)
	}
}

// 判据 7-d：管理员端点与员工上传**共用同一套归档解析**（不是复制粘贴）。
//
// 变异会红：管理员 handler 自写一份宽松解析（跳过 ValidatePresetArchive /
// ValidateAgentComposition / ParseAgent）⇒ 这些用例拿到 201 或错误码漂移。
func TestAdminUploadAgentArchiveReusesValidation(t *testing.T) {
	r, db, adminHdr, _, _ := setup(t)
	defer db.Close()

	// 坏 JSON。
	if w := postJSON(t, r, "/api/server/admin/agent-presets/bad-body/archive", "{", adminHdr); w.Code != http.StatusBadRequest {
		t.Fatalf("坏请求体 = %d, want 400", w.Code)
	}
	// 缺归档。
	if w := postJSON(t, r, "/api/server/admin/agent-presets/no-archive/archive", `{}`, adminHdr); w.Code != http.StatusBadRequest {
		t.Fatalf("缺归档 = %d %s, want 400", w.Code, w.Body.String())
	}
	// 归档里没有 agent.cordis.yml。
	noComposition := makeArchive(t, map[string]string{"preset.yml": presetMeta("无编排", "1.0.0")})
	if w := postJSON(t, r, "/api/server/admin/agent-presets/no-composition/archive", adminArchiveBody(t, noComposition), adminHdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("缺编排 = %d %s, want 422", w.Code, w.Body.String())
	}
	// 归档里没有 preset.yml（元数据不全）。
	noMeta := makeArchive(t, map[string]string{"agent.cordis.yml": testComposition})
	if w := postJSON(t, r, "/api/server/admin/agent-presets/no-meta/archive", adminArchiveBody(t, noMeta), adminHdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("缺 preset.yml = %d %s, want 422", w.Code, w.Body.String())
	}
	// 非法路径名。
	if w := postJSON(t, r, "/api/server/admin/agent-presets/BadName/archive", adminArchiveBody(t, noMeta), adminHdr); w.Code != http.StatusBadRequest {
		t.Fatalf("非法路径名 = %d %s, want 400", w.Code, w.Body.String())
	}
}
