package api

// 部署 / 回滚 / 撤回 / 恢复的**行为级**用例（迁移 0086；设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §3.3、§5.1–§5.3、§6、§9.2–§9.4）。
//
// 为什么这些用例必须走 HTTP 面而不是只测 DAO：本轮的病根是"生效版本隐式推导"
// （max(id) approved）—— 它不在任何单个函数里，而在**端点怎么组合 DAO** 上。
// 因此每条判据都从生产路径打进去，断言响应体、库状态与审计三处一致。
//
// 夹具用 serverstore 直接建 app/release（不跑发布编译）：本文件测的是**部署语义**，
// 不是发布链路；编译一次 3–11 s 会把整轮反馈时间拉长一个数量级，而发布链路本身
// 已有自己的用例（publish_test.go 等）。
//
// 变异验证（每条对应一处实现，删掉后本文件必红）：
//   - 删掉"目标即当前 ⇒ changed=false 且不写审计"⇒ TestDeployIdempotent 的审计计数红；
//   - 把 kind 判定固定成 publish ⇒ TestDeployRollback 的 kind 断言红；
//   - 审计 detail 去掉 actor_role ⇒ TestDeployRollback 的明细断言红；
//   - 员工面把超管兜底记成 owner ⇒ TestDeployAuthMatrix 的 super_admin 断言红；
//   - 撤回只判"版本存在"不判 pending ⇒ TestWithdrawRules 的 approved 撤回红；
//   - 恢复把 enabled 置 1 ⇒ TestRestoreRules 的 enabled 断言红；
//   - purged 之后还允许恢复（返回 200）⇒ TestRestoreRules 的 410 断言红。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// seedLifecycleApp 直接建一个 wasm 应用行（不走发布链路，见文件头）。
func (e *testEnv) seedLifecycleApp(appID, owner string) {
	e.t.Helper()
	if err := serverstore.UpsertWasmApp(e.ctx(), e.db, serverstore.WasmApp{
		AppID: appID, Title: appID + " 标题", Owner: owner, Enabled: true,
		Purpose: "演示", DataSensitivity: "internal",
	}); err != nil {
		e.t.Fatalf("建应用 %s 失败: %v", appID, err)
	}
}

// seedLifecycleRelease 直接写一个版本行（status 由调用方给；withBytes=false 造
// "字节已释放"的存量形态）。
func (e *testEnv) seedLifecycleRelease(appID, version, status string, withBytes bool) int64 {
	e.t.Helper()
	var archive []byte
	if withBytes {
		archive = []byte("wasm-bytes-" + version)
	}
	id, err := serverstore.CreateWasmRelease(e.ctx(), e.db, serverstore.WasmRelease{
		AppID: appID, Version: version, Title: appID + " " + version,
		Description: "描述 " + version, Changelog: "第 " + version + " 版",
		Publisher: "alice", Checksum: "sum-" + version, Size: int64(len(archive)),
		Status: status, Wasm: archive,
		ConfigJSON: `{"access":"login","purpose":"用途 ` + version + `","data_sensitivity":"internal"}`,
	})
	if err != nil {
		e.t.Fatalf("建版本 %s v%s 失败: %v", appID, version, err)
	}
	return id
}

