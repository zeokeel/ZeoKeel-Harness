package serverauth

// 钉钉扫码登录 provider 的判据（2026-11-03）。
//
// 覆盖：二维码 URL 参数/编码、userAccessToken → users/me 的映射（含请求体与
// 鉴权头的形状）、unionId 缺失必须失败。出站打 httptest 假服务。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestDingTalkProviderAuthURL 断言二维码内容（钉钉 OAuth2 授权页）的参数与编码。
func TestDingTalkProviderAuthURL(t *testing.T) {
	p := &DingTalkProvider{
		clientID:    "ding-client-1",
		redirectURL: "https://harness.example.com/api/client/v2/auth/dingtalk/callback",
	}
	raw, err := p.AuthURL("state-xyz")
	if err != nil {
		t.Fatalf("AuthURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	if u.Scheme != "https" || u.Host != "login.dingtalk.com" || u.Path != "/oauth2/auth" {
		t.Fatalf("二维码 URL = %q, want https://login.dingtalk.com/oauth2/auth", raw)
	}
	q := u.Query()
	for key, want := range map[string]string{
		"redirect_uri":  "https://harness.example.com/api/client/v2/auth/dingtalk/callback",
		"response_type": "code",
		"client_id":     "ding-client-1",
		"scope":         "openid",
		"state":         "state-xyz",
		"prompt":        "consent",
	} {
		if got := q.Get(key); got != want {
			t.Fatalf("query %s = %q, want %q (URL=%s)", key, got, want, raw)
		}
	}
	if !strings.Contains(raw, "redirect_uri=https%3A%2F%2Fharness.example.com%2Fapi%2Fclient%2Fv2%2Fauth%2Fdingtalk%2Fcallback") {
		t.Fatalf("redirect_uri 未按 urlencoded 形式出现：%s", raw)
	}
	if _, err := p.AuthURL(""); err == nil {
		t.Fatal("AuthURL 空 state 应报错")
	}
	if _, err := (&DingTalkProvider{}).AuthURL("s"); err == nil {
		t.Fatal("未配置的 provider AuthURL 应报错")
	}
}

// TestDingTalkExchangeMapping 断言 userAccessToken → users/me 的映射。
func TestDingTalkExchangeMapping(t *testing.T) {
	var tokenBody map[string]string
	var meToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/oauth2/userAccessToken":
			if r.Method != http.MethodPost {
				t.Errorf("userAccessToken method = %s, want POST", r.Method)
			}
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &tokenBody); err != nil {
				t.Errorf("token body 不是 JSON: %v (%s)", err, raw)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken": "DING-ACCESS", "expireIn": 7200, "refreshToken": "R", "corpId": "corp",
			})
		case "/v1.0/contact/users/me":
			meToken = r.Header.Get("x-acs-dingtalk-access-token")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nick": "钉钉用户", "email": "ding@example.com",
				"openId": "open-1", "unionId": "union-1", "avatarUrl": "https://example.invalid/a.png",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	p := &DingTalkProvider{clientID: "ding-client-1", clientSecret: "ding-secret", apiBaseURL: srv.URL}
	ui, err := p.Exchange(context.Background(), "CODE-1")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if tokenBody["clientId"] != "ding-client-1" || tokenBody["clientSecret"] != "ding-secret" ||
		tokenBody["code"] != "CODE-1" || tokenBody["grantType"] != "authorization_code" {
		t.Fatalf("userAccessToken body = %v", tokenBody)
	}
	if meToken != "DING-ACCESS" {
		t.Fatalf("users/me x-acs-dingtalk-access-token = %q", meToken)
	}
	if ui.Username != "union-1" || ui.DisplayName != "钉钉用户" || ui.Email != "ding@example.com" {
		t.Fatalf("UserInfo = %+v", ui)
	}
	if ui.ExternalID != "union-1" || ui.ExternalSource != "dingtalk" || ui.Source != "external" || ui.GroupsPresent {
		t.Fatalf("identity boundary = %+v", ui)
	}
}

// TestDingTalkExchangeRejectsMissingUnionID：unionId 是钉钉侧稳定主体标识，
// 缺失必须失败（否则会按空 ExternalID 建出一个无法绑定的账号）。
func TestDingTalkExchangeRejectsMissingUnionID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/oauth2/userAccessToken":
			_ = json.NewEncoder(w).Encode(map[string]any{"accessToken": "AT"})
		case "/v1.0/contact/users/me":
			_ = json.NewEncoder(w).Encode(map[string]any{"nick": "no-union"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	p := &DingTalkProvider{clientID: "c", clientSecret: "s", apiBaseURL: srv.URL}
	if _, err := p.Exchange(context.Background(), "CODE"); err == nil {
		t.Fatal("unionId 为空时必须失败")
	} else if !strings.Contains(err.Error(), "unionId") {
		t.Fatalf("error = %v, want mention unionId", err)
	}
}
