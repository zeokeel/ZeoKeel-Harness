package api

// 本文件是**应用级限流覆盖**的管理面端点（决策
// docs/decisions/2026-10-22-wasm-per-app-limits.md §2.3）：
//
//	GET    /api/server/admin/wasm-apps/:app_id/limits   capability:read
//	PUT    /api/server/admin/wasm-apps/:app_id/limits   capability:write
//	DELETE /api/server/admin/wasm-apps/:app_id/limits   capability:write（= PUT null）
//
// 三层职责必须分清（任何一层多写一份判据都会出现第二个真源）：
//   - **模型/校验**：applimits.ApplyOverride / ValidateOverride / ParseOverride
//     （per-app 与全局保存走同一份 Limits.Validate 判据）；
//   - **存储**：serverstore 的 wasm_app_limits DAO（NULL = 继承，四列全 NULL 归一为无覆盖）；
//   - **本文件**：身份、应用存在性（404 不泄露存在性）、落库 → 下发调度器 → 审计、
//     以及响应视图（global / override / effective / exceeds_global）。
//
// 保存路径的**顺序**是硬的（决策 §2.2）：先校验、再落库、再下发运行态、最后写审计。
// 反过来会让"审计写了但库没改"或"调度器改了但落库失败（重启后覆盖消失）"。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/registry"
)

// AuditActionWasmAppLimitsChange 是应用级限流覆盖的审计动作名（决策 §2.3）。
//
// 与全局的 `wasm_limits_change` 刻意分开：全局动作是**组织级**（不带 app_id），
// 本动作是**应用级**（带 app_id 列，0069 的 app 维度）—— 审计页按动作筛时两者不该混。
const AuditActionWasmAppLimitsChange = "wasm_app_limits_change"

// appLimitGlobals 返回当前**全局**限制项（覆盖的继承基线）。
//
// nil 闭包（最小装配/单元测试）⇒ 编译期默认值 —— 与 limitsView 同一降级口径：
// 视图仍能给出有意义的 global/effective，而不是一片 0。
func (h *Handlers) appLimitGlobals() applimits.Limits {
	if h.opt.Limits != nil {
		return h.opt.Limits()
	}
	return applimits.Defaults()
}

// appLimitOverrideFromDB 读某应用的覆盖（无覆盖 ⇒ 零值）。
//
// DAO 用 `(nil, nil)` 表达"没有覆盖"（见 serverstore 包注释）：这里把它折成
// `limits.AppOverride{}`，让调用方只需要比较一次 `IsZero()`。
func (h *Handlers) appLimitOverrideFromDB(ctx context.Context, appID string) (limits.AppOverride, error) {
	rec, err := serverstore.GetWasmAppLimitOverride(ctx, h.opt.DB, appID)
	if err != nil {
		return limits.AppOverride{}, err
	}
	if rec == nil {
		return limits.AppOverride{}, nil
	}
	return limits.AppOverride{
		AppRunning:        intOrZero(rec.AppRunning),
		AppQueue:          intOrZero(rec.AppQueue),
		UserPerAppRunning: intOrZero(rec.UserPerAppRunning),
		UserPerAppQueued:  intOrZero(rec.UserPerAppQueued),
	}, nil
}

