package connectors

// 连接器静默授权断言端点的判据（2026-11）。
//
// 端点的安全承诺按**校验顺序**逐层断言（关掉任意一层都必须有红灯）：
//   401 未认证 → 开关关闭 → 连接器不存在/停用 → 非白名单 → 非 RBAC 身份
//   → 定义未自述端点 → 缺密钥/issuer/client_id → 成功签发（claims 可验、TTL 生效、
//   不缓存、不泄露秘密）。
//
// 失败形态的选择也是契约：客户端把任何非 2xx 当作"静默授权不可用"并回落交互式
// 流程，所以这里全部是固定文案 JSON 信封（serverauth.WriteError），不得回显
// secret / 断言。

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/bootstrap"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

const (
	assertionTestConnectorID = "rbac-demo"
	assertionTestTokenURL    = "https://rbac.example.com/oauth/token"
	assertionTestScopes      = "openid offline_access"
	assertionTestResource    = "https://mcp.example.com/mcp"
	assertionTestSecret      = "test-assertion-secret-not-for-production"
	assertionTestIssuer      = "https://harness.example.com"
	assertionTestClientID    = "rbac-bridge"
	assertionTestRBACUID     = "alice-uid"
)

// assertionTestDefinition 是**合法**的连接器定义（validateConnector 会接受它）：
// 同时具备 auth.tokenUrl / auth.scopes / mcp[0].url 三段断言必需信息。
const assertionTestDefinition = `{"auth":{"tokenUrl":"` + assertionTestTokenURL + `","scopes":"` + assertionTestScopes + `"},` +
	`"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http","url":"` + assertionTestResource + `"}]}`

// assertionFixture 是一套真实的 PG 库 + 一条最小路由树（与生产同形：
// POST /api/client/v2/connectors/:id/assertion + serverauth.BearerAuth）。
type assertionFixture struct {
	t         *testing.T
	db        *sql.DB
	engine    *gin.Engine
	rbacToken string
}

func newAssertionFixture(t *testing.T) *assertionFixture {
	t.Helper()
	// 断言端点读的环境变量全部先清空：用例断言 settings/缺省，不能被宿主环境
	// （或上一个用例）里残留的 ZEOKEEL_CONNECTOR_* 污染。
	t.Setenv("ZEOKEEL_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	for _, env := range []string{
		assertionSecretEnv, assertionIssuerEnv,
		keyAutoAuthEnabled.Env, keyAutoAuthConnectors.Env,
		// auto_connect 不是签发端点的输入（它只影响 bootstrap 下发），但同一组
		// ZEOKEEL_CONNECTOR_* 前缀的残留值仍应在每个用例开始前清干净。
		"ZEOKEEL_CONNECTOR_AUTO_AUTH_AUTO_CONNECT",
		keyAssertionIssuer.Env, keyAssertionTTL.Env, keyAssertionClientID.Env,
	} {
		t.Setenv(env, "")
	}
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// RBAC 员工身份：ExternalSource=rbac、ExternalID=rbac:<uid>（生产由
	// serverauth/identity.go 写入；断言 sub 就是去前缀后的 uid）。
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456"); err != nil {
		t.Fatalf("建用户: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatalf("读用户: %v", err)
	}
	if err := serverstore.BindExternalIdentity(db, u.ID, "rbac:"+assertionTestRBACUID, "rbac"); err != nil {
		t.Fatalf("绑定 RBAC 身份: %v", err)
	}
	token, err := serverauth.IssueToken(db, u.ID)
	if err != nil {
		t.Fatalf("签发员工令牌: %v", err)
	}

	if err := serverstore.CreateConnector(db, &serverstore.Connector{
		ID: assertionTestConnectorID, Name: "RBAC 演示", AuthMode: "oauth",
		Definition: assertionTestDefinition, Enabled: true,
	}); err != nil {
		t.Fatalf("建连接器: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 与 internal/router 的 registerConnectorClientRoutes 同形（生产声明在 router 包，
	// 本包测试自建最小树；路由声明纪律允许测试自建）。
	r.POST("/api/client/v2/connectors/:id/assertion", serverauth.BearerAuth(db), NewHandlers(db).IssueAssertion)
	return &assertionFixture{t: t, db: db, engine: r, rbacToken: token}
}

func setAssertionSetting(t *testing.T, db *sql.DB, key, value string) {
	t.Helper()
	if err := serverstore.SetSetting(db, key, value); err != nil {
		t.Fatalf("写设置 %s=%q: %v", key, value, err)
	}
}

// configure 写入成功路径所需的最小部署配置（开关 + 白名单 + issuer + client_id +
// 签名密钥；ttl 传空串 = 不配置，验证默认 60s）。
func (f *assertionFixture) configure(ttl string) {
	f.t.Helper()
	for key, value := range map[string]string{
		"connector.auto_auth.enabled":    "true",
		"connector.auto_auth.connectors": assertionTestConnectorID,
		"connector.assertion.issuer":     assertionTestIssuer,
		"connector.assertion.ttl":        ttl,
		"connector.assertion.client_id":  assertionTestClientID,
	} {
		setAssertionSetting(f.t, f.db, key, value)
	}
	f.t.Setenv(assertionSecretEnv, assertionTestSecret)
}

// post 以指定身份调用断言端点（token 为空 = 未认证）。
func (f *assertionFixture) post(id, token string) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest("POST", "/api/client/v2/connectors/"+id+"/assertion", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	return w
}

// postAsRBAC 是成功路径的便捷形态。
func (f *assertionFixture) postAsRBAC() *httptest.ResponseRecorder {
	f.t.Helper()
	return f.post(assertionTestConnectorID, f.rbacToken)
}

func assertionErrorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是错误信封 JSON: %v body=%s", err, w.Body.String())
	}
	return body.Error.Code
}

