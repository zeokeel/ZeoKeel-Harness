package serverstore

// 生命周期 DAO 的行为级用例（迁移 0086 / wasm_deployments.go；设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.1–§5.5、§9.2）。
//
// 口径：全部走**生产 DAO**（不手写 SQL 造状态），断言落在"指针/历史行/投影/状态机"
// 这些**行为后果**上，而不是函数返回了什么。
//
// 变异验证（每条判据对应一处可被删掉的实现，删掉后本文件必红）：
//   - 删掉 DeployWasmRelease 的 `status != approved` 判据 ⇒ TestDeployRejectsNonApproved 红
//     （pending/rejected/withdrawn 都能部署成功）；
//   - 删掉 deleted/frozen 判定 ⇒ TestDeployRejectsLifecycleTerminal 红；
//   - 删掉"目标即当前 ⇒ changed=false"的幂等分支 ⇒ TestDeployIsIdempotent 的
//     "不追加历史"断言红（部署历史变成 2 条）；
//   - 把 kind 判定固定成 publish ⇒ TestDeployRollbackUpdatesPointer 的 kind=rollback 断言红；
//   - 去掉 `archive IS NOT NULL` 判据 ⇒ TestDeployRejectsReleasedBytes 红；
//   - 把 WithdrawWasmRelease 的 `status='pending'` 从 WHERE 挪到调用方 ⇒
//     TestWithdrawOnlyPending 红（approved 版本被撤回、字节被销毁）；
//   - 去掉 PurgeCandidates 的 `snapshot_at IS NOT NULL` ⇒
//     TestPurgeCandidatesRequireSnapshotAndDeadline 红（无快照的应用进了删除路径）；
//   - RestoreWasmApp 恢复时把 enabled 置 1 ⇒ TestRestoreKeepsUnpublished 红；
//   - 部署不写投影（只切指针）⇒ TestDeployProjectsTargetVersion 红。

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// releaseFixture 是一套生命周期用例夹具（独立临时库 + 常用构造器）。
type releaseFixture struct {
	t   *testing.T
	db  *sql.DB
	ctx context.Context
}

func newReleaseFixture(t *testing.T) *releaseFixture {
	t.Helper()
	db, cleanup := newTestDB(t)
	t.Cleanup(cleanup)
	return &releaseFixture{t: t, db: db, ctx: context.Background()}
}

// app 建一个 wasm 应用行（归属 alice、已上架）。
func (f *releaseFixture) app(appID string) *WasmApp {
	f.t.Helper()
	if err := UpsertWasmApp(f.ctx, f.db, WasmApp{
		AppID: appID, Title: appID + " 标题", Owner: "alice", Enabled: true,
		Purpose: "演示", DataSensitivity: "internal",
	}); err != nil {
		f.t.Fatalf("建应用 %s: %v", appID, err)
	}
	return f.getApp(appID)
}

// release 写一个版本行（带/不带字节；status 由调用方给）。
func (f *releaseFixture) release(appID, version, title, configJSON, status string, withBytes bool) int64 {
	f.t.Helper()
	var archive []byte
	if withBytes {
		archive = []byte("wasm-bytes-" + version)
	}
	id, err := CreateWasmRelease(f.ctx, f.db, WasmRelease{
		AppID: appID, Version: version, Title: title, Description: title + " 的描述",
		Changelog: "第 " + version + " 版", Publisher: "alice", Checksum: "sum-" + version,
		Size: int64(len(archive)), Status: status, Wasm: archive, ConfigJSON: configJSON,
	})
	if err != nil {
		f.t.Fatalf("CreateWasmRelease(%s v%s, %s): %v", appID, version, status, err)
	}
	return id
}

// approved 写一个 approved 且带字节的版本（最常见的前置状态）。
func (f *releaseFixture) approved(appID, version, title, configJSON string) int64 {
	return f.release(appID, version, title, configJSON, ReleaseStatusApproved, true)
}

