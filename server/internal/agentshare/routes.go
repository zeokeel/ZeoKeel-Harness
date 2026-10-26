package agentshare

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/appstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/archiveutil"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/sharedskills"
	"github.com/zeokeel/zeokeel-harness/server/internal/skillmanifest"
	"github.com/zeokeel/zeokeel-harness/server/internal/util"
)

// 待审配额取 serverstore 的唯一真源（F-47：此前与 sharedskills 各写一份 10）。
// 员工不得用待审行淹没审核队列；重新提交被拒名字始终允许。

// maxReasonLen bounds the admin's rejection reason shown to the author.
const maxReasonLen = 500

var presetIDRe = regexp.MustCompile("^" + util.PresetIDPattern + "$")

// versionRe accepts semver-ish version strings (no path separators).
var versionRe = regexp.MustCompile(`^[0-9a-zA-Z.-]{1,64}$`)

// preview reads one stored archive and returns the top-level composition
// (agent.cordis.yml) plus the full file list for admin review. When version
// is non-empty it addresses one row; empty addresses the name's latest row
// (legacy callers).
func preview(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		version := c.Param("version")
		if version != "" && !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本号不合法")
			return
		}
		var p *serverstore.AgentPreset
		var err error
		if version != "" {
			p, err = serverstore.GetAgentPresetByVersion(db, name, version)
		} else {
			p, err = serverstore.GetAgentPreset(db, name) // latest
		}
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// agentshare-2:审核预览只服务组织共享库。
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
			if r, rerr := os.ReadFile(diskPath); rerr == nil {
				raw = r
			} else {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档数据缺失")
				return
			}
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		files, composition, err := ListArchiveContents(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}
		c.JSON(http.StatusOK, gin.H{"files": files, "composition": composition})
	}
}

// presetFileContent returns one file's content from a stored preset archive so
// admins can review every uploaded file (审核查看全部内容)。Text (UTF-8) files
// are returned inline capped at 1MB; binary or oversized entries are flagged
// for archive download. Admin-only; version-empty resolves the name's latest
// row (legacy callers).
func presetFileContent(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		version := c.Param("version")
		if version != "" && !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本号不合法")
			return
		}
		target := c.Query("path")
		if target == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少文件路径")
			return
		}
		norm, err := archiveutil.NormalizePath(target)
		if err != nil || norm == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
			return
		}
		var p *serverstore.AgentPreset
		var gerr error
		if version != "" {
			p, gerr = serverstore.GetAgentPresetByVersion(db, name, version)
		} else {
			p, gerr = serverstore.GetAgentPreset(db, name)
		}
		if gerr != nil {
			if errors.Is(gerr, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// agentshare-2:逐文件审核只服务组织共享库。
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
			if r, rerr := os.ReadFile(diskPath); rerr == nil {
				raw = r
			} else {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档数据缺失")
				return
			}
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		content, size, found, binary, tooLarge, xerr := ExtractFileContent(raw, norm)
		if xerr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(xerr))
			return
		}
		if !found {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档中不存在该文件")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"path":      norm,
			"size":      size,
			"binary":    binary,
			"too_large": tooLarge,
			"content":   content,
		})
	}
}

// RegisterRoutes mounts /api/agent-presets (employee Bearer endpoints).
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/client/v2/agent-presets"
	g := r.Group(base, serverauth.BearerAuth(db))
	g.GET("", listVisible(db))
	g.POST("", upload(db, cacheDir))
	g.GET("/:name/archive", download(db, cacheDir, false))
	g.GET("/:name/:version/archive", downloadVersioned(db, cacheDir, false))
}

