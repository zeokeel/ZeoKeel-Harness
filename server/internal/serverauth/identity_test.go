package serverauth

// 外部身份解析（identity.external.*，RBAC 定制客户）的服务端判据：
//   - 默认关闭时零请求、零行为变化；
//   - 企微/钉钉渠道身份 → RBAC resolve 的请求形状与响应映射；
//   - 404/409/status=0/503/超时/坏 JSON/uid 超长/部门清洗的错误映射；
//   - sync_groups 开关；
//   - QR 回调端到端（假 provider + 假 RBAC）：username=RBAC uid、组同步、审计；
//   - 管理端 GET 掩码 / PUT 加密+关闭保护 / /auth/test type=identity。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/util"
)

// saveIdentitySettings 写入一组 identity.external.* 配置（token 按生产口径加密）。
func saveIdentitySettings(t *testing.T, db *sql.DB, endpoint, token string, enabled bool, methods string, syncGroups bool, timeoutMS int) {
	t.Helper()
	ensureTestMasterKey(t)
	sealed, err := encryptSettingSecret(token)
	if err != nil {
		t.Fatalf("encrypt identity token: %v", err)
	}
	for k, v := range map[string]string{
		identityExternalEnabledKey:    fmt.Sprintf("%t", enabled),
		identityExternalEndpointKey:   endpoint,
		identityExternalTokenKey:      sealed,
		identityExternalMethodsKey:    methods,
		identityExternalSyncGroupsKey: fmt.Sprintf("%t", syncGroups),
		identityExternalTimeoutMSKey:  fmt.Sprintf("%d", timeoutMS),
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatalf("set %s: %v", k, err)
		}
	}
}

// fakeRBAC 返回一个可编程的 RBAC resolve 服务；handler 里可检查请求形状。
func fakeRBAC(t *testing.T, fn func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(fn))
	t.Cleanup(srv.Close)
	return srv
}

func identityOK(w http.ResponseWriter, uid string, depts ...string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"uid": uid, "name": "张三", "email": "zhangsan@example.com",
		"mobile": "", "status": 1, "departments": depts,
	})
}

func TestEnrichExternalIdentityDisabledNoRequest(t *testing.T) {
	db := mustDB(t)
	var calls atomic.Int64
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		identityOK(w, "should-not-be-used")
	})
	saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "tok", false, "wecom,dingtalk", true, 3000)

	api := New(db)
	ui := UserInfo{Username: "wecom-user", ProviderUserID: "u1", ExternalID: "wecom:c:u1", ExternalSource: "wecom", Source: "external"}
	got, ierr := api.enrichExternalIdentity(context.Background(), "wecom", ui)
	if ierr != nil {
		t.Fatalf("disabled enrich err = %v", ierr)
	}
	if calls.Load() != 0 {
		t.Fatalf("disabled 时发起了 %d 次请求，want 0", calls.Load())
	}
	if got.Username != ui.Username || got.ExternalSource != ui.ExternalSource {
		t.Fatalf("disabled 时 UserInfo 被改写: %+v", got)
	}
}

