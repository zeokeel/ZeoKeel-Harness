package appstore

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/skillmanifest"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 统一应用模型管理面 handler 集合。
// 服务端面 /api/server/admin(权限由 router 申报)。
type Handlers struct {
	// 归属转移(2026-09-02):PUT /apps/:kind/:app_id/owner
	TransferOwner gin.HandlerFunc
	// 空壳释放(F-02,2026-10-26):DELETE /apps/:kind/:app_id
	DeleteApp gin.HandlerFunc
}

// NewHandlers 返回管理面 handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{TransferOwner: transferOwner(db), DeleteApp: deleteApp(db)}
}

// 空壳硬删被拒时的**对外**错误码(409)。与 serverstore 的 sentinel 一一对应:
// 调用方(webadmin)按 code 渲染"先下架/先处理版本"的指路文案,不要靠消息文本。
const (
	// CodeAppHasReleases:仍有版本 ⇒ 不是空壳,请先删除版本或下架。
	CodeAppHasReleases = "APP_HAS_RELEASES"
	// CodeAppOfficial:官方归属 ⇒ 不可释放名称。
	CodeAppOfficial = "APP_OFFICIAL"
)

// deleteApp 硬删一个**空壳** App(释放被占用的名称)。F-02(能力中心审计
// 2026-10-26)。
//
// 为什么需要它:管理端「新建」只登记名称(POST /skills、POST /agents),内容
// 另一步上传。打错名字/放弃创建后,这一行既没有版本也没有删除入口,而名称
// 跨渠道互斥(市场占名同时挡组织同名)—— 唯一出路是改库。
//
// 安全边界(全部由 serverstore.DeleteEmptyApp 在事务内一次判定):
//   - 没有未软删版本(有 pending/approved ⇒ 409 APP_HAS_RELEASES,指路下架/删版本);
//   - 非官方归属(否则 409 APP_OFFICIAL);
//   - kind ∈ {skill, agent}(WASM 应用有独立 purge 生命周期,不走本入口)。
//
// 硬删 = 释放名称:apps 行删除(app_releases 墓碑随 CASCADE 清除)、app_grants
// 一并清理;审计 app_delete 留痕(按 app_id 归档,便于之后追查"这个名字是谁释放的")。
func deleteApp(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		kind := c.Param("kind")
		appID := c.Param("app_id")
		if kind != serverstore.AppKindSkill && kind != serverstore.AppKindAgent {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"类型不合法:只能是 skill 或 agent(WASM 应用请在应用管理里卸载)")
			return
		}
		if !skillmanifest.IsAppID(appID) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
				"名称不合法:必须是小写 kebab-case(如 my-skill)")
			return
		}
		err := serverstore.DeleteEmptyApp(db, kind, appID)
		switch {
		case err == nil:
		case errors.Is(err, serverstore.ErrNotFound):
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "能力不存在")
			return
		case errors.Is(err, serverstore.ErrAppHasReleases):
			serverauth.WriteError(c, http.StatusConflict, CodeAppHasReleases,
				"该能力已有版本,不能按空壳删除:要停止提供请先下架(可恢复),要彻底移除请先删除各版本")
			return
		case errors.Is(err, serverstore.ErrAppOfficial):
			serverauth.WriteError(c, http.StatusConflict, CodeAppOfficial,
				"官方归属的能力不能删除:请先把归属转给具体负责人")
			return
		case errors.Is(err, serverstore.ErrValidation):
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "类型不合法")
			return
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		admin := serverauth.AdminUser(c)
		actor := ""
		if admin != nil {
			actor = admin.Username
		}
		_ = serverstore.AuditLogApp(db, appID, actor, "app_delete",
			kind+":"+appID+" 硬删除空壳应用(释放名称)")
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// TransferOwnerAuditDetail 归属转移审计明细(稳定格式,webadmin 直接可读)。
func TransferOwnerAuditDetail(kind, appID, title, from, to string) string {
	detail := kind + ":" + appID
	if title != "" {
		detail += " 「" + title + "」"
	}
	return detail + " 归属 " + from + " → " + to
}

