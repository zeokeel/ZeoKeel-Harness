package api

// 本文件是**部署 / 回滚 / 撤回 / 恢复**四条动作的 HTTP 面（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §3.3、§5.1–§5.3、§6）。
//
// 为什么需要这一层（审计 2026-10-22 C-03/C-08）：
//   - 生效版本此前是**隐式推导**（max(id) approved）：线上坏了既不能退版、也不能撤掉；
//   - 作者不能撤回已提交的待审版本，审核开关关掉之后 pending 永久积压；
//   - 软删的应用全仓没有 restore，404 却让人"联系管理员"（管理员也没这能力）。
//
// 本文件只做编排（身份/错误码/审计/响应），事务与不变量在 serverstore.DeployWasmRelease。
// 员工面与管理面**共用同一段部署逻辑**（deployForApp）：两条面各写一份必然漂移，
// 而漂移的形态是"管理端能回滚、作者端回滚时报另一种错"。

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/registry"
)

// deploymentJSON 把一条部署历史整理成稳定响应形状（员工面与管理面共用）。
//
// `current` 由 createdAt 之外的**指针**判定（app.current_deployment_id），不是"最新一条"：
// 回滚之后最新一条恰好也是当前那条，但"历史里有更晚的部署、当前指向更早"这件事本身
// 只有在指针口径下才看得见。
func deploymentJSON(d serverstore.WasmDeployment, currentID int64) gin.H {
	return gin.H{
		"id":         d.ID,
		"app_id":     d.AppID,
		"version":    d.Version,
		"release_id": d.ReleaseID,
		"kind":       d.Kind,
		"actor":      d.Actor,
		"actor_role": d.ActorRole,
		"message":    d.Message,
		"created_at": d.CreatedAt,
		"current":    d.ID == currentID && d.ID > 0,
	}
}

// deployments 是 GET …/:app_id/deployments（员工面；管理面见 admin_retirement.go）。
//
// 只读、不写审计（与 myReleases / adminReleases 同口径）：作者每次打开面板都会调一次，
// 逐次落审计只会把审计链淹掉；真正改变状态的部署动作仍然条条留痕。
//
// allowDeleted=true：已删除/已清除的应用**历史仍然可读**（真删也不删历史）——
// 这正是"谁在什么时候把我删掉的应用下线"唯一能回答的地方。
func (h *Handlers) deployments(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, _, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	h.respondDeployments(c, app)
}

// respondDeployments 组装部署历史响应（员工面/管理面共用）。
func (h *Handlers) respondDeployments(c *gin.Context, app *serverstore.WasmApp) {
	ctx := c.Request.Context()
	limit := atoiDefault(c.Query("limit"), 50)
	list, err := serverstore.ListWasmDeployments(ctx, h.opt.DB, app.AppID, limit)
	if err != nil {
		writeErr(c, internalErr("查询部署历史失败", err))
		return
	}
	rows := make([]gin.H, 0, len(list))
	for _, d := range list {
		rows = append(rows, deploymentJSON(d, app.CurrentDeploymentID))
	}
	c.JSON(http.StatusOK, gin.H{
		"app_id":                app.AppID,
		"current_version":       h.currentVersionOf(ctx, app.AppID, app),
		"current_deployment_id": app.CurrentDeploymentID,
		"current_release_id":    app.CurrentReleaseID,
		"deployments":           rows,
	})
}

// deployRelease 是 POST …/:app_id/deployments（员工面）：部署/回滚到一个 approved 版本。
func (h *Handlers) deployRelease(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	// allowDeleted=true：把"已删除 ⇒ 409 APP_DELETED"的判定交给事务（设计 §5.1 明写
	// 409 + 该错误码），而不是在这里变成 404 —— 作者看到"先恢复"才是可操作的。
	// 非发布者仍然 404（ownedApp 的归属判定在 allowDeleted 之前，不泄露存在性）。
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	role := serverstore.ActorRoleOwner
	if app.Owner != u.Username && isSuperAdmin(u) {
		// 超管兜底必须**可辨**（审计 2026-10-22 C-15）：审计里 owner 与 super_admin
		// 不能同形，否则事后无法区分"作者自己上线"与"平台接管上线"。
		role = serverstore.ActorRoleSuperAdmin
	}
	h.deployForApp(c, app, u.Username, role)
}