func TestEnrichExternalIdentitySuccessAndChannelFields(t *testing.T) {
	db := mustDB(t)
	var sawAuth, sawProvider, sawUserID, sawUnionID, sawMobile string
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		var body struct {
			Provider       string `json:"provider"`
			ProviderUserID string `json:"provider_user_id"`
			UnionID        string `json:"union_id"`
			Mobile         string `json:"mobile"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		sawProvider, sawUserID, sawUnionID, sawMobile = body.Provider, body.ProviderUserID, body.UnionID, body.Mobile
		identityOK(w, "rbac-zhangsan", "研发部", "平台组", "研发部")
	})
	saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "secret-token", true, "wecom,dingtalk", true, 3000)

	api := New(db)
	ui := UserInfo{
		Username: "wecom-user", DisplayName: "旧名字", Email: "old@example.com",
		Groups: []string{"手工组"}, ExternalID: "wecom:corp:u1", ExternalSource: "wecom",
		Source: "external", ProviderUserID: "zhangsan", Mobile: "13800000001",
	}
	got, ierr := api.enrichExternalIdentity(context.Background(), "wecom", ui)
	if ierr != nil {
		t.Fatalf("enrich err = %v", ierr)
	}
	if sawAuth != "Bearer secret-token" {
		t.Fatalf("Authorization = %q", sawAuth)
	}
	if sawProvider != "wecom" || sawUserID != "zhangsan" || sawUnionID != "" || sawMobile != "13800000001" {
		t.Fatalf("请求体 = provider:%q userid:%q union:%q mobile:%q", sawProvider, sawUserID, sawUnionID, sawMobile)
	}
	if got.Username != "rbac-zhangsan" || got.ExternalID != "rbac:rbac-zhangsan" || got.ExternalSource != "rbac" || got.Source != "external" {
		t.Fatalf("身份字段 = %+v", got)
	}
	if got.DisplayName != "张三" || got.Email != "zhangsan@example.com" {
		t.Fatalf("资料字段 = %+v", got)
	}
	wantGroups := []string{"研发部", "平台组"}
	if !got.GroupsPresent || strings.Join(got.Groups, ",") != strings.Join(wantGroups, ",") {
		t.Fatalf("groups = %v present=%v, want %v", got.Groups, got.GroupsPresent, wantGroups)
	}

	// 钉钉：请求必须带 union_id，provider_user_id 允许为空。
	sawUnionID, sawUserID = "", ""
	got, ierr = api.enrichExternalIdentity(context.Background(), "dingtalk", UserInfo{
		Username: "union-1", ProviderUnionID: "union-1", ExternalID: "union-1",
		ExternalSource: "dingtalk", Source: "external", Mobile: "13800000002",
	})
	if ierr != nil {
		t.Fatalf("dingtalk enrich err = %v", ierr)
	}
	if sawProvider != "dingtalk" || sawUnionID != "union-1" || sawUserID != "" {
		t.Fatalf("dingtalk 请求体 = provider:%q union:%q userid:%q", sawProvider, sawUnionID, sawUserID)
	}
	if got.Username != "rbac-zhangsan" {
		t.Fatalf("dingtalk username = %q", got.Username)
	}

	// sync_groups=false：不得改动手工组归属。
	saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "secret-token", true, "wecom,dingtalk", false, 3000)
	ui.Groups = []string{"手工组"}
	ui.GroupsPresent = false
	got, ierr = api.enrichExternalIdentity(context.Background(), "wecom", ui)
	if ierr != nil {
		t.Fatalf("sync_groups=false err = %v", ierr)
	}
	if got.GroupsPresent || strings.Join(got.Groups, ",") != "手工组" {
		t.Fatalf("sync_groups=false 改动了组: groups=%v present=%v", got.Groups, got.GroupsPresent)
	}

	// method 不在 methods 中：不发请求。
	srvCalls := atomic.Int64{}
	srv2 := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		srvCalls.Add(1)
		identityOK(w, "x")
	})
	saveIdentitySettings(t, db, srv2.URL+"/internal/v1/identity/resolve", "tok", true, "dingtalk", true, 3000)
	if _, ierr := api.enrichExternalIdentity(context.Background(), "wecom", ui); ierr != nil {
		t.Fatalf("method not in methods err = %v", ierr)
	}
	if srvCalls.Load() != 0 {
		t.Fatalf("method 未命中仍发起 %d 次请求", srvCalls.Load())
	}
}

func TestEnrichExternalIdentityErrorMapping(t *testing.T) {
	db := mustDB(t)
	cases := []struct {
		name       string
		status     int
		body       string
		wantHTTP   int
		wantCode   string
		wantReason string
	}{
		{"not-bound", http.StatusNotFound, `{"error":"identity_not_found"}`, http.StatusForbidden, "IDENTITY_NOT_BOUND", identityReasonNotBound},
		{"ambiguous", http.StatusConflict, `{"error":"identity_ambiguous"}`, http.StatusForbidden, "IDENTITY_AMBIGUOUS", identityReasonAmbiguous},
		{"disabled", http.StatusOK, `{"uid":"u1","status":0,"departments":[]}`, http.StatusForbidden, "IDENTITY_DISABLED", identityReasonDisabled},
		{"upstream-503", http.StatusServiceUnavailable, `{"error":"identity_store_unavailable"}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"upstream-401", http.StatusUnauthorized, `{"error":"invalid_service_token"}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"upstream-400", http.StatusBadRequest, `{"error":"invalid_request"}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"bad-json", http.StatusOK, `not-json`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"empty-uid", http.StatusOK, `{"uid":"","status":1}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"uid-too-long", http.StatusOK, `{"uid":"` + strings.Repeat("a", identityMaxUIDBytes+1) + `","status":1}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"bad-status", http.StatusOK, `{"uid":"u1","status":2}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
		{"dept-too-long", http.StatusOK, `{"uid":"u1","status":1,"departments":["` + strings.Repeat("d", identityMaxDepartmentBytes+1) + `"]}`, http.StatusBadGateway, "IDENTITY_PROVIDER_UNAVAILABLE", identityReasonUnavailable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom", true, 3000)
			api := New(db)
			_, ierr := api.enrichExternalIdentity(context.Background(), "wecom", UserInfo{ProviderUserID: "u1"})
			if ierr == nil {
				t.Fatal("want error, got nil")
			}
			if ierr.status != tc.wantHTTP || ierr.code != tc.wantCode || ierr.reason != tc.wantReason {
				t.Fatalf("err = %d/%s/%s, want %d/%s/%s", ierr.status, ierr.code, ierr.reason, tc.wantHTTP, tc.wantCode, tc.wantReason)
			}
			if strings.Contains(ierr.Error(), "tok") || strings.Contains(ierr.Error(), "138") {
				t.Fatalf("错误信息泄露敏感值: %v", ierr)
			}
		})
	}
}

func TestEnrichExternalIdentityTimeout(t *testing.T) {
	db := mustDB(t)
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(800 * time.Millisecond)
		identityOK(w, "u1")
	})
	saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom", true, 200)
	api := New(db)
	start := time.Now()
	_, ierr := api.enrichExternalIdentity(context.Background(), "wecom", UserInfo{ProviderUserID: "u1"})
	if ierr == nil || ierr.code != "IDENTITY_PROVIDER_UNAVAILABLE" {
		t.Fatalf("timeout err = %v", ierr)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("超时未生效: %v", elapsed)
	}
}

func TestEnrichExternalIdentityDepartmentCleanup(t *testing.T) {
	db := mustDB(t)
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"uid": "  u1  ", "status": 1,
			"departments": []string{" 研发部 ", "", "研发部", "平台组"},
		})
	})
	saveIdentitySettings(t, db, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom", true, 3000)
	api := New(db)
	got, ierr := api.enrichExternalIdentity(context.Background(), "wecom", UserInfo{ProviderUserID: "u1"})
	if ierr != nil {
		t.Fatalf("enrich err = %v", ierr)
	}
	if got.Username != "u1" {
		t.Fatalf("uid 未 trim: %q", got.Username)
	}
	if strings.Join(got.Groups, ",") != "研发部,平台组" {
		t.Fatalf("departments 未去重/trim: %v", got.Groups)
	}
}

func TestQRIdentityResolveEndToEnd(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "wecom-user", DisplayName: "旧名字", Email: "old@example.com",
		ExternalID: "wecom:corp:u1", ExternalSource: "wecom", Source: "external",
		ProviderUserID: "u1", Mobile: "13800000001",
	}}
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		identityOK(w, "rbac-zhangsan", "研发部", "平台组")
	})
	r, api := newQRTestServer(t, fake)
	saveIdentitySettings(t, api.DB, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom,dingtalk", true, 3000)

	flowID, _ := qrStart(t, r, "wecom")
	if w := qrCallback(r, "wecom", "CODE-1", fake.lastState); w.Code != http.StatusOK {
		t.Fatalf("callback = %d %s", w.Code, w.Body.String())
	}
	w, out := qrPoll(t, r, "wecom", flowID)
	if w.Code != http.StatusOK || out["status"] != "done" {
		t.Fatalf("poll done = %d %s", w.Code, w.Body.String())
	}
	user, _ := out["user"].(map[string]any)
	if user["username"] != "rbac-zhangsan" || user["source"] != "external" {
		t.Fatalf("done user = %v", user)
	}

	u, err := serverstore.GetUserByUsername(api.DB, "rbac-zhangsan")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.ExternalID != "rbac:rbac-zhangsan" || u.ExternalSource != "rbac" {
		t.Fatalf("users 外部身份 = %q/%q", u.ExternalID, u.ExternalSource)
	}
	var groupCount int
	if err := api.DB.QueryRow(`SELECT COUNT(*) FROM user_groups WHERE user_id = ?`, u.ID).Scan(&groupCount); err != nil {
		t.Fatalf("count groups: %v", err)
	}
	if groupCount != 2 {
		t.Fatalf("user_groups = %d, want 2", groupCount)
	}
	var detail string
	if err := api.DB.QueryRow(
		`SELECT detail FROM audit_logs WHERE action='login_success' AND username='rbac-zhangsan' ORDER BY id DESC LIMIT 1`,
	).Scan(&detail); err != nil {
		t.Fatalf("读审计: %v", err)
	}
	if !strings.Contains(detail, "wecom ip=") {
		t.Fatalf("login_success detail = %q", detail)
	}
}

func TestQRIdentityResolveFailureMarksFlowAndAudit(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "wecom-user", ProviderUserID: "u1",
		ExternalID: "wecom:corp:u1", ExternalSource: "wecom", Source: "external",
	}}
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"identity_not_found"}`))
	})
	r, api := newQRTestServer(t, fake)
	saveIdentitySettings(t, api.DB, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom", true, 3000)

	flowID, _ := qrStart(t, r, "wecom")
	w := qrCallback(r, "wecom", "CODE-1", fake.lastState)
	if w.Code != http.StatusForbidden {
		t.Fatalf("callback = %d %s, want 403", w.Code, w.Body.String())
	}
	if code := errorCode(t, w.Body.String()); code != "IDENTITY_NOT_BOUND" {
		t.Fatalf("callback code = %q", code)
	}
	_, out := qrPoll(t, r, "wecom", flowID)
	if out["status"] != "failed" {
		t.Fatalf("poll = %v, want failed", out)
	}
	errObj, _ := out["error"].(map[string]any)
	if errObj["code"] != "IDENTITY_NOT_BOUND" {
		t.Fatalf("poll error = %v", errObj)
	}
	var detail string
	if err := api.DB.QueryRow(
		`SELECT detail FROM audit_logs WHERE action='login_fail' ORDER BY id DESC LIMIT 1`,
	).Scan(&detail); err != nil {
		t.Fatalf("读审计: %v", err)
	}
	if !strings.Contains(detail, identityReasonNotBound) {
		t.Fatalf("login_fail detail = %q, want reason", detail)
	}
	if strings.Contains(detail, "u1") || strings.Contains(detail, "tok") {
		t.Fatalf("审计泄露渠道身份/令牌: %q", detail)
	}
}

