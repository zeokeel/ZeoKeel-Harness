package api

// 管理面的生命周期动作（设计契约 docs/planning/2026-10-22-wasm-lifecycle-redesign.md §6.2）。
//
// 为什么管理面必须有这一组（审计 2026-10-22 C-02/C-04/C-07）：
//   - 退役前导一份快照是运维刚需，而导出此前只挂在员工 Bearer 面 —— 管理员要么登录
//     桌面客户端、要么手搓员工令牌，且审计会把操作记成员工账号（"谁以什么身份做的" 失真）；
//   - 管理端有「已删除」筛选却没有任何删除/恢复动作（能看见、做不了）；
//   - 全组织待审队列只有计数没有清单（页头「待审 12」找不到那 12 个在哪）。
//
// 鉴权：管理会话（cookie）+ capability:read / capability:write（申报在 internal/router）。
// 审计：actor_role 一律 admin_session（与员工面 owner / super_admin 兜底可辨）。
// 实现全部复用员工面的同一段逻辑（freezeForApp / retireForApp / exportForApp …），
// 差别只有"载入应用时不受归属限制"与 actor_role。

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/registry"
)

// adminLifecycleApp 载入应用（管理员可处置任何应用；已删除行由 allowDeleted 决定）。
//
// 与 loadAdminApp 的差别：这里允许返回"已删除"的行给**恢复/导出/部署**这几条链
// （它们对已删除的处理各不相同：恢复要它、导出要它、部署要回 409 而不是 404）。
func (h *Handlers) adminLifecycleApp(c *gin.Context, allowDeleted bool) (*serverstore.WasmApp, *serverstore.User, *apperr.Error) {
	admin := serverauth.AdminUser(c)
	if admin == nil {
		return nil, nil, apperr.New(apperr.CodeAuthRequired, "未登录")
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.loadAdminApp(c, appID, allowDeleted)
	if aerr != nil {
		return nil, nil, aerr
	}
	return app, admin, nil
}

// adminDeployments 是 GET /wasm-apps/:app_id/deployments（capability:read）。
//
// 已清除（purged）的应用**也可以**读部署历史：真删保留元数据与历史正是为了回答
// "谁在什么时候把哪一版上线/下线"。
func (h *Handlers) adminDeployments(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	app, _, aerr := h.adminLifecycleApp(c, true)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.respondDeployments(c, app)
}

// adminDeployRelease 是 POST /wasm-apps/:app_id/deployments（capability:write）：
// 管理员部署/回滚任意 approved 版本（审计 2026-10-22 C-03 的处置面）。
func (h *Handlers) adminDeployRelease(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	// allowDeleted=true：把"已删除 ⇒ 409 APP_DELETED"的判定交给事务（错误码更具体），
	// 而不是在这里变成 404 —— 管理员看到"应用已删除，先恢复"才是可操作的。
	app, admin, aerr := h.adminLifecycleApp(c, true)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.deployForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
}

// adminRestoreApp 是 POST /wasm-apps/:app_id/restore（capability:write）。
func (h *Handlers) adminRestoreApp(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	app, admin, aerr := h.adminLifecycleApp(c, true)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.restoreForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
}

// adminDeleteApp 是 DELETE /wasm-apps/:app_id（capability:write）：删除（软删 + 快照）。
//
// 已删除的应用回 404（与员工面一致：重复删除不泄露状态）；真要"再看一眼"用只读面
// （列表带 include_deleted / 部署历史 / 诊断）。
func (h *Handlers) adminDeleteApp(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	app, admin, aerr := h.adminLifecycleApp(c, false)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.retireForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
}

// adminExport 是 GET /wasm-apps/:app_id/export（capability:read）：与员工面同参数。
//
// 与员工面的唯一差别：actor_role=admin_session（审计不再把管理员处置记成作者自己）。
func (h *Handlers) adminExport(c *gin.Context) {
	// 含数据/含资源的导出（?database=1 / ?assets=1）把**他人应用库与制品**交给操作者，
	// 是破坏性/高敏动作：只读权限（capability:read）不足以放行。默认 JSON 控制面导出
	// 仍按只读（排障/合规需要），写权限只加在数据面参数上。
	// （2026-10-22 生产评审管理员 P2：此前 capability:read 即可导出任意应用库。）
	if isTruthyQuery(c.Query("database")) || isTruthyQuery(c.Query("assets")) {
		admin := serverauth.AdminUser(c)
		if admin == nil {
			writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
			return
		}
		if !serverauth.HasPermission(admin, serverauth.PermCapabilityWrite) {
			writeErr(c, apperr.New(apperr.CodeForbidden, "导出应用数据/资源需要 capability:write 权限").
				WithHint("含数据/含资源的导出会把应用库或随包资源交给操作者；只读账号可导出控制面 JSON（不带 database/assets 参数）").
				WithDetail("required", serverauth.PermCapabilityWrite))
			return
		}
	}
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	app, admin, aerr := h.adminLifecycleApp(c, true)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.exportForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
}

// adminPendingReleases 是 GET /wasm-apps/releases/pending（capability:read）：
// 跨应用待审清单（设计 §5.7 / 审计 C-07 的服务端落点）。
//
// 路由是**静态段**且必须注册在 `/:app_id` 通配之前（gin 的静态优先规则会命中它，
// 但注册顺序仍是可读性要求 —— 见 internal/router/optional_apps_on.go 的注释）。
func (h *Handlers) adminPendingReleases(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	rows, err := h.pendingReleaseQueueRows(c.Request.Context())
	if err != nil {
		writeErr(c, internalErr("查询待审队列失败", err))
		return
	}
	// total 必须是**与徽标同源的全量计数**，不是本页行数（反证 F-1：200 上限会把
	// 两个"待审数"拆成两个真源）。
	total, cerr := serverstore.CountPendingReleases(c.Request.Context(), h.opt.DB)
	if cerr != nil {
		writeErr(c, internalErr("查询待审总数失败", cerr))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"pending":         rows,
		"total":           total,
		"review_required": h.reviewRequired(),
		"note": "处置复用既有 approve/reject：POST /wasm-apps/:app_id/releases/:version/{approve|reject}；" +
			"审核关闭时这批待审版本会失去意义（可让作者撤回，或管理面逐个处置）",
	})
}