// RegisterAdminRoutes mounts /api/server/admin/agent-presets (AdminAuth + RBAC v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin/agent-presets"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "", serverauth.PermCapabilityRead, listAll(db))
	serverauth.AdminRoute(g, "GET", "/:name/archive", serverauth.PermCapabilityRead, download(db, cacheDir, true))
	serverauth.AdminRoute(g, "GET", "/:name/preview", serverauth.PermCapabilityRead, preview(db, cacheDir))
	serverauth.AdminRoute(g, "POST", "/:name/approve", serverauth.PermCapabilityWrite, decide(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	serverauth.AdminRoute(g, "POST", "/:name/reject", serverauth.PermCapabilityWrite, decide(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	serverauth.AdminRoute(g, "DELETE", "/:name", serverauth.PermCapabilityWrite, remove(db, cacheDir))
	// 多版本端点(审计 2026-08-25 D-1):按 name@version 精确寻址,避免
	// 旧「最新版本」语义与 hardcoded 1.0.0 文件名的断链。
	serverauth.AdminRoute(g, "GET", "/:name/:version/archive", serverauth.PermCapabilityRead, downloadVersioned(db, cacheDir, true))
	serverauth.AdminRoute(g, "GET", "/:name/:version/preview", serverauth.PermCapabilityRead, preview(db, cacheDir))
	// 管理端发新版本(2026-10-23):与市场端点 POST /agents/:name/archive 同形同语义,
	// 只服务组织渠道(AdminPublish=true ⇒ approved)。请求体 {archive}。
	serverauth.AdminRoute(g, "POST", "/:name/archive", serverauth.PermCapabilityWrite, uploadAdmin(db))
	serverauth.AdminRoute(g, "POST", "/:name/:version/approve", serverauth.PermCapabilityWrite, decideVersioned(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	serverauth.AdminRoute(g, "POST", "/:name/:version/reject", serverauth.PermCapabilityWrite, decideVersioned(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	serverauth.AdminRoute(g, "DELETE", "/:name/:version", serverauth.PermCapabilityWrite, removeVersioned(db, cacheDir))
	// 质量标记(0037):仅 approved 行可设置/清除(official/featured,互斥)。
	serverauth.AdminRoute(g, "PUT", "/:name/:version/quality", serverauth.PermCapabilityWrite, setPresetQuality(db))
	// 单文件内容(审核查看):从归档提取指定文件内容,支持文本/二进制/超大。
	serverauth.AdminRoute(g, "GET", "/:name/:version/file", serverauth.PermCapabilityRead, presetFileContent(db, cacheDir))
	// 授权(审核通过后仍需授权才可见可装):按 name 授权(同名多版本共享)。
	serverauth.AdminRoute(g, "GET", "/:name/grants", serverauth.PermCapabilityRead, listPresetGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grants", serverauth.PermCapabilityWrite, replacePresetGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grant", serverauth.PermCapabilityWrite, setPresetGrant(db, true))
	serverauth.AdminRoute(g, "DELETE", "/:name/grant", serverauth.PermCapabilityWrite, setPresetGrant(db, false))
	// 组织共享智能体上下架(SG-4):与共享技能的 /:name/enabled 对称(同 RBAC、
	// 同 JSON 信封、同 apps.enabled 语义)。市场智能体仍走 marketplace 的
	// POST /agents/:name/enable。
	serverauth.AdminRoute(g, "PUT", "/:name/enabled", serverauth.PermCapabilityWrite, setEnabled(db))
}

func presetJSON(p serverstore.AgentPreset) gin.H {
	return gin.H{
		"name":         p.Name,
		"display_name": p.DisplayName,
		"description":  p.Description,
		"version":      p.Version,
		"author":       p.Author,
		"status":       p.Status,
		// Rejection reason: exposed only for the author's own rows (the
		// employee list endpoint serves approved rows too, where it is "").
		"reason":     p.Reason,
		"quality":    p.Quality, // 0037 组织库质量标记(official/featured)
		"downloads":  p.Downloads,
		"created_at": p.CreatedAt,
		"updated_at": p.UpdatedAt,
	}
}

func listVisible(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		// agentshare-2:共享面只列组织渠道。市场渠道智能体由能力中心
		// (capabilities, source=market)呈现,不能在这里被当成「组织共享」
		// 内容(来源标注错误 + 市场下架失效)。
		org, oerr := orgAgentNames(db)
		if oerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		var list []serverstore.AgentPreset
		if u.IsAdmin {
			// 管理员恒全量(不落授权表);仅已审核通过的进入员工可见清单位。
			all, err := serverstore.ListAgentPresets(db, "")
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			// P2-1(审计 2026-09-13):客户端面只呈现**上架**内容——App 级
			// 下架(apps.enabled=0)与不存在同语义,管理员在客户端面也不该
			// 看到可点但下载必 404 的行(管理面清单仍全量,见 listAll)。
			enabled, err := serverstore.EnabledAppIDs(db, serverstore.AppKindAgent)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range all {
				// 两个闸门都要:渠道(只列组织共享面)+ 上架(apps.enabled)。
				if p.Status == serverstore.AgentPresetApproved && org[p.Name] && enabled[p.Name] {
					list = append(list, p)
				}
			}
		} else {
			groups, err := serverstore.UserEffectiveGroups(db, u.ID)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			granted, err := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedPresetGrantTable, u.Username, groups)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			visible, err := serverstore.ListVisibleAgentPresets(db, u.Username, granted)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range visible {
				if org[p.Name] {
					list = append(list, p)
				}
			}
		}
		out := make([]gin.H, 0, len(list))
		for _, p := range list {
			out = append(out, presetJSON(p))
		}
		c.JSON(http.StatusOK, gin.H{"presets": out})
	}
}

// parsedPresetUpload 是一次预设归档解析的产物（员工上传与管理端发新版共用）。
type parsedPresetUpload struct {
	raw      []byte
	checksum string
	title    string
	manifest appstore.Manifest
}

// parsePresetUpload 是预设归档**安全校验 + 编排检查 + 包内元数据解析**的唯一实现。
//
// 员工上传（/api/client/v2/agent-presets）与管理端发新版
// （/api/server/admin/agent-presets/:name/archive）共用它：两条路径只要各写
// 一份解析，就会重新出现「管理端能上架、员工装不上」或「错误码两面不一致」
// 这类双份真源缺陷（sharedskills 的 parseSkillUpload 是同形而孪生的实现）。
//
// 判据链（顺序也是契约：先安全校验，再编排可读，最后元数据）：
//  1. ValidatePresetArchive：路径逃逸/符号链接/体积/条目数，并算 sha256；
//  2. ListArchiveContents + ValidateAgentComposition：编排必须可读且可解析
//     （archupd-1②：此前 composition 被丢弃，审核页只能看到空串）；
//  3. preset.yml 必须存在且 ParseAgent 通过（「包内即真相」）。
//
// 失败时**已写好错误响应**并返回 ok=false，调用方必须直接 return。
func parsePresetUpload(c *gin.Context, name, archiveB64 string) (parsedPresetUpload, bool) {
	var out parsedPresetUpload
	if len(archiveB64) == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少归档内容")
		return out, false
	}
	raw, err := base64.StdEncoding.DecodeString(archiveB64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归档编码错误")
		return out, false
	}
	checksum, err := ValidatePresetArchive(raw)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
		return out, false
	}
	// 2026-09-01:智能体对齐技能标准——展示元数据一律来自包内 preset.yml
	// (「包内即真相」),此前靠请求体手填,导致卡片只能显示目录名、版本
	// 永远是兜底的 1.0.0。
	entries, composition, listErr := ListArchiveContents(raw)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(listErr))
		return out, false
	}
	// archupd-1②:编排必须可读(非空且在上限内)且可解析才能进入审核队列。
	// 此前 composition 被 `_` 丢弃,任何真实超过预览上限的编排都能发布成功,
	// 而管理员审核页只能看到空串——审核这一门形同虚设。
	if cerr := ValidateAgentComposition(composition); cerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", cerr.Error())
		return out, false
	}
	presetYML, _, found, _, _, xerr := archiveutil.ExtractFileContent(raw, skillmanifest.PresetMetaFile, maxFilePreviewBytes)
	if xerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return out, false
	}
	if !found {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, skillmanifest.CodeMissingField,
			"归档缺少 "+skillmanifest.PresetMetaFile+":展示名/版本/描述/作者/分类必须写在包内")
		return out, false
	}
	man, manErr := skillmanifest.ParseAgent(entries, presetYML, name)
	if manErr != nil {
		var me *skillmanifest.Error
		if errors.As(manErr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return out, false
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "预设元数据校验失败")
		return out, false
	}
	out.raw, out.checksum, out.title = raw, checksum, man.Title
	out.manifest = appstore.FromSkillManifest(man)
	return out, true
}

