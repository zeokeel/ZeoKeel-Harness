package marketplace

// F-40（能力中心审计 2026-10-26，P3）：智能体侧的「逐文件查看」与技能侧四条口径
// 必须一致（修前：不 NormalizePath、空 path 不 400、提取错误回 500）。
//
// 技能侧的实现是 `archiveFilePathParam`（400 两种文案）+ `writeSkillArchiveFileContent`
// （解析错 422 ARCHIVE_INVALID）。智能体侧修前直接 `c.Query("path")` 送进提取器：
//   · `./docs/readme.md` 这种合法但未规范化的路径（NormalizePath 会去掉 `./`）
//     提取不到 ⇒ 404「文件不存在」；
//   · 空 path ⇒ 404（应为 400「缺少文件路径」）；
//   · 坏归档 ⇒ 500 INTERNAL（应为 422）。
//
// 本用例直接打共用实现 `writeAgentArchiveFileContent`（name 级与版本级端点都走它），
// 不依赖 DB。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func agentReleaseWithFiles(t *testing.T) *serverstore.Release {
	t.Helper()
	return &serverstore.Release{
		Kind:    serverstore.AppKindAgent,
		AppID:   "f40-agent",
		Version: "1.0.0",
		Status:  serverstore.ReleaseStatusApproved,
		Archive: makeTarGz(t, map[string]string{
			"agent.cordis.yml": "name: f40\nversion: 1.0.0\n",
			"docs/readme.md":   "hello-f40",
		}),
	}
}

func callAgentFileContent(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	url := "/api/server/admin/agent-presets/f40-agent/1.0.0/file"
	if target != "" {
		url += "?path=" + target
	}
	c.Request = httptest.NewRequest("GET", url, nil)
	writeAgentArchiveFileContent(c, agentReleaseWithFiles(t))
	return w
}

func TestAgentArchiveFileContentMatchesSkillSemantics(t *testing.T) {
	// ① 空 path ⇒ 400「缺少文件路径」（修前 404）。
	if w := callAgentFileContent(t, ""); w.Code != http.StatusBadRequest {
		t.Fatalf("空 path = %d %s, want 400（F-40：与技能侧同文案）", w.Code, w.Body.String())
	}
	// ② 路径穿越 ⇒ 400 VALIDATION（修前直接送进提取器）。
	if w := callAgentFileContent(t, "../../etc/passwd"); w.Code != http.StatusBadRequest {
		t.Fatalf("穿越路径 = %d %s, want 400", w.Code, w.Body.String())
	}
	// ③ 未规范化的合法路径 ⇒ 200 且内容是规范化后的那个文件（修前 404）。
	w := callAgentFileContent(t, "./docs/readme.md")
	if w.Code != http.StatusOK {
		t.Fatalf("未规范化路径 = %d %s, want 200（F-40：修前不做 NormalizePath，提取不到就 404）",
			w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "hello-f40") {
		t.Fatalf("响应里没有目标文件内容: %s", w.Body.String())
	}
}