func TestQRIdentityConflictWithLocalAccount(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "wecom-user", ProviderUserID: "u1",
		ExternalID: "wecom:corp:u1", ExternalSource: "wecom", Source: "external",
	}}
	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		identityOK(w, "rbac-zhangsan")
	})
	r, api := newQRTestServer(t, fake)
	if _, err := createUserDB(api.DB, "rbac-zhangsan", "pw123456", false); err != nil {
		t.Fatal(err)
	}
	saveIdentitySettings(t, api.DB, srv.URL+"/internal/v1/identity/resolve", "tok", true, "wecom", true, 3000)

	flowID, _ := qrStart(t, r, "wecom")
	w := qrCallback(r, "wecom", "CODE-1", fake.lastState)
	if w.Code != http.StatusForbidden {
		t.Fatalf("callback = %d %s, want 403", w.Code, w.Body.String())
	}
	if code := errorCode(t, w.Body.String()); code != "IDENTITY_CONFLICT" {
		t.Fatalf("code = %q", code)
	}
	_, out := qrPoll(t, r, "wecom", flowID)
	if out["status"] != "failed" {
		t.Fatalf("poll = %v", out)
	}
}

// ---------------------------------------------------------------------------
// 管理端
// ---------------------------------------------------------------------------

func TestAdminAuthConfigIdentity(t *testing.T) {
	ensureTestMasterKey(t)
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminLoginHdr(t, r)

	srv := fakeRBAC(t, func(w http.ResponseWriter, r *http.Request) {
		identityOK(w, "rbac-zhangsan", "研发部")
	})

	// 启用：token 必须加密落库，GET 只回 ***。
	w, out := doJSON(t, r, "PUT", "/api/server/admin/auth",
		fmt.Sprintf(`{"mode":"local","identity":{"enabled":true,"endpoint":%q,"token":"rbac-token","methods":"wecom,dingtalk","timeout_ms":2500,"sync_groups":false}}`,
			srv.URL+"/internal/v1/identity/resolve"), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("save identity: %d %s", w.Code, w.Body.String())
	}
	_ = out
	raw, ok, err := serverstore.GetSetting(db, identityExternalTokenKey)
	if err != nil || !ok {
		t.Fatalf("read token: ok=%v err=%v", ok, err)
	}
	if !strings.HasPrefix(raw, util.EncPrefix) {
		t.Fatalf("token 明文落库: %q", raw)
	}
	if got := decryptSettingSecret(raw); got != "rbac-token" {
		t.Fatalf("decrypt token = %q", got)
	}

	_, gotOut := doJSON(t, r, "GET", "/api/server/admin/auth", "", hdr)
	identity, _ := gotOut["auth"].(map[string]any)["identity"].(map[string]any)
	if identity["enabled"] != true || identity["token"] != MaskSecret {
		t.Fatalf("GET identity = %v", identity)
	}
	if identity["endpoint"] != srv.URL+"/internal/v1/identity/resolve" || identity["methods"] != "wecom,dingtalk" {
		t.Fatalf("GET identity endpoint/methods = %v", identity)
	}
	if identity["timeout_ms"] != float64(2500) || identity["sync_groups"] != false {
		t.Fatalf("GET identity timeout/sync = %v", identity)
	}
	if identity["rbac_user_count"] != float64(0) {
		t.Fatalf("rbac_user_count = %v, want 0", identity["rbac_user_count"])
	}

	// 测试解析：用已保存 endpoint/token。
	w, testOut := doJSON(t, r, "POST", "/api/server/admin/auth/test",
		`{"type":"identity","provider":"wecom","provider_user_id":"u1"}`, hdr)
	if w.Code != http.StatusOK || testOut["ok"] != true || testOut["uid"] != "rbac-zhangsan" {
		t.Fatalf("test identity = %d %v", w.Code, testOut)
	}
	depts, _ := testOut["departments"].([]any)
	if len(depts) != 1 || depts[0] != "研发部" {
		t.Fatalf("test departments = %v", testOut["departments"])
	}

	// 关闭保护：已有 rbac 用户 → 409；confirm_disable 后放行。
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "rbac-existing", DisplayName: "已有", Source: "external", ExternalSource: "rbac", Status: 1,
	}); err != nil {
		t.Fatalf("create rbac user: %v", err)
	}
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth",
		`{"mode":"local","identity":{"enabled":false}}`, hdr)
	if w.Code != http.StatusConflict || errorCode(t, w.Body.String()) != "IDENTITY_USERS_EXIST" {
		t.Fatalf("disable without confirm = %d %s", w.Code, w.Body.String())
	}
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth",
		`{"mode":"local","identity":{"enabled":false,"confirm_disable":true}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("disable with confirm = %d %s", w.Code, w.Body.String())
	}
	_, gotOut = doJSON(t, r, "GET", "/api/server/admin/auth", "", hdr)
	identity, _ = gotOut["auth"].(map[string]any)["identity"].(map[string]any)
	if identity["enabled"] != false || identity["rbac_user_count"] != float64(1) {
		t.Fatalf("after disable identity = %v", identity)
	}

	// 缺省 identity 对象 = 不改。
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth", `{"mode":"local"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("save without identity = %d %s", w.Code, w.Body.String())
	}
	_, gotOut = doJSON(t, r, "GET", "/api/server/admin/auth", "", hdr)
	identity, _ = gotOut["auth"].(map[string]any)["identity"].(map[string]any)
	if identity["endpoint"] != srv.URL+"/internal/v1/identity/resolve" {
		t.Fatalf("identity 被缺省保存清空: %v", identity)
	}

	// 启用但缺 token → 400。
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth",
		`{"mode":"local","identity":{"enabled":true,"endpoint":"https://rbac.example.com/internal/v1/identity/resolve","token":""}}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("enable without token = %d %s", w.Code, w.Body.String())
	}
}