// uploadPresetName 校验上传目标名；失败已写响应。
func uploadPresetName(c *gin.Context, name string) bool {
	if !presetIDRe.MatchString(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法(小写字母/数字/中划线)")
		return false
	}
	return true
}

// errPublish 把发布内核的结构化错误映射成统一 JSON 信封（与技能侧同形）。
func errPublish(c *gin.Context, perr error) {
	var ae *appstore.Error
	if errors.As(perr, &ae) {
		serverauth.WriteError(c, ae.Status, ae.Code, ae.Message)
		return
	}
	serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "发布失败")
}

// upload accepts one preset archive (base64 in JSON), validates it, stores
// it, and creates (or reuses on resubmit of a rejected name) a pending row.
//
// 渠道语义：PublishRequest.Channel 留空 = **自动解析**（2026-10-23「已上架技能
// 无法更新」修复）：已存在的 App 沿用 apps.channel（作者更新的是他自己那条
// 内容，渠道不是他该重新声明的事实），不存在的 App 落到组织渠道 org。此前
// 这里写死 org，内核按 `existingApp.Channel != req.Channel` 判跨渠道同名 ⇒
// 员工对已上架的市场预设永远 409 NAME_TAKEN。非管理员发布恒为 pending。
func upload(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > MaxBodyBytes {
			serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "归档过大")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxBodyBytes)
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			DisplayName string `json:"display_name"`
			Version     string `json:"version"`
			Archive     string `json:"archive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !uploadPresetName(c, req.Name) {
			return
		}
		// 请求里的 version 只做形状校验（旧客户端会硬编码 1.0.0）；
		// 真正的版本以包内 preset.yml 为准（「包内即真相」）。
		if req.Version == "" {
			req.Version = "1.0.0"
		}
		if !skillmanifest.IsVersion(req.Version) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidVersion,
				"版本号不合法:必须是 x.y.z(可带 -rc.1 预发布后缀)")
			return
		}
		parsed, ok := parsePresetUpload(c, req.Name, req.Archive)
		if !ok {
			return
		}

		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		// 锁定、版本语义(不可复用/必须递增/内容未变更)、归属保护与待审配额
		// 与技能共用同一个发布内核——此前智能体这条路径全都没有,管理员锁定
		// 对它不生效。
		res, perr := appstore.Publish(db, appstore.PublishRequest{
			Kind:       serverstore.AppKindAgent,
			AppID:      req.Name,
			Channel:    "",
			Archive:    parsed.raw,
			Publisher:  u.Username,
			PendingCap: serverstore.MaxPendingPerAuthor,
			Manifest:   parsed.manifest,
			Checksum:   parsed.checksum,
		})
		if perr != nil {
			errPublish(c, perr)
			return
		}
		_ = serverstore.AuditLog(db, u.Username, "agent_preset_upload",
			sharedskills.UploadAuditDetail(req.Name, res.Version, parsed.title, parsed.checksum))
		c.JSON(http.StatusCreated, gin.H{"preset": gin.H{"name": req.Name, "version": res.Version, "status": res.Status}})
	}
}

// uploadAdmin 是**管理端**「给组织共享智能体库发新版本」的端点
// （POST /api/server/admin/agent-presets/:name/archive）。
//
// 与技能侧 uploadAdmin 逐条同形（sharedskills/routes.go 的孪生实现）：
//   - 复用员工上传的同一套归档解析（parsePresetUpload），请求体只有 {archive}，
//     版本/展示名以**包内** preset.yml 为准（忽略请求里的 version 字段）；
//   - AdminPublish=true：跳过能力锁定与待审配额，发布即 approved；
//   - 渠道显式 org（管理端声明的是命名空间，不是「沿用作者的渠道」）。
//
// 为什么需要它：员工上传路径把非管理员发布恒定成 pending，而组织预设的
// 管理面此前只有审批与元数据操作，没有「管理员直接发版」的入口；市场侧
// 已有等价端点（POST /api/server/admin/agents/:name/archive）。
//
// RBAC（capability:write）由 internal/router 的路由声明负责，本 handler 不
// 重复判权限。
func uploadAdmin(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > MaxBodyBytes {
			serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "归档过大")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxBodyBytes)
		var req struct {
			Archive string `json:"archive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		name := c.Param("name")
		if !uploadPresetName(c, name) {
			return
		}
		parsed, ok := parsePresetUpload(c, name, req.Archive)
		if !ok {
			return
		}
		admin := adminUsername(c)
		res, perr := appstore.Publish(db, appstore.PublishRequest{
			Kind:         serverstore.AppKindAgent,
			AppID:        name,
			Channel:      serverstore.AppChannelOrg,
			Archive:      parsed.raw,
			Publisher:    admin,
			AdminPublish: true,
			Manifest:     parsed.manifest,
			Checksum:     parsed.checksum,
		})
		if perr != nil {
			errPublish(c, perr)
			return
		}
		_ = serverstore.AuditLog(db, admin, "agent_preset_upload",
			sharedskills.UploadAuditDetail(name, res.Version, parsed.title, parsed.checksum))
		c.JSON(http.StatusCreated, gin.H{"preset": gin.H{"name": name, "version": res.Version, "status": res.Status}})
	}
}

