//go:build connectors

package router

import (
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/connectors"
)

// TestOpenConnectorsRegistrationRegistersAssertionRoute：connectors **打开**时，
// 员工面断言路由必须真的注册出来，且形状/方法逐字正确。
//
// 与 off 文件的 `TestClosedConnectorsRegistrationIsNoOp` 是同一承诺的两面：
// 关闭态零新增、打开态恰好这一条 —— 只判一面时，"注册函数改名后不再被调用"
// 或"handler 字段漏接"都会静默通过（路由表与关闭态长得一样）。
func TestOpenConnectorsRegistrationRegistersAssertionRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	registerConnectorClientRoutes(engine.Group("/api/client/v2"), Deps{Connector: connectors.NewHandlers(nil)})

	routes := engine.Routes()
	if len(routes) != 1 {
		names := make([]string, 0, len(routes))
		for _, route := range routes {
			names = append(names, route.Method+" "+route.Path)
		}
		t.Fatalf("connectors 打开时员工面断言注册函数应注册恰好 1 条路由，实得 %d 条：%v", len(routes), names)
	}
	const want = "POST /api/client/v2/connectors/:id/assertion"
	if got := routes[0].Method + " " + routes[0].Path; got != want {
		t.Fatalf("员工面断言路由 = %q，期望 %q", got, want)
	}
}

// TestOpenConnectorsRegistrationSkipsNilHandlers：handler 缺失时**整条不注册**。
//
// gin 的 addRoute 只断言 len(handlers) > 0，nil handler 会照常注册并在请求期
// panic→Recovery→500 —— 既不是约定的 404，也躲开"路由消失声明表"的视线。
func TestOpenConnectorsRegistrationSkipsNilHandlers(t *testing.T) {
	gin.SetMode(gin.TestMode)

	for name, deps := range map[string]Deps{
		"Connector 为 nil":      {},
		"IssueAssertion 为 nil": {Connector: &connectors.Handlers{}},
	} {
		engine := gin.New()
		registerConnectorClientRoutes(engine.Group("/api/client/v2"), deps)
		if routes := engine.Routes(); len(routes) != 0 {
			t.Fatalf("%s 时员工面断言不应注册任何路由，实得 %d 条", name, len(routes))
		}
	}
}