// adminPurgeStaleReleases 是 POST /wasm-apps/releases/purge-stale（capability:write）：
// 审核开关**关闭**之后，把已经失去意义的积压 pending 批量标成 `withdrawn`
// （设计 §5.7 的可选清理动作；审计 2026-10-22 C-08）。
//
// 为什么需要它（C-08 原话）：审核开关关闭后遗留的 pending **没有任何清理路径**
// —— 它们永远停在"待审"（管理面能逐个通过/拒绝，作者能一个个撤回，但没有"这批都不要了"
// 的出口）。purge-stale 就是那条出口，语义与单条撤回逐字一致：置 withdrawn、释放
// 制品字节、**版本号永久占用**（行保留）。
//
// 三条纪律：
//  1. **只在审核关闭时允许**：开关打开时这些 pending 仍是可审对象，批量清掉等于绕过
//     审核。返回 409 并给出两条可操作路径（先关闭审核 / 逐个处置）。
//  2. **审计必写**（组织级动作，没有 app 维度）：清掉 N 个版本是会影响作者的动作，
//     "谁在什么时候清了多少"必须可查；0 个时不写（没有状态变更，幂等无副作用）。
//  3. **幂等**：判据在 SQL 的 `status='pending'` 里，第二次调用影响 0 行、返回 purged=0。
func (h *Handlers) adminPurgeStaleReleases(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	// **严格**读审核开关（与发布闸门同一读法）：读不到就 fail-closed 拒绝 ——
	// 用展示面的宽松读法会把"设置读故障"变成"按关闭处理，把整批待审版本清掉"。
	required, rerr := h.publishReviewRequired()
	if rerr != nil {
		writeErr(c, rerr)
		return
	}
	if required {
		e := apperr.New(apperr.CodeValidation, "审核开关仍开启：待审版本仍可审批，不能批量清理").
			WithDetail("setting_key", SettingReviewRequired).
			WithHint("先 PUT /wasm-apps/review {\"required\":false} 关闭审核（关闭那一刻起这批版本不再可能被通过），" +
				"再执行本端点；也可以让管理员逐个 approve/reject，或让作者自行 withdraw")
		e.HTTP = http.StatusConflict
		writeErr(c, e)
		return
	}
	reason := serverstore.StalePendingPurgeReason
	purged, err := serverstore.PurgeStalePendingReleases(c.Request.Context(), h.opt.DB, reason)
	if err != nil {
		writeErr(c, internalErr("清理积压待审版本失败", err))
		return
	}
	if purged > 0 {
		h.auditOrg(admin.Username, "wasm_release_purge_stale",
			fmt.Sprintf("审核关闭后清理积压待审版本 %d 个（pending → withdrawn，reason=%q，"+
				"制品字节已释放，版本号永久占用）", purged, reason))
	}
	c.JSON(http.StatusOK, gin.H{
		"purged":           purged,
		"changed":          purged > 0,
		"status":           serverstore.ReleaseStatusWithdrawn,
		"reason":           reason,
		"review_required":  false,
		"setting_key":      SettingReviewRequired,
		"version_occupied": true,
		"note": "被清理的版本行保留（版本号永久占用，作者重发需升版本号）；" +
			"重复调用是幂等的（第二次 purged=0、不写审计）",
	})
}

// adminFreezeLifecycle 是管理面冻结/解冻的入口（复用共享实现；admin.go 的 adminFreeze
// 委托到这里）。返回 handled=false 表示请求体不合法，调用方不必再处理。
func (h *Handlers) adminFreezeLifecycle(c *gin.Context) bool {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return true
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return true
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.loadAdminApp(c, appID, false)
	if aerr != nil {
		writeErr(c, aerr)
		return true
	}
	// body 可选（缺省 = 冻结）：只认显式的 {"frozen":false} 表示解冻。
	req := struct {
		Frozen *bool `json:"frozen"`
	}{}
	if c.Request.ContentLength > 0 {
		if berr := bindAdminJSON(c, &req); berr != nil {
			writeErr(c, berr)
			return true
		}
	}
	frozen := true
	if req.Frozen != nil {
		frozen = *req.Frozen
	}
	if frozen {
		h.freezeForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
		return true
	}
	h.unfreezeForApp(c, app, admin.Username, serverstore.ActorRoleAdminSession)
	return true
}