// deployInput 是部署请求体（两条面共用）。
type deployInput struct {
	Version string `json:"version"`
	Message string `json:"message"`
}

// deployForApp 解析请求体 → 调事务 → 映射错误码 → 写审计 → 回响应。
//
// 这一段被员工面与管理面共用（唯一的差别是 actor/actor_role）。
func (h *Handlers) deployForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	var in deployInput
	if c.Request.ContentLength > 0 {
		body, berr := bindJSONLimited[deployInput](c, 8*1024, "deploy")
		if berr != nil {
			writeErr(c, berr)
			return
		}
		in = body
	}
	version := releaseVersion(in.Version)
	if version == "" {
		writeErr(c, apperr.New(apperr.CodeMissingField, "缺少 version").
			WithDetail("field", "version").
			WithHint("body 形如 {\"version\":\"1.2.0\",\"message\":\"回滚到上一版\"}；版本必须是 approved 且仍有制品字节"))
		return
	}
	ctx := c.Request.Context()
	rel, err := serverstore.GetWasmReleaseMeta(ctx, h.opt.DB, app.AppID, version)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			writeErr(c, apperr.New(apperr.CodeNotFound, "版本不存在").
				WithDetail("app_id", app.AppID).WithDetail("version", version).
				WithHint("版本号一经落行永久占位；部署只能用已存在的 approved 版本"))
			return
		}
		writeErr(c, internalErr("查询版本失败", err))
		return
	}
	h.deployReleaseRow(c, app, rel, actor, role, in.Message)
}

// deployReleaseRow 在已解析出目标版本之后执行部署（审批路径也复用这一段）。
func (h *Handlers) deployReleaseRow(c *gin.Context, app *serverstore.WasmApp, rel *serverstore.WasmRelease,
	actor, role, message string) {
	ctx := c.Request.Context()
	dep, changed, err := serverstore.DeployWasmRelease(ctx, h.opt.DB, serverstore.DeployWasmReleaseInput{
		AppID: app.AppID, ReleaseID: rel.ID, Actor: actor, ActorRole: role,
		Message: message, Now: h.now().UTC(),
	})
	if err != nil {
		writeErr(c, deployError(app.AppID, rel.Version, err))
		return
	}
	// 幂等分支：不追加历史、不写审计（设计 §5.1 原话）。响应仍如实报 changed=false。
	if !changed {
		c.JSON(http.StatusOK, gin.H{
			"app": gin.H{"app_id": app.AppID, "current_version": rel.Version,
				"current_release_id": app.CurrentReleaseID, "current_deployment_id": app.CurrentDeploymentID},
			"deployment": deploymentJSON(*dep, dep.ID),
			"changed":    false,
			"note":       "目标版本已经是当前生效版本（幂等：未追加部署历史，未写审计）",
		})
		return
	}
	// 审计：detail 必须含 deployment_id / version / kind / actor_role —— 这四项是
	// "谁在什么时候把哪一版放上线、是发布还是回滚、以什么身份"的完整答案。
	h.auditApp(app.AppID, actor, "wasm_app_deploy",
		auditDetail(app.AppID, auditTitleOf(app), "部署 deployment_id="+strconv.FormatInt(dep.ID, 10)+
			" version="+dep.Version+" kind="+dep.Kind+" actor_role="+dep.ActorRole+" "+
			stringOr(message, "（无备注）")))
	if dep.Kind == serverstore.DeployKindRollback {
		// 回滚不需要额外审计动作名（kind 已经在 detail 里），但日志要给运维一行
		// 可 grep 的证据。
		h.evictApp(app.AppID)
	}
	c.JSON(http.StatusOK, gin.H{
		"app": gin.H{"app_id": app.AppID, "current_version": dep.Version,
			"current_release_id": dep.ReleaseID, "current_deployment_id": dep.ID},
		"deployment": deploymentJSON(*dep, dep.ID),
		"changed":    true,
	})
}

