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
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/bootstrap"
	"github.com/zeokeel/zeokeel-harness/server/internal/clientrelease"
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
		assertionSecretEnv, clientrelease.PublicBaseURLEnv,
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
	// P0 跨服务契约：RBAC 在验签**之前**从 header 读 ver；缺失/非 v1 ⇒ 400
	// invalid_grant。只断言 alg/typ 会让"ver 只在 claims 里"的回归静默通过
	//（真实跨仓探针已复现该 400）。
	if header["ver"] != "v1" {
		t.Fatalf("header.ver = %v，期望 v1 —— RBAC 会直接 400 invalid_grant"+
			"（契约位在 header，不在 claims；见 assertionHeaderJSON）", header["ver"])
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

// TestAssertionHeaderContractVectors：JWT header 是跨服务契约的**固定向量**。
//
// 依据（真实跨仓探针，RBAC 9210d04 真 handler）：同一份 claims、只差 header 有没有
// `"ver":"v1"` —— 无 ver 的形态回 400 `invalid_grant` "ver 必须是 v1"（整条静默
// 授权不可用），补上 ver 回 200 并签发 access_token。本用例把"ZeoKeel 签出的 header"
// 钉成 fixture，并把旧形态（只有 alg/typ）作为反例：改回旧 header ⇒ 本用例红，
// 不必等联调才发现。
func TestAssertionHeaderContractVectors(t *testing.T) {
	// fixture：与 RBAC 验签前的 header 判据逐字对齐（alg HS256 + ver v1）。
	const wantHeader = `{"alg":"HS256","typ":"JWT","ver":"v1"}`
	if assertionHeaderJSON != wantHeader {
		t.Fatalf("断言 header fixture = %s，期望 %s（RBAC 从 header 读 ver）",
			assertionHeaderJSON, wantHeader)
	}

	// 生产签名函数的实际输出必须与 fixture 逐字节一致（不是"注释里写着"）。
	raw, err := signAssertion(assertionTestSecret, assertionClaims{Issuer: "iss", Version: assertionVersion})
	if err != nil {
		t.Fatalf("签名: %v", err)
	}
	parts := strings.Split(raw, ".")
	gotHeader, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("解 header: %v", err)
	}
	if string(gotHeader) != wantHeader {
		t.Fatalf("实际签出的 header = %s，期望 %s", gotHeader, wantHeader)
	}

	// RBAC 验签前的 header 判据最小复刻：alg 必须 HS256、ver 必须 v1。
	rbacAcceptsHeader := func(headerJSON string) bool {
		var h map[string]any
		if err := json.Unmarshal([]byte(headerJSON), &h); err != nil {
			return false
		}
		return h["alg"] == "HS256" && h["ver"] == "v1"
	}
	for _, vector := range []struct {
		name   string
		header string
		want   bool
	}{
		{"现行契约（header 带 ver）", wantHeader, true},
		{"旧形态：缺 ver（P0 现场，RBAC 实测 400）", `{"alg":"HS256","typ":"JWT"}`, false},
		{"ver 非 v1", `{"alg":"HS256","typ":"JWT","ver":"v2"}`, false},
		{"alg 非 HS256", `{"alg":"none","typ":"JWT","ver":"v1"}`, false},
	} {
		if got := rbacAcceptsHeader(vector.header); got != vector.want {
			t.Fatalf("%s：header %s 被接受=%v，期望 %v", vector.name, vector.header, got, vector.want)
		}
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

	// 双条件隔离（P2）：ExternalSource=rbac **但 ExternalID 没有 `rbac:` 前缀** ——
	// 这是历史/错误绑定形态；若只判 source，断言 sub 会变成非 RBAC uid（换不出 token
	// 或换出别人的身份），所以必须 409。两个条件（source + 前缀）缺一不可。
	if _, err := serverstore.CreateUserWithPassword(f.db, "halfrbac", "pw123456"); err != nil {
		t.Fatalf("建半绑定用户: %v", err)
	}
	half, err := serverstore.GetUserByUsername(f.db, "halfrbac")
	if err != nil {
		t.Fatalf("读半绑定用户: %v", err)
	}
	if err := serverstore.BindExternalIdentity(f.db, half.ID, "alice-uid-no-prefix", "rbac"); err != nil {
		t.Fatalf("绑定半 Rbac 身份: %v", err)
	}
	halfToken, err := serverauth.IssueToken(f.db, half.ID)
	if err != nil {
		t.Fatalf("签发半绑定用户令牌: %v", err)
	}
	w = f.post(assertionTestConnectorID, halfToken)
	if w.Code != http.StatusConflict {
		t.Fatalf("source=rbac 但 ExternalID 无 rbac: 前缀 = %d, want 409（body=%s）", w.Code, w.Body.String())
	}
	if code := assertionErrorCode(t, w); code != "CONFLICT" {
		t.Fatalf("半绑定账号 error.code = %q, want CONFLICT", code)
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
	f.t.Setenv(clientrelease.PublicBaseURLEnv, assertionTestIssuer+"/")
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
	f.t.Setenv(clientrelease.PublicBaseURLEnv, "")
	setAssertionSetting(t, f.db, "connector.assertion.issuer", assertionTestIssuer)
	setAssertionSetting(t, f.db, "connector.assertion.client_id", "")
	if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺 client_id = %d, want 503（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionIssuerFallback：issuer 解析顺序是**部署契约**：
// connector.assertion.issuer → 对外地址（ZEOKEEL_PUBLIC_BASE_URL env，其次
// settings server.base_url）。对外地址的读取/规范化必须复用 clientrelease 的唯一
// 实现（拒绝 query/fragment/userinfo；https 或回环 http）。
//
// 现场最常见的部署形态是"只在控制台「网关」页配了对外访问地址"（settings
// server.base_url，main 把它注入 clientrelease.PublicBaseResolver）—— 此时也必须能签发
// （此前只读 env，导致这类部署恒 503，是 P1）。
func TestAssertionIssuerFallback(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")
	// 关掉显式 issuer：模拟"没配 connector.assertion.issuer"的部署。
	setAssertionSetting(t, f.db, "connector.assertion.issuer", "")

	prevResolver := clientrelease.PublicBaseResolver
	t.Cleanup(func() { clientrelease.PublicBaseResolver = prevResolver })
	clientrelease.PublicBaseResolver = func() string { return "https://console.example.com/" }

	// ① 仅控制台 server.base_url 配置 ⇒ 签发成功，尾斜杠归一化。
	w := f.postAsRBAC()
	if w.Code != http.StatusOK {
		t.Fatalf("仅 server.base_url 配置 = %d, want 200（body=%s）", w.Code, w.Body.String())
	}
	body := decodeAssertionResponse(t, w)
	if got := body["issuer"]; got != "https://console.example.com" {
		t.Fatalf("issuer = %v, want https://console.example.com（尾斜杠应归一化）", got)
	}
	if claims := verifyAssertion(t, body["assertion"].(string), assertionTestSecret); claims["iss"] != "https://console.example.com" {
		t.Fatalf("claim iss = %v, want 控制台对外地址", claims["iss"])
	}

	// ② env 优先于 settings（存量部署的覆盖口语义）。
	f.t.Setenv(clientrelease.PublicBaseURLEnv, "https://env.example.com/")
	body = decodeAssertionResponse(t, f.postAsRBAC())
	if got := body["issuer"]; got != "https://env.example.com" {
		t.Fatalf("env 应压过 settings：issuer = %v, want https://env.example.com", got)
	}

	// ③ 显式 env 非法（带 userinfo / 带 query）⇒ 503（fail-closed，不回落到 settings
	//     —— 否则"配错了反而静默用上另一个旧配置"）。
	for _, invalid := range []string{
		"https://user:pass@env.example.com",
		"https://env.example.com/?token=1",
	} {
		f.t.Setenv(clientrelease.PublicBaseURLEnv, invalid)
		if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("非法 env %q = %d, want 503（body=%s）", invalid, w.Code, w.Body.String())
		}
	}

	// ④ env 清空后，控制台配置非法（带 query）⇒ 503。
	f.t.Setenv(clientrelease.PublicBaseURLEnv, "")
	clientrelease.PublicBaseResolver = func() string { return "https://console.example.com/?token=1" }
	if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("非法 server.base_url = %d, want 503（body=%s）", w.Code, w.Body.String())
	}
}

// TestAssertionGapLogRateLimited：501/503（部署配置缺项）必须有**限频**日志，
// 只点名连接器 id 与缺项，便于现场定位；且不得出现任何配置取值/密钥。
func TestAssertionGapLogRateLimited(t *testing.T) {
	// 复位限频表 + 替换日志出口（同包变量；测试串行执行，恢复后不影响其它用例）。
	assertionGapLogMu.Lock()
	prevLast := assertionGapLogLast
	assertionGapLogLast = map[string]time.Time{}
	assertionGapLogMu.Unlock()
	prevLogf := assertionGapLogf
	var got []string
	assertionGapLogf = func(format string, args ...any) { got = append(got, fmt.Sprintf(format, args...)) }
	t.Cleanup(func() {
		assertionGapLogf = prevLogf
		assertionGapLogMu.Lock()
		assertionGapLogLast = prevLast
		assertionGapLogMu.Unlock()
	})

	f := newAssertionFixture(t)
	f.configure("60s")
	setAssertionSetting(t, f.db, "connector.assertion.client_id", "")
	for i := 0; i < 3; i++ {
		if w := f.postAsRBAC(); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("缺 client_id = %d, want 503", w.Code)
		}
	}
	if len(got) != 1 {
		t.Fatalf("同一 (连接器,缺项) 一秒内 3 次 503 应只打 1 条日志，实得 %d 条：%v", len(got), got)
	}
	if !strings.Contains(got[0], assertionTestConnectorID) || !strings.Contains(got[0], "client_id") {
		t.Fatalf("告警必须点名连接器 id 与缺项：%s", got[0])
	}
	joined := strings.Join(got, "\n")
	if strings.Contains(joined, assertionTestSecret) || strings.Contains(joined, assertionTestIssuer) {
		t.Fatalf("告警不得包含配置取值：%s", joined)
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

// TestAssertionOnDemandWecomIdentity：历史企微用户（external_source=wecom）没有
// identity.external 登录闸门，但 RBAC 里已有绑定；断言端点按需解析一次后仍应签发
// （sub=RBAC uid）。解析失败则 409，不影响登录。
func TestAssertionOnDemandWecomIdentity(t *testing.T) {
	f := newAssertionFixture(t)
	f.configure("60s")

	if _, err := serverstore.CreateUserWithPassword(f.db, "wecom-user", "pw123456"); err != nil {
		t.Fatalf("建企微用户: %v", err)
	}
	row := f.db.QueryRow(`SELECT id FROM users WHERE username = 'wecom-user'`)
	var id int64
	if err := row.Scan(&id); err != nil {
		t.Fatalf("读企微用户 id: %v", err)
	}
	if err := serverstore.BindExternalIdentity(f.db, id, "wecom:corp:u1", "wecom"); err != nil {
		t.Fatalf("绑定企微身份: %v", err)
	}
	tok, err := serverauth.IssueToken(f.db, id)
	if err != nil {
		t.Fatalf("签发企微用户令牌: %v", err)
	}

	old := lookupExternalIdentity
	t.Cleanup(func() { lookupExternalIdentity = old })
	lookupExternalIdentity = func(_ context.Context, _ *sql.DB, provider, providerUserID string) (serverauth.ExternalIdentity, error) {
		if provider != "wecom" || providerUserID != "u1" {
			return serverauth.ExternalIdentity{}, fmt.Errorf("unexpected lookup %s/%s", provider, providerUserID)
		}
		return serverauth.ExternalIdentity{UID: "wecom-rbac-uid", Status: 1}, nil
	}

	w := f.post(assertionTestConnectorID, tok)
	if w.Code != http.StatusOK {
		t.Fatalf("企微按需解析后应 200，实际 %d（body=%s）", w.Code, w.Body.String())
	}
	var body struct {
		Assertion string `json:"assertion"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Assertion == "" {
		t.Fatalf("响应断言解析失败: %v body=%s", err, w.Body.String())
	}
	claims := verifyAssertion(t, body.Assertion, assertionTestSecret)
	if claims["sub"] != "wecom-rbac-uid" {
		t.Fatalf("sub = %v, want wecom-rbac-uid", claims["sub"])
	}

	// 解析不到（status=0 或 error）→ 409，客户端回退；登录链路不受影响。
	lookupExternalIdentity = func(context.Context, *sql.DB, string, string) (serverauth.ExternalIdentity, error) {
		return serverauth.ExternalIdentity{}, fmt.Errorf("not found")
	}
	if w := f.post(assertionTestConnectorID, tok); w.Code != http.StatusConflict {
		t.Fatalf("解析失败应 409，实际 %d（body=%s）", w.Code, w.Body.String())
	}
}