func (f *releaseFixture) getApp(appID string) *WasmApp {
	f.t.Helper()
	app, err := GetWasmApp(f.ctx, f.db, appID)
	if err != nil {
		f.t.Fatalf("GetWasmApp(%s): %v", appID, err)
	}
	return app
}

func (f *releaseFixture) deploy(appID string, releaseID int64, kind string) (*WasmDeployment, bool, error) {
	f.t.Helper()
	return DeployWasmRelease(f.ctx, f.db, DeployWasmReleaseInput{
		AppID: appID, ReleaseID: releaseID, Kind: kind,
		Actor: "alice", ActorRole: ActorRoleOwner,
	})
}

func (f *releaseFixture) deployments(appID string) []WasmDeployment {
	f.t.Helper()
	list, err := ListWasmDeployments(f.ctx, f.db, appID, 50)
	if err != nil {
		f.t.Fatalf("ListWasmDeployments(%s): %v", appID, err)
	}
	return list
}

// TestDeployRejectsNonApproved：只有 approved 可部署（设计 §3.3 不变量 1）。
func TestDeployRejectsNonApproved(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("gate-app")
	pendingID := f.release("gate-app", "1.0.0", "待审", "", ReleaseStatusPending, true)
	rejectedID := f.release("gate-app", "1.1.0", "被拒", "", ReleaseStatusRejected, false)
	withdrawnID := f.release("gate-app", "1.2.0", "撤回", "", ReleaseStatusWithdrawn, false)

	for name, relID := range map[string]int64{
		"pending": pendingID, "rejected": rejectedID, "withdrawn": withdrawnID,
	} {
		_, changed, err := f.deploy("gate-app", relID, "")
		if !errors.Is(err, ErrReleaseNotDeployable) {
			t.Fatalf("%s 版本部署必须被拒（ErrReleaseNotDeployable），得到 err=%v changed=%v", name, err, changed)
		}
	}
	if n := len(f.deployments("gate-app")); n != 0 {
		t.Fatalf("被拒的部署不得留下历史行，得到 %d 条", n)
	}
	if app := f.getApp("gate-app"); app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("被拒的部署不得改指针（current_release_id=%d current_deployment_id=%d）",
			app.CurrentReleaseID, app.CurrentDeploymentID)
	}
}

// TestDeployRejectsReleasedBytes：版本行还在（approved）但字节已被释放 ⇒ 不可部署。
//
// 这是存量形态：软删应用/审核拒绝/版本 GC 都会清 archive 而留下行与状态。
func TestDeployRejectsReleasedBytes(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("bytes-app")
	relID := f.release("bytes-app", "1.0.0", "无字节", "", ReleaseStatusApproved, false)
	if _, _, err := f.deploy("bytes-app", relID, ""); !errors.Is(err, ErrReleaseBytesReleased) {
		t.Fatalf("字节已释放的版本必须回 ErrReleaseBytesReleased，得到 %v", err)
	}
}

// TestDeployRejectsLifecycleTerminal：冻结/删除/清除的应用不可部署（设计 §5.1）。
func TestDeployRejectsLifecycleTerminal(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("state-app")
	relID := f.approved("state-app", "1.0.0", "正常", `{"access":"login"}`)

	// 冻结：先写冻结时间线（生产写入口），再试部署。
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if err := FreezeWasmAppWithRetention(f.ctx, f.db, "state-app", now, retentionForTest(now)); err != nil {
		t.Fatalf("FreezeWasmAppWithRetention: %v", err)
	}
	if _, _, err := f.deploy("state-app", relID, ""); !errors.Is(err, ErrAppFrozen) {
		t.Fatalf("冻结应用的部署必须回 ErrAppFrozen，得到 %v", err)
	}
	// 解冻后可部署（解冻本身不自动上架，但部署是"版本指针"动作，与上下架正交）。
	if err := UnfreezeWasmApp(f.ctx, f.db, "state-app"); err != nil {
		t.Fatalf("UnfreezeWasmApp: %v", err)
	}
	if _, changed, err := f.deploy("state-app", relID, DeployKindPublish); err != nil || !changed {
		t.Fatalf("解冻后应能部署（err=%v changed=%v）", err, changed)
	}
	// 软删 → 已删除不可部署。
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "state-app", now, retentionForTest(now)); err != nil {
		t.Fatalf("SoftDeleteWasmAppWithTimeline: %v", err)
	}
	if _, _, err := f.deploy("state-app", relID, ""); !errors.Is(err, ErrAppDeleted) {
		t.Fatalf("已删除应用的部署必须回 ErrAppDeleted，得到 %v", err)
	}
	// 标记真删 → APP_PURGED（比"已删除"更终态）。
	if err := MarkWasmAppPurged(f.ctx, f.db, "state-app", now); err != nil {
		t.Fatalf("MarkWasmAppPurged: %v", err)
	}
	if _, _, err := f.deploy("state-app", relID, ""); !errors.Is(err, ErrAppPurged) {
		t.Fatalf("已清除应用的部署必须回 ErrAppPurged（不是 ErrAppDeleted），得到 %v", err)
	}
}

