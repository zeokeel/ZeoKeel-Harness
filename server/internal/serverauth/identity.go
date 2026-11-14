package serverauth

// 外部身份解析（2026-11-03，RBAC 定制客户）。
//
// 默认关闭。启用后，扫码登录在 provider 换到外部身份之后、provisionUser 之前，
// 由**服务端**调用 RBAC 的只读接口：
//
//	POST <endpoint>
//	Authorization: Bearer <token>
//	{"provider":"wecom|dingtalk","provider_user_id":"","union_id":"","mobile":""}
//	→ 200 {"uid","name","email","mobile","status":1|0,"departments":[]}
//
// 语义：RBAC 是用户主数据的权威源。ZeoKeel 用返回的 uid 作为用户名/外部身份；
// status=0 一律拒绝登录；查不到/多义/服务不可用都按 fail-closed 处理。
//
// 纪律：
//   - 只在 enabled=true 且 method 命中 identity.external.methods 时才发请求；
//     未启用/未命中时该函数是纯 no-op（零行为变化、零额外延迟）。
//   - token 只走 Header；响应内容、token、手机号都不进日志/审计/URL。
//   - 出站走 util.SafeOutboundTransport（链路本地/云 metadata 拦截）+ 显式超时 +
//     拒绝重定向 + 响应体上限。
//   - 不写任何数据库：身份绑定/组同步仍由既有 provisionUser 路径完成。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/util"
)

const (
	identityExternalEnabledKey    = "identity.external.enabled"
	identityExternalEndpointKey   = "identity.external.endpoint"
	identityExternalTokenKey      = "identity.external.token"
	identityExternalMethodsKey    = "identity.external.methods"
	identityExternalTimeoutMSKey  = "identity.external.timeout_ms"
	identityExternalSyncGroupsKey = "identity.external.sync_groups"

	// identityDefaultMethods 是未配置时的默认生效方式。
	identityDefaultMethods = "wecom,dingtalk"
	// identityDefaultTimeout 与 webadmin 的默认值一致。
	identityDefaultTimeout = 3 * time.Second
	// identityMinTimeout / identityMaxTimeout 是管理端校验区间（毫秒）。
	identityMinTimeoutMS = 200
	identityMaxTimeoutMS = 10000
	// identityMaxResponseBytes 限制 RBAC 响应体，防被控上游打满内存。
	identityMaxResponseBytes = 64 << 10
	// identityMaxUIDBytes 是 users.username 的唯一上限（serverstore.MaxUsernameBytes）。
	identityMaxUIDBytes = serverstore.MaxUsernameBytes
	// identityMaxDepartments / identityMaxDepartmentBytes 限制组名列表。
	identityMaxDepartments     = 100
	identityMaxDepartmentBytes = 128

	identityReasonNotBound    = "identity_not_bound"
	identityReasonDisabled    = "identity_disabled"
	identityReasonAmbiguous   = "identity_ambiguous"
	identityReasonUnavailable = "identity_unavailable"
	identityReasonConflict    = "identity_conflict"
)

// identityError 是「已经映射成对外结论」的错误。
//
// qrCallbackHandler 直接拿这三个字段写响应并留审计，不再二次猜测 HTTP 状态：
// 404/409 与「服务不可用」对用户是三种完全不同的处置（联系管理员绑定 /
// 请管理员澄清 / 稍后重试），在映射处一次决定，避免旁路分支漂移。
type identityError struct {
	status  int    // HTTP 状态码
	code    string // 稳定错误码（客户端按码分支）
	message string // 用户可读中文
	reason  string // 审计 detail 的原因（不含手机号/令牌）
}

func (e *identityError) Error() string { return e.code + ": " + e.message }

// identityResolveResponse 是 RBAC 200 响应的严格形状（未知字段忽略）。
type identityResolveResponse struct {
	UID         string   `json:"uid"`
	Name        string   `json:"name"`
	Email       string   `json:"email"`
	Mobile      string   `json:"mobile"`
	Status      int      `json:"status"`
	Departments []string `json:"departments"`
}

