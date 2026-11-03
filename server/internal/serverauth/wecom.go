package serverauth

// 企业微信扫码登录 provider（2026-11-03）。
//
// 二维码来源：服务端请求企业微信官方 `qrConnect` 托管页，提取页面里的
// `qrImg?key=…`，下载官方二维码图片并转成 PNG 返回客户端。
//
// 为什么不能把 `login.work.weixin.qq.com/wwlogin/sso/login` 编码成二维码：
// 那是**登录页**，扫出来会再打开一个需要二次扫码的页面（2026-11-03 真机踩到）。
//
// 回调兑换走服务端公开 API：
//  1. GET <api>/cgi-bin/gettoken?corpid=&corpsecret=   → access_token
//  2. GET <api>/cgi-bin/auth/getuserinfo?access_token=&code= → userid
//  3. GET <api>/cgi-bin/user/get?access_token=&userid= → name/email（失败不阻塞）
//
// 只用公开域名（open.work.weixin.qq.com / qyapi.weixin.qq.com，已在
// scripts/check-no-real-domains.mjs 登记）；基址是**字段**，测试注入 httptest
// 服务即可覆盖二维码抓取与兑换链路，不需要改生产常量、也不需要真外网。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const (
	weComQRBaseURL  = "https://open.work.weixin.qq.com"
	weComAPIBaseURL = "https://qyapi.weixin.qq.com"
	// weComQRPNGMaxBytes 是转成 PNG 后允许的原始字节上限。
	// 客户端只接受 ≤200_000 字符的 base64 data URL；120 KiB 原始 PNG 编码后
	// 约 160 Ki 字符，留出余量（官方 505×505 黑白二维码通常只有几 KiB）。
	weComQRPNGMaxBytes = 120 << 10
)

// weComQRImgKeyRE 从 qrConnect 页面 HTML 中提取官方二维码 key。
// 页面当前形如 `<img class="qrcode" src="https://open.work.weixin.qq.com/wwopen/sso/qrImg?key=…">`。
var weComQRImgKeyRE = regexp.MustCompile(`qrImg\?key=([A-Za-z0-9_-]+)`)

// WeComProvider 实现 QRProvider（企业微信自建应用）。
// 一套配置 = 一个 corp / 一个自建应用（非目标：多 corp 并存）。
type WeComProvider struct {
	corpID      string
	agentID     string
	secret      string // 已解密的 corpsecret，只用于出站 query
	redirectURL string
	qrBaseURL   string
	apiBaseURL  string
	client      *http.Client
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
	p.qrBaseURL = weComQRBaseURL
	p.apiBaseURL = weComAPIBaseURL
	p.client = qrOutboundClient
	return nil
}

func (p *WeComProvider) qrBase() string {
	if p.qrBaseURL != "" {
		return strings.TrimRight(p.qrBaseURL, "/")
	}
	return weComQRBaseURL
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

// AuthURL 返回企业微信官方扫码登录页（qrConnect）。
//
// 注意：该 URL 只用于“服务端去抓官方二维码图片”或人工在浏览器打开；
// **不要**把它直接编码成客户端二维码（必须先经 QRImage 拿官方图片）。
func (p *WeComProvider) AuthURL(state string) (string, error) {
	if state == "" {
		return "", errors.New("wecom: empty state")
	}
	if p.corpID == "" || p.agentID == "" || p.redirectURL == "" {
		return "", errors.New("wecom: provider not configured")
	}
	q := url.Values{}
	q.Set("appid", p.corpID)
	q.Set("agentid", p.agentID)
	q.Set("redirect_uri", p.redirectURL)
	q.Set("state", state)
	return p.qrBase() + "/wwopen/sso/qrConnect?" + q.Encode(), nil
}

// QRImage 下载企业微信官方二维码图片，并转成 PNG 返回。
//
// 步骤：qrConnect 页 → 提取 qrImg?key → 下载 qrImg → 解码 → 重编码 PNG。
// 所有出站都走统一护栏 client（超时、重定向复检、体积上限），错误信息只
// 带阶段名，不回显含 query 的 URL。
func (p *WeComProvider) QRImage(ctx context.Context, state string) ([]byte, error) {
	pageURL, err := p.AuthURL(state)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, qrExchangeTimeout)
	defer cancel()

	page, err := p.getLimited(ctx, pageURL, "wecom qrConnect")
	if err != nil {
		return nil, err
	}
	m := weComQRImgKeyRE.FindSubmatch(page)
	if m == nil {
		return nil, errors.New("wecom: qrConnect 页面里找不到 qrImg key")
	}
	imgURL := p.qrBase() + "/wwopen/sso/qrImg?key=" + url.QueryEscape(string(m[1]))
	raw, err := p.getLimited(ctx, imgURL, "wecom qrImg")
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("wecom: 二维码图片解析失败")
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("wecom: 二维码 PNG 编码失败: %w", err)
	}
	if buf.Len() == 0 || buf.Len() > weComQRPNGMaxBytes {
		return nil, fmt.Errorf("wecom: 二维码 PNG 体积异常（%d 字节）", buf.Len())
	}
	return buf.Bytes(), nil
}

// getLimited 是二维码抓取的最小 HTTP 读取器：2xx、体积上限、统一护栏 client。
func (p *WeComProvider) getLimited(ctx context.Context, rawURL, label string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%s: 请求构造失败", label)
	}
	req.Header.Set("Accept", "text/html,image/*")
	resp, err := p.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: 请求失败: %w", label, qrSafeURLError(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("%s: 服务商返回 HTTP %d", label, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, qrMaxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("%s: 响应读取失败", label)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("%s: 响应为空", label)
	}
	return body, nil
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
	name, email, mobile := "", "", ""
	if err := qrGetJSON(ctx, p.httpClient(),
		p.apiBase()+"/cgi-bin/user/get?"+detailQuery.Encode(), "wecom user/get", &detail); err == nil &&
		detail.ErrCode == 0 {
		name = strings.TrimSpace(detail.Name)
		email = strings.TrimSpace(detail.Email)
		mobile = strings.TrimSpace(detail.Mobile)
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
		GroupsPresent:   false,
		ProviderUserID:  who.UserID,
		ProviderUnionID: "",
		Mobile:          mobile,
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
	Mobile  string `json:"mobile"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}
