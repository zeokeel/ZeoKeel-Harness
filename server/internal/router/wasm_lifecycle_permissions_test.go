//go:build apps

package router

// 管理面生命周期路由的**权限级别**判据（2026-10-22 反证 P2-7）。
//
// 现场：`TestAdminLifecycleSurface` 只断言了"无会话 ⇒ 401"与"路由是否申报"
// （`AdminRoutePerms` 完整性用例证明每条 admin 路由都有权限点），但没有一条判据约束
// **级别**。把 `DELETE /:app_id` 的 `PermCapabilityWrite` 改成 `Read` 预计零红 ——
// 于是没有写权限的管理员也能删除应用（或反过来读端点被收紧成写）。
//
// 本用例逐条钉死本组路由的级别（只读 = capability:read；改状态 = capability:write），
// 与设计 §6.2 的权限列逐条对应。
//
// 变异验证：把任一条的 read/write 互换 ⇒ 对应用例红；把路由从 AdminRoute 改成裸
// `g.Handle`（绕过权限申报）⇒ 该条在注册表里查不到 ⇒ 红。

import (
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
)

// TestWasmLifecycleRoutePermissionLevels 断言管理面生命周期端点的权限级别。
//
// 先 `buildTestRouter` 触发真实注册（AdminRoute 在注册时写登记表），再从
// `serverauth.AdminRoutePerms()` 读回实际级别 —— 判的是**注册事实**，不是源码字符串。
func TestWasmLifecycleRoutePermissionLevels(t *testing.T) {
	_ = buildTestRouter(t) // 触发 registerWasm 的 AdminRoute 注册

	const base = NamespaceServer + "/admin/wasm-apps"
	want := map[string]string{
		// 只读：看队列 / 看历史 / 导快照
		"GET " + base + "/releases/pending":    serverauth.PermCapabilityRead,
		"GET " + base + "/:app_id/deployments": serverauth.PermCapabilityRead,
		"GET " + base + "/:app_id/export":      serverauth.PermCapabilityRead,
		"GET " + base + "/:app_id/diagnostics": serverauth.PermCapabilityRead,
		"GET " + base + "/:app_id/releases":    serverauth.PermCapabilityRead,
		// 改状态：部署/回滚、恢复、删除（最危险的那一条）
		"POST " + base + "/:app_id/deployments": serverauth.PermCapabilityWrite,
		"POST " + base + "/:app_id/restore":     serverauth.PermCapabilityWrite,
		"DELETE " + base + "/:app_id":           serverauth.PermCapabilityWrite,
		"POST " + base + "/:app_id/unpublish":   serverauth.PermCapabilityWrite,
		"POST " + base + "/:app_id/freeze":      serverauth.PermCapabilityWrite,
		// 应用级限流覆盖（2026-10-22 per-app limits）：读视图 / 改覆盖 / 清空覆盖。
		// 反证 F-2 指出这三条此前只被"perm 非空"整体覆盖，read↔write 互换零红。
		"GET " + base + "/limit-overrides":   serverauth.PermCapabilityRead,
		"GET " + base + "/:app_id/limits":    serverauth.PermCapabilityRead,
		"PUT " + base + "/:app_id/limits":    serverauth.PermCapabilityWrite,
		"DELETE " + base + "/:app_id/limits": serverauth.PermCapabilityWrite,
	}
	got := map[string]string{}
	for _, r := range serverauth.AdminRoutePerms() {
		got[r.Method+" "+r.Path] = r.Perm
	}
	for key, wantPerm := range want {
		perm, ok := got[key]
		if !ok {
			t.Fatalf("路由 %s 不在 AdminRoute 登记表里（权限申报缺失 = fall-open 或整片路由消失）", key)
		}
		if perm != wantPerm {
			t.Fatalf("路由 %s 的权限 = %q, want %q（设计 §6.2 的 read/write 列）", key, perm, wantPerm)
		}
	}
	// 反向：这组路由不允许出现"空权限"（空 = 登录即可，会把写动作暴露给任意管理员会话）。
	for _, r := range serverauth.AdminRoutePerms() {
		if r.Path == base || len(r.Path) < len(base) || r.Path[:len(base)] != base {
			continue
		}
		if r.Perm == "" {
			t.Fatalf("路由 %s %s 没有权限点（perm 为空 = 仅登录即可，写动作会越权）", r.Method, r.Path)
		}
	}
}
