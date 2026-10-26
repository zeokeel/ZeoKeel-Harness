//go:build skills && connectors

// 镜像树 ↔ 生产树的**权限点**逐条对拍（F-05 镜像漂移，2026-10-26 能力中心审计）。
//
// 缺陷现场：`marketplace.RegisterAdminRoutes` 里
// `POST /api/server/admin/agents/:name/archive` 挂的是 `market:write`，而生产
// （`internal/router/optional_skills_on.go`）已按 F-05 改成 `capability:write`
// （管理员直发 = 落库即 approved = 审批同权）。
//
// 为什么现有两条镜像判据没咬住它：
//   - `TestAdminRouteMirrorIsSubsetOfProduction` 只比 (method, path)；
//   - `TestAdminRouteMirrorsBindProductionHandlers` 比的是运行时 handler 名 ——
//     两侧绑的确实是**同一个函数**（`uploadAgentArchiveAdmin`），差异只在中间件链
//     里的 `RequirePermission`，两条判据都看不见。
//
// 后果不只是"测试镜像与生产不一致"：镜像树是能力中心/管理端**权限用例**的观测面
// （`capabilities_test.go` 也用它建树）。镜像挂错权限点时，用例证明的授权结论与
// 生产行为相反 —— 一个能直发但不该能直发的角色在测试里 403、在生产上 200。
//
// 判据：**对每一条两侧都注册的路由，(method, path) → perm 必须逐字相等**。
// 只比交集：镜像独有/生产独有的路由由上面那两条判据各自负责。
//
// 变异证明（判据自带）：本文件在修复前必须红（`TestAdminRouteMirrorPermissionParity`
// 的失败信息会点名 3 处），修复 `marketplace/admin.go` 的那一行后转绿。
package router

import (
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/agentshare"
	"github.com/zeokeel/zeokeel-harness/server/internal/capabilities"
	"github.com/zeokeel/zeokeel-harness/server/internal/connectors"
	"github.com/zeokeel/zeokeel-harness/server/internal/llmgateway"
	"github.com/zeokeel/zeokeel-harness/server/internal/marketplace"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/sharedskills"
)

// recordAdminRoutePerms 运行 fn，返回 fn 期间新登记的 (method+" "+path) → perm 集合。
//
// 为什么用"注册前后取差集"而不是直接调 AdminRoutePerms()：注册表是**全局追加**的
// （serverauth.AdminRoute 每次都 append），同一进程里先建生产树、再建镜像树会留下
// 两份条目。差集把"这一次注册调用产生的条目"精确切出来，避免两条树互相盖住对方。
func recordAdminRoutePerms(fn func()) map[string]map[string]bool {
	before := len(serverauth.AdminRoutePerms())
	fn()
	after := serverauth.AdminRoutePerms()
	out := map[string]map[string]bool{}
	for _, entry := range after[before:] {
		route := entry.Method + " " + entry.Path
		if out[route] == nil {
			out[route] = map[string]bool{}
		}
		out[route][entry.Perm] = true
	}
	return out
}

// TestAdminRouteMirrorPermissionParity 是 F-05 镜像漂移的回归判据。
func TestAdminRouteMirrorPermissionParity(t *testing.T) {
	gin.SetMode(gin.TestMode)

	prodPerms := recordAdminRoutePerms(func() {
		Register(gin.New(), productionTestDeps(t))
	})
	mirrorPerms := recordAdminRoutePerms(func() {
		mirror := gin.New()
		serverauth.RegisterAdminRoutes(mirror, nil)
		agentshare.RegisterAdminRoutes(mirror, nil, t.TempDir())
		connectors.RegisterAdminRoutes(mirror, nil)
		marketplace.RegisterAdminRoutes(mirror, nil, t.TempDir())
		capabilities.RegisterAdminRoutes(mirror, nil, t.TempDir())
		llmgateway.RegisterAdminRoutes(mirror, nil)
		sharedskills.RegisterAdminRoutes(mirror, nil, t.TempDir())
	})
	if len(prodPerms) == 0 || len(mirrorPerms) == 0 {
		t.Fatal("判据的扫描面为空（至少一条树没扫到管理面路由）—— 不得静默通过")
	}

	var compared int
	var mismatched []string
	for route, perms := range mirrorPerms {
		prodSet, ok := prodPerms[route]
		if !ok {
			continue // 镜像独有：由 TestAdminRouteMirrorIsSubsetOfProduction 负责
		}
		compared++
		if equalPermSets(perms, prodSet) {
			continue
		}
		mismatched = append(mismatched, "  "+route+
			"\n      生产: "+formatPermSet(prodSet)+
			"\n      镜像: "+formatPermSet(perms))
	}
	sort.Strings(mismatched)
	if len(mismatched) > 0 {
		t.Fatalf("同一路径在生产树与测试镜像树挂了**不同的权限点**（%d 处）—— "+
			"镜像树是权限用例的观测面，漂移会让用例证明的授权结论与生产相反：\n%s\n"+
			"  处置：把镜像那一行改成与生产逐字相同的权限点（改镜像，不改生产 —— "+
			"生产权限点若确实要调整，请单独评审并同步本判据的语义说明）。",
			len(mismatched), strings.Join(mismatched, "\n"))
	}
	if compared < 20 {
		// 交集过小说明对拍面坏了（例如某侧注册函数改名/前缀变了），不能算通过。
		t.Fatalf("两侧交集只有 %d 条路由，判据面异常（期望 ≥20）—— 检查镜像注册函数", compared)
	}
}

func equalPermSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for perm := range a {
		if !b[perm] {
			return false
		}
	}
	return true
}

func formatPermSet(perms map[string]bool) string {
	list := make([]string, 0, len(perms))
	for perm := range perms {
		if perm == "" {
			perm = "<空>"
		}
		list = append(list, perm)
	}
	sort.Strings(list)
	return strings.Join(list, " | ")
}
