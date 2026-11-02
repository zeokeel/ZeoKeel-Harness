package serverauth

// 企业微信扫码登录 provider（2026-11-03）。
//
// 二维码内容 = 企业微信「扫码登录」托管页；回调兑换走服务端公开 API：
//  1. GET <api>/cgi-bin/gettoken?corpid=&corpsecret=   → access_token
//  2. GET <api>/cgi-bin/auth/getuserinfo?access_token=&code= → userid
//  3. GET <api>/cgi-bin/user/get?access_token=&userid= → name/email（失败不阻塞）
//
// 只用公开 API 域名（login.work.weixin.qq.com / qyapi.weixin.qq.com，已在
// scripts/check-no-real-domains.mjs 登记）；基址是**字段**，测试注入 httptest
// 服务即可覆盖兑换链路，不需要改生产常量、也不需要真外网。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const (
	weComLoginBaseURL = "https://login.work.weixin.qq.com"
	weComAPIBaseURL   = "https://qyapi.weixin.qq.com"
)

// WeComProvider 实现 QRProvider（企业微信自建应用）。
// 一套配置 = 一个 corp / 一个自建应用（非目标：多 corp 并存）。
type WeComProvider struct {
	corpID       string
	agentID      string
	secret       string // 已解密的 corpsecret，只用于出站 query
	redirectURL  string
	loginBaseURL string
	apiBaseURL   string
	client       *http.Client
}

func (p *WeComProvider) Name() string { return "wecom" }

// wecomFromSettings 从 settings 构建企业微信 provider（运行期热加载用）。
func wecomFromSettings(s map[string]string) (*WeComProvider, error) {
	p := &WeComProvider{}
	if err := p.Configure(stripPrefix(s, "wecom.")); err != nil {
		return nil, err
	}
	return p, nil
}

// Configure 校验必填项并保存配置。secret 落库形态是 enc:v1:…（与 OIDC
// client_secret 同一套 AES-GCM），这里解密成明文，只保存在进程内存。
func (p *WeComProvider) Configure(cfg map[string]string) error {
	corpID := strings.TrimSpace(cfg["corp_id"])
	agentID := strings.TrimSpace(cfg["agent_id"])
	secret := strings.TrimSpace(cfg["secret"])
	redirect := strings.TrimSpace(cfg["redirect_url"])
	if corpID == "" || agentID == "" || secret == "" || redirect == "" {
		return errors.New("wecom: corp_id, agent_id, secret and redirect_url are required")
	}
	if !authRedirectURLAllowed(redirect) {
		return errors.New("wecom: redirect_url 必须是 https(或 http 回环)")
	}
	p.corpID = corpID
	p.agentID = agentID
	p.secret = decryptSettingSecret(secret)
	p.redirectURL = redirect
	p.loginBaseURL = weComLoginBaseURL
	p.apiBaseURL = weComAPIBaseURL
	p.client = qrOutboundClient
	return nil
}

func (p *WeComProvider) loginBase() string {
	if p.loginBaseURL != "" {
		return strings.TrimRight(p.loginBaseURL, "/")
	}
	return weComLoginBaseURL
}

func (p *WeComProvider) apiBase() string {
	if p.apiBaseURL != "" {
		return strings.TrimRight(p.apiBaseURL, "/")
	}
	return weComAPIBaseURL
}

func (p *WeComProvider) httpClient() *http.Client {
	if p.client != nil {
		return p.client
	}
	return qrOutboundClient
}

// AuthURL 构造二维码内容（企业微信扫码登录页）。
func (p *WeComProvider) AuthURL(state string) (string, error) {
	if state == "" {
		return "", errors.New("wecom: empty state")
	}
	if p.corpID == "" || p.agentID == "" || p.redirectURL == "" {
		return "", errors.New("wecom: provider not configured")
	}
	q := url.Values{}
	q.Set("login_type", "CorpApp")
	q.Set("appid", p.corpID)
	q.Set("agentid", p.agentID)
	q.Set("redirect_uri", p.redirectURL)
	q.Set("state", state)
	return p.loginBase() + "/wwlogin/sso/login?" + q.Encode(), nil
}

