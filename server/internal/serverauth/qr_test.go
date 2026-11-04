package serverauth

// 扫码登录（企业微信 wecom / 钉钉 dingtalk）HTTP 面与流程状态机的判据
// （2026-11-03）。
//
// 覆盖设计文档 §4.2/§4.3/§4.4/§4.5 的契约：
//   - start → {flow_id, qr_png, expires_in}；未配置 404；限流/容量 429；
//   - poll → pending / done(token+user，单次消费) / failed(稳定 code) / expired；
//   - callback → 成功 200 极简 HTML（无脚本/外链）、失败 JSON 信封；
//   - state 单次使用、跨 provider 拒绝且不消耗对方流程、TTL 5 分钟；
//   - 身份/授权边界复用 OIDC 回调：provision、禁用账号、审计账号；
//   - /auth/methods 的 qr 字段（settings 回退 vs 运行期注册表权威）；
//   - 管理端 GET/PUT 的掩码与 AES-GCM 落库（同 admin_test.go 的既有口径）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/util"
)

// fakeQRProvider 是扫码流程测试用的最小 QRProvider：AuthURL 记录下发的 state，
// Exchange 按用例注入固定身份或错误。
type fakeQRProvider struct {
	name        string
	authErr     error
	exchangeErr error
	ui          UserInfo
	lastState   string
	lastCode    string
}

func (p *fakeQRProvider) Name() string                      { return p.name }
func (p *fakeQRProvider) Configure(map[string]string) error { return nil }

func (p *fakeQRProvider) AuthURL(state string) (string, error) {
	p.lastState = state
	if p.authErr != nil {
		return "", p.authErr
	}
	return "https://provider.example/login?state=" + url.QueryEscape(state), nil
}

func (p *fakeQRProvider) Exchange(_ context.Context, code string) (UserInfo, error) {
	p.lastCode = code
	if p.exchangeErr != nil {
		return UserInfo{}, p.exchangeErr
	}
	return p.ui, nil
}

func newQRTestServer(t *testing.T, providers ...QRProvider) (*gin.Engine, *API) {
	t.Helper()
	db := mustDB(t)
	api := New(db)
	for _, p := range providers {
		api.RegisterQR(p)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
		t.Fatal(err)
	}
	api.RegisterRoutes(r)
	return r, api
}

