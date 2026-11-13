// 连接器静默授权断言（2026-11）。
//
// 背景：连接器（MCP server）的授权原本只能靠用户扫码/跳转 OAuth。企业部署里员工
// 已经用 RBAC 身份登录了桌面客户端，再扫一次码是纯摩擦。这里让客户端用**登录会话**
// 换一份由服务端签发的短时签名断言（HS256 JWT），再拿断言去 RBAC 令牌端点做
// RFC 8693 token exchange 换 MCP token——员工的 RBAC 身份（sub）不变，只是换了个
// 授权路径。
//
// 安全边界（实现按"默认拒绝 + 逐层显式放行"组织，顺序即判据）：
//
//  1. 部署开关（connector.auto_auth.enabled）关闭 ⇒ 端点不存在（404）；
//  2. 连接器必须存在且 enabled；
//  3. 连接器 id 必须在白名单（connector.auto_auth.connectors）内 —— 开关是全局的，
//     白名单才是"这个 MCP 服务信任本服务端签名"的逐连接器同意；
//  4. 当前登录用户必须是 **RBAC 员工身份**（ExternalSource=rbac 且 ExternalID
//     带 `rbac:` 前缀）—— 断言里的 sub 就是去前缀后的 RBAC uid，换 token 的是
//     "同一个人"，不是任意本地账号；
//  5. 连接器定义必须自述令牌端点/授权范围/MCP 端点（否则 RBAC 侧无法校验
//     audience/resource，501 而不是猜）；
//  6. 签发密钥（ZEOKEEL_CONNECTOR_ASSERTION_SECRET）、签发者（issuer）与
//     client_id 三者缺一不可（缺 ⇒ 503：服务端配置不完整，拒绝签发而不是发一份
//     验不过/无法交换的断言）。issuer 解析顺序：控制台键 connector.assertion.issuer
//     → 对外地址（ZEOKEEL_PUBLIC_BASE_URL env，其次 settings server.base_url；
//     规范化/安全判定复用 clientrelease 的唯一实现）。
//
// **JWT header 是跨服务契约（P0，2026-11 真实探针）**：RBAC 在验签**之前**从 header
// 读 `ver`，缺失或非 "v1" 时直接 400 invalid_grant（"ver 必须是 v1"）——把 ver 只放在
// claims 里整条静默授权就不可用。header 固定为
// `{"alg":"HS256","typ":"JWT","ver":"v1"}`（见 assertionHeaderJSON，测试以 fixture
// 逐字钉住）；claims 里的 ver 是冗余镜像，不参与兼容性判断。
//
// 不记录/不回显断言与密钥：本文件里所有错误响应都是固定文案，断言只出现在成功
// 响应体（且响应对客户端声明 Cache-Control: no-store）；配置缺项的告警日志只点名
// 连接器 id 与缺项，**不含任何取值**。

package connectors

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/clientrelease"
	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// assertionSecretEnv 是 HS256 签名密钥（**秘密**，只在 env 里给：进库等于把秘密
// 复制进它保护的库，见 deployconfig 的「不可入库清单」）。
const assertionSecretEnv = "ZEOKEEL_CONNECTOR_ASSERTION_SECRET"

// assertionHeaderJSON 是断言 JWT 的 header —— **跨服务契约**（不是一个实现细节）：
//
//   - RBAC 在**验签之前**解析 header 并强制 `alg == "HS256"`、`ver == "v1"`；
//   - 缺 ver（把版本只放 claims）会被直接拒绝：真实探针（RBAC 9210d04）对该形态回
//     400 `invalid_grant` / `"ver 必须是 v1"`，整条静默授权不可用（P0）；
//   - 因此这里必须是唯一的 header 真源，测试用 fixture 逐字对拍，改一个字节 = 换契约。
const assertionHeaderJSON = `{"alg":"HS256","typ":"JWT","ver":"v1"}`

// AutoAuthModeRBACAssertion 是 bootstrap 下发给客户端的 auto_auth 取值（跨语言契约，
// 客户端 ConnectorDef.autoAuth 逐字比对；改名 = 换契约）。
const AutoAuthModeRBACAssertion = "rbac-assertion"

