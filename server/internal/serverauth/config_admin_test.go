package serverauth

// 部署期配置注册表管理端点（GET/PUT /api/server/admin/config）的契约与回归判据。
//
// 这些用例锁住的四件事（任何一条被拆掉，"控制台可改部署配置"就会退化成假象）：
//  1. **读面**列出注册表全量键 + 生效值 + 来源（env/setting/default）+ 两侧原始值，
//     并把"被环境变量覆盖"的键单独点名；
//  2. **写面**只接受注册表认识的键，值走 Key.Parse（非法值 400 且**一条都不写**，
//     不留半套配置）；空串 = 删除 settings 行（回落 env/默认）；
//  3. **写库与审计同事务**：审计 action = deploy_config，detail 里逐键 old→new；
//  4. **权限**：读写都只给 super_admin —— auditor 拿不到（键名与取值即部署拓扑，
//     理由见 rbac.go 的 PermConfigRead 注释）。
//
// 测试树**刻意不用 serverauth.AdminRoute**（它会把路由写进包级 adminRoutes 注册表，
// 污染 `TestAdminRouteRegistryNoUnprotected` 的"陈旧条目"判定 —— cmd/server 里已有
// 同类注释）；这里直接装 RequirePermission，与 AdminRoute 在 perm != "" 时的链形态
// 一致，且生产树的路由注册由 internal/router 的用例覆盖。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// configTestState 是测试路由树的句柄。
type configTestState struct {
	router http.Handler
	db     *sql.DB
	// hdr 是 super_admin 的 Cookie + CSRF。
	hdr map[string]string
}