// intOrZero 解引用可空整数（nil ⇒ 0 = 继承）。
func intOrZero(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// appLimitAxisValues 把一份 Limits 折成**四个并发轴**的值（视图的 global/effective）。
//
// 只给四轴（不是整个 Limits）：这个端点的语义域就是"并发四轴"，把内存/时间预算也
// 回显出来会让调用方误以为覆盖能改它们（决策 §2.2「不做 per-app 内存/时间预算」）。
func appLimitAxisValues(l applimits.Limits) gin.H {
	return gin.H{
		"app_running":          l.AppRunning,
		"app_queue":            l.AppQueue,
		"user_per_app_running": l.UserPerAppRunning,
		"user_per_app_queued":  l.UserPerAppQueued,
	}
}

// appLimitOverrideValues 把覆盖折成视图形态：**继承的轴是 JSON null**（不是 0）。
//
// 为什么必须 null：0 在并发语义里不成立，前端/运维看到 0 只会以为是"配成了 0"；
// null 直接表达"这一轴跟着全局走"（决策 §2.3 的响应形状）。
func appLimitOverrideValues(ov limits.AppOverride) gin.H {
	nullable := func(v int) any {
		if v <= 0 {
			return nil
		}
		return v
	}
	return gin.H{
		"app_running":          nullable(ov.AppRunning),
		"app_queue":            nullable(ov.AppQueue),
		"user_per_app_running": nullable(ov.UserPerAppRunning),
		"user_per_app_queued":  nullable(ov.UserPerAppQueued),
	}
}

// appLimitsView 组装 GET/PUT/DELETE 的响应（决策 §2.3 的字段集合）。
//
// `exceeds_global` 是**提示**：允许高于全局（管理员显式动作），但前端要二次确认
// "该应用会比其他应用占用更多槽位"。effective 用 applimits.ApplyOverride 同一个函数
// 算出 —— 与调度器的 effectiveOptionsLocked 同一条套用规则，两处不会分叉。
func (h *Handlers) appLimitsView(appID string, global applimits.Limits, ov limits.AppOverride) gin.H {
	eff := applimits.ApplyOverride(global, ov)
	return gin.H{
		"app_id":         appID,
		"global":         appLimitAxisValues(global),
		"override":       appLimitOverrideValues(ov),
		"effective":      appLimitAxisValues(eff),
		"exceeds_global": applimits.OverrideExceedsGlobal(global, ov),
	}
}

// AdminAppLimitsGet 返回某应用的 global / override / effective / exceeds_global。
func (h *Handlers) adminAppLimitsGet(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	// 应用存在性由 API 校验（DAO 不判）：不存在/已删除一律 404（决策 §2.3 末条）。
	if _, aerr := h.adminApp(c, appID); aerr != nil {
		writeErr(c, aerr)
		return
	}
	ov, err := h.appLimitOverrideFromDB(c.Request.Context(), appID)
	if err != nil {
		writeErr(c, internalErr("读取应用级限流覆盖失败", err))
		return
	}
	c.JSON(http.StatusOK, h.appLimitsView(appID, h.appLimitGlobals(), ov))
}

// AdminAppLimitsPut 保存某应用的覆盖；body `null` / `{}` / 四键全 null = 清空。
func (h *Handlers) adminAppLimitsPut(c *gin.Context) {
	h.saveAppLimits(c, false)
}

// AdminAppLimitsDelete 清空某应用的覆盖（与 `PUT null` 等价，决策 §2.3）。
func (h *Handlers) adminAppLimitsDelete(c *gin.Context) {
	h.saveAppLimits(c, true)
}

// saveAppLimits 是 PUT/DELETE 的共用实现（差异只有"是否强制清空"）。
//
// 步骤与失败语义（每一步都 fail-closed，且**没有任何"先改了运行态再说"的路径**）：
//  1. 装配自检：DB/数据根 + 下发钩子（nil ⇒ INTERNAL，不静默只落库）；
//  2. 身份：管理会话（审计的 actor）；
//  3. 应用：存在且未删除（404，不泄露存在性）；
//  4. 解析 body（严格四键，未知键 fail-loud；null/空对象 = 清空）；
//  5. 校验（复用 applimits.ValidateOverride，即全局同一份判据）；
//  6. 幂等：与服务端当前值相同 ⇒ **不写库、不下发、不写审计**，响应 changed=false；
//  7. 落库 → 下发调度器 → 写审计（顺序见文件头）。
func (h *Handlers) saveAppLimits(c *gin.Context, forceClear bool) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	if h.opt.AppLimitsApply == nil {
		// 与全局 LimitsApply 同一纪律：装配缺了就**拒绝保存**，绝不做"只落库不生效"
		// 的半套（那种状态在重启前后会给出两种行为，排障无从下手）。
		writeErr(c, apperr.New(apperr.CodeInternal, "应用级限流覆盖不可配置（装配未注入）").
			WithHint("服务端未提供覆盖下发钩子：请升级服务端或检查部署装配"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}

	next := limits.AppOverride{}
	if !forceClear {
		// 读**原始** JSON 再解析：`null` 与 `{}` 都表示清空，而"空 body"是请求不合法
		// （bindJSONLimited 的既有语义）—— 三者不能混成一个默认分支。
		var raw json.RawMessage
		if berr := bindAdminJSON(c, &raw); berr != nil {
			writeErr(c, berr)
			return
		}
		parsed, _, perr := applimits.ParseOverride(raw)
		if perr != nil {
			writeErr(c, perr)
			return
		}
		next = parsed
	} else if c.Request.ContentLength > 0 {
		// DELETE 带 body 是调用方状态错乱：宁可 400 也不静默忽略（"我以为它清的是 A"）。
		writeErr(c, apperr.New(apperr.CodeValidation, "DELETE 不接受请求体").
			WithHint("清空覆盖请直接 DELETE；要写入具体值请用 PUT"))
		return
	}

	global := h.appLimitGlobals()
	if !next.IsZero() {
		if verr := applimits.ValidateOverride(global, next); verr != nil {
			writeErr(c, verr)
			return
		}
	}

	ctx := c.Request.Context()
	prev, err := h.appLimitOverrideFromDB(ctx, appID)
	if err != nil {
		writeErr(c, internalErr("读取应用级限流覆盖失败", err))
		return
	}
	changed := !prev.Equal(next)
	if changed {
		if next.IsZero() {
			// 清空 = 删行（DAO 的归一化同义；这里显式走 Clear 让"有没有真的删到"可见）。
			if _, cerr := serverstore.ClearWasmAppLimitOverride(ctx, h.opt.DB, appID); cerr != nil {
				writeErr(c, internalErr("清空应用级限流覆盖失败", cerr))
				return
			}
		} else {
			rec := serverstore.WasmAppLimitOverride{AppID: appID}
			if next.AppRunning > 0 {
				rec.AppRunning = intPtrValue(next.AppRunning)
			}
			if next.AppQueue > 0 {
				rec.AppQueue = intPtrValue(next.AppQueue)
			}
			if next.UserPerAppRunning > 0 {
				rec.UserPerAppRunning = intPtrValue(next.UserPerAppRunning)
			}
			if next.UserPerAppQueued > 0 {
				rec.UserPerAppQueued = intPtrValue(next.UserPerAppQueued)
			}
			if _, serr := serverstore.SetWasmAppLimitOverride(ctx, h.opt.DB, rec, admin.Username); serr != nil {
				writeErr(c, internalErr("保存应用级限流覆盖失败", serr))
				return
			}
		}
		// 落库成功之后才下发：反过来会出现"调度器按新值跑、库里还是旧值"（重启即回退）。
		h.auditApp(appID, admin.Username, AuditActionWasmAppLimitsChange,
			appLimitsAuditDetail(app, appID, next, admin.Username))
	}
	// **幂等分支也下发**（2026-10-22 反证 F-10）：库与调度器可能因某次下发失败而漂移
	// （落库成功、`AppLimitsApply` 抛错/装配重启），此时管理员"再保存一次同样的值"
	// 是唯一无副作用的修复动作 —— 只在 changed 时下发会让这个漂移永远修不回来。
	// 下发本身是幂等的（设置同一份覆盖不会重复记账），审计仍只在 changed 时写。
	h.opt.AppLimitsApply(appID, next)
	view := h.appLimitsView(appID, global, next)
	view["changed"] = changed
	c.JSON(http.StatusOK, view)
}

// intPtrValue 返回 v 的指针（构造 DAO 的可空字段用）。
func intPtrValue(v int) *int { return &v }

// appLimitsAuditDetail 拼装审计明细（决策 §2.3）：app_id + 四个覆盖值 + actor/actor_role。
//
// 形态（稳定、可 grep、一行）：
//
//	wasm_app:<app_id> 「<title>」 限流覆盖 app_running=1 app_queue=null …（清空覆盖：恢复继承全局） actor=admin actor_role=admin_session
//
// `null` 表示该轴**恢复继承全局** —— 这是"清空同样留痕"的关键：一条 `四个全 null` 的
// 审计就是"管理员把该应用的例外撤掉了"，而不是"没动过"（没动过的保存不写审计）。
// `actor_role` 恒为 admin_session（本端点只存在于管理面，cookie 会话 + RBAC）。
func appLimitsAuditDetail(app *serverstore.WasmApp, appID string, ov limits.AppOverride, actor string) string {
	axis := func(field string, v int) string {
		if v <= 0 {
			return field + "=null"
		}
		return field + "=" + strconv.Itoa(v)
	}
	parts := []string{
		"限流覆盖",
		axis("app_running", ov.AppRunning),
		axis("app_queue", ov.AppQueue),
		axis("user_per_app_running", ov.UserPerAppRunning),
		axis("user_per_app_queued", ov.UserPerAppQueued),
	}
	change := strings.Join(parts, " ")
	if ov.IsZero() {
		change += "（清空覆盖：恢复继承全局）"
	}
	change += fmt.Sprintf(" actor=%s actor_role=admin_session", actor)
	return auditDetail(appID, auditTitleOf(app), change)
}

// AdminAppLimitsList 返回**全部**应用级限流覆盖（管理台总览用）。
//
// 为什么需要它（生产化评审）：单应用 GET 只能逐应用翻，"哪些应用被单独限流/降额"
// 是管理员排查平台公平性与异常应用的第一入口；没有总览就只能靠猜。
// 覆盖行随应用删除保留（0087 无外键）⇒ 列表也如实展示，供管理员发现"已删应用的残留覆盖"。
//
// 只读、capability:read；不分页（覆盖是例外配置，数量 ≤ 应用数；响应里给 total）。
func (h *Handlers) AdminAppLimitsList(c *gin.Context) {
	if err := h.requirePlatform(); err != nil {
		writeErr(c, err)
		return
	}
	rows, err := serverstore.ListWasmAppLimitOverrides(c.Request.Context(), h.opt.DB)
	if err != nil {
		writeErr(c, internalErr("读取应用级限流覆盖失败", err))
		return
	}
	global := h.appLimitGlobals()
	items := make([]gin.H, 0, len(rows))
	for _, rec := range rows {
		ov := limits.AppOverride{
			AppRunning:        intOrZero(rec.AppRunning),
			AppQueue:          intOrZero(rec.AppQueue),
			UserPerAppRunning: intOrZero(rec.UserPerAppRunning),
			UserPerAppQueued:  intOrZero(rec.UserPerAppQueued),
		}
		item := h.appLimitsView(rec.AppID, global, ov)
		item["updated_at"] = rec.UpdatedAt
		item["updated_by"] = rec.UpdatedBy
		delete(item, "app_id") // 由下面的 app_id 显式给，避免重复
		item["app_id"] = rec.AppID
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{
		"global": appLimitAxisValues(global),
		"items":  items,
		"total":  len(items),
	})
}
