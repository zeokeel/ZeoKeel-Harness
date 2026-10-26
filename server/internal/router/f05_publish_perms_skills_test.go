//go:build skills

package router

// F-05(能力中心审计 2026-10-26):直发/规范化与审批必须同权。
//
// 管理员直发(`POST /skills|/agents/:name/archive`、`POST /skills/:name/
// normalize`)落库即 approved,与审批队列是同一条审核门;此前挂 market:write
// 形成「能直发、不能审批」的权限反转。现已统一为 capability:write。
// 判据：这三条与审批面必须同权；若未来拆分权限，改这里必须同步说明。

import (
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
)

func TestDirectPublishRoutePermissionsAreLocked(t *testing.T) {
	r := buildTestRouter(t)
	want := map[string]string{
		"POST " + NamespaceServer + "/admin/skills/:name/archive":          serverauth.PermCapabilityWrite,
		"POST " + NamespaceServer + "/admin/agents/:name/archive":          serverauth.PermCapabilityWrite,
		"POST " + NamespaceServer + "/admin/skills/:name/normalize":        serverauth.PermCapabilityWrite,
		"POST " + NamespaceServer + "/admin/skills/:name/:version/approve": serverauth.PermCapabilityWrite,
		"POST " + NamespaceServer + "/admin/agents/:name/:version/approve": serverauth.PermCapabilityWrite,
	}
	present := map[string]bool{}
	for _, rt := range r.Routes() {
		present[rt.Method+" "+rt.Path] = true
	}
	got := map[string]string{}
	for _, rr := range serverauth.AdminRoutePerms() {
		got[rr.Method+" "+rr.Path] = rr.Perm
	}
	for route, perm := range want {
		if !present[route] {
			t.Fatalf("生产路由表缺少 %s(判据失效:路径改名后必须同步本表)", route)
		}
		if got[route] != perm {
			t.Fatalf("%s 的权限点 = %q, want %q。\n"+
				"  F-05:直发(approved)与审批必须同权;当前两权限点恒同时授予 super_admin,"+
				"所以这条只是锁定现状 —— 若确实要调整,请同时更新本表并说明产品决定。",
				route, got[route], perm)
		}
	}
}