// deploymentList 读员工面的部署历史。
func (e *testEnv) deploymentList(token, appID string) []map[string]any {
	e.t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/"+appID+"/deployments", token, nil)
	var out struct {
		Deployments []map[string]any `json:"deployments"`
		CurrentID   int64            `json:"current_deployment_id"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	return out.Deployments
}

// jsonMarshal 是 json.Marshal 的测试内薄封装（失败即 Fatal）。
func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

// TestDeployAndHistory 覆盖"部署 → 历史 → 幂等"主线（设计 §5.1、§9.2）。
func TestDeployAndHistory(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("dep-tool", "alice")
	v1 := e.seedLifecycleRelease("dep-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/dep-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0", "message": "上线首版"})
	var out struct {
		App struct {
			AppID               string `json:"app_id"`
			CurrentVersion      string `json:"current_version"`
			CurrentReleaseID    int64  `json:"current_release_id"`
			CurrentDeploymentID int64  `json:"current_deployment_id"`
		} `json:"app"`
		Deployment struct {
			ID        int64  `json:"id"`
			Version   string `json:"version"`
			Kind      string `json:"kind"`
			Actor     string `json:"actor"`
			ActorRole string `json:"actor_role"`
			Current   bool   `json:"current"`
		} `json:"deployment"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Changed {
		t.Fatal("首次部署必须 changed=true")
	}
	if out.Deployment.Kind != serverstore.DeployKindPublish {
		t.Fatalf("首次部署到最新 approved 版本的 kind = %q, want publish", out.Deployment.Kind)
	}
	if out.Deployment.Actor != "alice" || out.Deployment.ActorRole != serverstore.ActorRoleOwner {
		t.Fatalf("部署 actor/role = %q/%q, want alice/owner", out.Deployment.Actor, out.Deployment.ActorRole)
	}
	if !out.Deployment.Current {
		t.Fatal("新部署必须在历史里标 current")
	}
	app := e.appRow("dep-tool")
	if app.CurrentReleaseID != v1 || app.CurrentDeploymentID != out.Deployment.ID {
		t.Fatalf("库内指针不符：current_release_id=%d current_deployment_id=%d（want %d/%d）",
			app.CurrentReleaseID, app.CurrentDeploymentID, v1, out.Deployment.ID)
	}

	// 审计：一条 wasm_app_deploy，明细含 deployment_id/version/kind/actor_role。
	details := e.auditDetails("dep-tool", "wasm_app_deploy")
	if len(details) != 1 {
		t.Fatalf("成功部署必须写一条 wasm_app_deploy 审计，得到 %d 条: %v", len(details), details)
	}
	for _, want := range []string{"deployment_id=", "version=1.0.0", "kind=publish", "actor_role=owner"} {
		if !strings.Contains(details[0], want) {
			t.Fatalf("部署审计明细缺 %q；detail=%q", want, details[0])
		}
	}

	// 幂等：再部署一次 ⇒ changed=false、不追加历史、不写审计。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/dep-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	var again struct {
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &again)
	if again.Changed {
		t.Fatal("目标版本已是当前版本时必须 changed=false（幂等）")
	}
	if n := len(e.deploymentList(e.tokens["alice"], "dep-tool")); n != 1 {
		t.Fatalf("幂等部署不得追加历史，得到 %d 条", n)
	}
	if n := len(e.auditDetails("dep-tool", "wasm_app_deploy")); n != 1 {
		t.Fatalf("幂等部署不得写审计，得到 %d 条", n)
	}
	// 历史读取：current 标记 + 当前版本号取自指针（不是"最新一条"的假设）。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/dep-tool/deployments", e.tokens["alice"], nil)
	var hist struct {
		CurrentVersion string `json:"current_version"`
		Deployments    []struct {
			Version string `json:"version"`
			Current bool   `json:"current"`
		} `json:"deployments"`
	}
	e.decodeJSON(w, http.StatusOK, &hist)
	if hist.CurrentVersion != "1.0.0" || len(hist.Deployments) != 1 || !hist.Deployments[0].Current {
		t.Fatalf("部署历史响应不对: %+v", hist)
	}
}