// stringOr 返回 s，空串时返回 fallback。
func stringOr(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// deployError 把 DAO sentinel 映射成 §6.2 的错误码与 HTTP 状态。
//
// 状态码与码**成对**出现（设计 §5.1/§5.5 明写 409/410）：
//   - RELEASE_NOT_DEPLOYABLE / RELEASE_BYTES_RELEASED / APP_FROZEN / APP_DELETED → 409；
//   - APP_PURGED → 410（数据已清除，不是"现在不能"，而是"永远不能"）；
//   - 其余 → 500（真故障）。
//
// 为什么不用 apperr.StatusOf 的缺省映射：新码不在 §7.4 表里（那张表是执行面的失败语义），
// 生命周期动作的状态码由本设计规定；这里显式赋值而不是让它们落到 500。
func deployError(appID, version string, err error) *apperr.Error {
	var e *apperr.Error
	switch {
	case errors.Is(err, serverstore.ErrNotFound):
		return apperr.New(apperr.CodeNotFound, "应用或版本不存在").
			WithDetail("app_id", appID).WithDetail("version", version)
	case errors.Is(err, serverstore.ErrReleaseNotDeployable):
		e = apperr.New(apperr.Code(serverstore.CodeReleaseNotDeployable),
			"该版本不可部署：只有审核通过（approved）的版本能上线").
			WithDetail("app_id", appID).WithDetail("version", version).
			WithHint("pending 版本需要先通过审核；rejected/withdrawn 是终态（版本号永久占位），只能发布更高版本号")
	case errors.Is(err, serverstore.ErrReleaseBytesReleased):
		e = apperr.New(apperr.Code(serverstore.CodeReleaseBytesReleased),
			"该版本的制品字节已释放，无法再部署").
			WithDetail("app_id", appID).WithDetail("version", version).
			WithHint("字节在审核拒绝/作者撤回/应用退役/版本 GC 时释放；要恢复服务请部署其它仍有字节的 approved 版本，或让作者发新版本")
	case errors.Is(err, serverstore.ErrAppFrozen):
		e = apperr.New(apperr.CodeAppFrozen, "应用已冻结，不能部署").
			WithDetail("app_id", appID).
			WithHint("冻结期间应用不服务；先解冻（POST …/freeze {\"frozen\":false}），再重新上架并部署")
		e.HTTP = http.StatusConflict
	case errors.Is(err, serverstore.ErrAppDeleted):
		e = apperr.New(apperr.Code(serverstore.CodeAppDeleted), "应用已删除，不能部署").
			WithDetail("app_id", appID).
			WithHint("先恢复应用（POST …/restore），恢复后 enabled 仍为 0，需要显式上架")
		e.HTTP = http.StatusConflict
	case errors.Is(err, serverstore.ErrAppPurged):
		e = apperr.New(apperr.Code(serverstore.CodeAppPurged),
			"应用数据已清除（保留期到期后真删），不可恢复").
			WithDetail("app_id", appID).
			WithHint("元数据与部署历史仅作审计留档；如需重建请用新的 app_id 发布")
		e.HTTP = http.StatusGone
	default:
		return internalErr("部署失败", err)
	}
	if e.HTTP == 0 {
		e.HTTP = http.StatusConflict
	}
	return e
}

// withdrawRelease 是 POST …/:app_id/releases/:version/withdraw（员工面，设计 §5.3）。
//
// 权限：**作者本人或超管**。非本人一律 404（与 ownedApp 同口径：管理动作不泄露存在性）。
// 语义：仅 pending 可撤回；撤回落终态 withdrawn、释放制品字节、**版本号永久占用**。
func (h *Handlers) withdrawRelease(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, u, oerr := h.ownedApp(c, appID, false)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	version := releaseVersion(c.Param("version"))
	if version == "" {
		writeErr(c, apperr.New(apperr.CodeMissingField, "缺少 version").WithDetail("field", "version"))
		return
	}
	// 归属判定：作者本人**或**超管兜底（设计 §5.3「仅 pending 且属本人（或超管）」）。
	// 与同文件的 deployRelease/restoreApp 同口径：非本人且非超管 ⇒ 后续按"不存在"处理
	// （404 同形，不泄露版本存在性）。2026-10-22 反证 3b：此前恒传 true，超管也被 404，
	// 而 `requireOwnership=false` 那条分支没有调用点 = 死代码。
	requireOwnership := !(app.Owner != u.Username && isSuperAdmin(u))
	h.withdrawForApp(c, app, version, u.Username, requireOwnership)
}

// withdrawForApp 是一条撤回动作的共享实现（员工面校验作者身份，管理面不校验）。
//
// requireOwnership=true 时版本发布者必须等于 actor（否则 404 同形：撤回动作不需要
// 让外人知道"这个版本存在"）。
func (h *Handlers) withdrawForApp(c *gin.Context, app *serverstore.WasmApp, version, actor string, requireOwnership bool) {
	ctx := c.Request.Context()
	rel, err := serverstore.GetWasmReleaseMeta(ctx, h.opt.DB, app.AppID, version)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			writeErr(c, notFoundApp(app.AppID))
			return
		}
		writeErr(c, internalErr("查询版本失败", err))
		return
	}
	if requireOwnership && rel.Publisher != actor {
		writeErr(c, notFoundApp(app.AppID))
		return
	}
	if err := serverstore.WithdrawWasmRelease(ctx, h.opt.DB, app.AppID, version, "作者撤回"); err != nil {
		switch {
		case errors.Is(err, serverstore.ErrNotFound):
			writeErr(c, notFoundApp(app.AppID))
		case errors.Is(err, serverstore.ErrReleaseNotPending):
			e := apperr.New(apperr.Code(serverstore.CodeReleaseNotPending),
				"只有待审（pending）版本可以撤回；该版本已是终态或已生效").
				WithDetail("app_id", app.AppID).WithDetail("version", version).
				WithHint("approved 版本要下线请部署另一个版本（回滚）或下架/冻结应用；rejected/withdrawn 已是终态")
			e.HTTP = http.StatusConflict
			writeErr(c, e)
		default:
			writeErr(c, internalErr("撤回失败", err))
		}
		return
	}
	depInfo := "status=pending → withdrawn，制品字节已释放，版本号永久占用（重发请升版本号）"
	h.auditApp(app.AppID, actor, "wasm_app_release_withdraw",
		auditDetail(app.AppID, auditTitleOf(app), "撤回 v"+version+"："+depInfo))
	c.JSON(http.StatusOK, gin.H{
		"app_id":  app.AppID,
		"version": version,
		"status":  serverstore.ReleaseStatusWithdrawn,
		"changed": true,
		"note":    depInfo,
	})
}

