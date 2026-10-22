package api

// 2026-10-22 反证审计的 P0/P1 回归判据（M17 在 appserver；本文件是 M18 + 3b/1c/1e + 继承基线）。
//
// 覆盖四条被反证打红的判据：
//   - **8a（M18）**：回滚到 v1 之后 reject 一个无关 pending 版本，**不得**把指针推回
//     max approved、不得追加 kind=review 部署、不得写"审批部署"审计；
//   - **3b**：超管可撤回他人 pending 版本（与部署/恢复的超管兜底同口径）；普通员工仍 404；
//   - **1c**：幂等部署返回**当前那次部署的历史行**（不是 id=0/version="" 的空占位）；
//   - **1e（M10）**：并发部署同一版本只产生**一条**历史（部署事务的 `FOR UPDATE` 是唯一
//     防线 —— 拿掉它，两个并发请求都会读到"当前不是目标版本"并各插一条）；
//   - 附带：**发布继承基线**取当前部署版本（回滚到 v1 后发新版继承 v1 的配置，而不是
//     被回滚掉的 v2 配置）。
//
// 变异验证：
//   - 把 reviewRelease 的 reject 分支改回"部署 max approved"（旧 syncAppProjection）⇒
//     TestRollbackThenRejectKeepsDeployment 红（指针变 v2 / 多一条部署 / 多一条审计）；
//   - withdrawRelease 恒传 requireOwnership=true ⇒ 超管撤回用例红；
//   - 幂等分支返回空占位 ⇒ TestIdempotentDeployReturnsCurrentDeployment 红；
//   - 删掉部署事务的 `FOR UPDATE` ⇒ TestConcurrentDeploysSerialize 红（两条历史）；
//   - inheritBaseForApp 用 LatestApproved ⇒ TestPublishInheritsFromDeployedVersion 红。

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// deployViaAPI 通过员工面部署一个版本并断言 200。
func (e *testEnv) deployViaAPI(appID, version string) map[string]any {
	e.t.Helper()
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/deployments", e.tokens["alice"],
		map[string]any{"version": version})
	if w.Code != http.StatusOK {
		e.t.Fatalf("部署 %s@%s 失败: %d %s", appID, version, w.Code, w.Body.String())
	}
	var out struct {
		Deployment map[string]any `json:"deployment"`
		Changed    bool           `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	return out.Deployment
}

// TestRollbackThenRejectKeepsDeployment 是 M18：拒绝一个无关 pending 版本不得撤销回滚。
func TestRollbackThenRejectKeepsDeployment(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("p0-reject", "alice")
	v1 := e.seedLifecycleRelease("p0-reject", "1.0.0", serverstore.ReleaseStatusApproved, true)
	_ = e.seedLifecycleRelease("p0-reject", "2.0.0", serverstore.ReleaseStatusApproved, true)

	// 上线 v2，再回滚到 v1（生产路径：部署事务）。
	e.deployViaAPI("p0-reject", "2.0.0")
	e.deployViaAPI("p0-reject", "1.0.0")
	if app := e.appRow("p0-reject"); app.CurrentReleaseID != v1 {
		t.Fatalf("前置不成立：回滚后指针 = %d, want v1=%d", app.CurrentReleaseID, v1)
	}
	histBefore := len(e.deploymentList(e.tokens["alice"], "p0-reject"))
	auditBefore := len(e.auditDetails("p0-reject", "wasm_app_deploy"))
	if histBefore != 2 || auditBefore != 2 {
		t.Fatalf("前置不成立：应有 2 条部署/2 条部署审计，得到 %d/%d", histBefore, auditBefore)
	}

	// 一个新的待审版本，然后管理员**拒绝**它。
	e.seedLifecycleRelease("p0-reject", "3.0.0", serverstore.ReleaseStatusPending, true)
	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/p0-reject/releases/3.0.0/reject", "",
		map[string]any{"reason": "用途描述过简"})
	var rej struct {
		Status  string `json:"status"`
		Changed bool   `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &rej)
	if rej.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("拒绝后状态 = %q, want rejected", rej.Status)
	}

	// ① 指针仍是 v1（reject 从不改变"线上是哪一版"）。
	app := e.appRow("p0-reject")
	if app.CurrentReleaseID != v1 {
		t.Fatalf("拒绝无关 pending 版本后指针 = %d, want v1=%d —— 回滚被一次拒绝静默撤销了",
			app.CurrentReleaseID, v1)
	}
	// ② 投影仍是 v1（title/config 不能被 max approved 覆盖）。
	if app.Title != "p0-reject 1.0.0" {
		t.Fatalf("拒绝后投影 title = %q, want v1 的标题（投影必须跟着指针）", app.Title)
	}
	// ③ 没有新的部署历史。
	if got := len(e.deploymentList(e.tokens["alice"], "p0-reject")); got != histBefore {
		t.Fatalf("拒绝动作追加了部署历史：%d → %d（reject 不部署）", histBefore, got)
	}
	// ④ 没有新的 wasm_app_deploy 审计，也没有"审批部署"这种假审计。
	details := e.auditDetails("p0-reject", "wasm_app_deploy")
	if len(details) != auditBefore {
		t.Fatalf("拒绝动作写了 wasm_app_deploy 审计：%d → %d（detail=%v）", auditBefore, len(details), details)
	}
	for _, d := range details {
		if strings.Contains(d, "审批部署") {
			t.Fatalf("reject 路径留下了「审批部署」审计：%q", d)
		}
	}
	// ⑤ 拒绝本身仍要留痕（动作没被顺手吃掉）。
	if len(e.auditDetails("p0-reject", "wasm_app_release_reject")) != 1 {
		t.Fatalf("拒绝动作必须留痕，实际动作=%v", e.auditActions("p0-reject"))
	}
}