// qrStart 调 start 并返回 (flow_id, qr_png)。
func qrStart(t *testing.T, r http.Handler, name string) (string, string) {
	t.Helper()
	w, out := doJSON(t, r, "POST", "/api/client/v2/auth/"+name+"/qr/start", `{}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("%s start = %d %s", name, w.Code, w.Body.String())
	}
	flowID, _ := out["flow_id"].(string)
	qrPNG, _ := out["qr_png"].(string)
	if flowID == "" || qrPNG == "" {
		t.Fatalf("start 响应字段缺失: %s", w.Body.String())
	}
	return flowID, qrPNG
}

// qrPoll 调 poll。
func qrPoll(t *testing.T, r http.Handler, name, flowID string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return doJSON(t, r, "GET",
		"/api/client/v2/auth/"+name+"/qr/poll?flow_id="+url.QueryEscape(flowID), "", nil)
}

// qrCallback 调 callback（模拟手机浏览器）。
func qrCallback(r http.Handler, name, code, state string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet,
		"/api/client/v2/auth/"+name+"/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func errorCode(t *testing.T, body string) string {
	t.Helper()
	var out struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("响应不是 JSON 错误信封: %v (%s)", err, body)
	}
	return out.Error.Code
}

// ---------------------------------------------------------------------------
// 二维码渲染
// ---------------------------------------------------------------------------

func TestQRPNGDataURL(t *testing.T) {
	const prefix = "data:image/png;base64,"
	dataURL, err := qrPNGDataURL("https://login.work.weixin.qq.com/wwlogin/sso/login?state=abc")
	if err != nil {
		t.Fatalf("qrPNGDataURL: %v", err)
	}
	if !strings.HasPrefix(dataURL, prefix) {
		t.Fatalf("data URL 前缀 = %q, want %q", truncate(dataURL, 40), prefix)
	}
	png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(dataURL, prefix))
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if !bytes.HasPrefix(png, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("解码结果不是 PNG（魔数不匹配）")
	}
	// 客户端只接受 ≤200_000 的 PNG data URL（设计 §7）；服务端 320px 远低于上限。
	if len(dataURL) > 200_000 {
		t.Fatalf("data URL 长度 = %d, want ≤ 200000", len(dataURL))
	}
	if _, err := qrPNGDataURL("   "); err == nil {
		t.Fatal("空内容必须报错（不能渲染一个无法扫描的空二维码）")
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---------------------------------------------------------------------------
// 流程表（纯内存，不依赖 DB）
// ---------------------------------------------------------------------------

func TestQRFlowTableStateSingleUse(t *testing.T) {
	tbl := newQRFlowTable()
	f, err := tbl.create("wecom", "203.0.113.9")
	if err != nil {
		t.Fatal(err)
	}
	// 跨 provider：拒绝且**不消耗**对方流程（否则知道 state 的人能替别人取消登录）。
	if _, err := tbl.claim(f.state, "dingtalk"); !errors.Is(err, errQRStateWrongProvider) {
		t.Fatalf("cross-provider claim err = %v, want errQRStateWrongProvider", err)
	}
	claimed, err := tbl.claim(f.state, "wecom")
	if err != nil || claimed != f {
		t.Fatalf("claim = %v, %v", claimed, err)
	}
	// 单次使用：第二次 claim 必须失败。
	if _, err := tbl.claim(f.state, "wecom"); !errors.Is(err, errQRStateUnknown) {
		t.Fatalf("重复 claim err = %v, want errQRStateUnknown", err)
	}
}

func TestQRFlowTableTerminalConsumption(t *testing.T) {
	tbl := newQRFlowTable()

	// pending 不消费：连续轮询都应得到 pending。
	f, _ := tbl.create("wecom", "ip-1")
	for i := 0; i < 2; i++ {
		res, err := tbl.poll(f.id, "wecom")
		if err != nil || res.status != "pending" {
			t.Fatalf("pending poll = %+v, %v", res, err)
		}
	}

	// done：首次返回 token + user，随后 flow_id 失效。
	tbl.markDone(f, "raw-token", &serverstore.User{Username: "zhangsan", PasswordMustChange: true})
	res, err := tbl.poll(f.id, "wecom")
	if err != nil {
		t.Fatal(err)
	}
	if res.status != "done" || res.token != "raw-token" || res.user == nil || !res.mustChange {
		t.Fatalf("done poll = %+v", res)
	}
	if _, err := tbl.poll(f.id, "wecom"); !errors.Is(err, errQRFlowUnknown) {
		t.Fatalf("terminated flow 仍可轮询：err=%v", err)
	}

	// failed：稳定 code + message 原样交给客户端，同样单次消费。
	g, _ := tbl.create("dingtalk", "ip-2")
	tbl.markFailed(g, "AUTH_FAILED", "扫码登录认证失败")
	res, err = tbl.poll(g.id, "dingtalk")
	if err != nil || res.status != "failed" || res.errCode != "AUTH_FAILED" || res.errMessage == "" {
		t.Fatalf("failed poll = %+v, %v", res, err)
	}
	if _, err := tbl.poll(g.id, "dingtalk"); !errors.Is(err, errQRFlowUnknown) {
		t.Fatalf("failed flow 仍可轮询：err=%v", err)
	}
}

func TestQRFlowTableExpiry(t *testing.T) {
	tbl := newQRFlowTable()
	f, _ := tbl.create("wecom", "ip-1")
	tbl.mu.Lock()
	f.createdAt = time.Now().Add(-qrFlowTTL - time.Second)
	tbl.mu.Unlock()

	// poll：过期是**终态**，返回 expired 并消费 flow_id（再轮询 404）。
	res, err := tbl.poll(f.id, "wecom")
	if err != nil || res.status != "expired" {
		t.Fatalf("expired poll = %+v, %v", res, err)
	}
	if _, err := tbl.poll(f.id, "wecom"); !errors.Is(err, errQRFlowUnknown) {
		t.Fatalf("expired flow 仍可轮询：err=%v", err)
	}

	// callback：过期 state 必须 400（哨兵 errQRStateUnknown），且流程被清掉。
	g, _ := tbl.create("wecom", "ip-2")
	tbl.mu.Lock()
	g.createdAt = time.Now().Add(-qrFlowTTL - time.Second)
	tbl.mu.Unlock()
	if _, err := tbl.claim(g.state, "wecom"); !errors.Is(err, errQRStateUnknown) {
		t.Fatalf("expired state claim err = %v, want errQRStateUnknown", err)
	}
	tbl.mu.Lock()
	remaining := len(tbl.flows)
	tbl.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("过期流程未被清理，剩余 %d 条", remaining)
	}
}

func TestQRFlowTableCapacity(t *testing.T) {
	tbl := newQRFlowTable()
	// 每个 IP 都不同，绕开"单 IP 在途 10"的配额，单测表容量本身。
	for i := 0; i < qrMaxFlows; i++ {
		if _, err := tbl.create("wecom", fmt.Sprintf("ip-%d", i)); err != nil {
			t.Fatalf("第 %d 条流程创建失败: %v", i, err)
		}
	}
	if _, err := tbl.create("wecom", "ip-overflow"); !errors.Is(err, errQRFlowTableFull) {
		t.Fatalf("表满 err = %v, want errQRFlowTableFull（fail-closed，不驱逐在途流程）", err)
	}

	// 单 IP 在途配额 = 10：同一 IP 的第 11 条必须被拒。
	other := newQRFlowTable()
	for i := 0; i < qrMaxFlowsPerIP; i++ {
		if _, err := other.create("wecom", "same-ip"); err != nil {
			t.Fatalf("同 IP 第 %d 条失败: %v", i, err)
		}
	}
	if _, err := other.create("wecom", "same-ip"); !errors.Is(err, errQRFlowQuotaPerIP) {
		t.Fatalf("单 IP 配额 err = %v, want errQRFlowQuotaPerIP", err)
	}
}

// ---------------------------------------------------------------------------
// 端到端：start → callback → poll（真 DB，含 provision + token 签发 + 审计）
// ---------------------------------------------------------------------------

func TestQRBrowserLaunchRedirectsOnlyOfficialTargets(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom"}
	r, _ := newQRTestServer(t, fake)

	// 官方登录页：302 到白名单目标，且不缓存。
	target := "https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=ww-test&state=abc"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
		"/api/client/v2/auth/wecom/qr/launch?target="+url.QueryEscape(target), nil))
	if w.Code != http.StatusFound || w.Header().Get("Location") != target {
		t.Fatalf("launch = %d location=%q, want 302 %q", w.Code, w.Header().Get("Location"), target)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("launch Cache-Control = %q, want no-store", cc)
	}

	for _, bad := range []string{
		"",
		"http://open.work.weixin.qq.com/x",
		"https://evil.example/x",
		"https://login.dingtalk.com/oauth2/auth", // 属于另一个 provider
		"https://user:pass@open.work.weixin.qq.com/x",
		"https://open.work.weixin.qq.com:8443/x",
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
			"/api/client/v2/auth/wecom/qr/launch?target="+url.QueryEscape(bad), nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("launch target %q = %d, want 400", bad, w.Code)
		}
	}

	// 未注册的 provider：404 JSON 信封。
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
		"/api/client/v2/auth/dingtalk/qr/launch?target="+url.QueryEscape("https://login.dingtalk.com/x"), nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unregistered launch = %d, want 404", w.Code)
	}
}

func TestQRStartCallbackPollEndToEnd(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "zhangsan", DisplayName: "张三", Email: "zhangsan@example.com",
		ExternalID: "wecom:corp-1:zhangsan", ExternalSource: "wecom", Source: "external",
	}}
	r, api := newQRTestServer(t, fake)

	flowID, qrPNG := qrStart(t, r, "wecom")
	if len(flowID) != 64 {
		t.Fatalf("flow_id = %q(len=%d), want 64 hex（32 字节随机）", flowID, len(flowID))
	}
	if !strings.HasPrefix(qrPNG, "data:image/png;base64,") {
		t.Fatalf("qr_png 前缀错误: %q", truncate(qrPNG, 40))
	}
	if len(fake.lastState) != 64 {
		t.Fatalf("state = %q(len=%d), want 64 hex", fake.lastState, len(fake.lastState))
	}

	// pending
	if w, out := qrPoll(t, r, "wecom", flowID); w.Code != http.StatusOK || out["status"] != "pending" {
		t.Fatalf("poll pending = %d %v", w.Code, out)
	}

	// callback（手机浏览器）→ 200 text/html 成功页；静态倒计时脚本允许，
	// 但不得出现外链/外部资源/请求数据插值（设计 §4.4 的安全边界）。
	w := qrCallback(r, "wecom", "CODE-1", fake.lastState)
	if w.Code != http.StatusOK {
		t.Fatalf("callback = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("callback Content-Type = %q, want text/html", ct)
	}
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Fatalf("callback CSP = %q, want default-src 'none'", csp)
	}
	page := w.Body.String()
	for _, want := range []string{"登录成功", "请返回客户端继续使用", "window.close", "setInterval"} {
		if !strings.Contains(page, want) {
			t.Fatalf("成功页缺少 %q：%s", want, page)
		}
	}
	// 成功页不得反射 code/state；脚本里也不得出现外部资源。
	if strings.Contains(page, "CODE-1") || strings.Contains(page, fake.lastState) {
		t.Fatalf("成功页反射了请求数据：%s", page)
	}
	for _, banned := range []string{"http://", "https://", "<img", "<link"} {
		if strings.Contains(strings.ToLower(page), banned) {
			t.Fatalf("成功页不得包含 %q：%s", banned, page)
		}
	}
	if fake.lastCode != "CODE-1" {
		t.Fatalf("Exchange code = %q", fake.lastCode)
	}

	// poll done：token + user 只出现一次
	w, out := qrPoll(t, r, "wecom", flowID)
	if w.Code != http.StatusOK || out["status"] != "done" {
		t.Fatalf("poll done = %d %s", w.Code, w.Body.String())
	}
	token, _ := out["token"].(string)
	if token == "" {
		t.Fatal("done 缺少 token")
	}
	user, _ := out["user"].(map[string]any)
	if user["username"] != "zhangsan" || user["role"] != serverstore.RoleUser || user["source"] != "external" {
		t.Fatalf("done user = %v", user)
	}
	if user["password_changeable"] != false {
		t.Fatalf("外部身份 password_changeable = %v, want false", user["password_changeable"])
	}
	if out["must_change_password"] != false {
		t.Fatalf("must_change_password = %v, want false", out["must_change_password"])
	}

	// 签发的 token 真的可用（客户端据此构造 Session，不再调 /auth/me 登录）。
	meReq := httptest.NewRequest(http.MethodGet, "/api/client/v2/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+token)
	me := httptest.NewRecorder()
	r.ServeHTTP(me, meReq)
	if me.Code != http.StatusOK {
		t.Fatalf("GET /auth/me with QR token = %d %s", me.Code, me.Body.String())
	}

	// 终态后 flow_id 失效（不泄露是否曾经存在）。
	if w, _ := qrPoll(t, r, "wecom", flowID); w.Code != http.StatusNotFound {
		t.Fatalf("再次 poll = %d, want 404", w.Code)
	}
	// 重复回调 state 已被消费 ⇒ 400，且不会二次签发 token。
	if w := qrCallback(r, "wecom", "CODE-2", fake.lastState); w.Code != http.StatusBadRequest {
		t.Fatalf("重复 callback = %d %s, want 400", w.Code, w.Body.String())
	}

	// 审计：login_success detail 带 provider + ip；登录失败面不落 token。
	var detail string
	if err := api.DB.QueryRow(
		`SELECT detail FROM audit_logs WHERE action='login_success' AND username='zhangsan' ORDER BY id DESC LIMIT 1`,
	).Scan(&detail); err != nil {
		t.Fatalf("读审计: %v", err)
	}
	if !strings.Contains(detail, "wecom ip=") {
		t.Fatalf("login_success detail = %q, want wecom ip=…", detail)
	}
	if strings.Contains(detail, token) {
		t.Fatal("token 不得出现在审计日志里")
	}
}

// TestQRStateCrossProviderRejected：state 属于 wecom 时，用 dingtalk 的
// callback 必须被拒，且**不得**消费 wecom 的流程（随后 wecom 仍能完成登录）。
func TestQRStateCrossProviderRejected(t *testing.T) {
	wecom := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "cross-user", ExternalID: "wecom:corp:cross-user", ExternalSource: "wecom", Source: "external",
	}}
	dingtalk := &fakeQRProvider{name: "dingtalk", ui: UserInfo{
		Username: "cross-user", ExternalID: "ding:cross-user", ExternalSource: "dingtalk", Source: "external",
	}}
	r, _ := newQRTestServer(t, wecom, dingtalk)

	flowID, _ := qrStart(t, r, "wecom")
	state := wecom.lastState

	w := qrCallback(r, "dingtalk", "CODE", state)
	if w.Code != http.StatusBadRequest || errorCode(t, w.Body.String()) != "VALIDATION" {
		t.Fatalf("跨 provider callback = %d %s, want 400 VALIDATION", w.Code, w.Body.String())
	}
	// 流程未被消费 ⇒ 仍是 pending，且 wecom 自己的 callback 仍可完成。
	if _, out := qrPoll(t, r, "wecom", flowID); out["status"] != "pending" {
		t.Fatalf("跨 provider 拒绝后流程状态 = %v, want pending（不得消耗对方 state）", out)
	}
	if w := qrCallback(r, "wecom", "CODE", state); w.Code != http.StatusOK {
		t.Fatalf("wecom callback = %d %s", w.Code, w.Body.String())
	}
}

// TestQRCallbackFailureMarksFlowFailed：兑换失败 → 手机端 401 信封，同时
// 桌面端 poll 拿到**同一结论**（failed + 稳定 code），且只消费一次。
func TestQRCallbackFailureMarksFlowFailed(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", exchangeErr: errors.New("upstream down")}
	r, _ := newQRTestServer(t, fake)

	flowID, _ := qrStart(t, r, "wecom")
	w := qrCallback(r, "wecom", "CODE", fake.lastState)
	if w.Code != http.StatusUnauthorized || errorCode(t, w.Body.String()) != "AUTH_FAILED" {
		t.Fatalf("callback = %d %s, want 401 AUTH_FAILED", w.Code, w.Body.String())
	}
	w, out := qrPoll(t, r, "wecom", flowID)
	if w.Code != http.StatusOK || out["status"] != "failed" {
		t.Fatalf("poll = %d %s, want failed", w.Code, w.Body.String())
	}
	errObj, _ := out["error"].(map[string]any)
	if errObj["code"] != "AUTH_FAILED" || errObj["message"] == "" {
		t.Fatalf("failed error = %v", errObj)
	}
	if w, _ := qrPoll(t, r, "wecom", flowID); w.Code != http.StatusNotFound {
		t.Fatalf("再次 poll = %d, want 404（终态单次消费）", w.Code)
	}
}

// TestQRAuditorRejected：审计账号不可登录客户端 —— callback 401
// AUDITOR_NOT_ALLOWED，poll 拿到同一 code，且不签发 token。
func TestQRAuditorRejected(t *testing.T) {
	db := mustDB(t)
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "auditor-qr", Source: "external", Status: 1,
		Role: serverstore.RoleAuditor, ExternalID: "wecom:corp:auditor-qr", ExternalSource: "wecom",
	}); err != nil {
		t.Fatal(err)
	}
	api := New(db)
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "auditor-qr", ExternalID: "wecom:corp:auditor-qr", ExternalSource: "wecom", Source: "external",
	}}
	api.RegisterQR(fake)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	flowID, _ := qrStart(t, r, "wecom")
	w := qrCallback(r, "wecom", "CODE", fake.lastState)
	if w.Code != http.StatusUnauthorized || errorCode(t, w.Body.String()) != "AUDITOR_NOT_ALLOWED" {
		t.Fatalf("审计账号 callback = %d %s, want 401 AUDITOR_NOT_ALLOWED", w.Code, w.Body.String())
	}
	_, out := qrPoll(t, r, "wecom", flowID)
	if out["status"] != "failed" {
		t.Fatalf("poll = %v, want failed", out)
	}
	if errObj, _ := out["error"].(map[string]any); errObj["code"] != "AUDITOR_NOT_ALLOWED" {
		t.Fatalf("poll error = %v", errObj)
	}
}

// TestQRDisabledAccountRejected：Status != 1 的外部账号不得签发 token。
func TestQRDisabledAccountRejected(t *testing.T) {
	db := mustDB(t)
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "disabled-qr", Source: "external", Status: 0,
		Role: serverstore.RoleUser, ExternalID: "wecom:corp:disabled-qr", ExternalSource: "wecom",
	}); err != nil {
		t.Fatal(err)
	}
	api := New(db)
	fake := &fakeQRProvider{name: "wecom", ui: UserInfo{
		Username: "disabled-qr", ExternalID: "wecom:corp:disabled-qr", ExternalSource: "wecom", Source: "external",
	}}
	api.RegisterQR(fake)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	qrStart(t, r, "wecom")
	w := qrCallback(r, "wecom", "CODE", fake.lastState)
	if w.Code != http.StatusUnauthorized || errorCode(t, w.Body.String()) != "AUTH_FAILED" {
		t.Fatalf("禁用账号 callback = %d %s, want 401 AUTH_FAILED", w.Code, w.Body.String())
	}
}

// TestQRUnconfigured404：未配置/已禁用的扫码方式 ⇒ 三条路由都是 404 JSON 信封
// （不泄露配置细节，也不暴露"这个方式是否存在"）。
func TestQRUnconfigured404(t *testing.T) {
	r, _ := newQRTestServer(t) // 不注册任何 QR provider
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodPost, "/api/client/v2/auth/wecom/qr/start"},
		{http.MethodGet, "/api/client/v2/auth/wecom/qr/poll?flow_id=x"},
		{http.MethodGet, "/api/client/v2/auth/wecom/callback?code=c&state=s"},
		{http.MethodPost, "/api/client/v2/auth/dingtalk/qr/start"},
		{http.MethodGet, "/api/client/v2/auth/dingtalk/qr/poll?flow_id=x"},
		{http.MethodGet, "/api/client/v2/auth/dingtalk/callback?code=c&state=s"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s %s = %d, want 404", tc.method, tc.path, w.Code)
		}
		if code := errorCode(t, w.Body.String()); code != "NOT_FOUND" {
			t.Fatalf("%s %s error code = %q, want NOT_FOUND", tc.method, tc.path, code)
		}
	}
}

// TestQRStartRateLimit：30 次**真实失败**之后，第 31 次启动被 429 拦下
// （独立 limiter，只对失败记账）。
func TestQRStartRateLimit(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom", authErr: errors.New("cannot build QR")}
	r, api := newQRTestServer(t, fake)

	for i := 0; i < qrStartMaxAttempts; i++ {
		w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/wecom/qr/start", `{}`, nil)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("第 %d 次 start = %d %s, want 500（AuthURL 失败）", i+1, w.Code, w.Body.String())
		}
	}
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/wecom/qr/start", `{}`, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("第 %d 次 start = %d, want 429", qrStartMaxAttempts+1, w.Code)
	}
	if code := errorCode(t, w.Body.String()); code != "RATE_LIMITED" {
		t.Fatalf("错误码 = %q, want RATE_LIMITED", code)
	}
	var n int
	if err := api.DB.QueryRow(
		`SELECT COUNT(*) FROM audit_logs WHERE action='login_fail' AND detail LIKE '%rate_limited%'`,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("启动限流必须留审计（login_fail rate_limited）")
	}
}

// TestQRStartPerIPQuota：单 IP 在途 10 条，第 11 条 429；容量拒绝走独立计数
// 与独立审计动作（qr_flow_capacity），不污染失败预算。
func TestQRStartPerIPQuota(t *testing.T) {
	fake := &fakeQRProvider{name: "wecom"}
	r, api := newQRTestServer(t, fake)

	for i := 0; i < qrMaxFlowsPerIP; i++ {
		qrStart(t, r, "wecom")
	}
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/wecom/qr/start", `{}`, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("第 %d 条在途 = %d %s, want 429", qrMaxFlowsPerIP+1, w.Code, w.Body.String())
	}
	if got := QRFlowCapacityRejections(); got != 1 {
		t.Fatalf("容量拒绝计数 = %d, want 1", got)
	}
	var n int
	if err := api.DB.QueryRow(
		`SELECT COUNT(*) FROM audit_logs WHERE action='qr_flow_capacity' AND detail LIKE '%per_ip_quota%'`,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("qr_flow_capacity 审计条数 = %d, want 1", n)
	}
	// 容量拒绝不计入失败预算：成功的 start 不记账 ⇒ 失败桶为空。
	api.qrStartLimiter.mu.Lock()
	failures := len(api.qrStartLimiter.attempts)
	api.qrStartLimiter.mu.Unlock()
	if failures != 0 {
		t.Fatalf("容量拒绝/成功启动污染了失败预算：%d 个键有记账", failures)
	}
}

// TestQRSettingsToProviderBuild：从 settings 构建两个 provider；缺必填项时
// 构建失败被如实登记（kindQR），并保留旧实例（ReloadProviders 语义）。
func TestQRSettingsToProviderBuild(t *testing.T) {
	settings := map[string]string{
		"auth.enabled":           "local,wecom,dingtalk",
		"wecom.corp_id":          "ww-corp",
		"wecom.agent_id":         "100001",
		"wecom.secret":           "plain-secret",
		"wecom.redirect_url":     "https://harness.example.com/api/client/v2/auth/wecom/callback",
		"dingtalk.client_id":     "ding-id",
		"dingtalk.client_secret": "ding-secret",
		"dingtalk.redirect_url":  "https://harness.example.com/api/client/v2/auth/dingtalk/callback",
	}
	_, _, qrs, failures := configureProvidersFromSettings(settings, nil)
	if len(qrs) != 2 || len(failures) != 0 {
		t.Fatalf("qrs = %v, failures = %v", qrs, failures)
	}
	for _, p := range qrs {
		switch p.Name() {
		case "wecom", "dingtalk":
		default:
			t.Fatalf("unexpected QR provider %q", p.Name())
		}
	}

	// 缺 redirect_url ⇒ 构建失败且如实回报（不得静默变成"没有这种登录方式"）。
	broken := map[string]string{"auth.enabled": "local,wecom", "wecom.corp_id": "c", "wecom.agent_id": "a", "wecom.secret": "s"}
	_, _, qrs, failures = configureProvidersFromSettings(broken, nil)
	if len(qrs) != 0 || len(failures) != 1 || failures[0].Name != "wecom" || failures[0].Kind != kindQR {
		t.Fatalf("broken config: qrs=%v failures=%v", qrs, failures)
	}
}

// ---------------------------------------------------------------------------
// /auth/methods 的 qr 字段
// ---------------------------------------------------------------------------

type methodEntry struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
	Browser    bool   `json:"browser"`
	QR         bool   `json:"qr"`
}

func decodeMethods(t *testing.T, w *httptest.ResponseRecorder) map[string]methodEntry {
	t.Helper()
	var out struct {
		Methods []methodEntry `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析 methods: %v (%s)", err, w.Body.String())
	}
	m := make(map[string]methodEntry, len(out.Methods))
	for _, e := range out.Methods {
		m[e.Name] = e
	}
	return m
}

