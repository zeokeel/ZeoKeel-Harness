package api

// A8 / C-08 + Lead 改动的核对判据（2026-10-22 第二轮服务端）。
//
// A8「驳回永久烧掉一个版本号，却没有影响面提示」：驳回只清归档字节、不删行 ⇒
// `(app_id, version)` 永久占位，作者"改完再发同一版"必然撞 MustBeNewer。回执与审计
// 都必须明写这件事。
//
// C-08「审核关闭后遗留 pending 没有任何清理路径」：`POST /releases/purge-stale` 把它们
// 标 withdrawn（reason 固定）、释放字节、版本号仍占位、写审计、幂等；审核开关仍开启时
// 一律拒绝（否则等于绕过审核）。
//
// Lead 改动核对（反证 F-1/F-3/F-4）：
//   - F-1：徽标 `pending_count` 与待审队列 `total` 必须同值，且**已删除应用的 pending
//     两边都不算**（两源分叉会让页头数字永远清不掉）；
//   - F-3：已删除应用的 `GET …/:app_id/releases` 必须 200（只读详情不再 404）；
//   - F-4：用户可见的错误 hint 里不得出现「后台任务」这类未实现措辞。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// TestRejectResponseWarnsVersionPermanentlyOccupied 覆盖 A8 的回执 + 审计 + 占位事实。
func TestRejectResponseWarnsVersionPermanentlyOccupied(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("rej-tool", "alice")
	e.seedLifecycleRelease("rej-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("rej-tool", "1.1.0", serverstore.ReleaseStatusPending, true)

	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/rej-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": "用途描述过简，请补充数据流向"})
	var out struct {
		Status          string `json:"status"`
		VersionOccupied bool   `json:"version_occupied"`
		Note            string `json:"note"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("status = %q, want rejected", out.Status)
	}
	if !out.VersionOccupied {
		t.Fatal("A8：拒绝回执必须显式标注 version_occupied=true（版本号永久占用）")
	}
	for _, want := range []string{"永久占用", "升版本号"} {
		if !strings.Contains(out.Note, want) {
			t.Fatalf("拒绝回执 note 必须写明「%s」: %q", want, out.Note)
		}
	}
	// 版本行仍占位（驳回不删行，只释放字节）：状态 rejected、字节已清、size=0。
	status, archiveEmpty, size := e.releaseState("rej-tool", "1.1.0")
	if status != serverstore.ReleaseStatusRejected || !archiveEmpty || size != 0 {
		t.Fatalf("驳回后版本行必须保留且释放字节: status=%q archiveEmpty=%v size=%d", status, archiveEmpty, size)
	}
	if n := e.countReleases("rej-tool"); n != 2 {
		t.Fatalf("驳回不得删除版本行（行仍占号），版本行数 = %d, want 2", n)
	}
	// 审计明细同样写明占号（事后复盘要看得到）。
	details := e.auditDetails("rej-tool", "wasm_app_release_reject")
	if len(details) == 0 || !strings.Contains(details[len(details)-1], "版本号永久占用") {
		t.Fatalf("拒绝审计必须写明版本号永久占用；details=%v", details)
	}
	// 事实核对：同一版本号再发布必被拒（永久占位的直接后果）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/rej-tool/releases", e.tokens["alice"],
		e.payload("rej-tool", "1.1.0", testGuestModule(t), goodConfig()))
	if w.Code < 400 {
		t.Fatalf("同一版本号重发必须被拒（永久占位），得到 %d %s", w.Code, w.Body.String())
	}
}

// TestPurgeStalePendingReleases 覆盖 C-08 的成功路径 / 幂等 / 审计 / 范围。
func TestPurgeStalePendingReleases(t *testing.T) {
	e := newTestEnv(t)
	// 两个存活应用各有一个待审版本。
	e.seedLifecycleApp("stale-a", "alice")
	e.seedLifecycleRelease("stale-a", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("stale-a", "1.1.0", serverstore.ReleaseStatusPending, true)
	e.seedLifecycleApp("stale-b", "alice")
	e.seedLifecycleRelease("stale-b", "2.0.0", serverstore.ReleaseStatusPending, true)
	// 一个**已软删**应用的待审版本：不在徽标/队列里 ⇒ 也不该被本端点改动。
	e.seedLifecycleApp("stale-gone", "alice")
	e.seedLifecycleRelease("stale-gone", "3.0.0", serverstore.ReleaseStatusPending, true)
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "stale-gone",
		e.h.now().UTC(), e.h.now().UTC().AddDate(0, 0, 90)); err != nil {
		t.Fatalf("软删应用: %v", err)
	}

	// 审核开关缺省是**关**（默认免审 + 事后抽检）⇒ 允许清理。
	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/releases/purge-stale", "", nil)
	var out struct {
		Purged          int    `json:"purged"`
		Changed         bool   `json:"changed"`
		Status          string `json:"status"`
		Reason          string `json:"reason"`
		VersionOccupied bool   `json:"version_occupied"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Purged != 2 || !out.Changed {
		t.Fatalf("应清理 2 个存活应用的待审版本，得到 purged=%d changed=%v", out.Purged, out.Changed)
	}
	if out.Status != serverstore.ReleaseStatusWithdrawn || !out.VersionOccupied {
		t.Fatalf("清理后必须是 withdrawn 且版本号仍占用: %+v", out)
	}
	if out.Reason != serverstore.StalePendingPurgeReason {
		t.Fatalf("reason 必须是固定文案 %q（作者面归因），得到 %q", serverstore.StalePendingPurgeReason, out.Reason)
	}
	// 两个存活行：withdrawn + 字节释放 + reason 落库。
	for _, tc := range []struct{ app, version string }{{"stale-a", "1.1.0"}, {"stale-b", "2.0.0"}} {
		status, archiveEmpty, size := e.releaseState(tc.app, tc.version)
		if status != serverstore.ReleaseStatusWithdrawn || !archiveEmpty || size != 0 {
			t.Fatalf("%s v%s 应被清理为 withdrawn 且释放字节: status=%q archiveEmpty=%v size=%d",
				tc.app, tc.version, status, archiveEmpty, size)
		}
		var reason string
		if err := e.db.QueryRow(`SELECT reason FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3`,
			serverstore.AppKindWasmApp, tc.app, tc.version).Scan(&reason); err != nil {
			t.Fatalf("读 reason: %v", err)
		}
		if reason != serverstore.StalePendingPurgeReason {
			t.Fatalf("%s v%s 的 reason = %q, want %q", tc.app, tc.version, reason, serverstore.StalePendingPurgeReason)
		}
	}
	// 已软删应用的待审行**不在候选集**里（与徽标/队列同一判据集合）。
	if status, _, _ := e.releaseState("stale-gone", "3.0.0"); status != serverstore.ReleaseStatusPending {
		t.Fatalf("已删除应用的待审版本不得被清理（它本来就不在队列里）: %q", status)
	}
	// 审计：一条组织级记录。
	var audits int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'wasm_release_purge_stale'`).Scan(&audits); err != nil {
		t.Fatalf("统计审计: %v", err)
	}
	if audits != 1 {
		t.Fatalf("清理必须写一条审计（组织级动作），得到 %d 条", audits)
	}
	// 幂等：第二次什么都不改，也不写审计。
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/releases/purge-stale", "", nil)
	var second struct {
		Purged  int  `json:"purged"`
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &second)
	if second.Purged != 0 || second.Changed {
		t.Fatalf("重复调用必须幂等（purged=0/changed=false），得到 %+v", second)
	}
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'wasm_release_purge_stale'`).Scan(&audits); err != nil {
		t.Fatalf("统计审计: %v", err)
	}
	if audits != 1 {
		t.Fatalf("幂等调用不得重复写审计，得到 %d 条", audits)
	}
}

// TestPendingBadgeMatchesQueueTotalForDeletedApps 是 F-1 的**跨端点**判据：
// 列表 `pending_count` 与队列 `total` 必须同值，且已删除应用的 pending 两边都不算。
func TestPendingBadgeMatchesQueueTotalForDeletedApps(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("badge-live", "alice")
	e.seedLifecycleRelease("badge-live", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("badge-live", "1.1.0", serverstore.ReleaseStatusPending, true)
	// 应用在 pending 状态下被删除：它的待审版本**不得**再被计入（否则徽标永远清不掉）。
	e.seedLifecycleApp("badge-gone", "alice")
	e.seedLifecycleRelease("badge-gone", "2.0.0", serverstore.ReleaseStatusPending, true)
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "badge-gone",
		e.h.now().UTC(), e.h.now().UTC().AddDate(0, 0, 90)); err != nil {
		t.Fatalf("软删应用: %v", err)
	}

	var list struct {
		PendingCount int `json:"pending_count"`
		Apps         []struct {
			AppID           string   `json:"app_id"`
			PendingCount    int      `json:"pending_count"`
			PendingReleases []string `json:"pending_releases"`
		} `json:"apps"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps?include_deleted=1", "", nil),
		http.StatusOK, &list)
	var queue struct {
		Total   int `json:"total"`
		Pending []struct {
			AppID string `json:"app_id"`
		} `json:"pending"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps/releases/pending", "", nil),
		http.StatusOK, &queue)
	if list.PendingCount != 1 {
		t.Fatalf("徽标 pending_count = %d, want 1（已删除应用的待审不计入）", list.PendingCount)
	}
	// 每一行的 pending_* 也必须是同一判据：已删除行的待审版本不得再出现在行级字段里
	// （反证 F-1 的另一半：徽标与行级字段若各查一次、判据不同，同一页会出现两个结论）。
	rowPending := map[string]struct {
		count    int
		releases []string
	}{}
	for _, a := range list.Apps {
		rowPending[a.AppID] = struct {
			count    int
			releases []string
		}{a.PendingCount, a.PendingReleases}
	}
	if got := rowPending["badge-live"]; got.count != 1 || len(got.releases) != 1 {
		t.Fatalf("存活应用的待审行级字段不对: %+v", got)
	}
	if got := rowPending["badge-gone"]; got.count != 0 || len(got.releases) != 0 {
		t.Fatalf("已删除应用的待审版本不得计入行级 pending_*（否则徽标与行内字段分叉）: %+v", got)
	}
	if queue.Total != list.PendingCount {
		t.Fatalf("徽标 %d 与队列 total %d 必须同值（F-1 的两源分叉）", list.PendingCount, queue.Total)
	}
	for _, p := range queue.Pending {
		if p.AppID == "badge-gone" {
			t.Fatal("已删除应用的待审版本不得出现在队列里")
		}
	}
	// 状态筛选 pending 与徽标同判据（行数 = 徽标数）。
	var filtered struct {
		Total int `json:"total"`
		Apps  []struct {
			AppID string `json:"app_id"`
		} `json:"apps"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps?status=pending", "", nil),
		http.StatusOK, &filtered)
	if filtered.Total != 1 || len(filtered.Apps) != 1 || filtered.Apps[0].AppID != "badge-live" {
		t.Fatalf("status=pending 必须与徽标同判据: %+v", filtered)
	}
}

// TestDeletedAppReadOnlyDetailsDoNot404 是 F-3 的判据：已删除应用的只读详情必须 200。
func TestDeletedAppReadOnlyDetailsDoNot404(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("gone-detail", "alice")
	e.seedLifecycleRelease("gone-detail", "1.0.0", serverstore.ReleaseStatusApproved, true)
	e.seedLifecycleRelease("gone-detail", "1.1.0", serverstore.ReleaseStatusPending, true)
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "gone-detail",
		e.h.now().UTC(), e.h.now().UTC().AddDate(0, 0, 90)); err != nil {
		t.Fatalf("软删应用: %v", err)
	}
	// 只读面全部 200（详情抽屉打开时要拉的三份 + 部署历史 + 诊断）。
	for _, path := range []string{
		"/api/server/admin/wasm-apps/gone-detail/releases?status=pending",
		"/api/server/admin/wasm-apps/gone-detail/releases?status=rejected",
		"/api/server/admin/wasm-apps/gone-detail/deployments",
		"/api/server/admin/wasm-apps/gone-detail/diagnostics",
	} {
		w := e.req(http.MethodGet, path, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s 对已删除应用必须 200（只读详情不再 404），得到 %d %s", path, w.Code, w.Body.String())
		}
	}
}

// TestUserFacingHintsNeverClaimBackgroundJob 是 F-4 的判据：可触达的错误 hint 里
// 不得出现「后台任务」（退役作业已实现，旧文案停在 R37 且与 restore 能力矛盾）。
func TestUserFacingHintsNeverClaimBackgroundJob(t *testing.T) {
	e := newTestEnv(t)
	e.seedLifecycleApp("hint-tool", "alice")
	e.seedLifecycleRelease("hint-tool", "1.0.0", serverstore.ReleaseStatusApproved, true)
	if err := serverstore.SoftDeleteWasmAppWithTimeline(e.ctx(), e.db, "hint-tool",
		e.h.now().UTC(), e.h.now().UTC().AddDate(0, 0, 90)); err != nil {
		t.Fatalf("软删应用: %v", err)
	}
	// 写动作对已删除应用回 404，错误体里的 message/hints 是**用户可见**的。
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/server/admin/wasm-apps/hint-tool/unpublish"},
		{http.MethodPost, "/api/server/admin/wasm-apps/hint-tool/publish"},
		{http.MethodPost, "/api/server/admin/wasm-apps/hint-tool/freeze"},
		{http.MethodPut, "/api/server/admin/wasm-apps/hint-tool/owner"},
	} {
		w := e.req(tc.method, tc.path, "", map[string]any{"owner": "bob", "frozen": true})
		raw := w.Body.String()
		if strings.Contains(raw, "后台任务") || strings.Contains(raw, "未实现") {
			t.Fatalf("%s %s 的错误回执不得出现「后台任务/未实现」措辞: %s", tc.method, tc.path, raw)
		}
		// 已清除 vs 已删除的口径必须可辨（purged 的 hint 说明不可恢复与真删作业的语义）。
		if !strings.Contains(raw, "已删除") && !strings.Contains(raw, "已清除") {
			t.Fatalf("%s %s 的错误回执必须说明应用状态: %s", tc.method, tc.path, raw)
		}
	}
	// 已清除（purged）应用：只读诊断仍 200，写动作 404 且 hint 明说不可恢复（不得提后台任务）。
	if _, err := e.db.Exec(`UPDATE apps SET purged_at = now() WHERE kind='wasm_app' AND app_id='hint-tool'`); err != nil {
		t.Fatalf("置 purged: %v", err)
	}
	if w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/hint-tool/diagnostics", "", nil); w.Code != http.StatusOK {
		t.Fatalf("已清除应用的诊断必须仍可读（审计留档），得到 %d", w.Code)
	}
	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/hint-tool/unpublish", "", nil)
	raw := w.Body.String()
	if w.Code != http.StatusNotFound {
		t.Fatalf("已清除应用的写动作应 404，得到 %d %s", w.Code, raw)
	}
	if !strings.Contains(raw, "数据已清除") || strings.Contains(raw, "后台任务") {
		t.Fatalf("已清除应用的 hint 必须说清「数据已清除、不可恢复」且不得提后台任务: %s", raw)
	}
}
