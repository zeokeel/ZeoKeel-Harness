//go:build !connectors

package router

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestClosedConnectorsRegistrationIsNoOp：connectors **关闭**时，连接器的两个
// 注册函数（管理面 + 员工面断言）实跑之后一条路由都不许新增
// （P1 第三片，2026-10-14 独立审计 P1-3；员工面断言 2026-11 补入）。
//
// 与 `optional_skills_off_registration_test.go` 同一口径：命名空间前缀表判不了
// "关闭态在**新**命名空间下注册路由"，位置级判据可以 —— 真调用一次，断言树上零新增。
// 员工面断言落在 `/api/client/v2/connectors`（一个**基础面命名空间**里的新前缀），
// 正是"只改 router.go 就会绕过前缀表"的那一类形态，所以两个注册函数都要实跑一次。
func TestClosedConnectorsRegistrationIsNoOp(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	registerConnectorAdminRoutes(engine.Group("/api/server/admin"), Deps{})
	registerConnectorClientRoutes(engine.Group("/api/client/v2"), Deps{})

	if added := engine.Routes(); len(added) != 0 {
		names := make([]string, 0, len(added))
		for _, route := range added {
			names = append(names, route.Method+" "+route.Path)
		}
		t.Errorf("connectors 关闭时连接器的注册函数新增了 %d 条路由（必须 0 条）：%v\n"+
			"  关闭态语义 = 整片命名空间从产物里消失（编译期 no-op），"+
			"见 docs/decisions/2026-10-14-server-build-tags.md。", len(added), names)
	}
}