// externalIdentitySettings 是 identity.external.* 解析后的运行期视图。
type externalIdentitySettings struct {
	enabled    bool
	endpoint   string
	token      string
	methods    map[string]bool
	timeout    time.Duration
	syncGroups bool
}

// identityOutboundTransport 与 OIDC/扫码兑换共用同一套出站护栏
// （链路本地/云 metadata 拦截、DNS rebinding 兜底）；包级复用避免每次登录
// 新建连接池。
var identityOutboundTransport = util.SafeOutboundTransport()

// loadExternalIdentitySettings 把 settings 映射解析成运行期配置。
//
// 关闭时只返回 enabled=false，**不校验**其它字段（半配置不应该让登录失败，
// 因为此时根本不会发起请求）。启用时才校验 endpoint/token/methods/timeout；
// 任何一项不合法都返回错误，由调用方按「服务不可用」fail-closed。
func loadExternalIdentitySettings(s map[string]string) (externalIdentitySettings, error) {
	cfg := externalIdentitySettings{
		enabled:    s[identityExternalEnabledKey] == "true",
		endpoint:   strings.TrimSpace(s[identityExternalEndpointKey]),
		token:      decryptSettingSecret(s[identityExternalTokenKey]),
		timeout:    identityDefaultTimeout,
		syncGroups: s[identityExternalSyncGroupsKey] != "false",
		methods:    map[string]bool{},
	}
	for _, m := range strings.Split(strings.TrimSpace(s[identityExternalMethodsKey]), ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			cfg.methods[m] = true
		}
	}
	if len(cfg.methods) == 0 {
		for _, m := range strings.Split(identityDefaultMethods, ",") {
			cfg.methods[strings.TrimSpace(m)] = true
		}
	}
	if raw := strings.TrimSpace(s[identityExternalTimeoutMSKey]); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err != nil {
			return cfg, fmt.Errorf("identity.external.timeout_ms 非法: %q", raw)
		}
		cfg.timeout = time.Duration(ms) * time.Millisecond
	}
	if !cfg.enabled {
		return cfg, nil
	}
	if cfg.endpoint == "" || !authRedirectURLAllowed(cfg.endpoint) {
		return cfg, errors.New("identity.external.endpoint 必须是非空 https(或 http 回环) URL")
	}
	if cfg.token == "" {
		return cfg, errors.New("identity.external.token 未配置")
	}
	if len(cfg.methods) == 0 {
		return cfg, errors.New("identity.external.methods 不能为空")
	}
	for m := range cfg.methods {
		if m != "wecom" && m != "dingtalk" {
			return cfg, fmt.Errorf("identity.external.methods 含非法方式 %q", m)
		}
	}
	if cfg.timeout < identityMinTimeoutMS*time.Millisecond || cfg.timeout > identityMaxTimeoutMS*time.Millisecond {
		return cfg, fmt.Errorf("identity.external.timeout_ms 必须在 %d~%d 之间", identityMinTimeoutMS, identityMaxTimeoutMS)
	}
	return cfg, nil
}

// ExternalIdentity 是按需解析的只读身份视图（连接器断言端点用）。
type ExternalIdentity struct {
	UID         string
	Name        string
	Email       string
	Mobile      string
	Status      int
	Departments []string
}

// ErrExternalIdentityUnavailable 表示解析服务当前不可用/未配置。
var ErrExternalIdentityUnavailable = errors.New("identity resolve unavailable")