func TestAuthMethodsQRField(t *testing.T) {
	db := mustDB(t)
	for k, v := range map[string]string{
		"auth.enabled":           "local,wecom,dingtalk",
		"wecom.corp_id":          "ww-corp",
		"wecom.agent_id":         "100001",
		"wecom.secret":           "enc:v1:placeholder",
		"wecom.redirect_url":     "https://harness.example.com/api/client/v2/auth/wecom/callback",
		"dingtalk.client_id":     "ding-id",
		"dingtalk.client_secret": "enc:v1:placeholder",
		"dingtalk.redirect_url":  "https://harness.example.com/api/client/v2/auth/dingtalk/callback",
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}
	gin.SetMode(gin.TestMode)

	// ① 没有运行期视图（管理端镜像树）⇒ 按 settings 必填项判定。
	admin := &AdminAPI{DB: db}
	settingsOnly := gin.New()
	settingsOnly.GET("/methods", admin.getPublicAuthMethods)
	w := httptest.NewRecorder()
	settingsOnly.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/methods", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("settings-only methods = %d", w.Code)
	}
	m := decodeMethods(t, w)
	for _, name := range []string{"wecom", "dingtalk"} {
		e := m[name]
		if !e.Configured || !e.QR || e.Browser {
			t.Fatalf("%s = %+v, want configured=true qr=true browser=false", name, e)
		}
	}
	if local := m["local"]; local.QR || local.Browser {
		t.Fatalf("local = %+v, want qr=false browser=false", local)
	}

	// ② 有运行期视图 ⇒ 注册表是权威：settings 齐全但未注册 = configured:false。
	// 与生产装配同形：local provider 恒注册（NewConfiguredAPI），runtimeReady
	// 从那一刻起为 true；扫码 provider 构建失败时不在表里。
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	api.SetEnabledProviders([]string{"local", "wecom", "dingtalk"})
	runtime := gin.New()
	runtime.GET("/methods", api.publicMethodsHandler())
	w = httptest.NewRecorder()
	runtime.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/methods", nil))
	m = decodeMethods(t, w)
	if m["wecom"].Configured || m["dingtalk"].Configured {
		t.Fatalf("运行期未注册时 configured 必须为 false：%+v", m)
	}
	if !m["wecom"].QR || !m["dingtalk"].QR {
		t.Fatalf("qr 字段是协议常量，不依赖注册表：%+v", m)
	}

	// ③ 注册后立刻 true（与登录路由解析 provider 的表同源）。
	api.RegisterQR(&fakeQRProvider{name: "wecom"})
	api.RegisterQR(&fakeQRProvider{name: "dingtalk"})
	w = httptest.NewRecorder()
	runtime.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/methods", nil))
	m = decodeMethods(t, w)
	if !m["wecom"].Configured || !m["dingtalk"].Configured {
		t.Fatalf("注册后 configured 必须为 true：%+v", m)
	}
}