// verifyAssertion 校验 HS256 签名并解出 claims（与 RBAC 侧验证口径同形：
// 签名覆盖 header.payload，base64url 无填充）。
func verifyAssertion(t *testing.T, raw, secret string) map[string]any {
	t.Helper()
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		t.Fatalf("断言不是 JWT 三段形态：%q", raw)
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("解 header: %v", err)
	}
	var header map[string]any
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		t.Fatalf("header 不是 JSON: %v", err)
	}
	if header["alg"] != "HS256" || header["typ"] != "JWT" {
		t.Fatalf("header = %v，期望 alg=HS256 typ=JWT", header)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	if _, err := mac.Write([]byte(parts[0] + "." + parts[1])); err != nil {
		t.Fatalf("计算签名: %v", err)
	}
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		t.Fatalf("断言签名不可验（用签发密钥重算不一致）")
	}
	// 反向自证：换一把密钥必须算出不同的签名（判据不是拿恒真函数在自证）。
	wrong := hmac.New(sha256.New, []byte(secret+"-wrong"))
	if _, err := wrong.Write([]byte(parts[0] + "." + parts[1])); err != nil {
		t.Fatalf("计算反向签名: %v", err)
	}
	if hmac.Equal([]byte(base64.RawURLEncoding.EncodeToString(wrong.Sum(nil))), []byte(parts[2])) {
		t.Fatal("不同密钥算出了相同签名 —— 判据锚点异常")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("解 payload: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatalf("payload 不是 JSON: %v", err)
	}
	return claims
}

func decodeAssertionResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON: %v body=%s", err, w.Body.String())
	}
	return body
}

func claimInt64(t *testing.T, claims map[string]any, name string) int64 {
	t.Helper()
	value, ok := claims[name].(float64)
	if !ok {
		t.Fatalf("claim %s 不是数字：%v", name, claims[name])
	}
	return int64(value)
}

// TestAutoAuthModeContractMatchesBootstrap：auto_auth 的取值是**跨语言契约**
// （客户端 `ConnectorDef.autoAuth === 'rbac-assertion'` 逐字比对），服务端却在两处
// 各声明了一份：本包（可选模块，签发面）与 internal/bootstrap（基础面，下发面）——
// 后者不能 import 前者，所以两份字面量必须被同一组判据钉住：
//   - 取值必须逐字等于客户端认识的 'rbac-assertion'（改一侧 = 换契约，客户端静默
//     不认，功能整体失效且无红灯）；
//   - 两处 Go 常量必须相等（否则"下发了但签发端不认"这类分叉会静默存在）。
func TestAutoAuthModeContractMatchesBootstrap(t *testing.T) {
	if AutoAuthModeRBACAssertion != "rbac-assertion" {
		t.Fatalf("auto_auth 契约值 = %q，客户端只认 %q", AutoAuthModeRBACAssertion, "rbac-assertion")
	}
	if AutoAuthModeRBACAssertion != bootstrap.ConnectorAutoAuthModeRBACAssertion {
		t.Fatalf("签发面 auto_auth=%q 与 bootstrap 下发面 %q 不一致 —— 客户端会看到"+
			"auto_auth 却拿不到可签发的端点（或反之）",
			AutoAuthModeRBACAssertion, bootstrap.ConnectorAutoAuthModeRBACAssertion)
	}
}