// assertionVersion 是断言载荷里的版本镜像（v1）。**契约位在 header**（见
// assertionHeaderJSON）；claims 这份保留是为了向后兼容与诊断，RBAC 不据它判定。
const assertionVersion = "v1"

// assertionGapLogInterval 是"配置缺项"告警的限频窗口。
//
// 501/503 都是**部署配置问题**：每个请求都打会把日志淹掉（客户端还会反复重试），
// 但完全不打会让现场只剩"客户端说静默授权不可用"、没有任何服务端线索。每个
// (连接器, 缺项) 每分钟最多一条即可回答"是哪台连接器缺什么"。
const assertionGapLogInterval = time.Minute

var (
	assertionGapLogMu   sync.Mutex
	assertionGapLogLast = map[string]time.Time{}
	// assertionGapLogf 是日志出口（测试可替换；默认标准日志）。
	assertionGapLogf = log.Printf
)

// logAssertionGap 限频记录一次"断言签发被配置缺项挡住"。
//
// 只点名连接器 id 与缺项名：**不打印任何配置取值/密钥/断言**（与错误响应同一条纪律）。
func logAssertionGap(connectorID, missing string) {
	key := connectorID + "|" + missing
	now := time.Now()
	assertionGapLogMu.Lock()
	if last, ok := assertionGapLogLast[key]; ok && now.Sub(last) < assertionGapLogInterval {
		assertionGapLogMu.Unlock()
		return
	}
	assertionGapLogLast[key] = now
	assertionGapLogMu.Unlock()
	assertionGapLogf("connectors: 断言签发不可用 connector=%s 缺项=%s（检查部署配置 connector.* / 环境变量；该告警每项每分钟最多一条）",
		connectorID, missing)
}

// connectorAutoAuthAllowed 报告该连接器是否在静默授权白名单内（开关关闭时恒 false）。
//
// 注意：bootstrap 侧（internal/bootstrap）会**独立**解析同一组键来下发 auto_auth ——
// 那里不能 import 本包（connectors 是 build-tag 可选模块，bootstrap 是基础面）。
// 两处语义必须一致：开关关 ⇒ 两边都不生效；白名单命中才下发/才签发。
func connectorAutoAuthAllowed(db *sql.DB, id string) bool {
	if !deployconfig.Bool(db, keyAutoAuthEnabled) {
		return false
	}
	for _, allowed := range deployconfig.CSV(db, keyAutoAuthConnectors) {
		if allowed == id {
			return true
		}
	}
	return false
}

// 部署配置键（编译期绑定注册表；写错键名的开发期错误在这里当场 panic）。
//
// 只绑定断言端点**自己**读的键：连接器的 bootstrap 下发面（internal/bootstrap）会
// 另外解析 auto_auth.auto_connect —— 那是客户端"登录后自动连接"的开关，不是签发
// 端点的判定输入。
var (
	keyAutoAuthEnabled    = deployconfig.MustKey("connector.auto_auth.enabled")
	keyAutoAuthConnectors = deployconfig.MustKey("connector.auto_auth.connectors")
	keyAssertionIssuer    = deployconfig.MustKey("connector.assertion.issuer")
	keyAssertionTTL       = deployconfig.MustKey("connector.assertion.ttl")
	keyAssertionClientID  = deployconfig.MustKey("connector.assertion.client_id")
)

