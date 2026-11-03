package serverauth

import "context"

// UserInfo is the normalized identity returned by providers.
type UserInfo struct {
	Username    string
	DisplayName string
	Email       string
	Groups      []string
	// GroupsPresent 表示本次认证**确实拿到了组声明**(哪怕为空数组)。
	// 用于区分"IdP 说该用户不属于任何组"(要回收)与"这次没下发组 claim"
	// (不能回收 —— 否则会清掉另一套 IdP/LDAP 同步来的组,审计 2026-09-13 P2-9)。
	//
	// ⚠️ "确实拿到了"必须是**真的查询过**,不得按提供方恒真:LDAP 的判据是
	// LDAPProvider.syncsGroups()(未配 group_filter ⇒ 目录不接管组,R24-X4-B1)。
	// GroupsPresent=true 而 Groups=nil 会被 SyncUserGroups 当成"该用户没有组"
	// 做全量替换(清空全部组归属),且同步侧有守卫时不可自愈。
	GroupsPresent bool
	// ExternalID 是 IdP 侧的主体标识(OIDC 的 sub;LDAP 的 entry DN)。
	// 外部身份按 (ExternalID) 绑定到本地行,而不是只按用户名 —— 否则同名
	// 外部身份互相接管(审计 2026-09-13 P2-9)。local 身份为空。
	ExternalID string
	// Source identifies the identity source: "local" for the local users
	// table, "external" for ldap/oidc. provisionUser refuses to let an
	// external identity adopt a local account row.
	Source string
	// ExternalSource 是哪套 IdP(ldap/oidc/openid);仅 external 有值。
	ExternalSource string
	// ProviderUserID / ProviderUnionID / Mobile 是**渠道原生身份**，只在
	// 外部身份解析（identity.external.*，RBAC 定制客户）里使用：
	//   - 企微：ProviderUserID = userid；
	//   - 钉钉：ProviderUnionID = unionId（userid 会变，unionId 稳定）；
	//   - Mobile：服务商返回的手机号，仅用于 RBAC 侧的兜底匹配，不落 ZeoKeel 库。
	// 其它登录方式留空，不改变既有语义。
	ProviderUserID  string
	ProviderUnionID string
	Mobile          string
}

// PasswordProvider authenticates via username/password (local/ldap).
type PasswordProvider interface {
	Name() string
	Authenticate(username, password string) (UserInfo, error)
	Configure(cfg map[string]string) error
}

// QRProvider authenticates via a provider-hosted QR code scanned by a phone
// (企业微信 / 钉钉).
//
// 与 BrowserProvider 的差异：没有浏览器重定向与 state cookie —— 二维码内容由
// 服务端渲染成 PNG 交给客户端，手机扫码后服务商直接回调
// `/api/client/v2/auth/<name>/callback`，服务端凭 state 找回内存流程并签发
// token，桌面客户端轮询 poll 一次性取走（状态机见 qr.go）。
type QRProvider interface {
	Name() string
	// AuthURL 返回服务商托管登录页（含 redirect_uri + state）。
	//
	// ⚠️ 不要把它的返回值直接编码成二维码：`login.work.weixin.qq.com/wwlogin/
	// sso/login` 这类是**登录页**，扫出来的二维码会再打开一个需要二次扫码的
	// 页面（2026-11-03 真机踩到）。能直接拿到官方二维码图片的 provider 必须
	// 实现 QRImageProvider，由服务端返回图片；否则才退回把该 URL 编码成码。
	AuthURL(state string) (string, error)
	// Exchange 用回调 code 兑换外部身份。ctx 由调用方限时（qrExchangeTimeout），
	// 实现必须把它传给每一次出站请求。
	Exchange(ctx context.Context, code string) (UserInfo, error)
	Configure(cfg map[string]string) error
}

// QRImageProvider 是可选能力：由服务端返回**服务商官方二维码图片**（PNG），
// 而不是把登录页 URL 编码成二维码。
//
// 注册了此能力的 provider 在 qr/start 时优先走 QRImage；返回的字节必须是
// 可解码的 PNG（调用方会再校验 PNG 签名与大小后才变成 data URL）。
type QRImageProvider interface {
	QRImage(ctx context.Context, state string) ([]byte, error)
}

// BrowserProvider authenticates via browser redirect flow (oidc).
type BrowserProvider interface {
	Name() string
	// AuthURL starts the browser redirect. `returnServer` is the client's
	// server address recorded from the login page (callback deep link回跳用);
	// `clientIP` 是发起流程的来源 IP(按信任边界解析),供实现在途流程配额用
	// (审计 2026-09-23 R5-A-18)。实现可忽略任一参数,接口统一签名。
	AuthURL(state, returnServer, clientIP string) (string, error)
	HandleCallback(code, state string) (UserInfo, error)
	Configure(cfg map[string]string) error
}