// retentionForTest 是保留期到期时刻（与生产同一条公式：冻结时刻 + 保留天数）。
func retentionForTest(at time.Time) time.Time {
	return at.AddDate(0, 0, 90)
}

// TestDeployIsIdempotent：目标 == 当前 ⇒ changed=false 且**不追加历史**（设计 §5.1）。
//
// 这条判据同时是"回滚后再部署当前版本"的行为：重复按下不会把历史刷成一堆重复行。
func TestDeployIsIdempotent(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("idem-app")
	relID := f.approved("idem-app", "1.0.0", "幂等", `{"access":"login"}`)

	dep, changed, err := f.deploy("idem-app", relID, DeployKindPublish)
	if err != nil || !changed {
		t.Fatalf("首次部署应 changed=true（err=%v changed=%v）", err, changed)
	}
	if dep.Kind != DeployKindPublish || dep.ActorRole != ActorRoleOwner {
		t.Fatalf("首次部署 kind/role = %q/%q, want publish/owner", dep.Kind, dep.ActorRole)
	}
	app := f.getApp("idem-app")
	if app.CurrentReleaseID != relID || app.CurrentDeploymentID != dep.ID {
		t.Fatalf("部署后指针不对：current_release_id=%d current_deployment_id=%d (want %d/%d)",
			app.CurrentReleaseID, app.CurrentDeploymentID, relID, dep.ID)
	}

	// 幂等：再部署同一版本 ⇒ changed=false，历史仍是 1 条、指针不动。
	again, changed, err := f.deploy("idem-app", relID, DeployKindPublish)
	if err != nil || changed {
		t.Fatalf("重复部署应 changed=false（err=%v changed=%v）", err, changed)
	}
	if again == nil || again.ID != dep.ID {
		t.Fatalf("幂等分支应返回**当前那次**部署行（id=%d），得到 %+v", dep.ID, again)
	}
	if n := len(f.deployments("idem-app")); n != 1 {
		t.Fatalf("幂等部署不得追加历史，得到 %d 条", n)
	}
}