// TestAssertionRequiresBearer：未认证必须先被 BearerAuth 拦住（401 JSON 信封），
// 而不是落到 handler 里按"身份不满足"回 409。
func TestAssertionRequiresBearer(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	w := f.post(assertionTestConnectorID, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未认证 = %d, want 401（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "AUTH_REQUIRED" {
		t.Fatalf("未认证 error.code = %q, want AUTH_REQUIRED", code)
	}
}

// TestAssertionFeatureSwitchOff：部署开关默认关闭 ⇒ 端点按"不存在"处理（404）。
// 之后再打开开关（只改 settings，不重启）必须立刻改变行为 —— 开关是热更新键。
func TestAssertionFeatureSwitchOff(t *testing.T) {
	f := newAssertionFixture(t)

	w := f.postAsRBAC()
	if w.Code != http.StatusNotFound {
		t.Fatalf("开关关闭 = %d, want 404（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "NOT_FOUND" {
		t.Fatalf("开关关闭 error.code = %q, want NOT_FOUND", code)
	}

	// 热更新：只开开关，白名单仍为空 ⇒ 不再是"未启用"，而是 403 非白名单。
	setAssertionSetting(t, f.db, "connector.auto_auth.enabled", "true")
	w = f.postAsRBAC()
	if w.Code != http.StatusForbidden {
		t.Fatalf("开关热更新后 = %d, want 403（白名单为空；body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionConnectorGate：连接器必须存在且启用；未在白名单内 ⇒ 403。
func TestAssertionConnectorGate(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	// 不存在。
	if w := f.post("missing-one", f.rbacToken); w.Code != http.StatusNotFound {
		t.Fatalf("不存在的连接器 = %d, want 404（body=%s）", w.Code, w.Body.String())
	}

	// 存在但不在白名单：另建一个合法、启用的连接器。
	if err := serverstore.CreateConnector(f.db, &serverstore.Connector{
		ID: "other-demo", Name: "另一个", AuthMode: "oauth",
		Definition: assertionTestDefinition, Enabled: true,
	}); err != nil {
		t.Fatalf("建第二个连接器: %v", err)
	}
	w := f.post("other-demo", f.rbacToken)
	if w.Code != http.StatusForbidden {
		t.Fatalf("非白名单连接器 = %d, want 403（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "FORBIDDEN" {
		t.Fatalf("非白名单 error.code = %q, want FORBIDDEN", code)
	}

	// 白名单内但已停用：按不存在处理（停用是紧急刹车）。
	if err := serverstore.SetConnectorEnabled(f.db, assertionTestConnectorID, false); err != nil {
		t.Fatalf("停用连接器: %v", err)
	}
	if w := f.postAsRBAC(); w.Code != http.StatusNotFound {
		t.Fatalf("停用的连接器 = %d, want 404（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionRequiresRBACIdentity：只有 RBAC 员工身份可以换 token（断言 sub 是
// RBAC uid）；本地账号与其它 IdP 用户 ⇒ 409 CONFLICT（客户端静默回落交互流程）。
func TestAssertionRequiresRBACIdentity(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	// 本地账号（未绑定外部身份）。
	if _, err := serverstore.CreateUserWithPassword(f.db, "localdev", "pw123456"); err != nil {
		t.Fatalf("建本地用户: %v", err)
	}
	local, err := serverstore.GetUserByUsername(f.db, "localdev")
	if err != nil {
		t.Fatalf("读本地用户: %v", err)
	}
	localToken, err := serverauth.IssueToken(f.db, local.ID)
	if err != nil {
		t.Fatalf("签发本地用户令牌: %v", err)
	}
	w := f.post(assertionTestConnectorID, localToken)
	if w.Code != http.StatusConflict {
		t.Fatalf("本地账号 = %d, want 409（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "CONFLICT" {
		t.Fatalf("本地账号 error.code = %q, want CONFLICT", code)
	}

	// 其它 IdP 来源（oidc）：ExternalID 没有 rbac: 前缀 ⇒ 同样拒绝。
	if _, err := serverstore.CreateUserWithPassword(f.db, "oidcuser", "pw123456"); err != nil {
		t.Fatalf("建 OIDC 用户: %v", err)
	}
	oidc, err := serverstore.GetUserByUsername(f.db, "oidcuser")
	if err != nil {
		t.Fatalf("读 OIDC 用户: %v", err)
	}
	if err := serverstore.BindExternalIdentity(f.db, oidc.ID, "sub-123", "oidc"); err != nil {
		t.Fatalf("绑定 OIDC 身份: %v", err)
	}
	oidcToken, err := serverauth.IssueToken(f.db, oidc.ID)
	if err != nil {
		t.Fatalf("签发 OIDC 用户令牌: %v", err)
	}
	if w := f.post(assertionTestConnectorID, oidcToken); w.Code != http.StatusConflict {
		t.Fatalf("OIDC 账号 = %d, want 409（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionDefinitionMustSelfDescribeEndpoints：定义缺 tokenUrl / scopes /
// mcp[0].url 任一项 ⇒ 501（RBAC 侧无法校验 audience/resource，不签发）。
func TestAssertionDefinitionMustSelfDescribeEndpoints(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	updateDefinition := func(definition string) {
		t.Helper()
		if _, err := f.db.Exec(`UPDATE connectors SET definition = ? WHERE id = ?`, definition, assertionTestConnectorID); err != nil {
			t.Fatalf("改定义: %v", err)
		}
	}

	cases := []struct {
		name       string
		definition string
	}{
		{"无 auth", `{"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http","url":"` + assertionTestResource + `"}]}`},
		{"缺 tokenUrl", `{"auth":{"scopes":"` + assertionTestScopes + `"},"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http","url":"` + assertionTestResource + `"}]}`},
		{"缺 scopes", `{"auth":{"tokenUrl":"` + assertionTestTokenURL + `"},"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http","url":"` + assertionTestResource + `"}]}`},
		{"缺 mcp url", `{"auth":{"tokenUrl":"` + assertionTestTokenURL + `","scopes":"` + assertionTestScopes + `"},"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http"}]}`},
		{"tokenUrl 全空白", `{"auth":{"tokenUrl":"  ","scopes":"x"},"mcp":[{"serverName":"rbac-mcp","transport":"streamable-http","url":"` + assertionTestResource + `"}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			updateDefinition(c.definition)
			w := f.postAsRBAC()
			if w.Code != http.StatusNotImplemented {
				t.Fatalf("%s = %d, want 501（body=%s）", c.name, w.Code, w.Body.String())
			}
			if code := assertionErrorCode(t, w); code != "NOT_IMPLEMENTED" {
				t.Fatalf("%s error.code = %q, want NOT_IMPLEMENTED", c.name, code)
			}
		})
	}

	// 历史/外部写入的坏 JSON（正常写路径会校验，这里直接改库模拟存量数据）。
	updateDefinition("{not json")
	if w := f.postAsRBAC(); w.Code != http.StatusNotImplemented {
		t.Fatalf("坏定义 JSON = %d, want 501（body=%s）", w.Code, w.Body.String())
	}

	// 恢复合法定义后必须重新可用（判据不是"一律 501"）。
	updateDefinition(assertionTestDefinition)
	if w := f.postAsRBAC(); w.Code != http.StatusOK {
		t.Fatalf("恢复合法定义后 = %d, want 200（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionSigningMaterialMissing：密钥 / issuer / client_id 三者缺一 ⇒ 503
// （服务端配置不完整时拒绝签发，而不是发一份换不了 token 的断言）。
// issuer 可以从 ZEOKEEL_PUBLIC_BASE_URL 兜底（尾斜杠归一化）。
func TestAssertionSigningMaterialMissing(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	// ① 缺签名密钥。
	f.t.Setenv(assertionSecretEnv, "")
	w := f.postAsRBAC()
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺密钥 = %d, want 503（body=%s）", w.Code, w.Body.String())
	}
	if body := w.Body.String(); strings.Contains(body, assertionTestSecret) {
		t.Fatalf("错误响应泄露了签名密钥：%s", body)
	}

	// ② 密钥有、issuer 与 PUBLIC_BASE_URL 都空。
	f.t.Setenv(assertionSecretEnv, assertionTestSecret)
	setAssertionSetting(t, f.db, "connector.assertion.issuer", "")
	if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺 issuer = %d, want 503（body=%s）", w.Code, w.Body.String())
	}

	// ③ issuer 从对外地址 env 兜底；尾斜杠必须被归一化（iss 是精确字符串契约）。
	f.t.Setenv(assertionIssuerEnv, assertionTestIssuer+"/")
	w = f.postAsRBAC()
	if w.Code != http.StatusOK {
		t.Fatalf("issuer 走 PUBLIC_BASE_URL 兜底 = %d, want 200（body=%s）", w.Code, w.Body.String())
	}
	body := decodeAssertionResponse(t, w)
	if got := body["issuer"]; got != assertionTestIssuer {
		t.Fatalf("issuer = %v, want %q（尾斜杠应被归一化）", got, assertionTestIssuer)
	}
	claims := verifyAssertion(t, body["assertion"].(string), assertionTestSecret)
	if got := claims["iss"]; got != assertionTestIssuer {
		t.Fatalf("claim iss = %v, want %q", got, assertionTestIssuer)
	}

	// ④ 缺 client_id（issuer 走设置，恢复原样）。
	f.t.Setenv(assertionIssuerEnv, "")
	setAssertionSetting(t, f.db, "connector.assertion.issuer", assertionTestIssuer)
	setAssertionSetting(t, f.db, "connector.assertion.client_id", "")
	if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺 client_id = %d, want 503（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionClaimClientIDBindsConfig：断言里的 client_id 必须**跟随配置并绑定进
// 签名载荷**（RBAC 将强制它与令牌交换请求里的 client_id 相等）。
//
// 威胁模型：公共客户端白名单下，任何拿到断言的一方都能自己发起 token exchange；
// 若断言不绑定 client_id，攻击者可以换成自己的 client 去冒用（跨客户端冒用）。
// 所以 client_id 必须签发进**不可篡改**的载荷，且与响应值同源；配置为空时端点
// 已由 503 分支拒绝签发。
func TestAssertionClaimClientIDBindsConfig(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	check := func(want string) {
		t.Helper()
		w := f.postAsRBAC()
		if w.Code != http.StatusOK {
			t.Fatalf("签发 = %d, want 200（body=%s）", w.Code, w.Body.String())
		}
		body := decodeAssertionResponse(t, w)
		if got := body["client_id"]; got != want {
			t.Fatalf("响应 client_id = %v, want %q", got, want)
		}
		claims := verifyAssertion(t, body["assertion"].(string), assertionTestSecret)
		if got := claims["client_id"]; got != want {
			t.Fatalf("claim client_id = %v, want %q", got, want)
		}
		if got, wantBody := claims["client_id"], body["client_id"]; got != wantBody {
			t.Fatalf("claim client_id = %v 与响应 client_id = %v 不一致（客户端会拿响应值去交换）", got, wantBody)
		}
	}
	check(assertionTestClientID)

	// 改配置 ⇒ 断言里的 client_id 随之变化（不是硬编码/启动快照：热更新键每次请求解析）。
	setAssertionSetting(t, f.db, "connector.assertion.client_id", "another-client")
	check("another-client")

	// 配置为空 ⇒ 503：拒绝签发，而不是签一份空 client_id 的断言让 RBAC 侧去猜。
	setAssertionSetting(t, f.db, "connector.assertion.client_id", "")
	w := f.postAsRBAC()
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("client_id 配置为空 = %d, want 503（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "SERVER" {
		t.Fatalf("client_id 配置为空 error.code = %q, want SERVER", code)
	}
}

// TestAssertionIssueSuccess：成功路径的完整契约 —— 响应字段、缓存头、
// claims 与签名（含 sub 去 rbac: 前缀）、expires_in 与 TTL 一致。
func TestAssertionIssueSuccess(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("2m")

	w := f.postAsRBAC()
	if w.Code != http.StatusOK {
		t.Fatalf("签发 = %d, want 200（body=%s）", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store（短时凭证不得被缓存）", got)
	}
	body := decodeAssertionResponse(t, w)
	for field, want := range map[string]string{
		"token_endpoint": assertionTestTokenURL,
		"client_id":      assertionTestClientID,
		"scope":          assertionTestScopes,
		"resource":       assertionTestResource,
		"issuer":         assertionTestIssuer,
	} {
		if got := body[field]; got != want {
			t.Fatalf("响应 %s = %v, want %q", field, got, want)
		}
	}
	if got, _ := body["expires_in"].(float64); int64(got) != 120 {
		t.Fatalf("expires_in = %v, want 120", body["expires_in"])
	}
	raw, ok := body["assertion"].(string)
	if !ok || strings.TrimSpace(raw) == "" {
		t.Fatalf("assertion 缺失或非字符串：%v", body["assertion"])
	}
	if strings.Contains(w.Body.String(), assertionTestSecret) {
		t.Fatal("成功响应泄露了签名密钥")
	}

	claims := verifyAssertion(t, raw, assertionTestSecret)
	for claim, want := range map[string]string{
		"iss":          assertionTestIssuer,
		"aud":          assertionTestTokenURL,
		"sub":          assertionTestRBACUID, // rbac: 前缀必须被剥掉
		"scope":        assertionTestScopes,
		"resource":     assertionTestResource,
		"connector_id": assertionTestConnectorID,
		// client_id 必须在**签名载荷**里（RBAC 强制断言 client_id == 请求 client_id，
		// 防公共客户端白名单下的跨客户端冒用；只靠请求参数不可信）。
		"client_id": assertionTestClientID,
		"ver":       "v1",
	} {
		if got := claims[claim]; got != want {
			t.Fatalf("claim %s = %v, want %q", claim, got, want)
		}
	}
	if got, want := claims["client_id"], body["client_id"]; got != want {
		t.Fatalf("claim client_id = %v 与响应 client_id = %v 不一致（客户端会拿响应值去交换）", got, want)
	}
	if jti, _ := claims["jti"].(string); jti == "" {
		t.Fatalf("claim jti 缺失：%v", claims["jti"])
	}
	iat, exp := claimInt64(t, claims, "iat"), claimInt64(t, claims, "exp")
	if exp-iat != 120 {
		t.Fatalf("exp-iat = %d, want 120（TTL 未生效）", exp-iat)
	}
	if now := time.Now().Unix(); iat < now-60 || iat > now+60 {
		t.Fatalf("iat = %d 与当前时间 %d 偏差过大", iat, now)
	}
}

// TestAssertionDefaultTTL：未配置 ttl 时用注册表默认 60s（升级零行为差的锚点）。
func TestAssertionDefaultTTL(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("")

	w := f.postAsRBAC()
	if w.Code != http.StatusOK {
		t.Fatalf("签发 = %d, want 200（body=%s）", w.Code, w.Body.String())
	}
	body := decodeAssertionResponse(t, w)
	if got, _ := body["expires_in"].(float64); int64(got) != 60 {
		t.Fatalf("默认 expires_in = %v, want 60", body["expires_in"])
	}
	claims := verifyAssertion(t, body["assertion"].(string), assertionTestSecret)
	if delta := claimInt64(t, claims, "exp") - claimInt64(t, claims, "iat"); delta != 60 {
		t.Fatalf("默认 exp-iat = %d, want 60", delta)
	}
}

// TestAssertionInvalidTTLFallsBackToDefault：注册表把 10s~300s 作为**安全契约**
// （connector.assertion.ttl 的 MaxDuration）。库里写了超上限/过低的值时，读取路径
// 回落到默认 60s —— 端点绝不能用超上限的 TTL 签一份"长效短时凭证"。
func TestAssertionInvalidTTLFallsBackToDefault(t *testing.T) {
	for _, invalid := range []string{"301s", "5s", "1h"} {
		t.Run(invalid, func(t *testing.T) {
			f := newAssertionFixture(t)
			f.configure(invalid)
			w := f.postAsRBAC()
			if w.Code != http.StatusOK {
				t.Fatalf("签发 = %d, want 200（body=%s）", w.Code, w.Body.String())
			}
			body := decodeAssertionResponse(t, w)
			claims := verifyAssertion(t, body["assertion"].(string), assertionTestSecret)
			if delta := claimInt64(t, claims, "exp") - claimInt64(t, claims, "iat"); delta != 60 {
				t.Fatalf("非法 ttl=%q 时 exp-iat = %d, want 默认 60（不得按非法值签发）", invalid, delta)
			}
		})
	}
}

// TestAssertionJTIUnique：每次签发 jti 必须不同（重放/去重的第一道事实）。
func TestAssertionJTIUnique(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	first := decodeAssertionResponse(t, f.postAsRBAC())
	second := decodeAssertionResponse(t, f.postAsRBAC())
	c1 := verifyAssertion(t, first["assertion"].(string), assertionTestSecret)
	c2 := verifyAssertion(t, second["assertion"].(string), assertionTestSecret)
	if c1["jti"] == c2["jti"] {
		t.Fatalf("两次签发的 jti 相同（%v）—— 断言可被当作同一凭证重放", c1["jti"])
	}
}
