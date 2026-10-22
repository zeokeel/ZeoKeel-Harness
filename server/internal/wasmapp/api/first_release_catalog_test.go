package api

// U-02（终端用户评审 2026-10-23，P1）：**作者的首版待审应用从应用中心彻底消失**。
//
// 现场（评审原文）：管理员打开审核（`wasm.review_required`）后，作者发布的**第一个**
// 版本落在 pending（publish.go：`review ⇒ status=pending`），而"生效"只发生在
// approved 分支（commitRelease 里 `in.status == approved` 才 `DeployWasmRelease`）
// ⇒ 首版待审期间 `apps.current_release_id` 恒为 0。员工面目录（`read.go` 的 catalog）
// 的目录条件要求 `current_release_id > 0`，**没有归属人例外** ⇒ 这个应用在应用中心里
// 整行消失：
//
//	· 作者看不到审核状态（"我发的版本去哪了"）；
//	· 看不到被拒理由（`app_releases.reason` 的唯一员工面读路径挂在版本历史上，
//	  而版本历史入口在目录行里）；
//	· **点不到撤回**（`POST …/releases/:version/withdraw` 服务端早就有，缺的只是
//	  目录行这个依附面）；
//	· 同一时刻发布成功块写死"待审核（线上仍是旧版本）"并照旧给出分享深链 ——
//	  线上根本没有旧版本，同事点开得到"这个应用不存在（可能已被删除或改名）"。
//
// 本文件钉住服务端那一半的行为判据：
//
//	① 归属人（review=on、首版 pending）在目录里**看得到**这一行，且行里带着
//	   `first_release` / `first_release_status` / `first_release_version`，`enabled=false`
//	   （没有可交付版本 ⇒ 打不开），标题取**待审那一版**的标题（不是 app_id 占位）；
//	② **非归属人看不到**这一行（与"不存在"同形，不泄露存在性），
//	   超管在员工面也不扩面（与 R6-B-3 的冻结行同口径：严格归属）；
//	③ 被拒后行里带 `first_release_reason`（理由必须有读路径），状态变 rejected；
//	④ **撤回可达**：同一行上的 `first_release_version` 就是撤回请求的路径参数，
//	   撤回后行仍在（状态 withdrawn）、线上仍没有任何版本；
//	⑤ 发布响应下发 `release.current_version`：首版待审 = 空串（线上没有任何版本），
//	   有旧版本待审 = 旧版本号，已生效 = 本次版本号 —— 客户端靠它区分"首版"与
//	   "线上仍是旧版本"（U-02 的文案与分享链接判据都建在它上面）。
//
// ---- 变异验证（删哪行 ⇒ 哪条红；实跑记录见本轮汇报）----
//   - `read.go` 里把 `if a.CurrentReleaseID <= 0 { ... }` 改回无条件的 `continue`
//     ⇒ ①②③④ 全红（这就是缺陷的原形态）；
//   - 把 `firstReleaseOf` 的 `if !ownedByViewer { continue }` 去掉（对所有人下发）
//     ⇒ ② 红（员工面泄露"某个标识下有个待审应用"）；
//   - 行里去掉 `first_release_version` ⇒ ④ 红（撤回拿不到版本号）；
//   - 行里去掉 `first_release_reason` ⇒ ③ 红（被拒理由重新变成不可读）；
//   - 行里的 `enabled` 改回 `a.Enabled`（true）⇒ ① 红（一个打不开的应用被标成可用）；
//   - 行里的标题改回 `a.Title`（首版待审时是 app_id 占位）⇒ ① 红；
//   - 发布响应去掉 `release.current_version` ⇒ ⑤ 红。

import (
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/appcfg"
)

// u02Row 取目录里某个 app_id 的行；不存在返回 nil（与 catalogRow 同一份实现口径，
// 这里显式重述返回契约，避免用例读起来像"拿到空 map 也算有行"）。
func u02Row(t *testing.T, e *testEnv, token, appID string) map[string]any {
	t.Helper()
	return e.catalogRow(token, appID)
}

