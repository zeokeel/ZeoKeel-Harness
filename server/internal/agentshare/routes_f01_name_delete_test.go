package agentshare

// F-01 残留（能力中心审计 2026-10-26，P0）：**name 级** `DELETE /api/server/admin/
// agent-presets/:name` 同样不得销毁已生效版本。
//
// 缺陷现场：`remove()` → `softDeleteAllPresetVersions()` 修前无条件
// `UPDATE app_releases SET deleted_at=…, archive=NULL WHERE kind='agent' AND app_id=$1`，
// 于是 approved 版本（正在对全员服务、可能唯一可回滚的历史版本）被永久清空归档，
// 且**没有 409、没有投影重算**。这与版本级删除（上一轮 F-01 已修）是同一个破坏面，
// 只是入口从 `:name/:version` 换成了 `:name`。
//
// 修后判据（本文件）：
//  1. approved + pending 混合 ⇒ DELETE name = 409 RELEASE_APPROVED_NOT_DELETABLE，
//     两个版本的 status/archive 与 apps 投影**一字不动**；
//  2. approved + rejected 混合（lead 指定的形态）⇒ 同样 409，rejected 行也不被删
//     （守卫在**任何写之前**判定：只锁行 + 读状态，未通过就整体回滚）；
//  3. 仅 pending/rejected ⇒ 允许删除（name 级契约保留），删后投影重算、行不可见；
//  4. 并发语义：守卫在同一条事务的 `FOR UPDATE` 行锁内完成（与 approve 的 UPDATE
//     争同一批行），不存在「读到全 pending、删除时已有人批准」的窗口。
//
// 变异验证：把 `softDeleteAllPresetVersions` 的 approved 判定摘掉（或把 remove 的
// 409 分支删掉）⇒ 判据 1/2 收到 200 且归档被清空，本文件变红。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func TestDeleteAllAgentPresetVersionsRejectsApproved(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	const name = "keep-name"
	// alice 上传 v1.0.0（pending）→ 管理员按版本通过（approved，带归档）。
	if w := apiDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody(name, "保留展示名", "保留展示名", makeArchive(t, map[string]string{
			"agent.cordis.yml": testComposition,
			"preset.yml":       presetMeta("保留展示名", "1.0.0"),
		}))); w.Code != http.StatusCreated {
		t.Fatalf("upload v1.0.0 = %d %s", w.Code, w.Body.String())
	}
	if w := apiDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.0.0/approve", ""); w.Code != http.StatusOK {
		t.Fatalf("approve v1.0.0 = %d %s", w.Code, w.Body.String())
	}
	// alice 再上传 v1.1.0（pending；非首版必须写 changelog）。
	if w := apiDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody(name, "第二个版本", "保留展示名", presetArchiveWith(t, "保留展示名", "1.1.0"))); w.Code != http.StatusCreated {
		t.Fatalf("upload v1.1.0 = %d %s", w.Code, w.Body.String())
	}

	appBefore, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		t.Fatal(err)
	}
	approvedBefore, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if approvedBefore.Status != serverstore.AgentPresetApproved || len(approvedBefore.Archive) == 0 {
		t.Fatalf("夹具不成立: v1.0.0 status=%s archive_len=%d", approvedBefore.Status, len(approvedBefore.Archive))
	}

	// ---- 判据 1：approved + pending 混合 ⇒ 409，任何东西都没被改动 ----
	w := apiDo(t, r, adminHdr, "DELETE", "/api/server/admin/agent-presets/"+name, "")
	t.Logf("DELETE name (approved+pending) -> %d %s", w.Code, truncateForLog(w.Body.String(), 300))
	if w.Code != http.StatusConflict {
		t.Fatalf("name 级删除 = %d, want 409（修前 200 且 approved 版本的归档被永久清空）; body=%s",
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
	if env.Error.Code != serverstore.CodeReleaseNotDeletable {
		t.Fatalf("error.code = %q, want %q", env.Error.Code, serverstore.CodeReleaseNotDeletable)
	}
	if env.Error.Message == "" {
		t.Fatal("409 必须带可读消息（说明不可恢复 + 指路下架）")
	}
	assertPresetIntact(t, db, name, "1.0.0", true)
	assertPresetIntact(t, db, name, "1.1.0", false)
	assertProjectionUnchanged(t, db, name, appBefore)

	// ---- 判据 2：approved + rejected 混合（lead 指定形态）⇒ 仍 409 ----
	if w := apiDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.1.0/reject", rejectBody("内容不完整")); w.Code != http.StatusOK {
		t.Fatalf("reject v1.1.0 = %d %s", w.Code, w.Body.String())
	}
	w = apiDo(t, r, adminHdr, "DELETE", "/api/server/admin/agent-presets/"+name, "")
	t.Logf("DELETE name (approved+rejected) -> %d %s", w.Code, truncateForLog(w.Body.String(), 300))
	if w.Code != http.StatusConflict {
		t.Fatalf("approved+rejected 的 name 级删除 = %d, want 409; body=%s", w.Code, w.Body.String())
	}
	assertPresetIntact(t, db, name, "1.0.0", true)
	if rejected, err := serverstore.GetAgentPresetByVersion(db, name, "1.1.0"); err != nil {
		t.Fatalf("rejected 行被删除(守卫必须整体回滚): %v", err)
	} else if rejected.Status != serverstore.AgentPresetRejected {
		t.Fatalf("rejected 行状态被改动: %s", rejected.Status)
	}
	assertProjectionUnchanged(t, db, name, appBefore)

	// ---- 判据 3：仅 pending/rejected ⇒ 仍然允许删除，且投影被重算 ----
	const draft = "draft-name"
	if w := apiDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody(draft, "草稿", "草稿预设", makeArchive(t, map[string]string{
			"agent.cordis.yml": testComposition,
			"preset.yml":       presetMeta("草稿预设", "1.0.0"),
		}))); w.Code != http.StatusCreated {
		t.Fatalf("upload draft = %d %s", w.Code, w.Body.String())
	}
	if w := apiDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+draft+"/1.0.0/reject", rejectBody("不需要")); w.Code != http.StatusOK {
		t.Fatalf("reject draft = %d %s", w.Code, w.Body.String())
	}
	if w := apiDo(t, r, adminHdr, "DELETE", "/api/server/admin/agent-presets/"+draft, ""); w.Code != http.StatusOK {
		t.Fatalf("全 rejected 的 name 级删除 = %d, want 200（name 级删除契约保留）; body=%s",
			w.Code, w.Body.String())
	}
	if _, err := serverstore.GetAgentPresetByVersion(db, draft, "1.0.0"); err == nil {
		t.Fatal("rejected 版本未被删除")
	}
	// 投影重算：全删后目录投影不得再指向已删版本（apps.title 清空或回落到默认）。
	if app, err := serverstore.GetApp(db, serverstore.AppKindAgent, draft); err == nil && app.Title == "草稿预设" {
		t.Fatalf("删除后投影仍指向已删版本: title=%q", app.Title)
	}
}

// assertPresetIntact 断言某个版本仍在且归档状态符合预期（approved 必须还有归档字节）。
func assertPresetIntact(t *testing.T, db *sql.DB, name, version string, wantArchive bool) {
	t.Helper()
	p, err := serverstore.GetAgentPresetByVersion(db, name, version)
	if err != nil {
		t.Fatalf("版本 %s@%s 被删除（守卫必须拒绝且整体回滚）: %v", name, version, err)
	}
	if wantArchive && len(p.Archive) == 0 {
		t.Fatalf("版本 %s@%s 的归档被清空（approved 版本不可销毁）", name, version)
	}
}

// assertProjectionUnchanged 断言 apps 投影（标题/描述）在 409 之后一字不动。
func assertProjectionUnchanged(t *testing.T, db *sql.DB, name string, before *serverstore.App) {
	t.Helper()
	after, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		t.Fatalf("apps 投影行消失: %v", err)
	}
	if after.Title != before.Title || after.Description != before.Description {
		t.Fatalf("投影被改动: before=%q/%q after=%q/%q",
			before.Title, before.Description, after.Title, after.Description)
	}
}
