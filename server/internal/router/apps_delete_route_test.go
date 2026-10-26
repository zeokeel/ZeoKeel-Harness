package router

// F-02 / F-05 的路由声明判据(能力中心审计 2026-10-26)。
//
// 这两条一起放在 router 包:路径与权限的**唯一真源**是 internal/router(server/AGENTS.md
// §7.0),业务包内镜像树只覆盖一部分。判据直接读运行时注册表
// (serverauth.AdminRoutePerms + gin.Routes),不读源码字符串 —— 改名/换权限点即红。

import (
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
)

// TestDeleteEmptyAppRouteRegistered:F-02 的空壳释放端点必须存在于**每个变体**
// (appstore 是共享底座,与归属转移同族),且权限点与归属转移一致(capability:write)。
func TestDeleteEmptyAppRouteRegistered(t *testing.T) {
	r := buildTestRouter(t)
	const key = "DELETE " + NamespaceServer + "/admin/apps/:kind/:app_id"
	present := false
	for _, rt := range r.Routes() {
		if rt.Method+" "+rt.Path == key {
			present = true
		}
	}
	if !present {
		t.Fatalf("生产路由表缺少 %s(F-02 的空壳释放端点)", key)
	}
	perm := ""
	for _, rr := range serverauth.AdminRoutePerms() {
		if rr.Method+" "+rr.Path == key {
			perm = rr.Perm
		}
	}
	if perm != serverauth.PermCapabilityWrite {
		t.Fatalf("%s 的权限点 = %q, want %q(与归属转移同族)", key, perm, serverauth.PermCapabilityWrite)
	}
}