// TestCatalogListsFirstReleasePendingForOwnerOnly 钉住 ①②④。
func TestCatalogListsFirstReleasePendingForOwnerOnly(t *testing.T) {
	e := reviewEnv(t)
	guest := testGuestModule(t)
	// 标题刻意与 app_id 不同：目录行必须显示**待审那一版**的标题（作者认得出自己做的是
	// 哪个应用），而不是 publish.go 写进 apps.title 的 app_id 占位。
	e.publishTitled(e.tokens["alice"], "u02-first", "1.0.0",
		"值班交接小工具", "把值班交接记录整理成一张卡片", string(appcfg.AccessLogin), guest)

	// 前提：首版待审 ⇒ 线上没有任何版本（这正是缺陷成立的现场）。
	if app := e.appRow("u02-first"); app.CurrentReleaseID != 0 {
		t.Fatalf("前提不成立：首版待审时 current_release_id 应仍为 0，得到 %d", app.CurrentReleaseID)
	}

	// ① 归属人看得到自己的首版待审行。
	row := u02Row(t, e, e.tokens["alice"], "u02-first")
	if row == nil {
		t.Fatal("U-02：归属人必须能在目录里看到自己首版待审的应用 —— 否则作者无法查看审核状态、" +
			"看不到被拒理由、也点不到撤回（撤回入口挂在目录行的版本历史里）")
	}
	if row["first_release"] != true {
		t.Fatalf("首版行的判据字段 first_release 必须是 true: %+v", row)
	}
	if row["first_release_status"] != serverstore.ReleaseStatusPending {
		t.Fatalf("first_release_status = %v, want %q", row["first_release_status"], serverstore.ReleaseStatusPending)
	}
	if row["first_release_version"] != "1.0.0" {
		t.Fatalf("first_release_version = %v, want 1.0.0（撤回请求的路径参数）", row["first_release_version"])
	}
	if _, ok := row["first_release_reason"]; ok {
		t.Fatalf("pending 行不应带被拒理由（数据库保证 approved/pending 的 reason 为空串）: %+v", row)
	}
	// 打不开：没有可交付版本。`enabled` 是"能不能用"的对外口径（客户端禁用打开、
	// 宿主工具面判断可用性），不能因为"应用行是上架状态"就下发 true。
	if row["enabled"] != false {
		t.Fatalf("首版待审行必须 enabled=false（没有可交付版本，打开必然失败）: %+v", row)
	}
	if row["is_owner"] != true || row["current_version"] != "" {
		t.Fatalf("首版行必须 is_owner=true 且 current_version 为空: %+v", row)
	}
	if row["title"] != "值班交接小工具" {
		t.Fatalf("首版行的标题必须取待审那一版的标题（不是 app_id 占位），得到 %v", row["title"])
	}
	if row["description"] != "把值班交接记录整理成一张卡片" {
		t.Fatalf("首版行的说明必须取待审那一版的用途，得到 %v", row["description"])
	}

	// ② 非归属人看不到（与"不存在"同形、不泄露存在性）。
	if bob := u02Row(t, e, e.tokens["bob"], "u02-first"); bob != nil {
		t.Fatalf("非归属人不得看到他人的首版待审行（不泄露存在性）: %+v", bob)
	}
	// 超管在**员工面**同样不扩面（管理员面在 webadmin；与 R6-B-3 的冻结行同口径）。
	if boss := u02Row(t, e, e.tokens["boss"], "u02-first"); boss != nil {
		t.Fatalf("员工面不为超管扩面：首版待审行只对严格归属人（apps.owner）下发: %+v", boss)
	}

	// ④ 撤回可达：用行里下发的版本号发撤回请求（员工面端点，服务端早已存在）。
	if w := e.req(http.MethodPost,
		"/api/client/v2/apps/wasm/u02-first/releases/"+row["first_release_version"].(string)+"/withdraw",
		e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("按目录行下发的版本号撤回首版待审版本应 200，得到 %d %s", w.Code, w.Body.String())
	}
	// 撤回后行仍在（不是"消失"）：作者要能看到"这一版已经撤回、线上仍没有版本、
	// 标识仍被自己占用"，才知道下一步是发新版。
	after := u02Row(t, e, e.tokens["alice"], "u02-first")
	if after == nil {
		t.Fatal("撤回后归属人仍应看到这一行（状态变 withdrawn），否则作者无从判断标识是否还占着")
	}
	if after["first_release_status"] != serverstore.ReleaseStatusWithdrawn {
		t.Fatalf("撤回后 first_release_status = %v, want %q", after["first_release_status"], serverstore.ReleaseStatusWithdrawn)
	}
	if after["enabled"] != false {
		t.Fatalf("撤回后仍没有任何可交付版本 ⇒ enabled 必须仍是 false: %+v", after)
	}
	if bob := u02Row(t, e, e.tokens["bob"], "u02-first"); bob != nil {
		t.Fatalf("撤回不清除归属关系：非归属人仍不得看到该行: %+v", bob)
	}
}

