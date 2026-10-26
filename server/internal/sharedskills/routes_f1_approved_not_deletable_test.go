package sharedskills

// F-01(能力中心审计 2026-10-26,P0):**已通过审核的版本不可删除**。
//
// 缺陷现场(修前):`DELETE /api/server/admin/shared-skills/:name/:version`
// 的 `remove` 没有状态守卫,`SoftDeleteRelease` 直接 `archive = NULL` —— 管理员在
// 审批页点一次「删除」就不可恢复地销毁正在对全员服务的归档字节,而 `apps`
// 投影仍停在旧标题上(不调 RecomputeAppProjection)。与「已通过不可拒绝」
// (reject 409)的产品语义自相矛盾:同一个版本,拒绝被挡、删除放行。
//
// 判据(修后):
//  1. 删除 approved 版本 ⇒ 409 + error.code=RELEASE_APPROVED_NOT_DELETABLE;
//     行仍在、archive 未被清空、apps 投影一字不动;
//  2. 删除 pending 版本仍然允许(只有未生效版本可删),删完投影仍等于
//     "最高 approved 版本"(这里就是那条 approved 行的 title);
//  3. 删除 pending 后 approved 版本依旧可下载(员工面 200 + 字节完整)——
//     证明删除动作没有波及相邻版本。
//
// 变异验证(把修复摘掉):①删掉 handler 的错误映射 ⇒ 用例 1 收到 200 立刻红;
// ②把 DeleteSharedSkillVersion 换回 DeleteSharedSkill ⇒ 同样红。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// TestDeleteApprovedSharedSkillVersionRejected 是 F-01 的端到端回归。
func TestDeleteApprovedSharedSkillVersionRejected(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// 员工上传 v1.0.0(pending)→ 管理员通过(approved,带归档)。
	raw := makeSkillArchive(t, map[string]string{"SKILL.md": skillMd("keep-me", "1.0.0")})
	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("keep-me", "1.0.0", "保留版本", raw)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST",
		"/api/server/admin/shared-skills/keep-me/1.0.0/approve", ""); code != http.StatusOK {
		t.Fatalf("approve = %d %s", code, body)
	}
	// 员工再上传 v1.1.0(pending),用于验证「只有未生效版本可删」。
	pendingRaw := makeSkillArchive(t, map[string]string{"SKILL.md": skillMd("keep-me", "1.1.0")})
	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("keep-me", "1.1.0", "待审版本", pendingRaw)); code != http.StatusCreated {
		t.Fatalf("upload pending = %d %s", code, body)
	}

	appBefore, err := serverstore.GetApp(db, serverstore.AppKindSkill, "keep-me")
	if err != nil {
		t.Fatal(err)
	}

	// ---- 判据 1:删除 approved ⇒ 409 + 明确错误码,且什么都没变 ----
	code, body := skAdminDo(t, r, adminHdr, "DELETE",
		"/api/server/admin/shared-skills/keep-me/1.0.0", "")
	t.Logf("DELETE approved version -> %d %s", code, truncateBody(body, 300))
	if code != http.StatusConflict {
		t.Fatalf("删除 approved 版本 = %d, want 409(修前 200 且归档被永久清空);body=%s", code, body)
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("错误信封不是 JSON: %v body=%s", err, body)
	}
	if env.Error.Code != "RELEASE_APPROVED_NOT_DELETABLE" {
		t.Fatalf("error.code = %q, want %q", env.Error.Code, "RELEASE_APPROVED_NOT_DELETABLE")
	}
	if env.Error.Message == "" {
		t.Fatal("409 必须带可读消息(说明不可恢复 + 指路下架)")
	}
	// 归档未丢、状态未变。
	s, err := serverstore.GetSharedSkill(db, "keep-me", "1.0.0")
	if err != nil {
		t.Fatalf("approved 版本被删除(应当拒绝): %v", err)
	}
	if s.Status != serverstore.SharedSkillApproved || len(s.Archive) == 0 {
		t.Fatalf("approved 版本被破坏: status=%s archive_len=%d", s.Status, len(s.Archive))
	}
	// 投影未变。
	appAfter, err := serverstore.GetApp(db, serverstore.AppKindSkill, "keep-me")
	if err != nil {
		t.Fatal(err)
	}
	if appAfter.Title != appBefore.Title || appAfter.Description != appBefore.Description {
		t.Fatalf("投影被改动: before=%q/%q after=%q/%q",
			appBefore.Title, appBefore.Description, appAfter.Title, appAfter.Description)
	}

	// ---- 判据 2:pending 版本可以删除,投影仍指向 approved 版本 ----
	code, body = skAdminDo(t, r, adminHdr, "DELETE",
		"/api/server/admin/shared-skills/keep-me/1.1.0", "")
	if code != http.StatusOK {
		t.Fatalf("删除 pending 版本 = %d %s, want 200", code, body)
	}
	if _, err := serverstore.GetSharedSkill(db, "keep-me", "1.1.0"); err == nil {
		t.Fatal("pending 版本未被删除")
	}
	// 投影仍 = 最高 approved 版本(而不是被删的 pending/app_id 占位)。
	appAfter, err = serverstore.GetApp(db, serverstore.AppKindSkill, "keep-me")
	if err != nil {
		t.Fatal(err)
	}
	if appAfter.Title != appBefore.Title || appAfter.Description != appBefore.Description {
		t.Fatalf("删除 pending 后投影漂移: before=%q/%q after=%q/%q",
			appBefore.Title, appBefore.Description, appAfter.Title, appAfter.Description)
	}

	// ---- 判据 3:approved 版本仍可被下载(字节完整) ----
	dl := "/api/client/v2/shared-skills/keep-me/1.0.0/archive"
	req := httptest.NewRequest("GET", dl, nil)
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approved 版本下载 = %d %s", w.Code, truncateBody(w.Body.String(), 200))
	}
	if strings.TrimSpace(w.Header().Get("X-Skill-Version")) != "1.0.0" {
		t.Fatalf("X-Skill-Version = %q", w.Header().Get("X-Skill-Version"))
	}
	if w.Body.Len() == 0 {
		t.Fatal("下载字节为空:删除动作波及了 approved 版本")
	}
}