// assertionClaims 是断言 JWT 的载荷。字段顺序即序列化顺序（便于人工比对）。
//
//	iss       签发者（部署对外地址/控制台配置）
//	aud       令牌端点 —— RBAC 只接受发给自己的断言
//	sub       RBAC 员工 uid（ExternalID 去掉 `rbac:` 前缀）
//	scope     授权范围（来自连接器定义的 auth.scopes）
//	resource  目标 MCP 端点（来自 mcp[0].url，防断言被换到别的资源）
//	client_id 令牌交换客户端（= 响应里的同一值；RBAC **强制**它与请求的
//	          client_id 相等 —— 否则公共客户端白名单下，拿到断言的一方可以把
//	          断言拿去给另一个 client 换 token（跨客户端冒用）。这是服务端
//	          签进**不可篡改载荷**里的绑定，不能只依赖请求参数）
//	ver       版本镜像：**契约位在 header**（assertionHeaderJSON），RBAC 从 header 读；
//	          这里保留一份只为向后兼容/诊断，验签方不得据它判断兼容性
type assertionClaims struct {
	Issuer      string `json:"iss"`
	Audience    string `json:"aud"`
	Subject     string `json:"sub"`
	Scope       string `json:"scope"`
	Resource    string `json:"resource"`
	ConnectorID string `json:"connector_id"`
	ClientID    string `json:"client_id"`
	JTI         string `json:"jti"`
	IssuedAt    int64  `json:"iat"`
	ExpiresAt   int64  `json:"exp"`
	Version     string `json:"ver"`
}

// assertionEndpoints 是连接器定义里签发断言所需的三段自述信息。
type assertionEndpoints struct {
	TokenURL string
	Scopes   string
	Resource string
}