// restoreApp 是 POST …/:app_id/restore（员工面，设计 §5.5）。
func (h *Handlers) restoreApp(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	// allowDeleted=true：恢复的对象天然是"已删除"的行。
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	role := serverstore.ActorRoleOwner
	if app.Owner != u.Username && isSuperAdmin(u) {
		role = serverstore.ActorRoleSuperAdmin
	}
	h.restoreForApp(c, app, u.Username, role)
}

// restoreForApp 恢复软删（员工面/管理面共用）。
func (h *Handlers) restoreForApp(c *gin.Context, app *serverstore.WasmApp, actor, role string) {
	ctx := c.Request.Context()
	if app.DeletedAt == nil {
		// 幂等：没删除过就没有可恢复的。仍回 200 让客户端不必区分，
		// 但不写审计（没有状态变更）。
		c.JSON(http.StatusOK, gin.H{
			"app":     gin.H{"app_id": app.AppID, "deleted": false, "enabled": app.Enabled},
			"changed": false,
			"note":    "应用未处于删除状态（幂等：未写审计）",
		})
		return
	}
	if err := serverstore.RestoreWasmApp(ctx, h.opt.DB, app.AppID); err != nil {
		switch {
		case errors.Is(err, serverstore.ErrNotFound):
			writeErr(c, notFoundApp(app.AppID))
		case errors.Is(err, serverstore.ErrAppPurged):
			e := apperr.New(apperr.Code(serverstore.CodeAppPurged),
				"应用数据已清除（保留期到期后真删），不可恢复").
				WithDetail("app_id", app.AppID).
				WithHint("元数据与部署历史仅作审计留档；如需重建请用新的 app_id 发布")
			e.HTTP = http.StatusGone
			writeErr(c, e)
		default:
			writeErr(c, internalErr("恢复失败", err))
		}
		return
	}
	// 快照目录在恢复后没有消费者（purge 的前置条件已被清空），尽力删除；
	// 磁盘故障不阻断恢复（恢复是"把服务救回来"的动作），但要在响应里如实报。
	snapshotCleanupError := ""
	if derr := deleteSnapshotsForApp(h.opt.DataRoot, app.AppID); derr != nil {
		snapshotCleanupError = derr.Error()
	}
	h.auditApp(app.AppID, actor, "wasm_app_restore",
		auditDetail(app.AppID, auditTitleOf(app),
			"恢复软删（enabled 保持 0，不自动上架；actor_role="+role+"）"))
	c.JSON(http.StatusOK, gin.H{
		"app":                    gin.H{"app_id": app.AppID, "deleted": false, "enabled": false},
		"changed":                true,
		"retention_cleared":      true,
		"snapshot_cleanup_error": snapshotCleanupError,
		// 恢复已经把部署指针复位（软删时版本字节已释放，旧指针不可交付）—— 回执必须
		// 说清"下一步是发布/部署一个仍有字节的版本"，否则管理员只会去点上架然后吃到 500
		// （2026-10-22 反证 P2-4）。
		"note": "已恢复：应用回到下架状态（不自动上架），且部署指针已复位 —— " +
			"软删时版本字节已释放，请先发布新版本（或部署一个仍有字节的 approved 版本），再上架",
	})
}