func listAll(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListAgentPresets(db, c.Query("status"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// agentshare-2:审批队列是共享库的队列 —— 市场渠道行由市场端点审核,
		// 混进来会让 webadmin 用 agentshare 的 base_path 渲染删除/审核按钮,
		// 一次点击即可销毁市场内容。
		org, oerr := orgAgentNames(db)
		if oerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, p := range list {
			if !org[p.Name] {
				continue
			}
			out = append(out, presetJSON(p))
		}
		c.JSON(http.StatusOK, gin.H{"presets": out})
	}
}

// decide approves or rejects one row (admin only). Legacy single-param form
// addresses the name's LATEST row (审计 2026-08-25 D-1:保留旧 UI/代理兼容,
// 但「最新」经 GetAgentPreset 的 semver 语义解析,非字符串排序)。
// P1-11:目标版本必须是「最高版本的非 approved 行」——已上架 1.0.0 + 待审
// 2.0.0 时,旧实现(GetAgentPreset = 最高 approved)会把 1.0.0 置 rejected
// (已上架版本从员工目录消失)而 2.0.0 仍 pending。按版本精确审核请用
// /:name/:version/{approve,reject}。
func decide(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		p, err := serverstore.GetAgentPresetForReview(db, name)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		if !decideBody(c, status) {
			return
		}
		// F-13(能力中心审计 2026-10-26,P2):审核落定的**唯一实现**是
		// `serverstore.ReviewPending`(状态迁移 + 下架冻结 + 拒绝即释放归档 +
		// apps 投影重算)。修前本函数与 sharedskills/agentshare 的另两处审核面
		// 各写一份,漂移面就是 F-13 记的账;现在三面只调这一个函数。
		//
		// 保留在本函数里的只有渠道/参数前置判定(渠道守卫、拒绝理由校验)——
		// "这次请求有没有资格落到那一行"是渠道相关的,不在 ReviewPending 契约内。
		// 错误映射见 writeDecideError(与 409/404 语义逐条对应)。
		if err := serverstore.ReviewPending(db, serverstore.AppKindAgent, p.Name, p.Version,
			status == serverstore.AgentPresetApproved, reasonOf(c)); err != nil {
			writeDecideError(c, err)
			return
		}
		// F-44(2026-10-26):审核审计带 app_id(审计日志的 app 维度可检索)。
		_ = serverstore.AuditLogApp(db, p.Name, adminUsername(c), auditAction, p.Name+"@"+p.Version)
	}
}

// decideVersioned approves or rejects one name@version row (admin only).
// 审计 2026-08-25 D-1:webadmin 多版本化后必须能按版本精确审核,
// 而不是只有「最新版本」行。
func decideVersioned(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if _, err := serverstore.GetAgentPresetByVersion(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !requireOrgAgent(c, db, name) {
			return
		}
		if !decideBody(c, status) {
			return
		}
		// F-13:与 decide 同一条唯一实现(见上)。
		if err := serverstore.ReviewPending(db, serverstore.AppKindAgent, name, version,
			status == serverstore.AgentPresetApproved, reasonOf(c)); err != nil {
			writeDecideError(c, err)
			return
		}
		// F-44:审核审计带 app_id。
		_ = serverstore.AuditLogApp(db, name, adminUsername(c), auditAction, name+"@"+version)
	}
}

// decideBody parses the optional rejection reason for a reject decision.
// Returns false (and writes the error response) when invalid.
func decideBody(c *gin.Context, status serverstore.AgentPresetStatus) bool {
	if status != serverstore.AgentPresetRejected {
		c.Set("preset_reason", "")
		return true
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return false
	}
	reason := strings.TrimSpace(body.Reason)
	if len([]rune(reason)) > maxReasonLen {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "拒绝理由过长(上限 500 字)")
		return false
	}
	if reason == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请填写拒绝理由")
		return false
	}
	c.Set("preset_reason", reason)
	return true
}