// newConfigAdminTest 装配一条与生产同构的管理端配置路由链
// （AdminAuth → RequirePermission → handler），并创建一个 super_admin 会话。
func newConfigAdminTest(t *testing.T) *configTestState {
	t.Helper()
	db := mustDB(t)
	uid, err := createUserDB(db, "cfg-boss", "pw123456", true)
	if err != nil {
		t.Fatalf("创建 super_admin 失败：%v", err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatalf("创建管理会话失败：%v", err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	h := NewDeployConfigAdminHandlers(db)
	g := r.Group("/api/server/admin", AdminAuth(db))
	g.GET("/config", RequirePermission(PermConfigRead), h.Get)
	g.PUT("/config", RequirePermission(PermConfigWrite), h.Put)
	return &configTestState{
		router: r,
		db:     db,
		hdr:    map[string]string{"Cookie": sessionCookieName + "=" + sess.ID, "X-CSRF-Token": csrf},
	}
}

// auditorHeaders 创建一个 auditor 会话（只读三元组，**没有** config:read）。
func auditorHeaders(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	uid, err := createUserDB(db, "cfg-auditor", "pw123456", false)
	if err != nil {
		t.Fatalf("创建 auditor 失败：%v", err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatalf("读取 auditor 失败：%v", err)
	}
	u.Role = serverstore.RoleAuditor
	u.IsAdmin = false
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatalf("设置 auditor 角色失败：%v", err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatalf("创建 auditor 会话失败：%v", err)
	}
	return map[string]string{"Cookie": sessionCookieName + "=" + sess.ID, "X-CSRF-Token": csrf}
}

// configGet 发一次 GET 并解析响应。
func configGet(t *testing.T, st *configTestState) (int, struct {
	Items        []ConfigItem `json:"items"`
	EnvOverrides []string     `json:"env_overrides"`
}) {
	t.Helper()
	w, _ := doJSON(t, st.router, "GET", "/api/server/admin/config", "", st.hdr)
	var body struct {
		Items        []ConfigItem `json:"items"`
		EnvOverrides []string     `json:"env_overrides"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("GET /config 响应不是 JSON：%v body=%s", err, w.Body.String())
	}
	return w.Code, body
}

// itemOf 在响应里按 settings 键找一项。
func itemOf(t *testing.T, items []ConfigItem, key string) ConfigItem {
	t.Helper()
	for _, it := range items {
		if it.Key == key {
			return it
		}
	}
	t.Fatalf("GET /config 没有返回配置项 %s（注册表里的键必须全部下发）", key)
	return ConfigItem{}
}

// latestDeployConfigAudit 返回最近一条 deploy_config 审计的 detail。
func latestDeployConfigAudit(t *testing.T, db *sql.DB) string {
	t.Helper()
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'deploy_config' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatalf("查询 deploy_config 审计失败：%v", err)
	}
	return detail
}

// TestConfigAdminGetListsRegistryAndSources 覆盖读面：全量下发、来源判定、环境变量覆盖名单。
func TestConfigAdminGetListsRegistryAndSources(t *testing.T) {
	st := newConfigAdminTest(t)
	// 一个键走 settings、一个键走环境变量、其余走默认。
	if err := serverstore.SetSetting(st.db, "auth.login_max_attempts", "7"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZEOKEEL_WASM_MEMORY_PROFILE", "small")

	code, body := configGet(t, st)
	if code != http.StatusOK {
		t.Fatalf("GET /config = %d, want 200", code)
	}
	if got, want := len(body.Items), len(deployconfig.Keys()); got != want {
		t.Fatalf("GET /config 下发 %d 项，注册表有 %d 项（必须全量下发）", got, want)
	}

	// settings 来源
	setting := itemOf(t, body.Items, "auth.login_max_attempts")
	if setting.Source != string(deployconfig.SourceSetting) || setting.Value != "7" {
		t.Fatalf("auth.login_max_attempts = %+v, want source=setting value=7", setting)
	}
	if setting.SettingValue != "7" || setting.Env != "ZEOKEEL_LOGIN_MAX_ATTEMPTS" {
		t.Fatalf("auth.login_max_attempts 两侧原始值/环境变量名不对：%+v", setting)
	}

	// 环境变量来源（优先于 settings，且出现在 env_overrides）
	envItem := itemOf(t, body.Items, "wasm.memory_profile")
	if envItem.Source != string(deployconfig.SourceEnv) || envItem.Value != "small" {
		t.Fatalf("wasm.memory_profile = %+v, want source=env value=small", envItem)
	}
	if envItem.EnvValue != "small" {
		t.Fatalf("wasm.memory_profile.env_value = %q, want small", envItem.EnvValue)
	}
	if len(envItem.Choices) != 3 || envItem.AppliesAt != deployconfig.AppliesRestart {
		t.Fatalf("wasm.memory_profile 的 choices/applies_at 不对：%+v", envItem)
	}
	if len(body.EnvOverrides) != 1 || body.EnvOverrides[0] != "wasm.memory_profile" {
		t.Fatalf("env_overrides = %v, want [wasm.memory_profile]", body.EnvOverrides)
	}

	// 默认来源
	dflt := itemOf(t, body.Items, "auth.ldap_allow_plaintext")
	if dflt.Source != string(deployconfig.SourceDefault) || dflt.Value != "false" || dflt.Default != "false" {
		t.Fatalf("auth.ldap_allow_plaintext = %+v, want source=default value=false", dflt)
	}
	// 整型取值域必须下发（前端用它做提示/校验）
	intItem := itemOf(t, body.Items, "auth.login_max_attempts")
	if intItem.Min == nil || *intItem.Min != 1 || intItem.Max == nil {
		t.Fatalf("auth.login_max_attempts 的 min/max 未下发：%+v", intItem)
	}
}

// TestConfigAdminPutWritesAndAudits 覆盖写面正常路径：落库 + 同事务审计 + 回读。
func TestConfigAdminPutWritesAndAudits(t *testing.T) {
	st := newConfigAdminTest(t)
	body := `{"values":{"auth.login_max_attempts":"7","wasm.memory_profile":"small"}}`
	w, _ := doJSON(t, st.router, "PUT", "/api/server/admin/config", body, st.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT /config = %d body=%s, want 200", w.Code, w.Body.String())
	}
	var saved struct {
		Saved    []string `json:"saved"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatalf("PUT 响应不是 JSON：%v", err)
	}
	if len(saved.Saved) != 2 {
		t.Fatalf("saved = %v, want 2 个键", saved.Saved)
	}
	if len(saved.Warnings) != 0 {
		t.Fatalf("warnings = %v, want 空（没有环境变量覆盖）", saved.Warnings)
	}

	for key, want := range map[string]string{"auth.login_max_attempts": "7", "wasm.memory_profile": "small"} {
		got, ok, err := serverstore.GetSetting(st.db, key)
		if err != nil || !ok || got != want {
			t.Fatalf("settings[%s] = %q ok=%v err=%v, want %q", key, got, ok, err, want)
		}
	}

	// 审计：action=deploy_config，detail 里逐键 old→new（old 是 settings 行的旧值）。
	detail := latestDeployConfigAudit(t, st.db)
	for _, want := range []string{
		"auth.login_max_attempts: (空)→7",
		"wasm.memory_profile: (空)→small",
	} {
		if !strings.Contains(detail, want) {
			t.Fatalf("deploy_config 审计 detail 缺 %q：%q", want, detail)
		}
	}

	// 回读：来源变成 setting。
	code, resp := configGet(t, st)
	if code != http.StatusOK {
		t.Fatalf("GET /config = %d, want 200", code)
	}
	if it := itemOf(t, resp.Items, "auth.login_max_attempts"); it.Source != "setting" || it.Value != "7" {
		t.Fatalf("回读 auth.login_max_attempts = %+v, want source=setting value=7", it)
	}
	if len(resp.EnvOverrides) != 0 {
		t.Fatalf("env_overrides = %v, want 空", resp.EnvOverrides)
	}
}

// TestConfigAdminPutRejectsUnknownKey：未知键 400 VALIDATION，且不写库、不审计。
func TestConfigAdminPutRejectsUnknownKey(t *testing.T) {
	st := newConfigAdminTest(t)
	w, out := doJSON(t, st.router, "PUT", "/api/server/admin/config", `{"values":{"nope.key":"1"}}`, st.hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("未知键 = %d body=%s, want 400", w.Code, w.Body.String())
	}
	if code := out["error"].(map[string]any)["code"]; code != "VALIDATION" {
		t.Fatalf("未知键错误码 = %v, want VALIDATION", code)
	}
	// 一条审计都不该产生（校验在事务之前）。
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'deploy_config'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("未知键被拒后仍写了 %d 条 deploy_config 审计", n)
	}
}

// TestConfigAdminPutRejectsInvalidValueAtomically：一个非法值 ⇒ 整批 400，合法项也不写。
func TestConfigAdminPutRejectsInvalidValueAtomically(t *testing.T) {
	st := newConfigAdminTest(t)
	body := `{"values":{"auth.login_max_attempts":"abc","telemetry.max_per_min":"30"}}`
	w, out := doJSON(t, st.router, "PUT", "/api/server/admin/config", body, st.hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法值 = %d body=%s, want 400", w.Code, w.Body.String())
	}
	if code := out["error"].(map[string]any)["code"]; code != "VALIDATION" {
		t.Fatalf("非法值错误码 = %v, want VALIDATION", code)
	}
	// 同批次的合法键不得落库（"先全量校验、再开事务"）。
	if _, ok, err := serverstore.GetSetting(st.db, "telemetry.max_per_min"); err != nil || ok {
		t.Fatalf("非法批次里的合法键被写入（ok=%v err=%v）—— 校验没有前置", ok, err)
	}
}

// TestConfigAdminPutEmptyDeletesSetting：空串 = 删除 settings 行（回落默认），审计记 old→(空)。
func TestConfigAdminPutEmptyDeletesSetting(t *testing.T) {
	st := newConfigAdminTest(t)
	if err := serverstore.SetSetting(st.db, "auth.login_max_attempts", "7"); err != nil {
		t.Fatal(err)
	}
	w, saved := doJSON(t, st.router, "PUT", "/api/server/admin/config", `{"values":{"auth.login_max_attempts":""}}`, st.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT 空串 = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := saved["saved"].([]any); len(got) != 1 || got[0] != "auth.login_max_attempts" {
		t.Fatalf("saved = %v", saved["saved"])
	}
	if _, ok, err := serverstore.GetSetting(st.db, "auth.login_max_attempts"); err != nil || ok {
		t.Fatalf("settings 行没有被删除（ok=%v err=%v）", ok, err)
	}
	// 回读：回落默认值 10。
	_, resp := configGet(t, st)
	if it := itemOf(t, resp.Items, "auth.login_max_attempts"); it.Source != "default" || it.Value != "10" {
		t.Fatalf("删除后回读 = %+v, want source=default value=10", it)
	}
	if detail := latestDeployConfigAudit(t, st.db); !strings.Contains(detail, "auth.login_max_attempts: 7→(空)") {
		t.Fatalf("审计 detail = %q, want 含 7→(空)", detail)
	}
}

// TestConfigAdminPutWarnsEnvOverride：仍被环境变量覆盖的键必须逐个点名（否则"保存成功但没生效"无迹可查）。
func TestConfigAdminPutWarnsEnvOverride(t *testing.T) {
	st := newConfigAdminTest(t)
	t.Setenv("ZEOKEEL_WASM_MEMORY_PROFILE", "small")
	w, out := doJSON(t, st.router, "PUT", "/api/server/admin/config",
		`{"values":{"wasm.memory_profile":"large"}}`, st.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT = %d body=%s, want 200", w.Code, w.Body.String())
	}
	warnings, _ := out["warnings"].([]any)
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v, want 1 条（wasm.memory_profile 被 env 覆盖）", out["warnings"])
	}
	msg, _ := warnings[0].(string)
	for _, want := range []string{"wasm.memory_profile", "ZEOKEEL_WASM_MEMORY_PROFILE", "仍被环境变量覆盖", "请删除 .env"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("warning 缺 %q：%q", want, msg)
		}
	}
	// 生效值仍是环境变量（priority: env > setting）。
	_, resp := configGet(t, st)
	if it := itemOf(t, resp.Items, "wasm.memory_profile"); it.Source != "env" || it.Value != "small" {
		t.Fatalf("回读 = %+v, want source=env value=small（settings 里存了 large 但不生效）", it)
	}
	// settings 里确实存了 large（用于删除 .env 后生效）。
	if got, ok, _ := serverstore.GetSetting(st.db, "wasm.memory_profile"); !ok || got != "large" {
		t.Fatalf("settings[wasm.memory_profile] = %q ok=%v, want large", got, ok)
	}
}

// TestConfigAdminPermissions：读写都只给 super_admin，auditor 一律 403（且 401 是未登录语义）。
func TestConfigAdminPermissions(t *testing.T) {
	st := newConfigAdminTest(t)
	aud := auditorHeaders(t, st.db)

	for _, tc := range []struct {
		method, body string
	}{
		{"GET", ""},
		{"PUT", `{"values":{"auth.login_max_attempts":"7"}}`},
	} {
		w, out := doJSON(t, st.router, tc.method, "/api/server/admin/config", tc.body, aud)
		if w.Code != http.StatusForbidden {
			t.Fatalf("auditor %s /config = %d body=%s, want 403", tc.method, w.Code, w.Body.String())
		}
		if code := out["error"].(map[string]any)["code"]; code != "FORBIDDEN" {
			t.Fatalf("auditor %s 错误码 = %v, want FORBIDDEN", tc.method, code)
		}
	}
	// 未登录：401 AUTH_REQUIRED（路由确实挂了 AdminAuth，而不是 404/500）。
	w, out := doJSON(t, st.router, "GET", "/api/server/admin/config", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录 GET = %d, want 401", w.Code)
	}
	if code := out["error"].(map[string]any)["code"]; code != "AUTH_REQUIRED" {
		t.Fatalf("未登录错误码 = %v, want AUTH_REQUIRED", code)
	}

	// 权限点本身：super_admin 有、auditor 没有，且**不在** AuditorPermissions（部署拓扑不外泄）。
	super := &serverstore.User{Role: serverstore.RoleSuperAdmin}
	for _, perm := range []string{PermConfigRead, PermConfigWrite} {
		if !HasPermission(super, perm) {
			t.Fatalf("super_admin 缺少 %s", perm)
		}
		if HasPermission(&serverstore.User{Role: serverstore.RoleAuditor}, perm) {
			t.Fatalf("auditor 不应持有 %s（键名/取值即部署拓扑）", perm)
		}
		for _, p := range AuditorPermissions {
			if p == perm {
				t.Fatalf("AuditorPermissions 不得包含 %s", perm)
			}
		}
	}
}

// TestConfigAdminPutRejectsMissingValues：空请求体/空 values 都是 400 VALIDATION。
func TestConfigAdminPutRejectsMissingValues(t *testing.T) {
	st := newConfigAdminTest(t)
	for _, body := range []string{`{}`, `{"values":{}}`, `not json`} {
		w, _ := doJSON(t, st.router, "PUT", "/api/server/admin/config", body, st.hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("PUT %q = %d, want 400", body, w.Code)
		}
	}
}