// pendingReleaseQueue 是 GET /wasm-apps/releases/pending 的数据装配（管理面共享）。
func (h *Handlers) pendingReleaseQueueRows(ctx context.Context) ([]gin.H, error) {
	list, err := serverstore.PendingReleaseQueue(ctx, h.opt.DB, 200)
	if err != nil {
		return nil, err
	}
	now := h.now().UTC()
	rows := make([]gin.H, 0, len(list))
	for _, p := range list {
		age := int64(0)
		if !p.CreatedAt.IsZero() {
			age = int64(now.Sub(p.CreatedAt).Seconds())
			if age < 0 {
				age = 0
			}
		}
		rows = append(rows, gin.H{
			// 字段集 = webadmin 待审队列契约（apps-lifecycle.ts 的 PendingQueueRow）：
			// 只给"处置一个待审版本"真正要看的六项。**不要**顺手加 id/size/changelog/
			// description —— 队列的用途是"决定通过还是拒绝"，不是版本详情页；管理台
			// 已明确不消费它们（2026-10-22 终轮反证：服务端下发、UI 零调用 = 死负载）。
			"app_id":          p.AppID,
			"title":           p.Title,
			"version":         p.Version,
			"publisher":       p.Publisher,
			"created_at":      p.CreatedAt,
			"age_seconds":     age,
			"current_version": p.CurrentVersion,
		})
	}
	return rows, nil
}
