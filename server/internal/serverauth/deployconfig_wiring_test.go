package serverauth

// 部署配置接线判据(2026-10-23:配置入库、控制台可改)。
//
// 这三个键此前各自 os.Getenv:运维只能改 .env + 重建容器,控制台既看不到也改不了。
// 改为 deployconfig 解析(显式环境变量 > 控制台 settings > 内置默认)后,必须证明:
//  1. 控制台保存的值真的生效(否则"保存成功、行为不变"是静默缺陷);
//  2. 历史环境变量仍压过控制台(存量 .env 的升级安全,也是启动闸门的逃生口);
//  3. 默认值/语义与历史逐字节一致(不配置 = 老行为)。

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/deployconfig"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// oidcLoginStatus 发一次 OIDC 登录流程启动,返回状态码(Host 故意写成内部地址:
// 来源判定只认服务端配置,不认 Host —— 见 returnServerIsTrusted 的注释)。
func oidcLoginStatus(t *testing.T, r http.Handler, server string) int {
	t.Helper()
	req := httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(server), nil)
	req.Host = "10.0.0.7:8080"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

// TestLoginMaxAttemptsFromDeployConfig:登录失败上限来自控制台设置,env 仍可覆盖。
func TestLoginMaxAttemptsFromDeployConfig(t *testing.T) {
	key := deployconfig.MustKey("auth.login_max_attempts")
	t.Setenv(key.Env, "")
	db := mustDB(t) // 内部会清空进程级失败预算桶
	if err := serverstore.SetSetting(db, key.Setting, "2"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	lim := sharedLoginLimiter(db)
	// 控制台:2 次失败预算。
	if !lim.allow("probe-a") || !lim.allow("probe-a") {
		t.Fatal("控制台把上限调到 2 后,前 2 次尝试应放行")
	}
	if lim.allow("probe-a") {
		t.Fatal("第 3 次尝试仍放行 —— 控制台保存的 auth.login_max_attempts 没有生效")
	}

	// 环境变量仍压过控制台(存量 .env 的升级安全;也是限流误伤时的逃生口)。
	t.Setenv(key.Env, "4")
	if !lim.allow("probe-b") || !lim.allow("probe-b") || !lim.allow("probe-b") || !lim.allow("probe-b") {
		t.Fatal("环境变量把上限调到 4 后,前 4 次尝试应放行")
	}
	if lim.allow("probe-b") {
		t.Fatal("环境变量覆盖未生效(第 5 次仍放行)")
	}
}

// TestLDAPPlaintextAllowanceFromDeployConfig:明文 LDAP 放行开关来自控制台设置。
func TestLDAPPlaintextAllowanceFromDeployConfig(t *testing.T) {
	key := deployconfig.MustKey("auth.ldap_allow_plaintext")
	t.Setenv(key.Env, "")
	db := mustDB(t)

	err := validateLDAPServerURL(db, "ldap://dir.example.com:389")
	if err == nil {
		t.Fatal("默认必须拒绝非回环明文 ldap://(bind 密码会明文过网)")
	}
	// 文案必须指向控制台,而不是教人设环境变量(旋钮已入库,新部署不写 .env)。
	if !strings.Contains(err.Error(), "系统配置") {
		t.Fatalf("错误文案应指向控制台「系统配置」,得到 %q", err.Error())
	}

	if err := serverstore.SetSetting(db, key.Setting, "true"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	if err := validateLDAPServerURL(db, "ldap://dir.example.com:389"); err != nil {
		t.Fatalf("控制台开启「允许明文 LDAP」后应放行: %v", err)
	}

	// 环境变量仍压过控制台:设置改回 false 后 env=1 仍放行。
	if err := serverstore.SetSetting(db, key.Setting, "false"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	t.Setenv(key.Env, "1")
	if err := validateLDAPServerURL(db, "ldap://dir.example.com:389"); err != nil {
		t.Fatalf("环境变量覆盖未生效(应压过控制台 false): %v", err)
	}
}

// TestOIDCTrustedHostsFromDeployConfig:OIDC 深链回跳的来源补充清单来自控制台设置。
//
// 判据必须走**真实登录入口**(而不是直接调用判定函数):清单生效 = `?server=`
// 能命中控制台里那条主机;env 覆盖 = 控制台那条随即失效。否则"配置读到了、
// 但判定没接上"这类半接线缺陷不会有红灯。
func TestOIDCTrustedHostsFromDeployConfig(t *testing.T) {
	key := deployconfig.MustKey("deploy.trusted_hosts")
	t.Setenv(key.Env, "")
	db := mustDB(t)
	if err := serverstore.SetSetting(db, key.Setting, "console.example.com"); err != nil {
		t.Fatalf("写设置: %v", err)
	}
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	login := func(server string) int {
		return oidcLoginStatus(t, r, server)
	}
	if code := login("https://console.example.com"); code != 302 {
		t.Fatalf("控制台清单里的主机 = %d, want 302(清单没生效)", code)
	}
	if code := login("https://other.example.com"); code != 400 {
		t.Fatalf("清单外主机 = %d, want 400(不得放行任意域名)", code)
	}

	// 环境变量仍压过控制台:清单换成 env 里那条,控制台那条立即不再可信。
	t.Setenv(key.Env, "envonly.example.com")
	if code := login("https://envonly.example.com"); code != 302 {
		t.Fatalf("环境变量清单里的主机 = %d, want 302", code)
	}
	if code := login("https://console.example.com"); code != 400 {
		t.Fatalf("env 覆盖后控制台清单不应再被信任: %d, want 400", code)
	}
}
