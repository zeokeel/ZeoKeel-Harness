//go:build !connectors

package router

// 本文件是 `connectors` 模块**关闭**时的接线（P1 第二片，2026-10-14）：
// 类型是空类型、注册函数是编译期 no-op，连接器路由（管理面 + 员工面断言）整片从
// 产物里消失。

import "github.com/gin-gonic/gin"

// ConnectorsAPI 在 connectors 关闭时是空类型（见 optional_apps_off.go 的说明）。
type ConnectorsAPI struct{}

// registerConnectorClientRoutes 在 connectors 关闭时是编译期 no-op。
func registerConnectorClientRoutes(_ *gin.RouterGroup, _ Deps) {}

// registerConnectorAdminRoutes 在 connectors 关闭时是编译期 no-op。
func registerConnectorAdminRoutes(_ *gin.RouterGroup, _ Deps) {}