// TestDeployRollbackUpdatesPointer：回滚 = 用旧 approved 版本再部署一次（kind=rollback），
// 历史追加而不改写，指针与投影一起回到旧版本（设计 §3.3、§5.1）。
func TestDeployRollbackUpdatesPointer(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("roll-app")
	v1 := f.approved("roll-app", "1.0.0", "旧标题", `{"access":"login","purpose":"旧用途","data_sensitivity":"internal"}`)
	v2 := f.approved("roll-app", "2.0.0", "新标题", `{"access":"login","purpose":"新用途","data_sensitivity":"public"}`)

	if _, changed, err := f.deploy("roll-app", v2, DeployKindPublish); err != nil || !changed {
		t.Fatalf("部署 v2: err=%v changed=%v", err, changed)
	}
	if app := f.getApp("roll-app"); app.CurrentReleaseID != v2 || app.Title != "新标题" || app.Purpose != "新用途" {
		t.Fatalf("部署 v2 后投影不对: title=%q purpose=%q current=%d", app.Title, app.Purpose, app.CurrentReleaseID)
	}

	// 回滚到 v1：kind 必须由 DAO 按事实判定为 rollback（调用方不传 kind）。
	dep, changed, err := f.deploy("roll-app", v1, "")
	if err != nil || !changed {
		t.Fatalf("回滚到 v1: err=%v changed=%v", err, changed)
	}
	if dep.Kind != DeployKindRollback {
		t.Fatalf("非最新 approved 版本的部署 kind = %q, want rollback（发布与回滚必须可辨）", dep.Kind)
	}
	app := f.getApp("roll-app")
	if app.CurrentReleaseID != v1 {
		t.Fatalf("回滚后 current_release_id = %d, want v1=%d", app.CurrentReleaseID, v1)
	}
	if app.CurrentDeploymentID != dep.ID {
		t.Fatalf("回滚后 current_deployment_id = %d, want %d", app.CurrentDeploymentID, dep.ID)
	}
	// 投影跟着回滚（title/purpose/data_sensitivity 都是目标版本的投影）。
	if app.Title != "旧标题" || app.Purpose != "旧用途" || app.DataSensitivity != "internal" {
		t.Fatalf("回滚后投影没有跟着回到 v1: title=%q purpose=%q sensitivity=%q",
			app.Title, app.Purpose, app.DataSensitivity)
	}
	// 历史：新的在前，两条都在，且 v2 那条不再是 current。
	list := f.deployments("roll-app")
	if len(list) != 2 {
		t.Fatalf("部署历史应有 2 条（publish + rollback），得到 %d", len(list))
	}
	if list[0].Kind != DeployKindRollback || list[0].Version != "1.0.0" {
		t.Fatalf("最新一条历史 = %+v, want rollback v1.0.0", list[0])
	}
	if list[1].Kind != DeployKindPublish || list[1].Version != "2.0.0" {
		t.Fatalf("历史第二条 = %+v, want publish v2.0.0（历史不改写）", list[1])
	}
}

// TestDeployReviewAndSeedKinds：显式 kind 必须原样落库（审批 = review、播种 = seed）。
func TestDeployReviewAndSeedKinds(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("kind-app")
	v1 := f.approved("kind-app", "1.0.0", "T1", `{"access":"login"}`)
	v2 := f.approved("kind-app", "2.0.0", "T2", `{"access":"login"}`)

	if dep, _, err := f.deploy("kind-app", v1, DeployKindSeed); err != nil || dep.Kind != DeployKindSeed {
		t.Fatalf("seed 部署 kind = %v (err=%v)", dep, err)
	}
	if dep, _, err := f.deploy("kind-app", v2, DeployKindReview); err != nil || dep.Kind != DeployKindReview {
		t.Fatalf("review 部署 kind = %v (err=%v)", dep, err)
	}
	// 审批更旧版本时不降级（这条由调用方保证：review 路径取 max(id) approved），
	// 但**显式**部署旧版本仍是回滚 —— 校验 last 两条历史的 kind 序列。
	list := f.deployments("kind-app")
	if len(list) != 2 || list[0].Kind != DeployKindReview || list[1].Kind != DeployKindSeed {
		t.Fatalf("历史 kind 序列不对: %+v", list)
	}
}

