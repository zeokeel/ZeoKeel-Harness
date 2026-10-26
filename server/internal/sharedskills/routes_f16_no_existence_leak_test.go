package sharedskills

// F-16（能力中心审计 2026-10-26，P2）：approve **不得**通过 `SkillNameExists`
// 泄露市场行存在性。
//
// 缺陷现场（修前）：`decide()` 先跑 `serverstore.SkillNameExists(name)`
// （市场渠道同名 ⇒ 409 CONFLICT），**之后**才跑渠道守卫 `requireOrgSkill`
// （非组织行 ⇒ 404）。于是同一条 approve 请求：
//   · 名字被市场渠道占用 ⇒ 409 CONFLICT「名称与市场技能冲突…」；
//   · 名字根本不存在     ⇒ 404 NOT_FOUND；
// 而同一端口的 reject 恒 404 —— 有 capability:write 的角色可以据此枚举
// 「市场里有哪些名字」，且 approve/reject 对同一输入给出两个不同答案。
//
// 修后：渠道守卫在**最前面**，市场行与不存在逐字节同形 404；原有的跨源同名
// 检测不可达并删除（apps 以 (kind, app_id) 唯一 ⇒ 同名不可能并存）。
//
// 变异验证：把渠道守卫挪回冲突检测之后（或恢复 SkillNameExists 分支）⇒
// 第一条判据收到 409 变红。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sharedskillsDo 发一个带头的共享库管理面请求。
func sharedskillsDo(r http.Handler, hdr map[string]string, method, path, body string) *httptest.ResponseRecorder {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestApproveDoesNotLeakMarketRowExistence(t *testing.T) {
	r, db, adminHdr, _, _ := setup(t)
	defer db.Close()

	const market = "market-leak"
	raw := makeSkillArchive(t, map[string]string{
		"SKILL.md": skillMdCustom(market, "1.0.0", "市场标题", "市场渠道的描述文本,长度足够通过校验。"),
	})
	seedPublishedMarketSkill(t, db, market, "alice", "市场标题", "1.0.0", raw)

	approve := sharedskillsDo(r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+market+"/1.0.0/approve", "")
	reject := sharedskillsDo(r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+market+"/1.0.0/reject", rejectBody("即使这样也不该泄露渠道"))
	missing := sharedskillsDo(r, adminHdr, "POST",
		"/api/server/admin/shared-skills/never-existed/1.0.0/approve", "")

	if approve.Code == http.StatusConflict {
		t.Fatalf("approve 对市场渠道的名字回了 409（F-16 存在性泄漏）: %s", approve.Body.String())
	}
	if approve.Code != http.StatusNotFound {
		t.Fatalf("approve 市场行 = %d, want 404（与「不存在」同形）; body=%s",
			approve.Code, approve.Body.String())
	}
	if reject.Code != http.StatusNotFound {
		t.Fatalf("reject 市场行 = %d, want 404", reject.Code)
	}
	if approve.Body.String() != reject.Body.String() {
		t.Fatalf("approve 与 reject 对同一市场行的响应不同（泄露渠道/存在性）:\n approve=%s\n reject=%s",
			approve.Body.String(), reject.Body.String())
	}
	if missing.Body.String() != approve.Body.String() {
		t.Fatalf("「市场行」与「不存在」响应不同（仍然可枚举）:\n market=%s\n missing=%s",
			approve.Body.String(), missing.Body.String())
	}
	if strings.Contains(approve.Body.String(), "CONFLICT") || strings.Contains(approve.Body.String(), "冲突") {
		t.Fatalf("approve 响应里仍带跨源冲突文案（F-16）: %s", approve.Body.String())
	}
}