// ---------------------------------------------------------------------------
// 管理端 GET/PUT /api/server/admin/auth
// ---------------------------------------------------------------------------

func TestAdminAuthConfigWeComDingTalk(t *testing.T) {
	ensureTestMasterKey(t)
	r, db := adminRouter(t)
	defer db.Close()

	w, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login = %d %s", w.Code, w.Body.String())
	}
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "zeokeel_session=" + sess, "X-CSRF-Token": csrf}
	getAuth := func() map[string]any {
		_, o := doJSON(t, r, "GET", "/api/server/admin/auth", "", hdr)
		return o["auth"].(map[string]any)
	}

	const redirect = "https://harness.example.com/api/client/v2/auth/"
	body := `{"mode":"local","enabled":"local,wecom,dingtalk",
		"wecom":{"corp_id":"ww-corp","agent_id":"100001","secret":"wecom-secret","redirect_url":"` + redirect + `wecom/callback"},
		"dingtalk":{"client_id":"ding-id","client_secret":"ding-secret","redirect_url":"` + redirect + `dingtalk/callback"}}`
	if w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("保存扫码配置 = %d %s", w.Code, w.Body.String())
	}

	// 读面：字段齐全、secret 掩码。
	auth := getAuth()
	wecom, _ := auth["wecom"].(map[string]any)
	dingtalk, _ := auth["dingtalk"].(map[string]any)
	if wecom["corp_id"] != "ww-corp" || wecom["agent_id"] != "100001" || wecom["redirect_url"] != redirect+"wecom/callback" {
		t.Fatalf("wecom = %v", wecom)
	}
	if wecom["secret"] != MaskSecret || dingtalk["client_secret"] != MaskSecret {
		t.Fatalf("secret 必须掩码：wecom=%v dingtalk=%v", wecom["secret"], dingtalk["client_secret"])
	}
	if dingtalk["client_id"] != "ding-id" || dingtalk["redirect_url"] != redirect+"dingtalk/callback" {
		t.Fatalf("dingtalk = %v", dingtalk)
	}

	// 落库：AES-GCM 密文，可解回原文（与 OIDC client_secret 同一套）。
	var stored string
	var ok bool
	if stored, ok, _ = serverstore.GetSetting(db, "wecom.secret"); !ok {
		t.Fatal("wecom.secret 未落库")
	}
	if !strings.HasPrefix(stored, util.EncPrefix) {
		t.Fatalf("wecom.secret 明文入库：%q", stored)
	}
	if got := decryptSettingSecret(stored); got != "wecom-secret" {
		t.Fatalf("wecom.secret 解密 = %q", got)
	}

	// "***" = 保持现值（密文逐字不变）。
	before := stored
	masked := strings.Replace(body, `"secret":"wecom-secret"`, `"secret":"***"`, 1)
	masked = strings.Replace(masked, `"client_secret":"ding-secret"`, `"client_secret":"***"`, 1)
	if w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth", masked, hdr); w.Code != http.StatusOK {
		t.Fatalf("掩码保存 = %d %s", w.Code, w.Body.String())
	}
	after, _, _ := serverstore.GetSetting(db, "wecom.secret")
	if after != before {
		t.Fatalf("掩码保存改变了密文：before=%q after=%q", before, after)
	}

	// redirect_url 必须是 https / 回环 http（每个方式独立校验）。
	bad := strings.Replace(body, redirect+"wecom/callback", "http://evil.example.com/cb", 1)
	if w, out = doJSON(t, r, "PUT", "/api/server/admin/auth", bad, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("非法 redirect_url = %d %s, want 400", w.Code, w.Body.String())
	}
	if out["error"].(map[string]any)["code"] != "VALIDATION" {
		t.Fatalf("错误码 = %v, want VALIDATION", out["error"])
	}
	// 回环 http 允许。
	loopback := strings.Replace(body, redirect+"wecom/callback", "http://localhost:8080/api/client/v2/auth/wecom/callback", 1)
	if w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth", loopback, hdr); w.Code != http.StatusOK {
		t.Fatalf("回环 http redirect_url = %d %s, want 200", w.Code, w.Body.String())
	}

	// enabled 合法值新增 wecom/dingtalk；未知值仍 400。
	if w, _ = doJSON(t, r, "PUT", "/api/server/admin/auth",
		`{"mode":"local","enabled":"local,wecom,dingtalk,nope"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("非法 enabled = %d, want 400", w.Code)
	}

	// 审计 changed 集合包含 wecom.* / dingtalk.*。
	var detail string
	if err := db.QueryRow(
		`SELECT detail FROM audit_logs WHERE action='auth_config' ORDER BY id DESC LIMIT 1`,
	).Scan(&detail); err != nil {
		t.Fatalf("读 auth_config 审计: %v", err)
	}
	for _, want := range []string{"wecom.*", "dingtalk.*"} {
		if !strings.Contains(detail, want) {
			t.Fatalf("auth_config detail = %q, want contains %q", detail, want)
		}
	}
	if strings.Contains(detail, "wecom-secret") || strings.Contains(detail, "ding-secret") {
		t.Fatalf("审计不得包含明文 secret：%q", detail)
	}
}

// ---------------------------------------------------------------------------
// 启动装配与热加载：扫码方式必须真的进运行期注册表
// ---------------------------------------------------------------------------

func qrConfiguredSettings() map[string]string {
	return map[string]string{
		"auth.enabled":           "local,wecom,dingtalk",
		"wecom.corp_id":          "ww-corp",
		"wecom.agent_id":         "100001",
		"wecom.secret":           "plain-secret",
		"wecom.redirect_url":     "https://harness.example.com/api/client/v2/auth/wecom/callback",
		"dingtalk.client_id":     "ding-id",
		"dingtalk.client_secret": "ding-secret",
		"dingtalk.redirect_url":  "https://harness.example.com/api/client/v2/auth/dingtalk/callback",
	}
}

// TestQRNewConfiguredAPIRegistersConfiguredProviders：启动装配（NewConfiguredAPI）
// 必须把已启用的扫码 provider 注册进运行期注册表。漏注册的形态是 settings 已
// 启用、登录入口恒 404，且只有管理员保存一次认证配置才恢复（R24-X4-B2 同族）。
func TestQRNewConfiguredAPIRegistersConfiguredProviders(t *testing.T) {
	db := mustDB(t)
	for k, v := range qrConfiguredSettings() {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}
	api := NewConfiguredAPI(db)
	if api.API.qrProvider("wecom") == nil {
		t.Fatal("NewConfiguredAPI 未注册 wecom —— 扫码入口会恒 404")
	}
	if api.API.qrProvider("dingtalk") == nil {
		t.Fatal("NewConfiguredAPI 未注册 dingtalk —— 扫码入口会恒 404")
	}
	check := api.API.runtimeMethodCheck()
	if check == nil || !check("wecom") || !check("dingtalk") {
		t.Fatal("运行期方式判定必须把扫码方式纳入 configured 真源")
	}
}

// TestQRReloadProvidersKeepsOldInstanceOnBuildFailure：保存认证配置时若扫码
// provider 构建失败（必填项被清空/写坏），运行期必须**保留旧实例**并把错误
// 如实回报（R24-X4-B2 的既有契约，扫码方式同样适用）。
func TestQRReloadProvidersKeepsOldInstanceOnBuildFailure(t *testing.T) {
	db := mustDB(t)
	for k, v := range qrConfiguredSettings() {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	if err := api.ReloadProviders(db); err != nil {
		t.Fatalf("ReloadProviders（完整配置）: %v", err)
	}
	if api.qrProvider("wecom") == nil || api.qrProvider("dingtalk") == nil {
		t.Fatal("前置不成立：完整配置下扫码 provider 未注册")
	}

	// 把 wecom 写坏（清空 corp_id）后热加载：构建失败 ⇒ 保留旧实例 + 返回错误。
	if err := serverstore.SetSetting(db, "wecom.corp_id", ""); err != nil {
		t.Fatal(err)
	}
	err := api.ReloadProviders(db)
	if err == nil || !strings.Contains(err.Error(), "wecom") {
		t.Fatalf("ReloadProviders（坏配置）err = %v, want 明确提到 wecom 的失败", err)
	}
	if !strings.Contains(err.Error(), "保留原配置") {
		t.Fatalf("ReloadProviders err = %v, want 说明已保留旧实例", err)
	}
	if api.qrProvider("wecom") == nil {
		t.Fatal("构建失败时旧 wecom 实例被静默摘除（保存接口会回 200 但登录已死）")
	}
	if api.runtimeMethodCheck()("wecom") != true {
		t.Fatal("保留旧实例后 /auth/methods 必须仍报 wecom 可用")
	}
}
