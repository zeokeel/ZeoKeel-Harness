package appserver

// 回滚后的**请求级**判据（2026-10-22 反证审计 P0，M17）。
//
// 现场：`current_release_id` 被目录/管理台/部署历史/GC 当作生效版本，而应用请求路径
// 仍按 `max(id) approved` 取版本（`serve.go` 的 `LatestApprovedWasmReleaseMeta`）——
// 回滚只改数据库记账，用户实际拿到的仍是回滚前的那一版。整个套件当时零红：因为
// 没有任何用例在"回滚之后发一次请求"。
//
// 本文件就是那条判据。三条断言缺一不可：
//  1. 静态资源（`/app.js`）返回**旧版本字节**；
//  2. 响应头 `X-ZeoKeel-App-Version` = 旧版本（客户端的缓存键唯一来源）；
//  3. wasm 请求路径（`/`，经 `/request` 管线）也报旧版本 —— 它走的是同一个
//     serve 入口，但版本头由 versionHeaderWriter 在另一条出口写，漏一处就是
//     "某一类响应没有版本"。
//
// 变异验证：
//   - 把 serve.go 的 CurrentWasmReleaseMeta 换回 LatestApprovedWasmReleaseMeta ⇒
//     三条断言全红（静态交付 v2 字节、版本头 v2）；
//   - 把版本头删掉 ⇒ 第 2/3 条红。

import (
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/edge"
)

// TestServingFollowsDeploymentPointerAfterRollback 是 P0 的验收判据：
// 回滚（= 用旧版本再部署一次）之后，**实际交付的字节与版本头**都必须是旧版本。
func TestServingFollowsDeploymentPointerAfterRollback(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rollback")
	v1 := e.publishApp(appSpec{appID: appID, version: "1.0.0", config: loginConfig(), assets: map[string]string{
		"index.html": "<html>v1</html>",
		"app.js":     "console.log('v1')",
	}})
	v2 := e.publishApp(appSpec{appID: appID, version: "2.0.0", config: loginConfig(), assets: map[string]string{
		"index.html": "<html>v2</html>",
		"app.js":     "console.log('v2')",
	}})
	// 前置：当前交付 v2（否则后面的"回滚"证不出任何东西）。
	before := e.get(appID, "/app.js")
	if before.Code != http.StatusOK || before.Body.String() != "console.log('v2')" {
		t.Fatalf("前置不成立：发布 v2 后应交付 v2，得到 %d %q", before.Code, before.Body.String())
	}
	if got := before.Header().Get(edge.AppVersionHeader); got != "2.0.0" {
		t.Fatalf("前置不成立：v2 的版本头 = %q, want 2.0.0", got)
	}

	// 回滚 = 生产路径（部署事务）把指针指回 v1；不删版本、不动 v2 的字节。
	dep, changed, err := serverstore.DeployWasmRelease(t.Context(), e.db, serverstore.DeployWasmReleaseInput{
		AppID: appID, ReleaseID: v1.ID, Actor: "alice", ActorRole: serverstore.ActorRoleOwner,
		Message: "回滚到 v1",
	})
	if err != nil || !changed {
		t.Fatalf("回滚部署失败: err=%v changed=%v", err, changed)
	}
	if dep.Kind != serverstore.DeployKindRollback {
		t.Fatalf("回滚的 kind = %q, want rollback（发布与回滚必须可辨）", dep.Kind)
	}
	app, aerr := serverstore.GetWasmApp(t.Context(), e.db, appID)
	if aerr != nil {
		t.Fatalf("读应用: %v", aerr)
	}
	if app.CurrentReleaseID != v1.ID {
		t.Fatalf("前置不成立：指针 = %d, want v1=%d", app.CurrentReleaseID, v1.ID)
	}

	// ① 静态资源：必须是 v1 的字节（这条是 M17 的核心）。
	rolled := e.get(appID, "/app.js")
	if rolled.Code != http.StatusOK {
		t.Fatalf("回滚后静态资源应 200，得到 %d %s", rolled.Code, rolled.Body.String())
	}
	if got := rolled.Body.String(); got != "console.log('v1')" {
		t.Fatalf("回滚后静态资源字节 = %q, want v1（回滚必须改变**实际交付**，不能只改数据库指针）", got)
	}
	// ② 静态面的版本头：客户端的内容缓存键是 (app_id, version, path)，
	// 版本头不跟着回滚 ⇒ 客户端会继续用 v2 的缓存内容。
	if got := rolled.Header().Get(edge.AppVersionHeader); got != "1.0.0" {
		t.Fatalf("回滚后静态响应版本头 = %q, want 1.0.0（缓存键必须跟着回滚）", got)
	}

	// ③ wasm 请求路径（/request 管线）：同样报 v1。
	// 入口文档 `/` 交给 wasm 处理（见 serveStatic 的 allowEntry=false），因此这条
	// 响应来自执行面；版本头由 versionHeaderWriter 统一写。
	wasmResp := e.post(appID, "/", "application/json", `{}`)
	if wasmResp.Code != http.StatusOK {
		t.Fatalf("回滚后 wasm 请求路径应 200，得到 %d %s", wasmResp.Code, wasmResp.Body.String())
	}
	if got := wasmResp.Header().Get(edge.AppVersionHeader); got != "1.0.0" {
		t.Fatalf("回滚后 wasm 路径版本头 = %q, want 1.0.0（版本头漏写一个出口 = 该类响应的缓存永不失效）", got)
	}

	// 反向：再部署回 v2 ⇒ 交付与版本头都回到 v2（部署指针是真源，不是一次性的特殊情形）。
	if _, _, derr := serverstore.DeployWasmRelease(t.Context(), e.db, serverstore.DeployWasmReleaseInput{
		AppID: appID, ReleaseID: v2.ID, Actor: "alice", ActorRole: serverstore.ActorRoleOwner,
		Message: "再上线 v2",
	}); derr != nil {
		t.Fatalf("再部署 v2: %v", derr)
	}
	again := e.get(appID, "/app.js")
	if again.Body.String() != "console.log('v2')" {
		t.Fatalf("再部署 v2 后字节 = %q, want v2", again.Body.String())
	}
	if got := again.Header().Get(edge.AppVersionHeader); got != "2.0.0" {
		t.Fatalf("再部署 v2 后版本头 = %q, want 2.0.0", got)
	}
}