// TestDeployRejectsNonDeployableAndReleasedBytes 覆盖两个 409 码（设计 §3.3 不变量 1、§6.2）。
func TestDeployRejectsNonDeployableAndReleasedBytes(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("gate-tool", "alice")
	e.seedLifecycleRelease("gate-tool", "1.0.0", serverstore.ReleaseStatusPending, true)
	e.seedLifecycleRelease("gate-tool", "0.9.0", serverstore.ReleaseStatusApproved, false)

	// pending ⇒ RELEASE_NOT_DEPLOYABLE（409）
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != serverstore.CodeReleaseNotDeployable {
		t.Fatalf("pending 版本部署 code = %q, want %q", eb.Error.Code, serverstore.CodeReleaseNotDeployable)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatal("错误信封必须带可操作 hint（第一消费者是 AI）")
	}
	// approved 但字节已释放 ⇒ RELEASE_BYTES_RELEASED（409）
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "0.9.0"})
	eb = e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != serverstore.CodeReleaseBytesReleased {
		t.Fatalf("字节已释放版本部署 code = %q, want %q", eb.Error.Code, serverstore.CodeReleaseBytesReleased)
	}
	// 不存在的版本 ⇒ 404（与"不可部署"可辨）
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "9.9.9"})
	e.decodeErr(w, http.StatusNotFound)
	// 缺 version ⇒ 422 MISSING_FIELD
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-tool/deployments", e.tokens["alice"], map[string]any{})
	eb = e.decodeErr(w, http.StatusUnprocessableEntity)
	if eb.Error.Code != "MISSING_FIELD" {
		t.Fatalf("缺 version 的 code = %q, want MISSING_FIELD", eb.Error.Code)
	}
	// 失败尝试不得留下历史/指针/审计。
	if n := len(e.deploymentList(e.tokens["alice"], "gate-tool")); n != 0 {
		t.Fatalf("被拒的部署不得留下历史，得到 %d", n)
	}
	if n := len(e.auditDetails("gate-tool", "wasm_app_deploy")); n != 0 {
		t.Fatalf("被拒的部署不得写部署审计，得到 %d", n)
	}
}

// TestDeployRollback 覆盖回滚：用旧 approved 版本再部署一次（kind=rollback，历史不改写）。
func TestDeployRollback(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("roll-tool", "alice")
	v1 := e.seedLifecycleRelease("roll-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	v2 := e.seedLifecycleRelease("roll-tool", "2.0.0", serverstore.ReleaseStatusApproved, true)

	for _, version := range []string{"2.0.0", "1.0.0"} {
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/roll-tool/deployments", e.tokens["alice"],
			map[string]any{"version": version, "message": "部署 " + version})
		if w.Code != http.StatusOK {
			t.Fatalf("部署 %s 失败: %d %s", version, w.Code, w.Body.String())
		}
	}
	app := e.appRow("roll-tool")
	if app.CurrentReleaseID != v1 {
		t.Fatalf("回滚后 current_release_id = %d, want v1=%d（v2=%d）", app.CurrentReleaseID, v1, v2)
	}
	hist := e.deploymentList(e.tokens["alice"], "roll-tool")
	if len(hist) != 2 {
		t.Fatalf("历史应有 2 条（publish + rollback），得到 %d", len(hist))
	}
	if hist[0]["kind"] != serverstore.DeployKindRollback || hist[0]["version"] != "1.0.0" || hist[0]["current"] != true {
		t.Fatalf("最新历史 = %+v, want rollback v1.0.0 current=true", hist[0])
	}
	if hist[1]["kind"] != serverstore.DeployKindPublish || hist[1]["version"] != "2.0.0" || hist[1]["current"] != false {
		t.Fatalf("历史第二条 = %+v, want publish v2.0.0 非 current（历史不改写）", hist[1])
	}
	// 两条审计都在，回滚那条 kind=rollback。
	details := e.auditDetails("roll-tool", "wasm_app_deploy")
	if len(details) != 2 {
		t.Fatalf("两次部署必须两条审计，得到 %d", len(details))
	}
	// 审计读面是**新的在前**，所以回滚那条不一定在 [1]：这里按内容找，顺序无关。
	foundRollback := false
	for _, d := range details {
		if strings.Contains(d, "kind=rollback") && strings.Contains(d, "version=1.0.0") {
			foundRollback = true
		}
	}
	if !foundRollback {
		t.Fatalf("回滚审计明细必须标 kind=rollback + version=1.0.0；details=%v", details)
	}
	// 投影跟着回滚（版本即投影）。
	if app.Title != "roll-tool 1.0.0" || app.Purpose != "用途 1.0.0" {
		t.Fatalf("回滚后投影未回到目标版本: title=%q purpose=%q", app.Title, app.Purpose)
	}
}