// transferOwner 归属转移:管理员把某个 App 的归属人改为其他存在用户。
// 归属只约束「谁能续传新版本」;转移后旧归属者的发布请求即 404,新归属者
// 获得续传权(版本语义规则不受影响)。审计 app_owner_transfer 留痕新旧值。
// 不支持清空归属(防误操作置为无主)。
func transferOwner(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		kind := c.Param("kind")
		appID := c.Param("app_id")
		// kind 白名单（§11 第 17 项）：wasm 应用与技能/智能体共用一个统一应用模型，
		// 归属转移/官方归属是**应用级**动作（与版本无关），因此同一个端点必须能覆盖
		// 三种 kind —— 此前硬写 skill/agent，导致对 wasm 应用一律 400。
		if kind != serverstore.AppKindSkill && kind != serverstore.AppKindAgent &&
			kind != serverstore.AppKindWasmApp {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"类型不合法:只能是 skill、agent 或 wasm_app")
			return
		}
		if !skillmanifest.IsAppID(appID) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
				"名称不合法:必须是小写 kebab-case(如 my-skill)")
			return
		}
		var req struct {
			// Owner 转给用户(互斥: 与 Official 二选一)。
			Owner string `json:"owner"`
			// Official 归属官方(0059): official=1 + owner=''(员工端蓝标, 仅管理员可上传)。
			Official *bool `json:"official"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if (req.Owner != "" && req.Official != nil) || (req.Owner == "" && req.Official == nil) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "owner 与 official 必须指定其一")
			return
		}
		app, err := serverstore.GetApp(db, kind, appID)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "能力不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if req.Official != nil {
			// P2-21:official 语义是「归属官方」的一次性转移,只接受 true。
			// 此前 `{"official":false}` 也被当作归属官方处理(反而置 official=1
			// 并清空 owner)——调用方想取消官方归属却被反向改写。取消官方归属
			// 必须显式指定新负责人({owner:...}),避免出现无主 App。
			if !*req.Official {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
					"official 只接受 true;取消官方归属请用 owner 指定新负责人")
				return
			}
			// 归属官方: official=1, owner 清空(展示「官方」)。
			if app.Official == 1 && app.Owner == "" {
				c.JSON(http.StatusOK, gin.H{"ok": true, "official": true})
				return
			}
			if err := serverstore.SetAppOfficial(db, kind, appID, true, ""); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
				return
			}
			admin := serverauth.AdminUser(c)
			actor := ""
			if admin != nil {
				actor = admin.Username
			}
			// 归属转移是**应用级**动作 ⇒ 必须带 app_id 列（AuditLogApp），
			// 否则应用维度的审计视图（ListAuditLogsByApp / 导出 / 排障）看不到
			// 这次转移 —— wasm 面自己的归属转移端点本来就写 app_id，两条路径
			// 对同一种动作的可检索性必须一致（R3-A A-9）。
			_ = serverstore.AuditLogApp(db, appID, actor, "app_owner_transfer",
				TransferOwnerAuditDetail(kind, appID, app.Title, app.Owner, "官方"))
			c.JSON(http.StatusOK, gin.H{"ok": true, "official": true})
			return
		}
		if _, err := serverstore.GetUserByUsername(db, req.Owner); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "目标用户不存在")
			return
		}
		if app.Owner == req.Owner && app.Official == 0 {
			// 幂等:归属未变更,直接成功且不写审计(避免噪音条目)。
			c.JSON(http.StatusOK, gin.H{"ok": true, "owner": req.Owner})
			return
		}
		if err := serverstore.SetAppOfficial(db, kind, appID, false, req.Owner); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
		admin := serverauth.AdminUser(c)
		actor := ""
		if admin != nil {
			actor = admin.Username
		}
		from := app.Owner
		if app.Official == 1 {
			from = "官方"
		}
		_ = serverstore.AuditLogApp(db, appID, actor, "app_owner_transfer",
			TransferOwnerAuditDetail(kind, appID, app.Title, from, req.Owner))
		c.JSON(http.StatusOK, gin.H{"ok": true, "owner": req.Owner})
	}
}
