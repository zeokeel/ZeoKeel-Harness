package agentshare

// F-01(能力中心审计 2026-10-26,P0):**已通过审核的预设版本不可删除**。
//
// 与 sharedskills 侧逐条同构:修前 `DELETE /api/server/admin/agent-presets/
// :name/:version` 的 `removeVersioned` 无状态守卫,`SoftDeleteRelease` 直接把
// archive 置 NULL(不可恢复),且不重算 apps 投影。修后:
//  1. 删除 approved 版本 ⇒ 409 + error.code=RELEASE_APPROVED_NOT_DELETABLE,
//     行与归档保持原样、投影一字不动;
//  2. 删除 pending 版本仍允许,删完投影仍 = 最高 approved 版本;
//  3. approved 版本仍可下载(字节完整)。
//
// 变异验证:把 handler 的错误映射摘掉 ⇒ 判据 1 收到 200 变红;把
// DeleteAgentPresetVersion 换回 DeleteAgentPresetByVersion ⇒ 同样变红。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// postWith 发一个带认证头的请求(agentshare 包内既有用例的同款写法抽成小助手)。
func apiDo(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
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

// truncateForLog 截断日志里的响应体(与 sharedskills 包的 truncateBody 同义,
// 跨包测试代码不共享 helper)。
func truncateForLog(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func TestDeleteApprovedAgentPresetVersionRejected(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// alice 上传 v1.0.0(pending)→ 管理员按版本通过(approved,带归档)。
	v1 := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("保留预设", "1.0.0"),
	})
	if w := apiDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody("keep-preset", "保留预设", "保留预设", v1)); w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	if w := apiDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/keep-preset/1.0.0/approve", ""); w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	// alice 再上传 v1.1.0(pending)——非首版必须有 changelog。
	if w := apiDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody("keep-preset", "待审版本", "保留预设", presetArchiveWith(t, "保留预设", "1.1.0"))); w.Code != http.StatusCreated {
		t.Fatalf("upload pending = %d %s", w.Code, w.Body.String())
	}

	appBefore, err := serverstore.GetApp(db, serverstore.AppKindAgent, "keep-preset")
	if err != nil {
		t.Fatal(err)
	}

	// ---- 判据 1:删除 approved ⇒ 409 + 明确错误码,内容与投影都没变 ----
	w := apiDo(t, r, adminHdr, "DELETE",
		"/api/server/admin/agent-presets/keep-preset/1.0.0", "")
	t.Logf("DELETE approved preset version -> %d %s", w.Code, truncateForLog(w.Body.String(), 300))
	if w.Code != http.StatusConflict {
		t.Fatalf("删除 approved 版本 = %d, want 409(修前 200 且归档被永久清空);body=%s",
			w.Code, w.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("错误信封不是 JSON: %v body=%s", err, w.Body.String())
	}
	if env.Error.Code != "RELEASE_APPROVED_NOT_DELETABLE" {
		t.Fatalf("error.code = %q, want %q", env.Error.Code, "RELEASE_APPROVED_NOT_DELETABLE")
	}
	if env.Error.Message == "" {
		t.Fatal("409 必须带可读消息(说明不可恢复 + 指路下架)")
	}
	p, err := serverstore.GetAgentPresetByVersion(db, "keep-preset", "1.0.0")
	if err != nil {
		t.Fatalf("approved 版本被删除(应当拒绝): %v", err)
	}
	if p.Status != serverstore.AgentPresetApproved || len(p.Archive) == 0 {
		t.Fatalf("approved 版本被破坏: status=%s archive_len=%d", p.Status, len(p.Archive))
	}
	appAfter, err := serverstore.GetApp(db, serverstore.AppKindAgent, "keep-preset")
	if err != nil {
		t.Fatal(err)
	}
	if appAfter.Title != appBefore.Title || appAfter.Description != appBefore.Description {
		t.Fatalf("投影被改动: before=%q/%q after=%q/%q",
			appBefore.Title, appBefore.Description, appAfter.Title, appAfter.Description)
	}

	// ---- 判据 2:pending 可以删除,投影仍 = 最高 approved 版本 ----
	if w := apiDo(t, r, adminHdr, "DELETE",
		"/api/server/admin/agent-presets/keep-preset/1.1.0", ""); w.Code != http.StatusOK {
		t.Fatalf("删除 pending 版本 = %d %s, want 200", w.Code, w.Body.String())
	}
	if _, err := serverstore.GetAgentPresetByVersion(db, "keep-preset", "1.1.0"); err == nil {
		t.Fatal("pending 版本未被删除")
	}
	appAfter, err = serverstore.GetApp(db, serverstore.AppKindAgent, "keep-preset")
	if err != nil {
		t.Fatal(err)
	}
	if appAfter.Title != appBefore.Title || appAfter.Description != appBefore.Description {
		t.Fatalf("删除 pending 后投影漂移: before=%q/%q after=%q/%q",
			appBefore.Title, appBefore.Description, appAfter.Title, appAfter.Description)
	}

	// ---- 判据 3:approved 版本仍可下载 ----
	w = apiDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets/keep-preset/1.0.0/archive", "")
	if w.Code != http.StatusOK {
		t.Fatalf("approved 版本下载 = %d %s", w.Code, truncateForLog(w.Body.String(), 200))
	}
	if strings.TrimSpace(w.Header().Get("X-Preset-Version")) != "1.0.0" {
		t.Fatalf("X-Preset-Version = %q", w.Header().Get("X-Preset-Version"))
	}
	if w.Body.Len() == 0 {
		t.Fatal("下载字节为空:删除动作波及了 approved 版本")
	}
}