// reasonOf reads the parsed rejection reason set by decideBody.
func reasonOf(c *gin.Context) string {
	if v, ok := c.Get("preset_reason"); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// writeDecideError 把审核写入的错误映射成稳定的 HTTP 语义。两条关键:
//
//   - N-4:两个管理员并发 approve/reject 时,后来者可能在 DAO 的条件 UPDATE
//     上发现「归档已经在上一个事务里被释放」—— 那不是服务器错误,而是「该
//     版本已不可通过」,必须回 409 ARCHIVE_CLEARED(与预检同码同文案),而不是 500。
//   - ID-01(审计 2026-09-23):拒绝一个**已通过审核**的版本会被 DAO 挡下
//     (`status <> 'approved'`)—— 拒绝与释放归档是同一条 UPDATE,对正在服务
//     的版本执行它等于不可恢复地销毁归档字节并烧掉版本号。这里回 409 并指路
//     (下架可逆),文案取自 serverstore 的共享常量,与 sharedskills / wasmapp
//     三面逐字一致 —— 「已 approved 不可拒绝」的判定只有 DAO 一处实现。
func writeDecideError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, serverstore.ErrReleaseApprovedNotRejectable):
		serverauth.WriteError(c, http.StatusConflict, serverstore.CodeReleaseNotRejectable,
			serverstore.MsgReleaseNotRejectable+"。"+serverstore.HintReleaseNotRejectable)
	case errors.Is(err, serverstore.ErrReleaseArchiveCleared):
		serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED",
			"该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本")
	case errors.Is(err, serverstore.ErrAppDelisted):
		// F-14:并发下「预检时还上架、落库时已下架」⇒ 409 APP_DELISTED。
		serverauth.WriteError(c, http.StatusConflict, appstore.CodeAppDelisted,
			"该智能体已下架，无法通过审核：请先重新上架再审核")
	case errors.Is(err, serverstore.ErrNotFound):
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
	default:
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
	}
}

