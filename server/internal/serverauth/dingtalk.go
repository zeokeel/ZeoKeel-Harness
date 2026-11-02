package serverauth

// 钉钉扫码登录 provider（2026-11-03）。
//
// 二维码内容 = 钉钉 OAuth2 授权页；回调兑换走服务端公开 API：
//  1. POST <api>/v1.0/oauth2/userAccessToken
//     body {clientId, clientSecret, code, grantType:"authorization_code"}
//     → accessToken
//  2. GET  <api>/v1.0/contact/users/me
//     header x-acs-dingtalk-access-token → unionId / nick / email
//
// 只用公开 API 域名（login.dingtalk.com / api.dingtalk.com，已在
// scripts/check-no-real-domains.mjs 登记）；基址是字段，测试可注入。

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

const (
	dingTalkLoginBaseURL = "https://login.dingtalk.com"
	dingTalkAPIBaseURL   = "https://api.dingtalk.com"
)

// DingTalkProvider 实现 QRProvider（钉钉企业内部应用）。
// 一套配置 = 一个应用（非目标：多应用并存）。
type DingTalkProvider struct {
	clientID     string
	clientSecret string // 已解密的 AppSecret，只用于 token 请求体
	redirectURL  string
	loginBaseURL string
	apiBaseURL   string
	client       *http.Client
}

func (p *DingTalkProvider) Name() string { return "dingtalk" }

// dingtalkFromSettings 从 settings 构建钉钉 provider（运行期热加载用）。
func dingtalkFromSettings(s map[string]string) (*DingTalkProvider, error) {
	p := &DingTalkProvider{}
	if err := p.Configure(stripPrefix(s, "dingtalk.")); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *DingTalkProvider) Configure(cfg map[string]string) error {
	clientID := strings.TrimSpace(cfg["client_id"])
	clientSecret := strings.TrimSpace(cfg["client_secret"])
	redirect := strings.TrimSpace(cfg["redirect_url"])
	if clientID == "" || clientSecret == "" || redirect == "" {
		return errors.New("dingtalk: client_id, client_secret and redirect_url are required")
	}
	if !authRedirectURLAllowed(redirect) {
		return errors.New("dingtalk: redirect_url 必须是 https(或 http 回环)")
	}
	p.clientID = clientID
	p.clientSecret = decryptSettingSecret(clientSecret)
	p.redirectURL = redirect
	p.loginBaseURL = dingTalkLoginBaseURL
	p.apiBaseURL = dingTalkAPIBaseURL
	p.client = qrOutboundClient
	return nil
}

func (p *DingTalkProvider) loginBase() string {
	if p.loginBaseURL != "" {
		return strings.TrimRight(p.loginBaseURL, "/")
	}
	return dingTalkLoginBaseURL
}

func (p *DingTalkProvider) apiBase() string {
	if p.apiBaseURL != "" {
		return strings.TrimRight(p.apiBaseURL, "/")
	}
	return dingTalkAPIBaseURL
}

func (p *DingTalkProvider) httpClient() *http.Client {
	if p.client != nil {
		return p.client
	}
	return qrOutboundClient
}

// AuthURL 构造二维码内容（钉钉扫码授权页）。
func (p *DingTalkProvider) AuthURL(state string) (string, error) {
	if state == "" {
		return "", errors.New("dingtalk: empty state")
	}
	if p.clientID == "" || p.redirectURL == "" {
		return "", errors.New("dingtalk: provider not configured")
	}
	q := url.Values{}
	q.Set("redirect_uri", p.redirectURL)
	q.Set("response_type", "code")
	q.Set("client_id", p.clientID)
	q.Set("scope", "openid")
	q.Set("state", state)
	q.Set("prompt", "consent")
	return p.loginBase() + "/oauth2/auth?" + q.Encode(), nil
}

// Exchange 用回调 code 换取钉钉身份。
func (p *DingTalkProvider) Exchange(ctx context.Context, code string) (UserInfo, error) {
	if code == "" {
		return UserInfo{}, errors.New("dingtalk: empty code")
	}
	if p.clientID == "" || p.clientSecret == "" {
		return UserInfo{}, errors.New("dingtalk: provider not configured")
	}
	var tok dingTalkTokenResponse
	if err := qrPostJSON(ctx, p.httpClient(),
		p.apiBase()+"/v1.0/oauth2/userAccessToken", "dingtalk userAccessToken",
		dingTalkTokenRequest{
			ClientID:     p.clientID,
			ClientSecret: p.clientSecret,
			Code:         code,
			GrantType:    "authorization_code",
		}, &tok); err != nil {
		return UserInfo{}, err
	}
	if tok.AccessToken == "" {
		return UserInfo{}, errors.New("dingtalk: userAccessToken returned empty accessToken")
	}

	me := dingTalkMeResponse{}
	if err := qrGetJSONWithHeaders(ctx, p.httpClient(),
		p.apiBase()+"/v1.0/contact/users/me", "dingtalk users/me",
		map[string]string{"x-acs-dingtalk-access-token": tok.AccessToken}, &me); err != nil {
		return UserInfo{}, err
	}
	if me.UnionID == "" {
		// unionId 是钉钉侧的稳定主体标识；缺它无法安全地绑定外部身份。
		return UserInfo{}, errors.New("dingtalk: users/me returned empty unionId")
	}
	return UserInfo{
		Username:       me.UnionID,
		DisplayName:    strings.TrimSpace(me.Nick),
		Email:          strings.TrimSpace(me.Email),
		ExternalID:     me.UnionID,
		ExternalSource: p.Name(),
		Source:         "external",
		// 不查通讯录/部门 ⇒ 不接管组归属（设计 §5.2）。
		GroupsPresent: false,
	}, nil
}

type dingTalkTokenRequest struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Code         string `json:"code"`
	GrantType    string `json:"grantType"`
}

type dingTalkTokenResponse struct {
	AccessToken  string `json:"accessToken"`
	ExpireIn     int    `json:"expireIn"`
	RefreshToken string `json:"refreshToken"`
	CorpID       string `json:"corpId"`
}

type dingTalkMeResponse struct {
	Nick      string `json:"nick"`
	AvatarURL string `json:"avatarUrl"`
	Mobile    string `json:"mobile"`
	OpenID    string `json:"openId"`
	UnionID   string `json:"unionId"`
	Email     string `json:"email"`
	StateCode string `json:"stateCode"`
}