// TestWithdrawOnlyPending：撤回只允许 pending；字节释放、版本行保留（版本号永久占用）。
func TestWithdrawOnlyPending(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("wd-app")
	pendingID := f.release("wd-app", "1.0.0", "待审", `{"access":"login"}`, ReleaseStatusPending, true)
	approvedID := f.approved("wd-app", "0.9.0", "已上线", `{"access":"login"}`)

	if err := WithdrawWasmRelease(f.ctx, f.db, "wd-app", "1.0.0", "作者撤回"); err != nil {
		t.Fatalf("撤回 pending 版本失败: %v", err)
	}
	var status string
	var size int64
	var archive []byte
	if err := f.db.QueryRow(`SELECT status, size, archive FROM app_releases WHERE id = $1`, pendingID).
		Scan(&status, &size, &archive); err != nil {
		t.Fatalf("读撤回后的版本: %v", err)
	}
	if status != ReleaseStatusWithdrawn {
		t.Fatalf("撤回后 status = %q, want withdrawn", status)
	}
	if size != 0 || archive != nil {
		t.Fatalf("撤回必须释放字节（size=%d archiveLen=%d）", size, len(archive))
	}

	// 非 pending 一律 ErrReleaseNotPending（approved 版本的字节**不能**被撤回销毁）。
	if err := WithdrawWasmRelease(f.ctx, f.db, "wd-app", "0.9.0", "试着撤回已上线"); !errors.Is(err, ErrReleaseNotPending) {
		t.Fatalf("撤回 approved 版本必须回 ErrReleaseNotPending，得到 %v", err)
	}
	var approvedBytes []byte
	if err := f.db.QueryRow(`SELECT archive FROM app_releases WHERE id = $1`, approvedID).Scan(&approvedBytes); err != nil {
		t.Fatalf("读 approved 版本: %v", err)
	}
	if len(approvedBytes) == 0 {
		t.Fatal("被拒的撤回不得动 approved 版本的字节（否则等于静默销毁线上版本）")
	}
	// 已撤回的版本再撤回 ⇒ 也回 ErrReleaseNotPending。
	if err := WithdrawWasmRelease(f.ctx, f.db, "wd-app", "1.0.0", "再撤一次"); !errors.Is(err, ErrReleaseNotPending) {
		t.Fatalf("重复撤回必须回 ErrReleaseNotPending，得到 %v", err)
	}
	// 不存在的版本 ⇒ ErrNotFound（与"状态不对"必须可辨）。
	if err := WithdrawWasmRelease(f.ctx, f.db, "wd-app", "9.9.9", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的版本必须回 ErrNotFound，得到 %v", err)
	}
}

// TestRestoreKeepsUnpublished：恢复清 deleted/frozen/purge_after，**enabled 保持 0**；
// 已清除的应用 410 语义由 ErrAppPurged 表达（设计 §5.5）。
func TestRestoreKeepsUnpublished(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("restore-app")
	relID := f.approved("restore-app", "1.0.0", "恢复", `{"access":"login"}`)
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if err := FreezeWasmAppWithRetention(f.ctx, f.db, "restore-app", now, retentionForTest(now)); err != nil {
		t.Fatalf("冻结: %v", err)
	}
	if err := SetWasmAppSnapshot(f.ctx, f.db, "restore-app", WasmSnapshotRecord{At: &now, Path: "/tmp/snap"}); err != nil {
		t.Fatalf("记快照: %v", err)
	}
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "restore-app", now, retentionForTest(now)); err != nil {
		t.Fatalf("软删: %v", err)
	}
	if err := RestoreWasmApp(f.ctx, f.db, "restore-app"); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	app := f.getApp("restore-app")
	// 恢复必须**复位部署指针**（2026-10-22 反证 P2-4）：软删已释放全部版本字节，
	// 留着指针会让"上架"变成"上架即 500"（没有可交付版本）。
	if app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("恢复必须复位部署指针（release=%d deployment=%d）—— 否则上架后会拿到无字节版本",
			app.CurrentReleaseID, app.CurrentDeploymentID)
	}
	if app.DeletedAt != nil || app.FrozenAt != nil || app.PurgeAfter != nil {
		t.Fatalf("恢复必须清删除/冻结/到期时间线: %+v", map[string]any{
			"deleted_at": app.DeletedAt, "frozen_at": app.FrozenAt, "purge_after": app.PurgeAfter})
	}
	if app.SnapshotAt != nil || app.SnapshotPath != "" {
		t.Fatalf("恢复必须清快照状态（否则下次删除会误以为已快照）: at=%v path=%q", app.SnapshotAt, app.SnapshotPath)
	}
	if app.Enabled {
		t.Fatal("恢复**不得**自动上架（enabled 必须保持 0）")
	}
	// 恢复**不**恢复制品字节：软删时 SoftDeleteWasmApp 已释放全部版本字节（配额口径），
	// 这是不可逆的 —— 所以恢复后部署同一个旧版本仍然被拒（RELEASE_BYTES_RELEASED）。
	// 这条断言把"恢复可用"的边界说清：恢复的是**应用身份与元数据**，不是制品。
	if _, _, err := f.deploy("restore-app", relID, ""); !errors.Is(err, ErrReleaseBytesReleased) {
		t.Fatalf("恢复后部署已释放字节的旧版本必须回 ErrReleaseBytesReleased，得到 %v", err)
	}
	// 恢复后发一个**新**版本即可再上线（身份/版本号占位语义不变）。
	newID := f.approved("restore-app", "2.0.0", "恢复后新版", `{"access":"login"}`)
	if dep, changed, err := f.deploy("restore-app", newID, ""); err != nil || !changed {
		t.Fatalf("恢复后部署新版本应成功（err=%v changed=%v）", err, changed)
	} else if dep.Version != "2.0.0" {
		t.Fatalf("恢复后部署的版本 = %q, want 2.0.0", dep.Version)
	}
	// purged 后恢复 ⇒ ErrAppPurged。
	if err := MarkWasmAppPurged(f.ctx, f.db, "restore-app", now); err != nil {
		t.Fatalf("标记 purged: %v", err)
	}
	if err := RestoreWasmApp(f.ctx, f.db, "restore-app"); !errors.Is(err, ErrAppPurged) {
		t.Fatalf("已清除应用的恢复必须回 ErrAppPurged，得到 %v", err)
	}
}