// softDeleteAllPresetVersions 软删该 name 的全部**未生效**版本，返回被删的版本号。
//
// name 级删除的契约是「删全版本」(统一存储前是 DELETE ... WHERE name=?),而 DAO
// 只有按版本软删;逐行调用一旦中途失败就会留下「半删除」僵尸行(agentshare-1)。
// 所以它在**一个事务 + 行锁**里做两件事:先锁住该 name 的全部活版本行、断言其中
// 没有 approved,再一条 UPDATE 全删。锁与 `SetReleaseStatusForReview` 的 approve
// UPDATE 争同一批行 ⇒ 「读到全是 pending」与「删除」之间不可能被并发 approve 穿过。
//
// F-01 残留(能力中心审计 2026-10-26,P0):修前这里**无条件**删全部版本并
// `archive = NULL` —— approved 版本(正在对全员服务、可能唯一可回滚的历史版本)也
// 被永久销毁,且不返回 409、不重算投影。现在 approved 存在 ⇒ 返回
// serverstore.ErrReleaseApprovedNotDeletable,调用方映射成与版本级删除逐字相同的
// 409 RELEASE_APPROVED_NOT_DELETABLE(要停止提供请用下架,要删先按版本删未生效行)。
func softDeleteAllPresetVersions(db *sql.DB, name string) ([]string, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.Query(`SELECT version, status FROM app_releases
		WHERE kind = ? AND app_id = ? AND deleted_at IS NULL FOR UPDATE`,
		serverstore.AppKindAgent, name)
	if err != nil {
		return nil, err
	}
	versions := make([]string, 0, 4)
	approved := make([]string, 0, 1)
	for rows.Next() {
		var version, status string
		if err := rows.Scan(&version, &status); err != nil {
			_ = rows.Close()
			return nil, err
		}
		versions = append(versions, version)
		if !serverstore.ReleaseDeletable(status) {
			approved = append(approved, version)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(approved) > 0 {
		// 不回滚也能退出(defer 会回滚),但显式说明语义:一行都不动。
		return nil, serverstore.ErrReleaseApprovedNotDeletable
	}
	if len(versions) == 0 {
		return nil, serverstore.ErrNotFound
	}
	if _, err := tx.Exec(`UPDATE app_releases SET deleted_at = `+serverstore.NowExpr()+`,
		archive = NULL, updated_at = `+serverstore.NowExpr()+`
		WHERE kind = ? AND app_id = ? AND deleted_at IS NULL AND status <> ?`,
		serverstore.AppKindAgent, name, serverstore.ReleaseStatusApproved); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return versions, nil
}

// remove deletes ALL rows of a name plus every archive file of that name
// (审计 2026-08-25 D-1:旧实现只删 1.0.0,遗留其它版本孤儿归档)。
//
// F-01 残留(能力中心审计 2026-10-26,P0):name 级删除同样不得销毁已生效版本 ——
// 有 approved ⇒ 409 RELEASE_APPROVED_NOT_DELETABLE(与版本级删除逐字同码同文案),
// 内容/归档/投影一字不动;只有全 pending/rejected 时才真删,删后**重算投影**
// (脏投影行因此有自愈路径),审计带 app_id(F-44)。
func remove(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		// agentshare-2:共享面的删除只作用于组织共享库,不能销毁市场内容。
		if !requireOrgAgent(c, db, name) {
			return
		}
		versions, derr := softDeleteAllPresetVersions(db, name)
		if derr != nil {
			switch {
			case errors.Is(derr, serverstore.ErrReleaseApprovedNotDeletable):
				// F-01:已生效版本不可删除(409 + 明确错误码 + 指路可逆动作)。
				serverauth.WriteError(c, http.StatusConflict, serverstore.CodeReleaseNotDeletable,
					serverstore.MsgReleaseNotDeletable+"。"+serverstore.HintReleaseNotDeletable)
				return
			case errors.Is(derr, serverstore.ErrNotFound):
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		// Best-effort archive cleanup:DB 归档列已由软删清空,这里只清磁盘
		// 回退缓存(pre-0041 行遗留的 tar.gz 文件)。
		for _, v := range versions {
			_ = os.Remove(filepath.Join(cacheDir, safeName(name, v)))
		}
		// 硬删全部行后清理该 name 的全部授权(资源级联;旧授权不复活重建资源)。
		_ = serverstore.DeleteSharedResourceGrants(db, serverstore.SharedPresetGrantTable, name)
		// F-01 残留:删除是投影的又一条写路径 —— 不重算会让 apps 行停在已删版本的
		// 标题上(目录与内容分叉且无自愈)。
		if _, perr := serverstore.RecomputeAppProjection(db, serverstore.AppKindAgent, name); perr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL",
				"预设已删除,但投影更新失败(请重试一次)")
			return
		}
		// F-44:审核/删除审计带 app_id(审计日志的 app 维度可检索),与 WASM 面同口径。
		_ = serverstore.AuditLogApp(db, name, adminUsername(c), "agent_preset_delete", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// removeVersioned deletes one name@version row plus its archive.
//
// F-01(能力中心 P0,2026-10-26):已通过审核的版本**不可删除** —— 删除会在
// 同一条 UPDATE 里把 archive 置 NULL(不可恢复),正在服务的版本立刻无法
// 下载,而 apps 投影仍停在旧标题上。判定唯一实现在
// serverstore.DeleteReleaseUnlessApproved(SQL 谓词 `status <> 'approved'`),
// 本函数只做错误码映射;要停止提供请用下架(PUT …/:name/enabled,可逆)。
//
// 删除成功后重算投影:与 decide 的收尾纪律一致(apps 行是目录下发的投影),
// 即使 pending/rejected 不参与投影,也显式让"投影 = 最高 approved 版本"
// 这条不变量重新成立一次(脏投影行因此有自愈路径)。
func removeVersioned(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if !requireOrgAgent(c, db, name) {
			return
		}
		if err := serverstore.DeleteAgentPresetVersion(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			// F-01:approved 版本不可删除(409 + 明确错误码 + 指路可逆动作)。
			if errors.Is(err, serverstore.ErrReleaseApprovedNotDeletable) {
				serverauth.WriteError(c, http.StatusConflict, serverstore.CodeReleaseNotDeletable,
					serverstore.MsgReleaseNotDeletable+"。"+serverstore.HintReleaseNotDeletable)
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		// 归档已在软删 UPDATE 里随 deleted_at 一起置 NULL(原子),不再补第二条
		// UPDATE —— 两条语句之间正是被并发 approve 穿过的窗口。
		_ = os.Remove(filepath.Join(cacheDir, safeName(name, version)))
		if _, perr := serverstore.RecomputeAppProjection(db, serverstore.AppKindAgent, name); perr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL",
				"版本已删除,但预设投影更新失败(请重试一次)")
			return
		}
		_ = serverstore.AuditLogApp(db, name, adminUsername(c), "agent_preset_delete", name+"@"+version)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// setEnabled 组织共享智能体上下架(SG-4,审计 2026-09-17,r2 server-gateway P3)。
//
// 语义与共享技能的 PUT /shared-skills/:name/enabled 完全对称(apps.enabled),
// 且**只作用于组织渠道行** —— 市场渠道智能体由 marketplace 的
// POST /agents/:name/enable 管理,那里同样拒绝跨渠道写(agentshare-2 的反方向
// 守卫,避免两个入口互相覆盖),所以本端点复用 requireOrgAgent。
//
// 为什么必须有它:读侧(员工清单 ListVisibleAgentPresets、agentshare.listVisible、
// serveArchive)一直按 apps.enabled 闸门过滤,但组织智能体此前**没有任何写入点**
// (marketplace 的 SetAppEnabled 只放行 AppChannelMarket),管理员要下线一个
// 组织智能体只能走软删 —— 而软删会永久烧掉名字与版本号。本端点把这个不对称
// 补上:下架不删数据,重新上架即恢复。
func setEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", `请求体格式错误(需要 {"enabled": true|false})`)
			return
		}
		if !requireOrgAgent(c, db, name) {
			return
		}
		if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, name, *req.Enabled); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "切换失败")
			return
		}
		// 可见性变更必审计(与市场智能体的 agent 上下架、共享技能的
		// shared_skill_disable/enable 同精神)。
		action := "agent_preset_disable"
		if *req.Enabled {
			action = "agent_preset_enable"
		}
		_ = serverstore.AuditLog(db, adminUsername(c), action, name)
		c.JSON(http.StatusOK, gin.H{"ok": true, "enabled": *req.Enabled})
	}
}

// grantReq carries {username} or {group} (webadmin sends @group).
type grantReq struct {
	Username string `json:"username"`
	Group    string `json:"group"`
}

func grantSubject(req grantReq) (string, serverstore.GranteeType, bool) {
	if req.Username != "" {
		return req.Username, serverstore.GranteeUser, true
	}
	if req.Group != "" {
		return req.Group, serverstore.GranteeGroup, true
	}
	return "", "", false
}

// listPresetGrants returns the grants on one shared agent preset (by name).
func listPresetGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// agentshare-2:授权读也只服务组织共享库(市场授权在 app_grants 里
		// 与共享库同名同 kind,不过滤渠道就会读出市场 ACL)。
		if !requireOrgAgent(c, db, c.Param("name")) {
			return
		}
		grants, err := serverstore.ListSharedResourceGrants(db, serverstore.SharedPresetGrantTable, c.Param("name"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if grants == nil {
			grants = []serverstore.Grant{}
		}
		c.JSON(http.StatusOK, gin.H{"grants": grants})
	}
}

