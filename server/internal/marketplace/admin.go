package marketplace

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// RegisterAdminRoutes mounts /api/server/admin/skills* behind AdminAuth + RBAC
// (v3b). cacheDir is the skill repo/archive cache, invalidated when a
// skill's source changes (C-6).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "/skills", serverauth.PermMarketRead, func(c *gin.Context) { listSkillsAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/skills", serverauth.PermMarketWrite, func(c *gin.Context) { createSkillAdmin(c, db) })
	// F-05:直发即 approved,与审批同权(capability:write);生产路由唯一真源在
	// internal/router,本函数是测试镜像,必须逐条同权。
	serverauth.AdminRoute(g, "POST", "/skills/:name/archive", serverauth.PermCapabilityWrite, func(c *gin.Context) { uploadSkillArchiveAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name", serverauth.PermMarketWrite, func(c *gin.Context) { updateSkillAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "DELETE", "/skills/:name", serverauth.PermMarketWrite, func(c *gin.Context) { deleteSkillAdmin(c, db) })
	// 重新上架(审计 A5-M1: 下架不可逆曾导致误下架无法恢复)
	serverauth.AdminRoute(g, "POST", "/skills/:name/enable", serverauth.PermMarketWrite, func(c *gin.Context) { enableSkillAdmin(c, db) })
	// 审批预览(2026-09-01):管理员上架前后都要能看到包内到底是什么。
	serverauth.AdminRoute(g, "GET", "/skills/:name/preview", serverauth.PermMarketRead, func(c *gin.Context) { previewSkillAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "GET", "/skills/:name/file", serverauth.PermMarketRead, func(c *gin.Context) { fileContentSkillAdmin(c, db, cacheDir) })
	// 归档下载(2026-09-23):预览弹层「文件过大 → 下载归档」= 预览基路径 + /archive。
	// 此前只有 POST …/archive(上传新版),市场行的那个链接必 404。
	serverauth.AdminRoute(g, "GET", "/skills/:name/archive", serverauth.PermMarketRead, func(c *gin.Context) { downloadSkillArchiveAdmin(c, db) })
	// 存量规范化(决策 2026-09-01 §八):产出符合发布契约的新版本(patch+1)。
	serverauth.AdminRoute(g, "POST", "/skills/:name/normalize", serverauth.PermCapabilityWrite, func(c *gin.Context) { normalizeSkillAdmin(c, db, cacheDir) })
	// 授权管理(严格默认:未授权不可见/不可下载)
	serverauth.AdminRoute(g, "GET", "/skills/:name/grants", serverauth.PermMarketRead, func(c *gin.Context) { listSkillGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name/grants", serverauth.PermMarketWrite, func(c *gin.Context) { replaceSkillGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { setSkillGrant(c, db, true) })
	serverauth.AdminRoute(g, "DELETE", "/skills/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { setSkillGrant(c, db, false) })
	// 市场智能体(G4):与市场技能同构(与 router 包镜像)。
	serverauth.AdminRoute(g, "GET", "/agents", serverauth.PermMarketRead, func(c *gin.Context) { listAgentsAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents", serverauth.PermMarketWrite, func(c *gin.Context) { createAgentAdmin(c, db) })
	// F-05(2026-10-26,镜像漂移补齐):管理员直发 = 落库即 approved = 审批同权 ⇒
	// `capability:write`。生产路由(internal/router/optional_skills_on.go)早已改,
	// 本镜像此前仍是 market:write —— 镜像树是权限用例的观测面(能力中心/管理端用例
	// 都用它建树),漂移会让测试证明的授权结论与生产**相反**。判据在 router 包:
	// TestAdminRouteMirrorPermissionParity(逐条比对两侧 (method,path)→perm)。
	serverauth.AdminRoute(g, "POST", "/agents/:name/archive", serverauth.PermCapabilityWrite, func(c *gin.Context) { uploadAgentArchiveAdmin(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name", serverauth.PermMarketWrite, func(c *gin.Context) { updateAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "DELETE", "/agents/:name", serverauth.PermMarketWrite, func(c *gin.Context) { deleteAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents/:name/enable", serverauth.PermMarketWrite, func(c *gin.Context) { enableAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/preview", serverauth.PermMarketRead, func(c *gin.Context) { previewAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/file", serverauth.PermMarketRead, func(c *gin.Context) { fileContentAgentAdmin(c, db) })
	// 归档下载(2026-09-23,与技能侧同形且同权限):预览弹层「文件过大 → 下载归档」。
	serverauth.AdminRoute(g, "GET", "/agents/:name/archive", serverauth.PermMarketRead, func(c *gin.Context) { downloadAgentArchiveAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/grants", serverauth.PermMarketRead, func(c *gin.Context) { listAgentGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name/grants", serverauth.PermMarketWrite, func(c *gin.Context) { replaceAgentGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { applyAgentGrant(c, db, true) })
	serverauth.AdminRoute(g, "DELETE", "/agents/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { applyAgentGrant(c, db, false) })

	// ---- 待审版本审核面（2026-10-23）----
	//
	// 与组织共享库同形：`/shared-skills/:name/:version/{approve,reject,preview,archive,file}`
	// 与 `/agent-presets/:name/:version/…` —— 技能/智能体两个 kind 在这里是对偶的，
	// 方法、路径形状、权限点逐条镜像（webadmin 的审核弹层复用同一个组件）。
	//
	// 权限点用 `capability:*`（与组织侧审核面同一族）：审核是对"平台内容"的裁决，
	// 不是市场运营的日常写操作；`market:*` 仍覆盖市场行的上架/授权/元数据。
	//
	// 渠道守卫与版本存在性由 `requireMarketReleaseForReview`（review.go）统一负责：
	// org 行与"该名字不存在"逐字节同形 404，绝不服务组织行。
	serverauth.AdminRoute(g, "POST", "/skills/:name/:version/approve", serverauth.PermCapabilityWrite, func(c *gin.Context) { approveSkillVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/skills/:name/:version/reject", serverauth.PermCapabilityWrite, func(c *gin.Context) { rejectSkillVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/skills/:name/:version/preview", serverauth.PermCapabilityRead, func(c *gin.Context) { previewSkillVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/skills/:name/:version/archive", serverauth.PermCapabilityRead, func(c *gin.Context) { downloadSkillVersionArchiveAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/skills/:name/:version/file", serverauth.PermCapabilityRead, func(c *gin.Context) { fileContentSkillVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents/:name/:version/approve", serverauth.PermCapabilityWrite, func(c *gin.Context) { approveAgentVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents/:name/:version/reject", serverauth.PermCapabilityWrite, func(c *gin.Context) { rejectAgentVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/:version/preview", serverauth.PermCapabilityRead, func(c *gin.Context) { previewAgentVersionAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/:version/archive", serverauth.PermCapabilityRead, func(c *gin.Context) { downloadAgentVersionArchiveAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/:version/file", serverauth.PermCapabilityRead, func(c *gin.Context) { fileContentAgentVersionAdmin(c, db) })

}

// grantReq carries a subject: {username} or {group} (webadmin sends @group).
type grantReq struct {
	Username string `json:"username"`
	Group    string `json:"group"`
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}

func parseGrantSubject(req grantReq) (string, serverstore.GranteeType, bool) {
	if req.Username != "" && req.Group == "" {
		return req.Username, serverstore.GranteeUser, true
	}
	if req.Group != "" && req.Username == "" {
		return req.Group, serverstore.GranteeGroup, true
	}
	return "", "", false
}

// strictBindJSON decodes the request body rejecting unknown fields, so a
// caller cannot silently send a body that this endpoint does not understand
// (审计 A5-M7: PUT grants 只接受 {groups:[...]})。
func strictBindJSON(c *gin.Context, v any) error {
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func grantsJSON(grants []serverstore.Grant) gin.H {
	if grants == nil {
		grants = []serverstore.Grant{}
	}
	return gin.H{"grants": grants}
}

func listSkillGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	grants, err := serverstore.ListSkillGrants(db, name)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, grantsJSON(grants))
}

func setSkillGrant(c *gin.Context, db *sql.DB, grant bool) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	applyGrant(c, db, grant, "skill#"+name,
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.GrantSkill(db, name, subject, t)
		},
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.RevokeSkill(db, name, subject, t)
		},
		"skill_grant", "skill_revoke")
}

// applyGrant 是技能单条授权与撤销的公共实现(审计 A5-L1):解析请求体
// → 主体存在性校验(拼错的用户名/部门名不应静默落库)→ grant/revoke → 审计。
func applyGrant(c *gin.Context, db *sql.DB, grant bool, subjectLabel string,
	grantFn, revokeFn func(subject string, t serverstore.GranteeType) error,
	grantAudit, revokeAudit string) {
	var req grantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	subject, t, ok := parseGrantSubject(req)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填且只能二选一")
		return
	}
	if t == serverstore.GranteeUser {
		if _, err := serverstore.GetUserByUsername(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "用户不存在: "+subject)
			return
		}
	} else if t == serverstore.GranteeGroup {
		if _, err := serverstore.GroupByName(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门不存在: "+subject)
			return
		}
	}
	if grant {
		if err := grantFn(subject, t); err != nil {
			writeMarketGrantWriteFailure(c, err, "授权对象不合法")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), grantAudit, subjectLabel+" "+string(t)+":"+subject)
	} else {
		if err := revokeFn(subject, t); err != nil {
			writeMarketGrantWriteFailure(c, err, "授权对象不合法")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), revokeAudit, subjectLabel+" "+string(t)+":"+subject)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// invalidateSkillCache removes the cached repo clone and built archives for a
// skill (C-6): a version/git change must not keep serving the old package.
func invalidateSkillCache(cacheDir, name string) {
	// CodeQL path-injection sanitizer: 仅字母数字与 ._- 的合法 skill 名。
	if !util.SafePathSegment(name) || !skillNameRe.MatchString(name) {
		return
	}
	os.RemoveAll(filepath.Join(cacheDir, name))
	matches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.tar.gz"))
	zipMatches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.zip"))
	for _, m := range append(zipMatches, matches...) {
		os.Remove(m)
	}
}

// skillNameRe 白名单(与 SafePathSegment 双重防护): [A-Za-z0-9._-]+
var skillNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func listSkillsAdmin(c *gin.Context, db *sql.DB) {
	list, err := serverstore.ListSkills(db, false)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, s := range list {
		out = append(out, skillJSON(s))
	}
	c.JSON(http.StatusOK, gin.H{"skills": out})
}

type skillReq struct {
	Name string `json:"name"`
	// Title 是展示名(2026-10-26 D 系列显示修复):管理端可显式改中文展示名。
	// 为空保持既有 apps.title(再空回落 name),绝不写 owner。
	Title       string `json:"title"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Author      string `json:"author"`
}

func createSkillAdmin(c *gin.Context, db *sql.DB) {
	var req skillReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	// marketplace-9:登记与上传同一套名字口径(上传走 appstore.Publish 的
	// skillmanifest.IsAppID)。此前只做 SafePathSegment,`My_Skill`/中文名
	// 能登记成功却永远无法上传内容(releases=0/enabled=1,无硬删除入口)。
	if !skillmanifest.IsAppID(req.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
			"技能名不合法:必须是小写 kebab-case(如 my-skill)")
		return
	}
	// 0052:git 源模式已移除——创建只登记名称与元数据,内容一律由
	// POST /skills/:name/archive 上传(归档是唯一入口,发布期集中严格校验)。
	s := &serverstore.Skill{Name: req.Name, Version: req.Version, Description: req.Description,
		Author: req.Author, DisplayName: strings.TrimSpace(req.Title), Enabled: 1}
	if _, err := serverstore.AddSkill(db, s); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能已存在")
			return
		}
		if errors.Is(err, serverstore.ErrConflict) {
			// 决策 2026-08-25:市场与组织合并为「市场」后,同名技能跨源互斥。
			// 共享库已存在同名技能(任意状态)时拒绝上架,要求管理员先处理共享库行。
			// F-42（2026-10-26）：四个"同名冲突"出口统一成一个码
			// `NAME_TAKEN`（与 appstore.Publish 一致）。修前这里回 `CONFLICT`
			// 而发布内核回 `NAME_TAKEN`，调用方要按"哪一个入口"分流才能识别
			// 同一件事；webadmin 不按该码分支（已核），因此只统一码不动文案。
			serverauth.WriteError(c, http.StatusConflict, appstore.CodeNameTaken,
				"名称与组织共享库技能冲突,请先在共享库处理同名技能")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_create", s.Name+" v"+s.Version)
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

// uploadSkillArchiveAdmin switches a skill to uploaded-archive mode: the
// admin submits a gzipped tar (base64 JSON, same envelope as shared-skills),
// it is validated structurally (SKILL.md at root) and stored directly in
// the DB row (0040). The git source is cleared — the archive is now the
// single source of truth. The version is taken from the request (must match
// the metadata inside, otherwise the client install fails cleanly).
func uploadSkillArchiveAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	// 归档以 base64 JSON 上传(base64 膨胀 ~33%):16MB 原始 → ≤24MB body。
	// marketplace 自建 /api/server/admin 组,不受 serverauth 1MB 中间件覆盖,此处
	// 显式限体(与 sharedskills.MaxBodyBytes 同值)。
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 24<<20)
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	// 存在性检查:上架前该 App 必须已登记(创建与内容分两步)。
	if _, err := serverstore.GetApp(db, serverstore.AppKindSkill, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req struct {
		Version string `json:"version"`
		Archive string `json:"archive"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Version == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "version 与 archive 必填")
		return
	}
	if strings.ContainsAny(req.Version, "/\\") || req.Version == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本不合法")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Archive)
	if err != nil || len(raw) == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归档编码错误或为空")
		return
	}
	if len(raw) > 16<<20 {
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "归档过大(上限 16MB)")
		return
	}
	checksum, err := sharedskills.ValidateSkillArchive(raw)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+err.Error())
		return
	}
	// 严格清单校验(决策 2026-09-01「包内即真相」):管理端上架与员工上传共用
	// 同一套规则——上游以 frontmatter 的 name 作运行时身份且强制 kebab-case,
	// 不合规的包上架后会被运行时静默忽略(2026-09-01 实测线上 30 个市场技能
	// 只有 3 个能被加载)。
	entries, skillMD, listErr := sharedskills.ListArchiveContents(raw)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+listErr.Error())
		return
	}
	man, manErr := skillmanifest.Parse(entries, skillMD, name)
	if manErr != nil {
		var me *skillmanifest.Error
		if errors.As(manErr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "SKILL.md 校验失败")
		return
	}
	// 2026-09-01:管理端上架同样走统一发布内核——版本语义(不可复用/必须
	// 递增/内容未变更)、跨渠道同名互斥、changelog 规则与员工路径完全一致,
	// 差别只有 AdminPublish=true(跳过锁定与待审配额,且发布即 approved)。
	res, perr := appstore.Publish(db, appstore.PublishRequest{
		Kind:            serverstore.AppKindSkill,
		AppID:           name,
		Channel:         serverstore.AppChannelMarket,
		Archive:         raw,
		Publisher:       adminUsername(c),
		AdminPublish:    true,
		DeclaredVersion: req.Version,
		Manifest:        appstore.FromSkillManifest(man),
		Checksum:        checksum,
	})
	if perr != nil {
		var ae *appstore.Error
		if errors.As(perr, &ae) {
			serverauth.WriteError(c, ae.Status, ae.Code, ae.Message)
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "发布失败")
		return
	}
	// 展示名回写:只认包内(trim 后)非空的 title。空 title 必须**保持既有**
	// apps.title(直接写空串会把管理员改好的中文展示名清掉,下一次渲染只剩
	// 英文目录名 —— 2026-10-26 D 系列显示修复)。
	if title := strings.TrimSpace(man.Title); title != "" {
		_ = serverstore.SetSkillDisplayName(db, name, title)
	}
	// 上传模式不再依赖磁盘缓存:清掉旧 clone/包,避免误读。
	invalidateSkillCache(cacheDir, name)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_update",
		sharedskills.UploadAuditDetail(name, res.Version, man.Title, checksum))
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": res.Version, "checksum": checksum})
}

func updateSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	s, err := serverstore.GetSkill(db, name)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req skillReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	// 0052:版本号一律由「上传新版」端点与归档原子写入——元数据 PUT 改版本
	// 会造成行版本与归档内容失配(git 模式移除后不再有例外)。
	if req.Version != "" && req.Version != s.Version {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请用「上传新版」随归档一起更改版本")
		return
	}
	// 归属(owner)= 发布权的唯一真源,前端把它当「署名」展示(webadmin 的
	// 文案就是「此处仅改署名展示」),但它的实际语义是"谁有权续传新版本"。
	// 因此这里**不接受**归属变更(审计 2026-09-23 G-P2-1):
	//
	//   - 此前 `s.Author = req.Author` 会被 UpdateSkill 写进 apps.owner ⇒ 一次
	//     普通元数据 PUT 变成**无审计的归属转移**(不校验用户是否存在、official
	//     行也照改,能造出 official=1 ∧ owner≠'' 的禁止状态);
	//   - 智能体孪生端点(agent_api.go 的 updateAgentAdmin)明确保留
	//     `Owner: a.Owner`,两条姊妹端点行为必须一致;
	//   - 合规入口只有一个:PUT /api/server/admin/apps/:kind/:app_id/owner
	//     (appstore/admin.go:目标用户存在性校验 + owner/official 互斥 + 同归属
	//     幂等 + app_owner_transfer 审计),webadmin 的「转移归属」按钮走它。
	//
	// 表单会回填当前归属,所以「值没变」必须放行(否则任何一次编辑描述都会被
	// 拒绝);只有**真的想改归属**才回 400 并指路 —— 静默忽略比报错更糟:
	// 管理员会以为改成功了。
	if req.Author != "" && req.Author != s.Author {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
			"归属(负责人)不能在这里修改:它决定谁能续传新版本,请用「转移归属」")
		return
	}
	if req.Description != "" {
		s.Description = req.Description
	}
	// 展示名(2026-10-26 D 系列显示修复):显式 title 优先;为空保持既有展示名
	// (appToSkill 已把「apps.title → 展示版本 title → name」的回退做在投影层),
	// UpdateSkillMeta 再对空值回落 name 并 trim。owner 不在此列 —— 它只走
	// 「转移归属」的唯一合规入口。
	if title := strings.TrimSpace(req.Title); title != "" {
		s.DisplayName = title
	}
	// UpdateSkillMeta 只写展示列(title/description/enabled),不碰 owner ——
	// 让"元数据 PUT 无意中改写归属"在 DAO 层结构上不可能(唯一真源在 DAO)。
	if err := serverstore.UpdateSkillMeta(db, s); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_update", s.Name+" v"+s.Version)
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

func deleteSkillAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// marketplace-8:市场端点只上下架市场渠道技能。org 渠道行此前被这里
	// 置成 enabled=0(200),而智能体侧同请求是 404 —— 越渠道写 + 审计
	// 记成 skill_disable。先断言渠道,再动 enabled。
	//
	// R23-V3-B3（复审 2026-09-27，P2）：这里的 `err != nil || a.Channel != market` 曾把
	// **依赖故障**（`apps` 表不可读）也塌成 404「技能不存在」，且零日志 —— 管理员把一次
	// PG 抖动读成终态。分类出口统一走 requireMarketAdminApp（与智能体对同一份实现）。
	if requireMarketAdminApp(c, db, serverstore.AppKindSkill, name, "技能不存在") == nil {
		return
	}
	// 下架 = 置 enabled=0(不删行,bootstrap 建议清单过滤)
	if _, err := serverstore.SetSkillEnabled(db, name, false); err != nil {
		writeMarketAppWriteFailure(c, err, "技能不存在", "下架失败")
		return
	}
	// 审计 A5-M8: 技能下架必须留痕(可见性变更必审计)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_disable", name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// enableSkillAdmin 重新上架技能(审计 A5-M1):enabled=1,恢复员工建议清单可见性。
func enableSkillAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// marketplace-8:同上,重新上架同样只作用于市场渠道行。
	// R23-V3-B3:分类出口同上（依赖故障 ⇒ 500 + 日志，不是 404）。
	if requireMarketAdminApp(c, db, serverstore.AppKindSkill, name, "技能不存在") == nil {
		return
	}
	if _, err := serverstore.SetSkillEnabled(db, name, true); err != nil {
		writeMarketAppWriteFailure(c, err, "技能不存在", "上架失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_enable", name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// replaceSkillGrants 整组替换技能的全部部门授权(原子;用户授权保留)。
func replaceSkillGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	var req struct {
		Groups []string `json:"groups"`
	}
	// 审计 A5-M7: 未知字段(如 {username})必须报错而非静默忽略 ——
	// 此前误传 username 的请求会把部门授权清空成空组。
	if err := strictBindJSON(c, &req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误(仅接受 groups 字段)")
		return
	}
	if err := serverstore.ReplaceSkillGroupGrants(db, name, req.Groups); err != nil {
		writeMarketGrantWriteFailure(c, err, "存在不认识的部门名称")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_grants_replace", name+" "+strings.Join(req.Groups, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// maxFilePreviewBytes caps the inline text returned by the per-file review
// endpoint. 真源 = skillmanifest.MaxSkillMDBytes(128 KB):sharedskills /
// agentshare / 解析入口同值,marketplace 曾是第 4 份独立拷贝(1 MB)——
// P2-5(审计 2026-09-13)。四处同值由 preview_limit_single_source_test.go
// 锁定;统一后「审核预览」语义不变:超过 128 KB 的条目仍标记 too_large
// 提示管理员下载归档查看,而不是让接口失去响应边界。
const maxFilePreviewBytes = skillmanifest.MaxSkillMDBytes

// skillArchiveForReview resolves the reviewable archive bytes of one market
// skill: 上传模式直接取 DB 归档;git 模式取磁盘上已构建的包(未构建则明确
// 告知,不静默回空)。
//
// P3-4(审计 2026-09-13):磁盘回退用 s.Version 拼文件名,而 legacy 行的
// version 可能含 `..`/分隔符(前者可读 cacheDir 之外的文件)。这里与
// agentshare.safeName 同级加固:两段都必须是合法单段路径,且 Clean 后的
// 结果必须仍在 cacheDir 之内;不合法一律当作「归档缺失」(调用方原有
// 404 语义,不新增响应形态)。
func skillArchiveForReview(s *serverstore.Skill, cacheDir string) ([]byte, string) {
	if len(s.Archive) > 0 {
		return s.Archive, ""
	}
	if !util.SafePathSegment(s.Name) {
		return nil, "技能名不合法"
	}
	if !util.SafePathSegment(s.Version) {
		return nil, "该技能尚未上传归档,暂无法预览"
	}
	base := filepath.Clean(cacheDir)
	for _, ext := range []string{".zip", ".tar.gz"} {
		p := filepath.Clean(filepath.Join(base, s.Name+"-"+s.Version+ext))
		if !strings.HasPrefix(p, base+string(os.PathSeparator)) {
			continue // 越界路径按「归档缺失」处理,绝不读 cacheDir 之外
		}
		if raw, err := os.ReadFile(p); err == nil {
			return raw, ""
		}
	}
	return nil, "该技能尚未上传归档,暂无法预览"
}

// previewSkillAdmin lists a market skill's archive entries and returns its
// SKILL.md inline —— 管理员审批前查看「到底上传了什么」的入口。
// 此前只有组织共享库有预览,管理后台上架的市场技能无从查看内容。
func previewSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	// 响应体构造与版本级审核预览**共用一份**（review.go 的 writeSkillArchivePreview）。
	writeSkillArchivePreview(c, s.Name, s.Version, s.Checksum, raw)
}

// downloadSkillArchiveAdmin 管理面下载市场技能的归档（2026-09-23）。
//
// 落点是 webadmin 归档预览弹层的「文件过大 → 下载归档」链接：链接 = 预览基路径
// + `/archive`，而市场行的基路径是 `/api/server/admin/skills/:name` —— 该命名空间
// 此前只声明了 `POST …/archive`（上传新版），GET 未声明 ⇒ 市场行点下去 404，组织行
// （`/shared-skills/:name/:version/archive`）正常。
//
// 与组织侧既有档案端点（sharedskills.DownloadAdmin）同形，不自创语义：
//   - 管理面只读归档，**不做上下架/授权闸门**（管理员本就能看到全部内容）；
//   - 缺失/尚未上传归档一律 JSON 信封 404（不是空 body、不是 405）；
//   - 命中即按归档实际格式下发二进制流 + 版本/校验和头 —— 字节与头由
//     serveSkillArchive 一处产出（员工面同一条出口，两端不可能漂移）。
//
// 渠道守卫来自 serverstore.GetSkill 本身（要求 apps.channel='market'），
// 与员工面同一条：市场命名空间不会服务组织行。
func downloadSkillArchiveAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	serveSkillArchive(c, db, s)
}

// fileContentSkillAdmin returns one file's content from a market skill's
// archive (审批时逐文件查看)。契约与共享技能审核面完全一致,webadmin 复用
// 同一个预览组件。
func fileContentSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	// ?path 的规范化与版本级端点共用（review.go 的 archiveFilePathParam）。
	norm, ok := archiveFilePathParam(c)
	if !ok {
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	// 逐文件响应与版本级端点共用（review.go 的 writeSkillArchiveFileContent）。
	writeSkillArchiveFileContent(c, raw, norm)
}

// normalizeSkillAdmin 一键规范化:把一个不合规的存量技能包改写成符合发布
// 契约的内容,并作为**新版本**(patch+1)入库。
//
// 决策 2026-09-01 §八:历史版本不可变,因此规范化不改写原版本,而是产出新
// 版本;规范化只做搬运与补齐(中文 name → title、剥 BOM、补 version/author/
// category),绝不编造 description —— 缺失时明确报错要人工补写。
func normalizeSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	files, rerr := archiveutil.ReadAll(raw, sharedskills.ArchiveLimits())
	if rerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	skillMD, ok := files["SKILL.md"]
	if !ok {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档缺少 SKILL.md")
		return
	}
	// 幂等:已经合规的包不再空转升版本(否则重复点「规范化」会不断产生
	// 内容相同、版本号递增的噪音版本)。
	if curEntries, curMD, cerr := sharedskills.ListArchiveContents(raw); cerr == nil {
		if m0, perr := skillmanifest.Parse(curEntries, curMD, s.Name); perr == nil && m0.Version == s.Version {
			// 空包内 title 不清空既有展示名(与上传/更新同一口径)。
			if title := strings.TrimSpace(m0.Title); title != "" {
				_ = serverstore.SetSkillDisplayName(db, s.Name, title)
			}
			c.JSON(http.StatusOK, gin.H{
				"ok": true, "version": s.Version, "checksum": s.Checksum,
				"changes": []string{}, "already_compliant": true,
			})
			return
		}
	}
	nextVersion := skillmanifest.BumpPatch(s.Version)
	normalized, changes, nerr := skillmanifest.NormalizeSkillMD(string(skillMD), skillmanifest.NormalizeOptions{
		AppID:   s.Name,
		Version: nextVersion,
		Author:  s.Author,
	})
	if nerr != nil {
		var me *skillmanifest.Error
		if errors.As(nerr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化失败")
		return
	}
	// 规范化产出的是新版本:版本号必须体现在包内(包内即真相)。
	normalized = forceVersion(normalized, nextVersion)
	// F-03(能力中心审计 2026-10-26):规范化必须服从**发布内核的硬规则** ——
	// 此前它绕过内核直接 `ReplaceSkillArchive` → CreateRelease(approved),既不判
	// 版本递增/同版本,也不判 changelog、下架冻结与官方/能力锁 ⇒ 规范化成了
	// 一条后门发布路径。现在落库改走 appstore.Publish(AdminPublish=true),由
	// 内核原子判定;本函数只负责把包改造成合规形态。
	//
	// changelog(非首个版本必填)不能凭空编造语义内容,但规范化**确实**发生了
	// 可列出的改动,因此把 changes 作为真实的更新说明写进 frontmatter;包内
	// 已有非空 changelog 时保持原值(作者写的说明优先)。
	normalized = ensureChangelogField(normalized, normalizeChangelog(changes))
	files["SKILL.md"] = []byte(normalized)
	// 溯源目录是客户端本地产物,不应存在于归档中。
	for path := range files {
		if strings.HasPrefix(path, skillmanifest.ProvenanceDir) {
			delete(files, path)
		}
	}
	rebuilt, werr := archiveutil.WriteZip(files)
	if werr != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "重新打包失败")
		return
	}
	checksum, verr := sharedskills.ValidateSkillArchive(rebuilt)
	if verr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后归档校验失败")
		return
	}
	entries, md, lerr := sharedskills.ListArchiveContents(rebuilt)
	if lerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后归档解析失败")
		return
	}
	// 自检:规范化产物必须通过与上传同一套严格校验,否则不入库。
	man, perr := skillmanifest.Parse(entries, md, s.Name)
	if perr != nil {
		var me *skillmanifest.Error
		if errors.As(perr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code,
				"规范化后仍不合规("+me.Message+"),需人工修正")
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后仍不合规")
		return
	}
	// F-03:发布内核是唯一的落库入口 —— 版本递增/同版本、changelog、下架冻结、
	// 官方锁、能力锁、跨渠道同名互斥全部在 Publish 里原子判定(AdminPublish=true
	// 表示这次写入是管理员裁决:发布即 approved)。
	res, perr := appstore.Publish(db, appstore.PublishRequest{
		Kind:            serverstore.AppKindSkill,
		AppID:           s.Name,
		Channel:         serverstore.AppChannelMarket,
		Archive:         rebuilt,
		Publisher:       adminUsername(c),
		AdminPublish:    true,
		DeclaredVersion: nextVersion,
		Manifest:        appstore.FromSkillManifest(man),
		Checksum:        checksum,
	})
	if perr != nil {
		var ae *appstore.Error
		if errors.As(perr, &ae) {
			serverauth.WriteError(c, ae.Status, ae.Code, ae.Message)
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	if title := strings.TrimSpace(man.Title); title != "" {
		// 空包内 title 不清空既有展示名(与上传/更新同一口径);非空时 Publish
		// 已把投影切到本版,这里只是幂等的显式回写(与 upload 路径同形)。
		_ = serverstore.SetSkillDisplayName(db, s.Name, title)
	}
	invalidateSkillCache(cacheDir, s.Name)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_normalize",
		s.Name+" v"+s.Version+" → v"+res.Version+" ("+strings.Join(changes, "; ")+")")
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": res.Version, "checksum": checksum, "changes": changes})
}

// normalizeChangelog 把规范化改动清单渲染成符合 MaxChangelogRunes 的更新说明。
//
// 规范化只在**确实有改动**时走到发布内核(已合规的包在上面的幂等分支提前
// 返回),所以这段文字描述的是真实发生的事,不是编造的用户语义内容。
func normalizeChangelog(changes []string) string {
	if len(changes) == 0 {
		return "规范化:补齐发布契约要求的字段"
	}
	out := "自动规范化:" + strings.Join(changes, ";")
	if runes := []rune(out); len(runes) > skillmanifest.MaxChangelogRunes {
		out = string(runes[:skillmanifest.MaxChangelogRunes-1]) + "…"
	}
	return out
}

// ensureChangelogField 保证规范化产物带有**非空** changelog 字段。
//
// F-03:changelog 是发布内核的硬规则(非首个版本必填),规范化不得绕过它,
// 也不该因为存量包没有 changelog 就整条路径失败 —— 用本次规范化的真实改动
// 清单补齐。包内已有非空 changelog 时保持原值(作者写的说明是内容,不是噪音)。
func ensureChangelogField(skillMD, changelog string) string {
	lines := strings.Split(skillMD, "\n")
	// 只在 frontmatter 区域内改:首行必须是 `---`,结束行是下一条 `---`。
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return skillMD
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return skillMD
	}
	for i := 1; i < end; i++ {
		if !strings.HasPrefix(lines[i], "changelog:") {
			continue
		}
		if strings.TrimSpace(strings.TrimPrefix(lines[i], "changelog:")) != "" {
			return skillMD // 已有非空 changelog:保持作者原文
		}
		// 空 changelog 行:直接替换(避免同一字段出现两次)。
		lines[i] = "changelog: " + yamlSingleQuoted(changelog)
		return strings.Join(lines, "\n")
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:end]...)
	out = append(out, "changelog: "+yamlSingleQuoted(changelog))
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n")
}

// yamlSingleQuoted 把任意文本渲染成 YAML 单引号标量(单引号转义规则:” 表示 ')。
//
// 不引号包裹时,中文冒号/括号/连字符都可能被 YAML 解析成结构;双引号标量的
// 转义集又不完全等价 JSON。单引号标量只认 ” 一种转义,最稳。
func yamlSingleQuoted(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// forceVersion 保证 frontmatter 的 version 与入库版本一致(规范化时旧包可能
// 自带一个较低的 version,不改会与新版本号失配)。
func forceVersion(skillMD, version string) string {
	lines := strings.Split(skillMD, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "version:") {
			lines[i] = "version: " + version
			return strings.Join(lines, "\n")
		}
		if i > 0 && line == "---" {
			break
		}
	}
	return skillMD
}