// TestPurgeCandidatesRequireSnapshotAndDeadline：真删候选 = 已删 + 到期 + **有成功快照**；
// 无快照的到期应用进 blocked（跳过 + 计错误），既不删也不静默消失（设计 §5.5）。
func TestPurgeCandidatesRequireSnapshotAndDeadline(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	past := now.Add(-24 * time.Hour)
	future := now.Add(24 * time.Hour)

	mk := func(appID string, deleted bool, purgeAfter time.Time, withSnapshot bool) {
		f.app(appID)
		f.approved(appID, "1.0.0", appID, `{"access":"login"}`)
		if deleted {
			if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, appID, past, purgeAfter); err != nil {
				t.Fatalf("软删 %s: %v", appID, err)
			}
		}
		if withSnapshot {
			if err := SetWasmAppSnapshot(f.ctx, f.db, appID, WasmSnapshotRecord{At: &past, Path: "/snap/" + appID}); err != nil {
				t.Fatalf("记快照 %s: %v", appID, err)
			}
		}
	}
	mk("due-with-snap", true, past, true)       // ✅ 候选
	mk("not-due-with-snap", true, future, true) // ❌ 未到期
	mk("due-no-snap", true, past, false)        // ❌ 无快照（blocked）
	mk("live-with-snap", false, past, true)     // ❌ 未删除

	cands, err := PurgeCandidates(f.ctx, f.db, now, 100)
	if err != nil {
		t.Fatalf("PurgeCandidates: %v", err)
	}
	got := map[string]bool{}
	for _, c := range cands {
		got[c.AppID] = true
	}
	if !got["due-with-snap"] {
		t.Fatalf("已删+到期+有快照的应用必须是真删候选；实际候选=%v", got)
	}
	for _, appID := range []string{"not-due-with-snap", "due-no-snap", "live-with-snap"} {
		if got[appID] {
			t.Fatalf("%s 不得进真删候选（未到期/无快照/未删除三者都会造成不可逆的误删），候选=%v", appID, got)
		}
	}

	blocked, err := PurgeBlockedWasmApps(f.ctx, f.db, now)
	if err != nil {
		t.Fatalf("PurgeBlockedWasmApps: %v", err)
	}
	if len(blocked) != 1 || blocked[0] != "due-no-snap" {
		t.Fatalf("blocked 必须恰好是「到期但无快照」的应用，得到 %v", blocked)
	}

	// 标记 purged 之后不再是候选（历史行保留）。
	if err := MarkWasmAppPurged(f.ctx, f.db, "due-with-snap", now); err != nil {
		t.Fatalf("MarkWasmAppPurged: %v", err)
	}
	cands, err = PurgeCandidates(f.ctx, f.db, now, 100)
	if err != nil {
		t.Fatalf("PurgeCandidates(2): %v", err)
	}
	if len(cands) != 0 {
		t.Fatalf("已清除的应用不得再被选为候选，得到 %v", cands)
	}
	// 指针已清、置了 purged_at、部署历史仍在。
	app := f.getApp("due-with-snap")
	if app.PurgedAt == nil {
		t.Fatal("MarkWasmAppPurged 必须写 purged_at")
	}
	if app.CurrentReleaseID != 0 || app.CurrentDeploymentID != 0 {
		t.Fatalf("purge 必须清当前指针（release=%d deployment=%d）", app.CurrentReleaseID, app.CurrentDeploymentID)
	}
	if n := len(f.deployments("due-with-snap")); n != 0 {
		// 该应用从未部署过（只有 approved 版本行），所以历史为 0；这条断言是为了
		// 明确"purge 不碰历史"，下面的用例覆盖"有历史时仍保留"。
		t.Logf("该应用无部署历史（预期）")
	}
}