// TestDeployLifecycleErrors 覆盖冻结/删除/清除三态的错误码（设计 §5.1、§5.5）。
func TestDeployLifecycleErrors(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("life-tool", "alice")
	relID := e.seedLifecycleRelease("life-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleApp("purged-tool", "alice")
	purgedRel := e.seedLifecycleRelease("purged-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	// 冻结 ⇒ 409 APP_FROZEN
	now := e.h.now().UTC()
	if err := serverstore.FreezeWasmAppWithRetention(e.ctx(), e.db, "life-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("冻结失败: %v", err)
	}
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/life-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != "APP_FROZEN" {
		t.Fatalf("冻结应用部署 code = %q, want APP_FROZEN", eb.Error.Code)
	}

	// 删除 ⇒ 409 APP_DELETED（不是 404：作者需要看到"先恢复"这条可操作路径）
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "life-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删失败: %v", err)
	}
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/life-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	eb = e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != serverstore.CodeAppDeleted {
		t.Fatalf("已删除应用部署 code = %q, want %q", eb.Error.Code, serverstore.CodeAppDeleted)
	}
	if len(eb.Error.Hints) == 0 || !strings.Contains(strings.Join(eb.Error.Hints, " "), "restore") {
		t.Fatalf("APP_DELETED 的 hint 必须指向 restore；hints=%v", eb.Error.Hints)
	}
	_ = relID

	// 真删 ⇒ 410 APP_PURGED
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "purged-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删 purged-tool: %v", err)
	}
	if err := serverstore.MarkWasmAppPurged(e.ctx(), e.db, "purged-tool", now); err != nil {
		e.t.Fatalf("标记 purged: %v", err)
	}
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/purged-tool/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	eb = e.decodeErr(w, http.StatusGone)
	if eb.Error.Code != serverstore.CodeAppPurged {
		t.Fatalf("已清除应用部署 code = %q, want %q", eb.Error.Code, serverstore.CodeAppPurged)
	}
	_ = purgedRel
}

// TestDeployAuthMatrix 覆盖员工面归属 + 超管兜底可辨（设计 §6.1、审计 C-15）。
func TestDeployAuthMatrix(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("auth-tool", "alice")
	e.seedLifecycleRelease("auth-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)

	// 非 owner（bob）⇒ 404（与不存在同形，不泄露存在性）
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/client/v2/apps/wasm/auth-tool/deployments"},
		{http.MethodPost, "/api/client/v2/apps/wasm/auth-tool/deployments"},
		{http.MethodPost, "/api/client/v2/apps/wasm/auth-tool/releases/1.0.0/withdraw"},
		{http.MethodPost, "/api/client/v2/apps/wasm/auth-tool/restore"},
	} {
		w := e.req(tc.method, tc.path, e.tokens["bob"], map[string]any{"version": "1.0.0"})
		eb := e.decodeErr(w, http.StatusNotFound)
		if eb.Error.Code != "NOT_FOUND" {
			t.Fatalf("%s %s 非 owner code = %q, want NOT_FOUND", tc.method, tc.path, eb.Error.Code)
		}
	}

	// 超管兜底：可以部署他人应用，且 actor_role=super_admin（员工面与审计都可辨）
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/auth-tool/deployments", e.tokens["boss"],
		map[string]any{"version": "1.0.0"})
	var out struct {
		Deployment struct {
			ActorRole string `json:"actor_role"`
			Actor     string `json:"actor"`
		} `json:"deployment"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Changed || out.Deployment.ActorRole != serverstore.ActorRoleSuperAdmin {
		t.Fatalf("超管兜底部署 actor_role = %q changed=%v, want super_admin/true", out.Deployment.ActorRole, out.Changed)
	}
	if out.Deployment.Actor != "boss" {
		t.Fatalf("超管兜底部署 actor = %q, want boss", out.Deployment.Actor)
	}
	details := e.auditDetails("auth-tool", "wasm_app_deploy")
	if len(details) != 1 || !strings.Contains(details[0], "actor_role=super_admin") {
		t.Fatalf("超管兜底必须留下 actor_role=super_admin 的审计；details=%v", details)
	}

	// 管理面：未登录（X-Test-Admin: none）⇒ 401 AUTH_REQUIRED。
	// e.req 不设自定义头，这里手搓一次请求（缺省头 = boss 已登录，无法表达"无会话"）。
	w = e.reqWithAdminHeader(http.MethodPost, "/api/server/admin/wasm-apps/auth-tool/deployments",
		"none", map[string]any{"version": "1.0.0"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("管理面无会话 status = %d, want 401（body=%s）", w.Code, w.Body.String())
	}
	// 管理面写：部署另一个版本，actor_role 必须是 admin_session（与 owner 可辨）。
	e.seedLifecycleRelease("auth-tool", "2.0.0", serverstore.ReleaseStatusApproved, true)
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/auth-tool/deployments", "",
		map[string]any{"version": "2.0.0"})
	var adminOut struct {
		Deployment struct {
			ActorRole string `json:"actor_role"`
			Actor     string `json:"actor"`
		} `json:"deployment"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &adminOut)
	if !adminOut.Changed || adminOut.Deployment.ActorRole != serverstore.ActorRoleAdminSession {
		t.Fatalf("管理面部署 actor_role = %q changed=%v, want admin_session/true",
			adminOut.Deployment.ActorRole, adminOut.Changed)
	}
	if adminOut.Deployment.Actor != "boss" {
		t.Fatalf("管理面部署 actor = %q, want boss", adminOut.Deployment.Actor)
	}
	details = e.auditDetails("auth-tool", "wasm_app_deploy")
	foundAdmin := false
	for _, d := range details {
		if strings.Contains(d, "actor_role=admin_session") {
			foundAdmin = true
		}
	}
	if !foundAdmin {
		t.Fatalf("管理面处置必须留 actor_role=admin_session 的审计；details=%v", details)
	}
}