// replacePresetGrants sets the full group-grant set of a shared preset.
func replacePresetGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !requireOrgAgent(c, db, name) {
			return
		}
		var req struct {
			Groups []string `json:"groups"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if err := serverstore.ReplaceSharedGroups(db, serverstore.SharedPresetGrantTable, name, req.Groups); err != nil {
			if err == serverstore.ErrValidation || err == serverstore.ErrNotFound {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门名不合法或不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_grant", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// setPresetQuality sets/clears the quality tag of one approved shared agent
// (”|official|featured). Only approved rows may carry a tag; audit as
// agent_preset_qualify.
func setPresetQuality(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !requireOrgAgent(c, db, name) {
			return
		}
		var req struct {
			Quality string `json:"quality"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !serverstore.ValidAgentQuality(req.Quality) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法(空/featured;官方已移交归属官方操作)")
			return
		}
		if err := serverstore.SetAgentPresetQuality(db, name, version, req.Quality); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在或未通过审核")
				return
			}
			if errors.Is(err, serverstore.ErrValidation) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLogApp(db, name, adminUsername(c), "agent_preset_qualify", name+"@"+version+"="+req.Quality)
		c.JSON(http.StatusOK, gin.H{"ok": true, "quality": req.Quality})
	}
}

// setPresetGrant adds/removes one user or group grant (idempotent).
func setPresetGrant(db *sql.DB, grant bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !requireOrgAgent(c, db, name) {
			return
		}
		var req grantReq
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		subject, t, ok := grantSubject(req)
		if !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少授权主体")
			return
		}
		// 存在性校验(审计 2026-08-25 G5):与 marketplace 的 applyGrant 对齐,
		// 防拼错主体导致「资源永远对某人可见/不可见」的静默授权错误。
		if grant {
			exists := false
			if t == serverstore.GranteeUser {
				_, uErr := serverstore.GetUserByUsername(db, subject)
				exists = uErr == nil
			} else {
				_, gErr := serverstore.GroupByName(db, subject)
				exists = gErr == nil
			}
			if !exists {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权主体不存在")
				return
			}
		}
		var err error
		if grant {
			err = serverstore.GrantSharedResource(db, serverstore.SharedPresetGrantTable, name, subject, t)
		} else {
			err = serverstore.RevokeSharedResource(db, serverstore.SharedPresetGrantTable, name, subject, t)
		}
		if err != nil {
			if err == serverstore.ErrValidation {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权主体不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		action := "agent_preset_grant"
		if !grant {
			action = "agent_preset_revoke"
		}
		_ = serverstore.AuditLog(db, adminUsername(c), action, name+"@"+string(t)+":"+subject)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// download serves the stored archive of the name's LATEST row (legacy
// single-param form). Employees may download only approved presets (anything
// else is the same 404 as "does not exist", so the review queue of other
// people is never leaked); admins may download any row.
//
// 渠道口径(F4,2026-09-23 复审):`admin=true`(管理面 `/api/server/admin/agent-presets/*`)
// **只服务组织行** —— 市场行有自己的管理面归档端点
// `GET /api/server/admin/agents/:name/archive`(marketplace,2026-09-23 补齐),
// 组织命名空间不该服务它。守卫在**任何行读取之前**,拒绝语义与"名字不存在"逐字节一致
// (requireOrgAgent ⇒ 404「预设不存在」);`admin=false`(员工面)仍两渠道都服务 ——
// 那是市场智能体的安装通路,口径见 channel.go 末段。
func download(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		if admin && !requireOrgAgent(c, db, name) {
			return
		}
		p, err := serverstore.GetAgentPreset(db, name)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		serveArchive(c, db, cacheDir, p, admin)
	}
}

// downloadVersioned serves the stored archive of one name@version row.
// 渠道口径与 download 相同(F4):管理面只服务组织行,员工面两渠道都服务。
func downloadVersioned(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if admin && !requireOrgAgent(c, db, name) {
			return
		}
		p, err := serverstore.GetAgentPresetByVersion(db, name, version)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		serveArchive(c, db, cacheDir, p, admin)
	}
}