// LookupExternalIdentity 在**不启用** identity.external 登录闸门的前提下，按需调用
// RBAC 只读解析接口。连接器自动授权用它把“企微已登录用户”映射到 RBAC uid：
//   - 未启用/未配置 endpoint·token ⇒ ErrExternalIdentityUnavailable（调用方回退扫码）；
//   - 404/409/停用/超时/坏 JSON ⇒ 同样按不可用处理（绝不阻断登录，只在本次断言请求上回退）；
//   - 成功返回 uid/姓名/状态/部门；调用方必须再检查 Status==1。
//
// 该函数只读、不写库、不改变登录链路；token 只走 Header，不落日志。
func LookupExternalIdentity(ctx context.Context, db *sql.DB, provider, providerUserID string) (ExternalIdentity, error) {
	if db == nil {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	cfg, err := loadExternalIdentitySettings(settings)
	if err != nil {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	// loadExternalIdentitySettings 在 enabled=false 时提前返回，不校验 endpoint/token；
	// 断言的按需解析必须在“登录闸门关闭”时也能用，所以这里自己校验运行期配置。
	if strings.TrimSpace(cfg.endpoint) == "" || !authRedirectURLAllowed(cfg.endpoint) || cfg.token == "" {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	if cfg.timeout < identityMinTimeoutMS*time.Millisecond || cfg.timeout > identityMaxTimeoutMS*time.Millisecond {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	if provider != "wecom" && provider != "dingtalk" {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	if len(cfg.methods) > 0 && !cfg.methods[provider] {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	if strings.TrimSpace(providerUserID) == "" {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	resp, err := callIdentityResolve(ctx, cfg, provider, providerUserID, "", "")
	if err != nil {
		return ExternalIdentity{}, ErrExternalIdentityUnavailable
	}
	return ExternalIdentity{
		UID: resp.UID, Name: resp.Name, Email: resp.Email, Mobile: resp.Mobile,
		Status: resp.Status, Departments: resp.Departments,
	}, nil
}

// enrichExternalIdentity 在扫码 provider 兑换出身份后调用。
//
// 未启用 / 当前方式不在 methods 中 / API 未装配 DB 时原样返回 (ui, nil)，
// 调用方无需分支 —— 这是「默认关闭零行为变化」的唯一实现点。
func (a *API) enrichExternalIdentity(ctx context.Context, method string, ui UserInfo) (UserInfo, *identityError) {
	if a == nil || a.DB == nil {
		return ui, nil
	}
	settings, err := serverstore.GetAllSettings(a.DB)
	if err != nil {
		// 读不到 settings 时无法判断是否启用。认证链路随后仍会读库并失败；
		// 这里按 fail-closed 处理，避免「读不到配置 = 跳过 RBAC」的绕过面。
		return ui, identityUnavailable()
	}
	cfg, err := loadExternalIdentitySettings(settings)
	if err != nil {
		if cfg.enabled {
			return ui, identityUnavailable()
		}
		return ui, nil
	}
	if !cfg.enabled || !cfg.methods[method] {
		return ui, nil
	}
	if ui.ProviderUserID == "" && ui.ProviderUnionID == "" && ui.Mobile == "" {
		// 启用后却拿不到任何可用于匹配的渠道身份：这是配置/协议错误，不能放行。
		return ui, identityUnavailable()
	}

	resp, err := callIdentityResolve(ctx, cfg, method, ui.ProviderUserID, ui.ProviderUnionID, ui.Mobile)
	if err != nil {
		var he *identityResolveHTTPError
		if errors.As(err, &he) {
			switch he.status {
			case http.StatusNotFound:
				return ui, &identityError{
					status: http.StatusForbidden, code: "IDENTITY_NOT_BOUND",
					message: "你的企业账号尚未在 RBAC 中绑定员工身份，请联系管理员",
					reason:  identityReasonNotBound,
				}
			case http.StatusConflict:
				return ui, &identityError{
					status: http.StatusForbidden, code: "IDENTITY_AMBIGUOUS",
					message: "你的身份在 RBAC 中不唯一，请联系管理员处理",
					reason:  identityReasonAmbiguous,
				}
			}
		}
		// 401/400/405/5xx/超时/坏 JSON/非法 URL 等：不区分细节，统一「暂不可用」。
		return ui, identityUnavailable()
	}
	if resp.Status == 0 {
		return ui, &identityError{
			status: http.StatusForbidden, code: "IDENTITY_DISABLED",
			message: "你的账号已在 RBAC 中停用，请联系管理员",
			reason:  identityReasonDisabled,
		}
	}

	// 覆盖身份字段：uid 是 RBAC 的稳定主键，用户名/外部绑定都以它为准。
	ui.Username = resp.UID
	if resp.Name != "" {
		ui.DisplayName = resp.Name
	}
	if resp.Email != "" {
		ui.Email = resp.Email
	}
	ui.ExternalID = "rbac:" + resp.UID
	ui.ExternalSource = "rbac"
	ui.Source = "external"
	if cfg.syncGroups {
		// 与 LDAP/OIDC 组同步同口径：RBAC 返回空数组 = 该用户不属于任何部门，
		// 要回收 ZeoKeel 组（GroupsPresent=true 才会触发 SyncUserGroups）。
		ui.Groups = resp.Departments
		ui.GroupsPresent = true
	}
	return ui, nil
}

func identityUnavailable() *identityError {
	return &identityError{
		status: http.StatusBadGateway, code: "IDENTITY_PROVIDER_UNAVAILABLE",
		message: "身份服务暂不可用，请稍后重试",
		reason:  identityReasonUnavailable,
	}
}

// identityResolveHTTPError 保留非 200 的状态码，供 enrich 做 404/409 的分流。
type identityResolveHTTPError struct {
	status int
	code   string
}

func (e *identityResolveHTTPError) Error() string {
	if e.code != "" {
		return fmt.Sprintf("identity resolve: HTTP %d (%s)", e.status, e.code)
	}
	return fmt.Sprintf("identity resolve: HTTP %d", e.status)
}

// identityResolveRequest 是发给 RBAC 的 JSON 体。未知字段按契约忽略，
// 四个字段始终显式给出（空串由 RBAC 自行忽略）。
type identityResolveRequest struct {
	Provider       string `json:"provider"`
	ProviderUserID string `json:"provider_user_id"`
	UnionID        string `json:"union_id"`
	Mobile         string `json:"mobile"`
}

// callIdentityResolve 发起一次只读解析。返回 200 时已做严格校验；
// 非 200 返回 *identityResolveHTTPError（调用方按状态码分流）。
func callIdentityResolve(
	ctx context.Context, cfg externalIdentitySettings,
	provider, providerUserID, unionID, mobile string,
) (identityResolveResponse, error) {
	var out identityResolveResponse
	body, err := json.Marshal(identityResolveRequest{
		Provider: provider, ProviderUserID: providerUserID, UnionID: unionID, Mobile: mobile,
	})
	if err != nil {
		return out, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.endpoint, strings.NewReader(string(body)))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.token)

	client := &http.Client{
		Timeout:   cfg.timeout,
		Transport: identityOutboundTransport,
		// 只允许契约里那一个端点：3xx 不跟随（跟随会把请求/凭据带去别的主机）。
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		// *url.Error 会带完整 URL（不含 token —— token 在 Header），但底层错误可能
		// 含内网主机名；调用方只把它映射成「不可用」，不会落日志，因此这里直接返回。
		return out, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, identityMaxResponseBytes+1))
	if err != nil {
		return out, err
	}
	if len(raw) > identityMaxResponseBytes {
		return out, errors.New("identity resolve: 响应体超过上限")
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		return out, &identityResolveHTTPError{status: resp.StatusCode, code: e.Error}
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("identity resolve: 响应 JSON 非法: %w", err)
	}
	if err := validateIdentityResolveResponse(&out); err != nil {
		return out, err
	}
	return out, nil
}

// validateIdentityResolveResponse 对 RBAC 返回做严格校验。
//
// 为什么不能只判 uid 非空：uid 会被直接写进 users.username（长度上限
// serverstore.MaxUsernameBytes），部门名会被写进 groups；任何一个控制字符/超长值
// 都会在后续写库处变成 500 或一条脏数据。这里提前拒绝，按「服务不可用」处理。
func validateIdentityResolveResponse(resp *identityResolveResponse) error {
	resp.UID = strings.TrimSpace(resp.UID)
	if resp.UID == "" {
		return errors.New("identity resolve: uid 为空")
	}
	if len(resp.UID) > identityMaxUIDBytes {
		return errors.New("identity resolve: uid 超长")
	}
	if hasControlRune(resp.UID) {
		return errors.New("identity resolve: uid 含控制字符")
	}
	if resp.Status != 0 && resp.Status != 1 {
		return fmt.Errorf("identity resolve: status 非法 %d", resp.Status)
	}
	resp.Name = strings.TrimSpace(resp.Name)
	resp.Email = strings.TrimSpace(resp.Email)
	resp.Mobile = strings.TrimSpace(resp.Mobile)

	out := make([]string, 0, len(resp.Departments))
	seen := make(map[string]bool, len(resp.Departments))
	for _, d := range resp.Departments {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if len(d) > identityMaxDepartmentBytes {
			return errors.New("identity resolve: 部门名超长")
		}
		if hasControlRune(d) {
			return errors.New("identity resolve: 部门名含控制字符")
		}
		if seen[d] {
			continue
		}
		seen[d] = true
		out = append(out, d)
		if len(out) > identityMaxDepartments {
			return errors.New("identity resolve: 部门过多")
		}
	}
	resp.Departments = out
	return nil
}

func hasControlRune(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) || r == utf8.RuneError {
			return true
		}
	}
	return false
}

// identityEndpointURLValid 是管理端保存时的 URL 校验（与 provider 构建共用）。
// 单独放这里是为了让 admin.go 不直接依赖 authRedirectURLAllowed 的注释语义。
func identityEndpointURLValid(raw string) bool {
	return authRedirectURLAllowed(raw)
}

// countRBACUsers 返回以 RBAC 身份建档的用户数（关闭保护用）。
func countRBACUsers(db *sql.DB) (int, error) {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users WHERE external_source = 'rbac'`).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// normalizeIdentityMethods 校验并归一化 identity.external.methods。
//
// 空串 = 使用默认值（wecom,dingtalk）；显式传入时必须至少有一个合法值。
// 返回值：规范化 CSV、集合、错误。
func normalizeIdentityMethods(raw string) (string, map[string]bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = identityDefaultMethods
	}
	out := make([]string, 0, 2)
	seen := map[string]bool{}
	for _, m := range strings.Split(raw, ",") {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if m != "wecom" && m != "dingtalk" {
			return "", nil, fmt.Errorf("identity.external.methods 只能包含 wecom|dingtalk（收到 %q）", m)
		}
		if seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	if len(out) == 0 {
		return "", nil, errors.New("identity.external.methods 不能为空")
	}
	return strings.Join(out, ","), seen, nil
}

// identityMethodsDisplay 是 GET 的展示值：未配置时显示默认值，不把空串丢给前端。
func identityMethodsDisplay(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return identityDefaultMethods
	}
	return strings.TrimSpace(raw)
}

// identityTimeoutMSValue 解析 timeout_ms；缺失/非法回默认 3000（GET 展示用）。
func identityTimeoutMSValue(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return int(identityDefaultTimeout / time.Millisecond)
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms < identityMinTimeoutMS || ms > identityMaxTimeoutMS {
		return int(identityDefaultTimeout / time.Millisecond)
	}
	return ms
}

// identitySyncGroupsValue 解析 sync_groups；缺省 true（RBAC 是权威源）。
func identitySyncGroupsValue(raw string) bool { return strings.TrimSpace(raw) != "false" }