// Exchange 用回调 code 换取企业微信身份。
//
// 错误信息只带服务商 errcode/errmsg 或通用阶段名，**绝不**带 corpsecret 或
// 含 query 的 URL（见 qrSafeURLError）。
func (p *WeComProvider) Exchange(ctx context.Context, code string) (UserInfo, error) {
	if code == "" {
		return UserInfo{}, errors.New("wecom: empty code")
	}
	if p.corpID == "" || p.secret == "" {
		return UserInfo{}, errors.New("wecom: provider not configured")
	}
	tokenQuery := url.Values{}
	tokenQuery.Set("corpid", p.corpID)
	tokenQuery.Set("corpsecret", p.secret)
	var tok weComTokenResponse
	if err := qrGetJSON(ctx, p.httpClient(),
		p.apiBase()+"/cgi-bin/gettoken?"+tokenQuery.Encode(), "wecom gettoken", &tok); err != nil {
		return UserInfo{}, err
	}
	if tok.ErrCode != 0 {
		return UserInfo{}, fmt.Errorf("wecom: gettoken errcode=%d errmsg=%s", tok.ErrCode, tok.ErrMsg)
	}
	if tok.AccessToken == "" {
		return UserInfo{}, errors.New("wecom: gettoken returned empty access_token")
	}

	userQuery := url.Values{}
	userQuery.Set("access_token", tok.AccessToken)
	userQuery.Set("code", code)
	var who weComUserInfoResponse
	if err := qrGetJSON(ctx, p.httpClient(),
		p.apiBase()+"/cgi-bin/auth/getuserinfo?"+userQuery.Encode(), "wecom getuserinfo", &who); err != nil {
		return UserInfo{}, err
	}
	if who.ErrCode != 0 {
		return UserInfo{}, fmt.Errorf("wecom: getuserinfo errcode=%d errmsg=%s", who.ErrCode, who.ErrMsg)
	}
	if who.UserID == "" {
		// 非企业成员（外部联系人/openid）不属于本 corp，不能建本地账号。
		return UserInfo{}, errors.New("wecom: getuserinfo returned empty userid")
	}

	// 第 3 步只取显示名/邮箱，失败**不阻塞登录**（设计 §5.1）：回落成 userid。
	detailQuery := url.Values{}
	detailQuery.Set("access_token", tok.AccessToken)
	detailQuery.Set("userid", who.UserID)
	var detail weComUserDetailResponse
	name, email := "", ""
	if err := qrGetJSON(ctx, p.httpClient(),
		p.apiBase()+"/cgi-bin/user/get?"+detailQuery.Encode(), "wecom user/get", &detail); err == nil &&
		detail.ErrCode == 0 {
		name = strings.TrimSpace(detail.Name)
		email = strings.TrimSpace(detail.Email)
	}

	return UserInfo{
		Username:    who.UserID,
		DisplayName: name,
		Email:       email,
		// 外部身份绑定到 (corp, userid)：单看 userid 在不同 corp 之间可能撞车。
		ExternalID:     "wecom:" + p.corpID + ":" + who.UserID,
		ExternalSource: p.Name(),
		Source:         "external",
		// 不查通讯录/部门 ⇒ 不接管组归属（与 OIDC 缺省组声明同口径）。
		GroupsPresent: false,
	}, nil
}

type weComTokenResponse struct {
	AccessToken string `json:"access_token"`
	ErrCode     int    `json:"errcode"`
	ErrMsg      string `json:"errmsg"`
}

type weComUserInfoResponse struct {
	UserID  string `json:"userid"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

type weComUserDetailResponse struct {
	UserID  string `json:"userid"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}