// serveArchive performs the status/auth checks and streams the archive for
// one resolved row; it writes the error response on any refusal.
// 审计 2026-08-25 D-1:文件路径用 p.Version(与上传一致),不再硬编码
// "1.0.0"(多版本下载曾必然 500「归档文件缺失」)。
//
// admin=false 的两条路由 = 客户端(员工)面,三重闸门(审核状态 / App 级
// 上下架 / 授权)任一不过都与「不存在」同 404;admin=true 的管理面只读归档,
// 便于审核与排查已下架内容。
func serveArchive(c *gin.Context, db *sql.DB, cacheDir string, p *serverstore.AgentPreset, admin bool) {
	if !admin && p.Status != serverstore.AgentPresetApproved {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
		return
	}
	// agentshare-2:员工下载是市场智能体唯一的安装通路(CapabilityCenterPanel
	// 的 installEndpoint),因此共享面的下载端点**两种渠道都服务**(清单/审核
	// 等其它共享面端点则只服务 org,见 orgAgentNames)。
	//
	// P2-1(审计 2026-09-13):apps.enabled=0(下架)即不可下载——此前只查
	// 审核状态与授权,管理员下架后员工仍能按名字取下归档。
	// 判据唯一实现在 serverstore.Distribution.Delivered()(见
	// serverstore/distribution.go 的语义权威);单个 App 一次查询,不引入逐行
	// N+1(同一次查询里的 Owner 供下面的归属豁免使用)。
	dist := serverstore.Distribution{}
	if !admin {
		var derr error
		dist, derr = serverstore.AppDistribution(db, serverstore.AppKindAgent, p.Name)
		if derr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !dist.Delivered() {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}
	}
	// 授权检查:非 admin 下载须已授权(**或为归属人本人**);否则与不存在同 404。
	//
	// 豁免判据是 apps.owner,不是 app_releases.publisher(第五轮审计 R5-B-2 的
	// 智能体孪生,2026-09-23 跨泳道补齐):归属转移后旧上传者已无任何权利,而新
	// 归属人——唯一有权续传的人——若还要靠授权才能取到自己的内容,「转移出来的
	// 发布权」就是空的。两面同源见 serverstore.AppOwnedByOwner(与技能侧
	// sharedskills.download 逐字同形)。
	if !admin {
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		isOwner := dist.OwnedBy(u.Username)
		if !isOwner {
			groups, gErr := serverstore.UserEffectiveGroups(db, u.ID)
			if gErr != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			names, gErr := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedPresetGrantTable, u.Username, groups)
			if gErr != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			granted := false
			for _, n := range names {
				if n == p.Name {
					granted = true
					break
				}
			}
			if !granted {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
		}
	}
	// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
	var payload []byte
	dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
	switch {
	case aerr == nil && dbRaw != nil:
		payload = dbRaw
	case aerr == nil:
		diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
		if r, rerr := os.ReadFile(diskPath); rerr == nil {
			payload = r
		} else {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档数据缺失")
			return
		}
	default:
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
		return
	}
	_, _ = serverstore.IncrementAgentPresetDownload(db, p.Name, p.Version)
	// 按归档实际格式回响应(zip 推荐 / tar.gz 兼容):文件名与 Content-Type
	// 跟随魔数嗅探,旧行(存库为 tar.gz)下载仍正确。
	dispName := safeName(p.Name, p.Version)
	contentType := "application/gzip"
	if archiveutil.Format(payload) == "zip" {
		dispName = p.Name + "-" + p.Version + ".zip"
		contentType = "application/zip"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", dispName))
	c.Header("X-Preset-Version", p.Version)
	// 完整性头走**唯一实现** `sharedskills.ArchiveChecksum`（第二十二轮复审 V2-B1，
	// P2，A2-02 的兄弟面）：`app_releases.checksum` 是 schema 的默认可达态为空
	// （`migrations-pg/0054_apps_backfill.sql` 按 `p.checksum` 原值回填），直发
	// `p.Checksum` 会发出**空头**；而客户端对"头存在但为空"是 fail-closed
	// （`packages/host/enterprise/src/auth-gate.ts` 的 `?? undefined` 把空头变成 `''`，
	// `agent-preset-install.ts` 的 `if (checksum !== undefined)` 于是进入比较分支 ⇒
	// `archive checksum mismatch; refused`）⇒ 那些行对**所有**员工永久装不上，
	// 与 A2-02 修前的技能组织面逐字同形。
	//
	// 「与市场面 `marketplace.downloadAgentArchiveAdmin` 共用同一份实现」这件事由
	// `internal/marketplace/agent_checksum_parity_test.go` 钉住（两头非空、彼此相等、
	// 且都等于归档字节的 sha256）。
	c.Header("X-Preset-Checksum", sharedskills.ArchiveChecksum(p.Checksum, payload))
	c.Data(http.StatusOK, contentType, payload)
}

// archiveErrorMessage maps validation refusals to the client-facing message.
//
// 文案的**单一真源**是 archiveutil.ErrorText(archive.go:816):本函数只保留
// 两处特例,其余分支一律经 ErrorText 生成 ——
//   - ErrArchiveTooLarge:本域把 ErrInvalid(空/超大)收敛成"过大",文案与
//     ErrorText 的 ErrInvalid 分支("归档过大或结构非法(上限 NMB)")不同;
//   - ErrCorrupt:本域按"条目解压或 CRC"描述,与 ErrorText 的"必填文件解压
//     或校验失败"不同,保留原文案。
//
// 其余本域哨兵(ErrNoComposition/ErrUnsafeArchive/ErrEntryLimit/
// ErrDuplicateEntry)不包装 archiveutil 哨兵,因此在这里显式映射到对应的
// archiveutil 哨兵再交给 ErrorText(输出与改前逐字相同);重复条目仍先用
// DuplicateEntryNames 点出两个折叠同名的条目(F2-N7),点不出来才用通用文案。
func archiveErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrArchiveTooLarge):
		return fmt.Sprintf("归档过大(上限 %dMB)", MaxArchiveBytes>>20)
	case errors.Is(err, ErrNoComposition):
		return archiveutil.ErrorText(archiveutil.ErrNoRequired, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrUnsafeArchive):
		return archiveutil.ErrorText(archiveutil.ErrUnsafe, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrEntryLimit):
		return archiveutil.ErrorText(archiveutil.ErrTooMany, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrDuplicateEntry):
		// F2-N7:列出被判为同一个文件的两个名字 —— installerKey 的折叠
		// (大小写/尾随点空格/NTFS 危险折叠)宁严勿宽,不点名的话用户无从改名。
		if first, second, ok := archiveutil.DuplicateEntryNames(err); ok {
			return fmt.Sprintf("归档含重复条目:%s 与 %s 在安装端是同一个文件(大小写/尾随点空格折叠),请改名后重新打包", first, second)
		}
		return archiveutil.ErrorText(archiveutil.ErrDuplicateEntry, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, archiveutil.ErrCorrupt):
		return "归档内容损坏(条目解压或 CRC 校验失败)"
	default:
		return archiveutil.ErrorText(err, CompositionFile, MaxArchiveBytes>>20)
	}
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}