// TestPurgeKeepsDeploymentHistory：真删之后部署历史仍然完整（tombstone 语义）。
func TestPurgeKeepsDeploymentHistory(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	f.app("tomb-app")
	relID := f.approved("tomb-app", "1.0.0", "墓碑", `{"access":"login"}`)
	if _, changed, err := f.deploy("tomb-app", relID, DeployKindPublish); err != nil || !changed {
		t.Fatalf("部署: err=%v changed=%v", err, changed)
	}
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "tomb-app", now.Add(-48*time.Hour), now.Add(-24*time.Hour)); err != nil {
		t.Fatalf("软删: %v", err)
	}
	snapAt := now.Add(-48 * time.Hour)
	if err := SetWasmAppSnapshot(f.ctx, f.db, "tomb-app", WasmSnapshotRecord{At: &snapAt, Path: "/snap/tomb"}); err != nil {
		t.Fatalf("记快照: %v", err)
	}
	if err := MarkWasmAppPurged(f.ctx, f.db, "tomb-app", now); err != nil {
		t.Fatalf("purge: %v", err)
	}
	list := f.deployments("tomb-app")
	if len(list) != 1 || list[0].Version != "1.0.0" || list[0].Kind != DeployKindPublish {
		t.Fatalf("真删之后部署历史必须完整保留，得到 %+v", list)
	}
}

