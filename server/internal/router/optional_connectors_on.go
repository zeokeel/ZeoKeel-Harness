//go:build connectors

package router

// 本文件是 `connectors` 模块**打开**时的类型与路由接线（P1 第二片，2026-10-14）。

import (
	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/connectors"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
)

// ConnectorsAPI 是连接器管理面的 handler 集合（`connectors` 打开时就是
// `connectors.Handlers` 本身：别名，调用点零改写）。
type ConnectorsAPI = connectors.Handlers

// registerConnectorClientRoutes 注册 `/api/client/v2` 下连接器员工面
// （静默授权断言：客户端拿登录会话换 RBAC MCP token，见 internal/connectors/assertion.go）。
//
// 身份口径 = 员工 Bearer（与 bootstrap 同一批登录会话）；逐连接器放行/部署开关在
// handler 内判定（部署配置是热更新键，不能在装配期快照成路由表）。
//
// 提前 return 的理由与 registerConnectorAdminRoutes 同：nil handler 交给 gin 会照常
// 注册并在请求期 panic→500。
func registerConnectorClientRoutes(cli *gin.RouterGroup, d Deps) {
	if d.Connector == nil || d.Connector.IssueAssertion == nil {
		return
	}
	cli.POST("/connectors/:id/assertion", serverauth.BearerAuth(d.DB), d.Connector.IssueAssertion)
}

// registerConnectorAdminRoutes 注册 `/api/server/admin/connectors*`。
//
// 提前 return（而不是把 nil 交给 gin）：字段为 nil 时整片不注册 —— gin 的
// `addRoute` 只断言 `len(handlers) > 0`，nil handler 会照常注册并在请求期 panic→500。
func registerConnectorAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Connector == nil {
		return
	}
	// 连接器管理
	serverauth.AdminRoute(authed, "GET", "/connectors", serverauth.PermConnectorRead, d.Connector.List)
	serverauth.AdminRoute(authed, "GET", "/connectors/:id", serverauth.PermConnectorRead, d.Connector.Get)
	serverauth.AdminRoute(authed, "POST", "/connectors", serverauth.PermConnectorWrite, d.Connector.Create)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Update)
	serverauth.AdminRoute(authed, "DELETE", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Remove)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id/enabled", serverauth.PermConnectorWrite, d.Connector.SetEnabled)
}
