package api

// 生产评审（2026-10-22 管理员视角 P2）：管理面**高敏读取**不能与普通只读共用
// capability:read —— `?database=1` 导出他人应用库、`?unmask=1` 读未脱敏敏感列，
// 都需要 capability:write。此前 auditor（只读角色）可一键导出/读原始数据。
//
// 变异：删掉 adminExport 的写权限判断 / adminRows 的 unmask 判断 ⇒ auditor 得到非 403。

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// reqAsAdmin 发一个带 `X-Test-Admin` 的请求（身份映射见 helpers_test 的 adminFromHeader）。
func (e *testEnv) reqAsAdmin(method, path, admin string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-Test-Admin", admin)
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// addAuditor 建一个只读角色账号并放进测试身份表。
func (e *testEnv) addAuditor(t *testing.T) {
	t.Helper()
	id, err := serverstore.CreateUser(e.db, &serverstore.User{
		Username: "auditor1", Source: "local", Status: 1, Role: serverstore.RoleAuditor,
	})
	if err != nil {
		t.Fatalf("建 auditor: %v", err)
	}
	u, err := serverstore.GetUserByUsername(e.db, "auditor1")
	if err != nil || u == nil {
		t.Fatalf("读 auditor（id=%d）: %v", id, err)
	}
	e.users["auditor1"] = u
}

func TestAdminSensitiveReadRequiresWrite(t *testing.T) {
	e := newTestEnv(t)
	e.addAuditor(t)
	e.publishOK(e.tokens["alice"], "perm-tool", "1.0.0", testGuestModule(t), goodConfig())

	// 含数据库导出：auditor（capability:read）必须 403；超管放行（不要求它一定 200：
	// 该应用可能还没有数据库文件，但**不能**是 403）。
	w := e.reqAsAdmin(http.MethodGet, "/api/server/admin/wasm-apps/perm-tool/export?database=1", "auditor1")
	if w.Code != http.StatusForbidden {
		t.Fatalf("auditor 导出含数据库 = %d，want 403：%s", w.Code, w.Body.String())
	}
	w = e.reqAsAdmin(http.MethodGet, "/api/server/admin/wasm-apps/perm-tool/export?database=1", "boss")
	if w.Code == http.StatusForbidden {
		t.Fatalf("super_admin 导出含数据库被误拒：%s", w.Body.String())
	}

	// 未脱敏行：auditor 必须 403（在触碰应用库之前就拒）。
	w = e.reqAsAdmin(http.MethodGet, "/api/server/admin/wasm-apps/perm-tool/rows?table=notes&unmask=1", "auditor1")
	if w.Code != http.StatusForbidden {
		t.Fatalf("auditor 读 unmask=1 = %d，want 403：%s", w.Code, w.Body.String())
	}

	// 对照：默认 JSON 导出（不带 database/assets）仍是只读允许的（排障/合规需要）。
	w = e.reqAsAdmin(http.MethodGet, "/api/server/admin/wasm-apps/perm-tool/export", "auditor1")
	if w.Code == http.StatusForbidden {
		t.Fatalf("控制面 JSON 导出不该被写权限拦：%s", w.Body.String())
	}
}
