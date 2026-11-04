package serverauth

// 企业微信扫码登录 provider 的判据（2026-11-03）。
//
// 覆盖：二维码 URL 的参数/编码、gettoken → getuserinfo → user/get 的映射、
// 以及三条失败边界（errcode≠0 / userid 为空 / user/get 失败不阻塞登录）。
// 所有出站请求都打到 httptest 假服务（apiBaseURL 是字段），不需要真外网。

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestWeComProviderAuthURL 断言二维码内容（企业微信扫码登录页）的参数与编码。
func TestWeComProviderAuthURL(t *testing.T) {
	p := &WeComProvider{
		corpID:      "ww-corp-1",
		agentID:     "100001",
		redirectURL: "https://harness.example.com/api/client/v2/auth/wecom/callback",
	}
	raw, err := p.AuthURL("state-abc")
	if err != nil {
		t.Fatalf("AuthURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	if u.Scheme != "https" || u.Host != "open.work.weixin.qq.com" || u.Path != "/wwopen/sso/qrConnect" {
		t.Fatalf("二维码 URL = %q, want https://open.work.weixin.qq.com/wwopen/sso/qrConnect", raw)
	}
	q := u.Query()
	for key, want := range map[string]string{
		"appid":         "ww-corp-1",
		"agentid":       "100001",
		"redirect_uri":  "https://harness.example.com/api/client/v2/auth/wecom/callback",
		"state":         "state-abc",
		"self_redirect": "true",
	} {
		if got := q.Get(key); got != want {
			t.Fatalf("query %s = %q, want %q (URL=%s)", key, got, want, raw)
		}
	}
	if got := q.Get("login_type"); got != "" {
		t.Fatalf("qrConnect 不应带 login_type（登录页参数），got %q", got)
	}
	// redirect_uri 必须被 percent-encode（否则回调路径里的 `&`/`?` 会截断参数）。
	if !strings.Contains(raw, "redirect_uri=https%3A%2F%2Fharness.example.com%2Fapi%2Fclient%2Fv2%2Fauth%2Fwecom%2Fcallback") {
		t.Fatalf("redirect_uri 未按 urlencoded 形式出现：%s", raw)
	}
	// 空 state / 未配置的 provider 必须拒绝，而不是发出一个无法回调的二维码。
	if _, err := p.AuthURL(""); err == nil {
		t.Fatal("AuthURL 空 state 应报错")
	}
	if _, err := (&WeComProvider{}).AuthURL("s"); err == nil {
		t.Fatal("未配置的 provider AuthURL 应报错")
	}
}

// TestWeComProviderQRImage 断言服务端从官方 qrConnect 页提取 qrImg key、
// 下载官方图片并转成 PNG（2026-11-03 真机缺陷：不能把登录页 URL 当二维码）。
func TestWeComProviderQRImage(t *testing.T) {
	var gotState string
	qrJPG := makeTestJPEG(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/wwopen/sso/qrConnect", func(w http.ResponseWriter, r *http.Request) {
		gotState = r.URL.Query().Get("state")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<html><body><img class="qrcode" src="https://open.work.weixin.qq.com/wwopen/sso/qrImg?key=test-key-123"></body></html>`)
	})
	mux.HandleFunc("/wwopen/sso/qrImg", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("key"); got != "test-key-123" {
			t.Errorf("qrImg key = %q", got)
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(qrJPG)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := &WeComProvider{
		corpID:      "ww-corp-1",
		agentID:     "100001",
		redirectURL: "https://harness.example.com/api/client/v2/auth/wecom/callback",
		qrBaseURL:   srv.URL,
		client:      srv.Client(),
	}
	pngBytes, err := p.QRImage(context.Background(), "state-img")
	if err != nil {
		t.Fatalf("QRImage: %v", err)
	}
	if !bytes.HasPrefix(pngBytes, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		t.Fatalf("QRImage 返回的不是 PNG: % x", pngBytes[:minInt(len(pngBytes), 8)])
	}
	if gotState != "state-img" {
		t.Fatalf("qrConnect state = %q", gotState)
	}

	// 页面里没有 qrImg key（例如服务商改版）必须报错，绝不能退化成把登录页
	// URL 编成二维码（那正是二次扫码缺陷的来源）。
	badMux := http.NewServeMux()
	badMux.HandleFunc("/wwopen/sso/qrConnect", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `<html><body>no qr here</body></html>`)
	})
	badSrv := httptest.NewServer(badMux)
	defer badSrv.Close()
	p.qrBaseURL = badSrv.URL
	p.client = badSrv.Client()
	if _, err := p.QRImage(context.Background(), "state-bad"); err == nil {
		t.Fatal("缺少 qrImg key 时 QRImage 应报错")
	}
}

func makeTestJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			c := color.RGBA{R: 255, G: 255, B: 255, A: 255}
			if (x/4+y/4)%2 == 0 {
				c = color.RGBA{A: 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatalf("jpeg encode: %v", err)
	}
	return buf.Bytes()
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func TestWeComExchangeMapping(t *testing.T) {
	var tokenQuery, userQuery, detailQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			tokenQuery = r.URL.Query()
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "ACCESS-TOKEN", "errcode": 0})
		case "/cgi-bin/auth/getuserinfo":
			userQuery = r.URL.Query()
			_ = json.NewEncoder(w).Encode(map[string]any{"userid": "zhangsan", "errcode": 0})
		case "/cgi-bin/user/get":
			detailQuery = r.URL.Query()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"userid": "zhangsan", "name": "张三", "email": "zhangsan@example.com", "errcode": 0,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	p := &WeComProvider{corpID: "ww-corp-1", secret: "corp-secret", apiBaseURL: srv.URL}
	ui, err := p.Exchange(context.Background(), "CODE-1")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if got := tokenQuery.Get("corpid"); got != "ww-corp-1" {
		t.Fatalf("gettoken corpid = %q", got)
	}
	if got := tokenQuery.Get("corpsecret"); got != "corp-secret" {
		t.Fatalf("gettoken corpsecret = %q", got)
	}
	if got := userQuery.Get("access_token"); got != "ACCESS-TOKEN" {
		t.Fatalf("getuserinfo access_token = %q", got)
	}
	if got := userQuery.Get("code"); got != "CODE-1" {
		t.Fatalf("getuserinfo code = %q", got)
	}
	if got := detailQuery.Get("userid"); got != "zhangsan" {
		t.Fatalf("user/get userid = %q", got)
	}
	if ui.Username != "zhangsan" || ui.DisplayName != "张三" || ui.Email != "zhangsan@example.com" {
		t.Fatalf("UserInfo = %+v", ui)
	}
	if ui.ExternalID != "wecom:ww-corp-1:zhangsan" {
		t.Fatalf("ExternalID = %q, want wecom:<corp>:<userid>", ui.ExternalID)
	}
	if ui.ExternalSource != "wecom" || ui.Source != "external" || ui.GroupsPresent {
		t.Fatalf("identity boundary = %+v（Source=external / GroupsPresent=false）", ui)
	}
}

// TestWeComExchangeUserGetFallback：user/get 失败**不阻塞**登录，回落 userid。
func TestWeComExchangeUserGetFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "AT", "errcode": 0})
		case "/cgi-bin/auth/getuserinfo":
			_ = json.NewEncoder(w).Encode(map[string]any{"userid": "lisi", "errcode": 0})
		case "/cgi-bin/user/get":
			_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 40003, "errmsg": "invalid userid"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	p := &WeComProvider{corpID: "corp", secret: "s", apiBaseURL: srv.URL}
	ui, err := p.Exchange(context.Background(), "CODE")
	if err != nil {
		t.Fatalf("user/get 失败不应阻塞登录：%v", err)
	}
	if ui.Username != "lisi" || ui.DisplayName != "" || ui.Email != "" {
		t.Fatalf("fallback UserInfo = %+v, want username only", ui)
	}
}

// TestWeComExchangeRejectsBadResponses：errcode≠0 / userid 为空必须失败，
// 且错误信息**不得**回显 corpsecret。
func TestWeComExchangeRejectsBadResponses(t *testing.T) {
	const secret = "VERY-SECRET-CORPSECRET"
	cases := []struct {
		name  string
		token map[string]any
		user  map[string]any
		want  string
	}{
		{
			name:  "gettoken errcode",
			token: map[string]any{"errcode": 40013, "errmsg": "invalid corpid"},
			want:  "gettoken",
		},
		{
			name:  "empty userid",
			token: map[string]any{"access_token": "AT", "errcode": 0},
			user:  map[string]any{"userid": "", "errcode": 0},
			want:  "userid",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/cgi-bin/gettoken":
					_ = json.NewEncoder(w).Encode(tc.token)
				case "/cgi-bin/auth/getuserinfo":
					_ = json.NewEncoder(w).Encode(tc.user)
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			p := &WeComProvider{corpID: "corp", secret: secret, apiBaseURL: srv.URL}
			_, err := p.Exchange(context.Background(), "CODE")
			if err == nil {
				t.Fatal("want error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want contains %q", err, tc.want)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatalf("错误信息回显了 corpsecret：%v", err)
			}
		})
	}
}