// parseAssertionEndpoints 从连接器定义 JSON 中取出 tokenUrl/scopes/mcp[0].url。
// 任一缺失/为空/JSON 非法 ⇒ false（调用方回 501：连接器没声明清楚，不猜）。
func parseAssertionEndpoints(definition string) (assertionEndpoints, bool) {
	var def struct {
		Auth struct {
			TokenURL string `json:"tokenUrl"`
			Scopes   string `json:"scopes"`
		} `json:"auth"`
		MCP []struct {
			URL string `json:"url"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal([]byte(definition), &def); err != nil {
		return assertionEndpoints{}, false
	}
	out := assertionEndpoints{
		TokenURL: strings.TrimSpace(def.Auth.TokenURL),
		Scopes:   strings.TrimSpace(def.Auth.Scopes),
	}
	if len(def.MCP) > 0 {
		out.Resource = strings.TrimSpace(def.MCP[0].URL)
	}
	if out.TokenURL == "" || out.Scopes == "" || out.Resource == "" {
		return assertionEndpoints{}, false
	}
	return out, true
}

// signAssertion 用 HS256 手工签一份 JWT（不引第三方 JWT 库：本仓只签/验这一种形态，
// 手写 20 行比多一个依赖更可控）。返回 header.payload.signature（base64url 无填充）。
//
// header 固定取 assertionHeaderJSON（含 ver=v1）：RBAC 在验签前就校验它，缺 ver 的
// 形态会被 400 invalid_grant 拒绝 —— 这不是可选项，是跨服务契约。
func signAssertion(secret string, claims assertionClaims) (string, error) {
	header := base64.RawURLEncoding.EncodeToString([]byte(assertionHeaderJSON))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	if _, err := mac.Write([]byte(signingInput)); err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// newAssertionID 生成 jti（随机 16 字节 hex）。一次一签，重放由 exp + RBAC 侧
// jti 去重共同兜底。
func newAssertionID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// normalizeIssuer 去掉首尾空白与尾部斜杠（iss 是**精确字符串**契约，带不带尾斜杠
// 必须由服务端统一，不能随控制台输入漂移）。
func normalizeIssuer(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

// issueAssertion 构造 POST /api/client/v2/connectors/:id/assertion 的 handler。
//
// 校验顺序见文件头注释：开关 → 连接器存在/启用 → 白名单 → RBAC 身份 →
// 定义自述 → 密钥/签发者/client_id。**先便宜后昂贵、先通用后具体**：前四步不需要
// 读秘密与签名。
func issueAssertion(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1) 部署开关。关闭态返回 404（客户端把它当作"服务端没有这个能力"并回落
		//    交互式授权；不暴露"有端点只是没开"的配置面）。
		if !deployconfig.Bool(db, keyAutoAuthEnabled) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器静默授权未启用")
			return
		}

		// 2) 连接器必须存在且启用。停用的连接器按"不存在"处理（停用是运维的紧急
		//    刹车，不能靠"客户端记得检查 enabled"来维持）。
		id := c.Param("id")
		conn, err := serverstore.GetConnector(db, id)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !conn.Enabled {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
			return
		}

		// 3) 逐连接器白名单。
		if !connectorAutoAuthAllowed(db, id) {
			serverauth.WriteError(c, http.StatusForbidden, "FORBIDDEN", "该连接器不允许静默授权")
			return
		}

		// 4) 只有 RBAC 员工身份可换（断言 sub 是 RBAC uid）。本地账号/其它 IdP 用户
		//    即使登录了也没有可交换的 RBAC 主体 ⇒ 409（客户端静默回落）。
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		rbacUID := strings.TrimPrefix(u.ExternalID, "rbac:")
		if u.ExternalSource != "rbac" || rbacUID == "" || rbacUID == u.ExternalID {
			serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "当前登录身份不是 RBAC 员工身份")
			return
		}

		// 5) 连接器定义必须自述令牌端点/授权范围/MCP 端点 —— RBAC 侧据此校验
		//    audience/resource；缺字段时签发一份无法交换的断言只会变成误导。
		endpoints, ok := parseAssertionEndpoints(conn.Definition)
		if !ok {
			logAssertionGap(id, "连接器定义 auth.tokenUrl/auth.scopes/mcp[0].url")
			serverauth.WriteError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED",
				"连接器未声明断言授权参数（auth.tokenUrl / auth.scopes / mcp[0].url）")
			return
		}

		// 6) 签发材料：密钥（秘密，只从 env 来）→ issuer（控制台键 → 对外地址）→
		//    client_id（RBAC 侧登记的交换客户端）。缺任何一项都拒绝签发。
		secret := strings.TrimSpace(os.Getenv(assertionSecretEnv))
		if secret == "" {
			logAssertionGap(id, "签名密钥（环境变量，不打印取值）")
			serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "连接器断言签发未配置")
			return
		}
		// issuer 顺序：控制台键 connector.assertion.issuer → 对外地址（env
		// ZEOKEEL_PUBLIC_BASE_URL，其次 settings server.base_url）。对外地址的读取与
		// 规范化只走 clientrelease.PublicBaseURL（唯一实现：拒绝 query/fragment/
		// userinfo，https 或回环 http）—— 本包不新增裸 env 读非秘密项的口径。
		issuer := normalizeIssuer(deployconfig.String(db, keyAssertionIssuer))
		if issuer == "" {
			issuer = normalizeIssuer(clientrelease.PublicBaseURL())
		}
		if issuer == "" {
			logAssertionGap(id, "issuer（connector.assertion.issuer 与对外地址均未配置/非法）")
			serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "连接器断言签发未配置")
			return
		}
		clientID := strings.TrimSpace(deployconfig.String(db, keyAssertionClientID))
		if clientID == "" {
			logAssertionGap(id, "client_id（connector.assertion.client_id）")
			serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "连接器断言签发未配置")
			return
		}

		// TTL 由注册表校验（10s~300s，非法值在读取路径回落到默认 60s）。
		ttl := deployconfig.Duration(db, keyAssertionTTL)
		jti, err := newAssertionID()
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "断言签发失败")
			return
		}
		now := time.Now()
		assertion, err := signAssertion(secret, assertionClaims{
			Issuer:      issuer,
			Audience:    endpoints.TokenURL,
			Subject:     rbacUID,
			Scope:       endpoints.Scopes,
			Resource:    endpoints.Resource,
			ConnectorID: id,
			ClientID:    clientID,
			JTI:         jti,
			IssuedAt:    now.Unix(),
			ExpiresAt:   now.Add(ttl).Unix(),
			Version:     assertionVersion,
		})
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "断言签发失败")
			return
		}

		// 断言是短时凭证：禁止任何中间层/客户端缓存（客户端也按不缓存处理）。
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{
			"assertion":      assertion,
			"token_endpoint": endpoints.TokenURL,
			"client_id":      clientID,
			"scope":          endpoints.Scopes,
			"resource":       endpoints.Resource,
			"issuer":         issuer,
			"expires_in":     int64(ttl / time.Second),
		})
	}
}