// TestWithdrawSuperAdminFallback 是反证 3b：超管可撤回他人的 pending 版本。
func TestWithdrawSuperAdminFallback(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("wd-super", "alice")
	e.seedLifecycleRelease("wd-super", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("wd-super", "1.1.0", serverstore.ReleaseStatusPending, true)

	// 普通员工（非作者）仍 404 —— 不泄露版本存在性。
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-super/releases/1.1.0/withdraw", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)

	// 超管兜底：与部署/恢复同口径（设计 §5.3「属本人（或超管）」）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/wd-super/releases/1.1.0/withdraw", e.tokens["boss"], nil)
	var out struct {
		Status  string `json:"status"`
		Changed bool   `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Status != serverstore.ReleaseStatusWithdrawn || !out.Changed {
		t.Fatalf("超管撤回响应 = %+v, want withdrawn/true", out)
	}
	var status string
	var archive []byte
	if err := e.db.QueryRow(`SELECT status, archive FROM app_releases WHERE app_id = 'wd-super' AND version = '1.1.0'`).
		Scan(&status, &archive); err != nil {
		e.t.Fatalf("读撤回后的版本: %v", err)
	}
	if status != serverstore.ReleaseStatusWithdrawn || archive != nil {
		t.Fatalf("超管撤回后 status=%q archiveLen=%d", status, len(archive))
	}
	if len(e.auditDetails("wd-super", "wasm_app_release_withdraw")) != 1 {
		t.Fatalf("超管撤回想必须留痕: %v", e.auditActions("wd-super"))
	}
}

// TestIdempotentDeployReturnsCurrentDeployment 是反证 1c：幂等分支必须回**真实**部署行。
func TestIdempotentDeployReturnsCurrentDeployment(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("idem-row", "alice")
	e.seedLifecycleRelease("idem-row", "1.0.0", serverstore.ReleaseStatusApproved, true)

	first := e.deployViaAPI("idem-row", "1.0.0")
	if first["id"] == nil || first["version"] != "1.0.0" || first["kind"] != serverstore.DeployKindPublish {
		t.Fatalf("首次部署响应不完整: %+v", first)
	}
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/idem-row/deployments", e.tokens["alice"],
		map[string]any{"version": "1.0.0"})
	var again struct {
		Deployment map[string]any `json:"deployment"`
		Changed    bool           `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &again)
	if again.Changed {
		t.Fatal("目标已是当前版本时必须 changed=false")
	}
	// 幂等分支的响应必须是**当前那次部署**的历史行：id 非 0、version/kind 都填对。
	// 返回 id=0/version="" 的空占位会让客户端退化成猜（反证 1c）。
	if again.Deployment["id"] == nil || again.Deployment["id"].(float64) == 0 {
		t.Fatalf("幂等响应返回了空部署行（id=0）: %+v", again.Deployment)
	}
	if again.Deployment["version"] != "1.0.0" || again.Deployment["kind"] != serverstore.DeployKindPublish {
		t.Fatalf("幂等响应的 version/kind = %v/%v, want 1.0.0/publish",
			again.Deployment["version"], again.Deployment["kind"])
	}
	if again.Deployment["id"] != first["id"] {
		t.Fatalf("幂等响应应指向同一条部署（first id=%v, again id=%v）", first["id"], again.Deployment["id"])
	}
	// 历史仍是一条（幂等不追加）。
	if got := len(e.deploymentList(e.tokens["alice"], "idem-row")); got != 1 {
		t.Fatalf("幂等部署追加了历史: %d 条", got)
	}
}

// TestPublishInheritsFromDeployedVersion：发新版的继承基线 = 当前部署版本（回滚后是 v1）。
func TestPublishInheritsFromDeployedVersion(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("inherit-roll", "alice")
	e.seedLifecycleRelease("inherit-roll", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("inherit-roll", "2.0.0", serverstore.ReleaseStatusApproved, true)

	e.deployViaAPI("inherit-roll", "2.0.0")
	e.deployViaAPI("inherit-roll", "1.0.0") // 回滚

	base, aerr := e.h.inheritBaseForApp(e.ctx(), "inherit-roll")
	if aerr != nil {
		t.Fatalf("继承基线读取失败: %v", aerr)
	}
	if !strings.Contains(base, "用途 1.0.0") {
		t.Fatalf("回滚后继承基线应来自 v1 的配置，得到 %q（取 max approved 会让下一次发布静默撤销回滚）", base)
	}
	if strings.Contains(base, "用途 2.0.0") {
		t.Fatalf("继承基线来自被回滚掉的 v2：%q", base)
	}
}

// TestConcurrentDeploysSerialize 是反证 1e（M10）：并发部署同一版本只能留下一条历史。
//
// 机制：部署事务先 `SELECT … FOR UPDATE` 应用行，后到者在锁上等待，拿到锁时**重读**到
// 新指针 ⇒ 幂等分支直接返回；去掉 `FOR UPDATE` 后两个请求都会读到"当前不是目标版本"
// 并各插一条历史（两条 kind=publish，指针只可能指向一条）⇒ 断言红。
func TestConcurrentDeploysSerialize(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("race-app", "alice")
	relID := e.seedLifecycleRelease("race-app", "1.0.0", serverstore.ReleaseStatusApproved, true)

	type result struct {
		changed bool
		err     error
	}
	const workers = 2
	start := make(chan struct{})
	results := make(chan result, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // 屏障：尽量让两个事务同时进入
			_, changed, err := serverstore.DeployWasmRelease(context.Background(), e.db,
				serverstore.DeployWasmReleaseInput{
					AppID: "race-app", ReleaseID: relID, Kind: serverstore.DeployKindPublish,
					Actor: "alice", ActorRole: serverstore.ActorRoleOwner,
				})
			results <- result{changed: changed, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	changedTrue := 0
	for res := range results {
		if res.err != nil {
			t.Fatalf("并发部署出错（应为成功 + 幂等，而不是报错）: %v", res.err)
		}
		if res.changed {
			changedTrue++
		}
	}
	if changedTrue != 1 {
		t.Fatalf("并发部署同一版本：changed=true 的次数 = %d, want 1（两次都 true ⇒ 应用行锁没有生效）", changedTrue)
	}
	hist := e.deploymentList(e.tokens["alice"], "race-app")
	if len(hist) != 1 {
		t.Fatalf("并发部署留下 %d 条历史，want 1（删掉 FOR UPDATE 后两个请求各插一条）", len(hist))
	}
	app := e.appRow("race-app")
	if app.CurrentDeploymentID == 0 || app.CurrentReleaseID != relID {
		t.Fatalf("并发后指针不对: release=%d deployment=%d", app.CurrentReleaseID, app.CurrentDeploymentID)
	}
	// 指针必须指向唯一那条历史（"两条 current"在单列指针下不可能，但指到不存在的行可以）。
	var depRelease int64
	var depVersion string
	if err := e.db.QueryRow(`SELECT release_id, version FROM wasm_app_deployments WHERE id = $1`,
		app.CurrentDeploymentID).Scan(&depRelease, &depVersion); err != nil {
		t.Fatalf("指针指向的部署行不存在: %v", err)
	}
	if depRelease != relID || depVersion != "1.0.0" {
		t.Fatalf("指针指向的部署行 = release %d v%s, want %d v1.0.0", depRelease, depVersion, relID)
	}
}

// TestRestoreResetsDeploymentPointer 是反证 P2-4 的判据：恢复必须复位部署指针，
// 且回执把"下一步"指向**发布新版本**（而不是让管理员去点上架然后吃到 500）。
func TestRestoreResetsDeploymentPointer(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("p0-rest", "alice")
	e.seedLifecycleRelease("p0-rest", "1.0.0", serverstore.ReleaseStatusApproved, true)
	now := e.h.now().UTC()
	if err := serverstore.FreezeWasmAppWithRetention(e.ctx(), e.db, "p0-rest", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("冻结: %v", err)
	}
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "p0-rest", now, now.AddDate(0, 0, 90)); err != nil {
		e.t.Fatalf("软删: %v", err)
	}
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/p0-rest/restore", e.tokens["alice"], nil)
	var out struct {
		App struct {
			Deleted bool `json:"deleted"`
			Enabled bool `json:"enabled"`
		} `json:"app"`
		Changed bool   `json:"changed"`
		Note    string `json:"note"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Changed || out.App.Deleted || out.App.Enabled {
		t.Fatalf("恢复响应 = %+v, want changed=true deleted=false enabled=false", out)
	}
	app := e.appRow("p0-rest")
	if app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("恢复必须复位部署指针（release=%d deployment=%d）—— 软删已释放字节，旧指针不可交付",
			app.CurrentReleaseID, app.CurrentDeploymentID)
	}
	for _, want := range []string{"发布新版本", "部署指针已复位"} {
		if !strings.Contains(out.Note, want) {
			t.Fatalf("恢复回执必须说明 %q；note=%q", want, out.Note)
		}
	}
	// 恢复后：部署一个**仍有字节的新版本**即可再上线（身份/版本号占位语义不变）。
	newID := e.seedLifecycleRelease("p0-rest", "2.0.0", serverstore.ReleaseStatusApproved, true)
	if dep, changed, err := serverstore.DeployWasmRelease(e.ctx(), e.db, serverstore.DeployWasmReleaseInput{
		AppID: "p0-rest", ReleaseID: newID, Actor: "alice", ActorRole: serverstore.ActorRoleOwner,
	}); err != nil || !changed || dep.Version != "2.0.0" {
		t.Fatalf("恢复后部署新版本应成功: dep=%v changed=%v err=%v", dep, changed, err)
	}
}

// TestDeleteWhenLongFrozenReportsRemainingRetention 是反证 P2-3 的判据：
// 已冻结很久后再删除，响应/审计报的是**实际剩余**保留期，而不是固定 90 天。
func TestDeleteWhenLongFrozenReportsRemainingRetention(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("p0-frozen-del", "alice")
	e.seedLifecycleRelease("p0-frozen-del", "1.0.0", serverstore.ReleaseStatusApproved, true)

	// 冻结于 60 天前（保留期 90 天 ⇒ 实际只剩 30 天）。
	now := e.h.now().UTC()
	frozenAt := now.AddDate(0, 0, -60)
	purgeAfter := frozenAt.AddDate(0, 0, limits.RetirementSnapshotRetentionDays)
	if err := serverstore.FreezeWasmAppWithRetention(e.ctx(), e.db, "p0-frozen-del", frozenAt, purgeAfter); err != nil {
		e.t.Fatalf("冻结: %v", err)
	}
	w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/p0-frozen-del", e.tokens["alice"], nil)
	var out struct {
		RetentionDays int `json:"retention_days"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.RetentionDays >= limits.RetirementSnapshotRetentionDays {
		t.Fatalf("retention_days = %d, want 实际剩余（约 30，绝不能仍是 %d）",
			out.RetentionDays, limits.RetirementSnapshotRetentionDays)
	}
	if out.RetentionDays < 28 || out.RetentionDays > 31 {
		t.Fatalf("retention_days = %d, want ≈30（冻结 60 天前 + 保留期 90 天）", out.RetentionDays)
	}
	// 审计同样必须写剩余天数（不能写 90）。
	details := e.auditDetails("p0-frozen-del", "wasm_app_delete")
	if len(details) != 1 {
		t.Fatalf("删除审计条数 = %d, want 1", len(details))
	}
	if strings.Contains(details[0], "保留期 90 天") {
		t.Fatalf("已冻结 60 天后删除，审计仍写「保留期 90 天」（假陈述）: %q", details[0])
	}
	if !strings.Contains(details[0], "保留期剩余") {
		t.Fatalf("审计必须写「保留期剩余 N 天」: %q", details[0])
	}
	// 真删到期时刻仍是"原冻结时刻 + 90 天"（而不是"删除时刻 + 90 天"）。
	if app := e.appRow("p0-frozen-del"); app.PurgeAfter == nil ||
		app.PurgeAfter.Sub(purgeAfter).Abs().Minutes() > 1 {
		t.Fatalf("purge_after = %v, want %v（保留期从冻结时刻算）", app.PurgeAfter, purgeAfter)
	}
}

// TestApproveDeploysOnlyTheApprovedVersion 是终轮反证（refute-final 第 1 条）的判据：
// 审批的目标必须**只能是本次被批准的版本**，不能再取 max(id) approved —— 否则
// "回滚到 v1 之后审批一个无关/更旧 pending 版本"会静默把线上推回最新版本。
func TestApproveDeploysOnlyTheApprovedVersion(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("p0-approve", "alice")
	_ = e.seedLifecycleRelease("p0-approve", "1.0.0", serverstore.ReleaseStatusApproved, true)
	v2 := e.seedLifecycleRelease("p0-approve", "2.0.0", serverstore.ReleaseStatusApproved, true)

	// 上线 v2 再回滚 v1；然后批准一个**比当前新**的待审版本 v3 ⇒ 部署 v3（这符合预期）。
	e.deployViaAPI("p0-approve", "2.0.0")
	e.deployViaAPI("p0-approve", "1.0.0")
	v3 := e.seedLifecycleRelease("p0-approve", "3.0.0", serverstore.ReleaseStatusPending, true)
	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/p0-approve/releases/3.0.0/approve", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("审批 v3 失败: %d %s", w.Code, w.Body.String())
	}
	if app := e.appRow("p0-approve"); app.CurrentReleaseID != v3 {
		t.Fatalf("审批比当前新的 v3 后指针 = %d, want %d", app.CurrentReleaseID, v3)
	}

	// 再批准一个**比当前旧**的 pending（0.9.0）：既不降级、也不跳到 max approved。
	histBefore := len(e.deploymentList(e.tokens["alice"], "p0-approve"))
	deployAuditBefore := len(e.auditDetails("p0-approve", "wasm_app_deploy"))
	_ = e.seedLifecycleRelease("p0-approve", "0.9.0", serverstore.ReleaseStatusPending, true)
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/p0-approve/releases/0.9.0/approve", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("审批更旧版本失败: %d %s", w.Code, w.Body.String())
	}
	if app := e.appRow("p0-approve"); app.CurrentReleaseID != v3 {
		t.Fatalf("审批更旧版本后指针 = %d, want 仍为 %d（不得降级/跳版）", app.CurrentReleaseID, v3)
	}
	if got := len(e.deploymentList(e.tokens["alice"], "p0-approve")); got != histBefore {
		t.Fatalf("审批更旧版本追加了部署历史：%d → %d", histBefore, got)
	}
	if got := len(e.auditDetails("p0-approve", "wasm_app_deploy")); got != deployAuditBefore {
		t.Fatalf("审批更旧版本写了部署审计：%d → %d", deployAuditBefore, got)
	}
	_ = v2
}

// TestOpenReportsDeployedPointerAfterRollback 是 P0 第三消费点（/open）的判据：
// 回滚后 open 必须报**指针版本**，而不是 max(id) approved（否则客户端会拿错缓存键）。
func TestOpenReportsDeployedPointerAfterRollback(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("p0-open", "alice")
	_ = e.seedLifecycleRelease("p0-open", "1.0.0", serverstore.ReleaseStatusApproved, true)
	_ = e.seedLifecycleRelease("p0-open", "2.0.0", serverstore.ReleaseStatusApproved, true)
	e.deployViaAPI("p0-open", "2.0.0")
	e.deployViaAPI("p0-open", "1.0.0")

	rec := e.postOpen("p0-open", e.tokens["alice"], "2.0.0", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("open = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Version string `json:"version"`
		Changed bool   `json:"changed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析 open 响应: %v (%s)", err, rec.Body.String())
	}
	if out.Version != "1.0.0" {
		t.Fatalf("回滚后 open.version = %q, want 1.0.0（open 必须跟部署指针）", out.Version)
	}
	if !out.Changed {
		t.Fatal("回滚后客户端持有 v2 缓存 ⇒ changed 必须为 true（缓存键要跟着回滚）")
	}
}