// TestCatalogFirstReleaseRejectedShowsReason 钉住 ③：被拒理由必须有读路径。
//
// 理由的写入侧一直是通的（`SetReleaseStatusForReview` 的 rejected 分支把理由与"释放
// 归档"写在同一条 UPDATE 里），读侧在首版这一档原先根本没有出口（行都不在目录里）。
func TestCatalogFirstReleaseRejectedShowsReason(t *testing.T) {
	e := reviewEnv(t)
	e.publishOK(e.tokens["alice"], "u02-rejected", "1.0.0", testGuestModule(t), goodConfig())
	const reason = "首版请补充数据来源说明，并去掉示例手机号"
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/u02-rejected/releases/1.0.0/reject", "",
		map[string]any{"reason": reason}), http.StatusOK, &struct{}{})

	row := u02Row(t, e, e.tokens["alice"], "u02-rejected")
	if row == nil {
		t.Fatal("被拒的首版应用同样必须对归属人可见（这是作者唯一能看到理由的地方）")
	}
	if row["first_release_status"] != serverstore.ReleaseStatusRejected {
		t.Fatalf("first_release_status = %v, want %q", row["first_release_status"], serverstore.ReleaseStatusRejected)
	}
	if row["first_release_reason"] != reason {
		t.Fatalf("first_release_reason = %v, want %q（被拒理由必须随行下发）", row["first_release_reason"], reason)
	}
	if row["enabled"] != false {
		t.Fatalf("被拒后线上仍没有任何版本 ⇒ enabled 必须 false: %+v", row)
	}
	// 被拒后「发新版」是唯一出路：行必须还在，且 `is_owner` 让客户端给出该入口。
	if row["is_owner"] != true {
		t.Fatalf("被拒行必须 is_owner=true（客户端据此给出「发新版」入口）: %+v", row)
	}
	if bob := u02Row(t, e, e.tokens["bob"], "u02-rejected"); bob != nil {
		t.Fatalf("非归属人不得看到被拒的首版行: %+v", bob)
	}
}

// TestPublishResponseLiveVersionDistinguishesFirstRelease 钉住 ⑤。
//
// 这是客户端文案与分享链接判据的**唯一**服务端事实来源：
//   - 首版待审 ⇒ `current_version == ""`（线上没有任何版本 ⇒ 不许说"线上仍是旧版本"，
//     也不许给分享链接）；
//   - 有旧版本待审 ⇒ `current_version == "1.0.0"`（既有语义：线上仍是旧版本）；
//   - 已生效 ⇒ `current_version == 本次版本号`。
func TestPublishResponseLiveVersionDistinguishesFirstRelease(t *testing.T) {
	e := reviewEnv(t)

	// ① 首版待审：线上没有任何版本。
	first := e.publishOK(e.tokens["alice"], "u02-live", "1.0.0", testGuestModule(t), goodConfig())
	if first["status"] != serverstore.ReleaseStatusPending || first["current"] != false {
		t.Fatalf("前提不成立：首版应停在 pending 且非当前版本: %+v", first)
	}
	if v, ok := first["current_version"]; !ok {
		t.Fatalf("发布响应必须下发 release.current_version（客户端据此区分首版与「线上仍是旧版本」）: %+v", first)
	} else if v != "" {
		t.Fatalf("首版待审时 release.current_version 必须是空串（线上没有任何版本），得到 %v", v)
	}

	// ② 通过后线上有 1.0.0；此时再发 1.1.0（审核开启）⇒ 待审但不影响线上版本。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/u02-live/releases/1.0.0/approve", "", nil), http.StatusOK, &struct{}{})
	second := e.publishOK(e.tokens["alice"], "u02-live", "1.1.0", testGuestModule(t), goodConfig())
	if second["status"] != serverstore.ReleaseStatusPending {
		t.Fatalf("审核开启时新版本应停在 pending: %+v", second)
	}
	if second["current_version"] != "1.0.0" {
		t.Fatalf("有旧版本待审时 release.current_version 必须是线上那一版（1.0.0），得到 %v", second["current_version"])
	}

	// ③ 已生效（审核关闭）：current_version = 本次版本号。
	e.setReviewRequired(false)
	live := e.publishOK(e.tokens["alice"], "u02-live", "1.2.0", testGuestModule(t), goodConfig())
	if live["status"] != serverstore.ReleaseStatusApproved || live["current"] != true {
		t.Fatalf("审核关闭时应直接生效: %+v", live)
	}
	if live["current_version"] != "1.2.0" {
		t.Fatalf("已生效版本的 current_version 必须是本次版本号，得到 %v", live["current_version"])
	}

	// ④ 审核关掉之后，首版待审那一档不再出现（行回到正常形态）：这条钉住"新字段不
	// 会跟着旧数据跑到正常行上"。
	row := u02Row(t, e, e.tokens["alice"], "u02-live")
	if row == nil {
		t.Fatal("已上线应用必须在目录里")
	}
	if _, ok := row["first_release"]; ok {
		t.Fatalf("有生效版本的行不得带 first_release 字段（会把正常应用渲染成「尚未上线」）: %+v", row)
	}
	if row["enabled"] != true || row["current_version"] != "1.2.0" {
		t.Fatalf("已上线行应 enabled=true 且 current_version=1.2.0: %+v", row)
	}
}