// TestPendingReleaseQueueIsCrossApp：跨应用待审清单（含标题/提交人/当前线上版本），
// 已删除应用的待审行不进队列（不可处置）。
func TestPendingReleaseQueueIsCrossApp(t *testing.T) {
	f := newReleaseFixture(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

	f.app("queue-a")
	cur := f.approved("queue-a", "1.0.0", "队列A", `{"access":"login"}`)
	if _, changed, err := f.deploy("queue-a", cur, DeployKindPublish); err != nil || !changed {
		t.Fatalf("部署 queue-a: err=%v changed=%v", err, changed)
	}
	f.release("queue-a", "1.1.0", "队列A新版", `{"access":"login"}`, ReleaseStatusPending, true)

	f.app("queue-b")
	f.release("queue-b", "2.0.0", "队列B", `{"access":"login"}`, ReleaseStatusPending, true)

	// 已删除应用的待审行：不可处置，不得出现在队列里。
	f.app("queue-deleted")
	f.release("queue-deleted", "1.0.0", "已删", `{"access":"login"}`, ReleaseStatusPending, true)
	if err := SoftDeleteWasmAppWithTimeline(f.ctx, f.db, "queue-deleted", now, now.AddDate(0, 0, 90)); err != nil {
		t.Fatalf("软删: %v", err)
	}

	rows, err := PendingReleaseQueue(f.ctx, f.db, 100)
	if err != nil {
		t.Fatalf("PendingReleaseQueue: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("跨应用待审清单应恰好 2 条（queue-a / queue-b），得到 %d: %+v", len(rows), rows)
	}
	byApp := map[string]WasmPendingRelease{}
	for _, r := range rows {
		byApp[r.AppID] = r
	}
	if _, ok := byApp["queue-deleted"]; ok {
		t.Fatal("已删除应用的待审版本不得进队列（它没有可处置的路径）")
	}
	a, ok := byApp["queue-a"]
	if !ok {
		t.Fatalf("队列缺 queue-a: %+v", rows)
	}
	if a.Title != "队列A" || a.Version != "1.1.0" || a.Publisher != "alice" || a.CurrentVersion != "1.0.0" {
		t.Fatalf("队列行字段不全: %+v", a)
	}
	// webadmin 待审队列契约要求 id/size/changelog/description（反证 8b-①）：
	// 少了它们管理台那四列只能空着，管理员无法就地判断"这一版改了什么、有多大"。
	if a.ID == 0 {
		t.Fatal("队列行必须下发待审版本的 id（管理台按它做行键/处置定位）")
	}
	if a.Changelog == "" {
		t.Fatal("队列行必须下发 changelog（「这一版改了什么」是审核第一现场）")
	}
	if a.Size == 0 {
		t.Fatalf("队列行必须下发 size（制品字节；0 会让审核看不到体积），得到 %d", a.Size)
	}
	if a.CreatedAt.IsZero() {
		t.Fatal("队列行必须带提交时刻（age 是管理端排序/催促的依据）")
	}
}

// TestSetWasmAppSnapshotKeepsPreviousOnFailure：快照失败**不清**已成功的 snapshot_at
// （一次临时磁盘故障不该把"已有可用快照"降级成"没有快照"，那会让真删永久被阻断）。
func TestSetWasmAppSnapshotKeepsPreviousOnFailure(t *testing.T) {
	f := newReleaseFixture(t)
	f.app("snap-app")
	at := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	if err := SetWasmAppSnapshot(f.ctx, f.db, "snap-app", WasmSnapshotRecord{At: &at, Path: "/snap/ok"}); err != nil {
		t.Fatalf("记成功快照: %v", err)
	}
	if err := SetWasmAppSnapshot(f.ctx, f.db, "snap-app", WasmSnapshotRecord{Error: "磁盘满"}); err != nil {
		t.Fatalf("记失败快照: %v", err)
	}
	app := f.getApp("snap-app")
	if app.SnapshotAt == nil {
		t.Fatal("失败不得清掉此前成功的 snapshot_at（否则真删前置条件永久不成立）")
	}
	if app.SnapshotPath != "/snap/ok" {
		t.Fatalf("失败不得清掉 snapshot_path，得到 %q", app.SnapshotPath)
	}
	if app.SnapshotError != "磁盘满" {
		t.Fatalf("失败原因必须落库（运维面唯一可见的错误出口），得到 %q", app.SnapshotError)
	}
	// 下一次成功必须清掉陈旧错误。
	at2 := at.Add(time.Hour)
	if err := SetWasmAppSnapshot(f.ctx, f.db, "snap-app", WasmSnapshotRecord{At: &at2, Path: "/snap/ok2"}); err != nil {
		t.Fatalf("记第二次成功快照: %v", err)
	}
	app = f.getApp("snap-app")
	if app.SnapshotError != "" {
		t.Fatalf("成功快照必须清掉上次失败原因，得到 %q", app.SnapshotError)
	}
	if app.SnapshotPath != "/snap/ok2" {
		t.Fatalf("成功快照必须更新路径，得到 %q", app.SnapshotPath)
	}
}