// reqWithAdminHeader 发一个带显式管理会话头的请求（"none" = 无会话）。
func (e *testEnv) reqWithAdminHeader(method, path, adminHeader string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	raw := []byte("")
	if body != nil {
		b, err := jsonMarshal(body)
		if err != nil {
			e.t.Fatalf("序列化请求体失败: %v", err)
		}
		raw = b
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Admin", adminHeader)
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// TestWithdrawRules 覆盖撤回：仅 pending、仅作者（或超管）、字节释放、版本号占位（设计 §5.3）。
func TestWithdrawRules(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("wd-tool", "alice")
	approvedID := e.seedLifecycleRelease("wd-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("wd-tool", "1.1.0", serverstore.ReleaseStatusPending, true)
	e.seedLifecycleRelease("wd-tool", "1.2.0", serverstore.ReleaseStatusRejected, false)

	// approved 版本不可撤回 ⇒ 409 RELEASE_NOT_PENDING
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/1.0.0/withdraw", e.tokens["alice"], nil)
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != serverstore.CodeReleaseNotPending {
		t.Fatalf("撤回 approved 版本 code = %q, want %q", eb.Error.Code, serverstore.CodeReleaseNotPending)
	}
	// rejected 版本同样终态 ⇒ 409
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/1.2.0/withdraw", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusConflict)

	// pending ⇒ 200，状态 withdrawn、字节释放、版本行仍在（版本号占位）
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/1.1.0/withdraw", e.tokens["alice"], nil)
	var out struct {
		Status  string `json:"status"`
		Changed bool   `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Status != serverstore.ReleaseStatusWithdrawn || !out.Changed {
		t.Fatalf("撤回响应 = %+v, want withdrawn/true", out)
	}
	var status string
	var archive []byte
	if err := e.db.QueryRow(`SELECT status, archive FROM app_releases WHERE app_id = 'wd-tool' AND version = '1.1.0'`).
		Scan(&status, &archive); err != nil {
		e.t.Fatalf("读撤回后的版本: %v", err)
	}
	if status != serverstore.ReleaseStatusWithdrawn || archive != nil {
		t.Fatalf("撤回后 status=%q archiveLen=%d（应为 withdrawn + 字节释放）", status, len(archive))
	}
	if !contains(e.auditActions("wd-tool"), "wasm_app_release_withdraw") {
		t.Fatalf("撤回想必须留痕: %v", e.auditActions("wd-tool"))
	}
	// approved 版本的字节没有被撤回动作碰掉（只有 pending 会被销毁）
	var approvedBytes []byte
	if err := e.db.QueryRow(`SELECT archive FROM app_releases WHERE id = $1`, approvedID).Scan(&approvedBytes); err != nil {
		e.t.Fatalf("读 approved 版本: %v", err)
	}
	if len(approvedBytes) == 0 {
		t.Fatal("撤回 pending 不得销毁 approved 版本的字节（那等于静默下线服务）")
	}
	// 重复撤回 ⇒ 409
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/1.1.0/withdraw", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusConflict)
	// 不存在的版本 ⇒ 404（与"状态不对"可辨）
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/9.9.9/withdraw", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusNotFound)
	// 非作者（bob）⇒ 404（不泄露版本存在性）
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-tool/releases/1.1.0/withdraw", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)
}

// TestRestoreRules 覆盖恢复：不自动上架、purged ⇒ 410、未删除时幂等（设计 §5.5）。
func TestRestoreRules(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("rest-tool", "alice")
	e.seedLifecycleRelease("rest-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	now := e.h.now().UTC()

	// 先冻结 + 软删（生产同款时间线），恢复后必须 enabled=0。
	if err := serverstore.FreezeWasmAppWithRetention(e.ctx(), e.db, "rest-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("冻结: %v", err)
	}
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "rest-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删: %v", err)
	}
	// 非作者不可恢复
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/rest-tool/restore", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)

	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/rest-tool/restore", e.tokens["alice"], nil)
	var out struct {
		App struct {
			Deleted bool `json:"deleted"`
			Enabled bool `json:"enabled"`
		} `json:"app"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Changed || out.App.Deleted || out.App.Enabled {
		t.Fatalf("恢复响应 = %+v, want changed=true deleted=false enabled=false（不自动上架）", out)
	}
	app := e.appRow("rest-tool")
	if app.DeletedAt != nil || app.FrozenAt != nil || app.PurgeAfter != nil {
		t.Fatalf("恢复必须清时间线: deleted=%v frozen=%v purge_after=%v", app.DeletedAt, app.FrozenAt, app.PurgeAfter)
	}
	if app.Enabled {
		t.Fatal("恢复**不得**自动上架")
	}
	if !contains(e.auditActions("rest-tool"), "wasm_app_restore") {
		t.Fatalf("恢复必须留痕: %v", e.auditActions("rest-tool"))
	}
	// 未删除时恢复 ⇒ 200 changed=false（幂等，不写审计）
	before := len(e.auditDetails("rest-tool", "wasm_app_restore"))
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/rest-tool/restore", e.tokens["alice"], nil)
	var again struct {
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &again)
	if again.Changed {
		t.Fatal("未删除的应用恢复必须 changed=false（幂等）")
	}
	if after := len(e.auditDetails("rest-tool", "wasm_app_restore")); after != before {
		t.Fatalf("幂等恢复不得写审计: %d → %d", before, after)
	}

	// 已清除（purged）⇒ 410 APP_PURGED
	e.seedLifecycleApp("gone-tool", "alice")
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "gone-tool", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删 gone-tool: %v", err)
	}
	if err := serverstore.MarkWasmAppPurged(e.ctx(), e.db, "gone-tool", now); err != nil {
		e.t.Fatalf("标记 purged: %v", err)
	}
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/gone-tool/restore", e.tokens["alice"], nil)
	eb := e.decodeErr(w, http.StatusGone)
	if eb.Error.Code != serverstore.CodeAppPurged {
		t.Fatalf("已清除应用恢复 code = %q, want %q", eb.Error.Code, serverstore.CodeAppPurged)
	}
}

// TestDeployNotFoundApp 覆盖"应用不存在"在所有新端点上的响应形状（404 JSON 信封）。
func TestDeployNotFoundApp(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/client/v2/apps/wasm/no-such/deployments"},
		{http.MethodPost, "/api/client/v2/apps/wasm/no-such/deployments"},
		{http.MethodPost, "/api/client/v2/apps/wasm/no-such/restore"},
	} {
		w := e.req(tc.method, tc.path, e.tokens["alice"], map[string]any{"version": "1.0.0"})
		eb := e.decodeErr(w, http.StatusNotFound)
		if eb.Error.Code != "NOT_FOUND" {
			t.Fatalf("%s %s code = %q, want NOT_FOUND", tc.method, tc.path, eb.Error.Code)
		}
	}
}
