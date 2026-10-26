package marketplace

// 市场渠道的**待审版本审核面**（2026-10-23）。
//
// 【缺口现场】市场命名空间此前只有"管理端直发"（`appstore.Publish` 带
// AdminPublish=true ⇒ 发布即 approved）。员工归属人经能力中心提交的新版本落在
// `app_releases.status=pending` 之后**没有任何审核入口**：审批队列
// （`/capabilities/approvals`）只读组织库，而组织库的 approve/reject 在
// sharedskills / agentshare 里且只服务 `channel='org'`。结果：市场待审版本
// 永远卡在 pending，apps 投影永远停在旧版本，作者等不到任何结论。
//
// 【本文件的定位】
//   - 审核**落定语义**不在这里重写：唯一实现是
//     `serverstore.ReviewPending`（状态 + 归档释放 + 下架冻结 + 投影重算），
//     本文件只做「渠道守卫 → 版本存在性 → 理由校验 → 落定 → 审计」的编排；
//   - 版本级 preview / archive / file 的**字节生产者**也不在这里重写：
//     技能侧复用 `skillArchiveForReview` / `serveSkillArchive` 与
//     `sharedskills.ListArchiveContents`，智能体侧复用
//     `agentshare.ListArchiveContents` / `ExtractFileContent` / 同名下载出口
//     （`serveAgentReleaseArchive`）。本文件只负责"按**指定版本**取到字节"。
//
// 【为什么必须"按指定版本"】name 级端点（preview/file/archive）取的是
// `CurrentMarketReleaseFor` = 最高 **approved** 版本。审核人要看的是**待审的
// 那一版**（它还没 approved），复用 name 级实现会让"预览/下载"永远看到旧版本、
// 审核变成盲批 —— 判据见 `review_pending_test.go` 的
// `TestMarketSkillVersionScopedBytesAreNotTheCurrentRelease`（变异即红）。
//
// 【渠道口径】一律复用 `requireMarketAdminApp`（`channel.go`，唯一实现）：
// org 行与"该名字不存在"逐字节同形 404。新增的 5 条 `/agents/:name/:version/*`
// 同时登记进 `marketAgentRoutePolicy`，由
// `TestAgentAdminRoutesAreMarketOnlyOrRegistered` 与 `internal/router` 的生产树
// 对拍（新增路由不登记即红）。

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/agentshare"
	"github.com/zeokeel/zeokeel-harness/server/internal/appstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/archiveutil"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/sharedskills"
)

// 审核面文案/上限常量。**与组织共享库逐字同源**：
//   - maxRejectReasonRunes：sharedskills / agentshare 的拒绝理由上限都是 500 字；
//   - archivedClearedMessage：拒绝即释放存储，之后不能再通过（三面同一句话）。
const (
	maxRejectReasonRunes  = 500
	archiveClearedMessage = "该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本"
)

// marketKindLabel 返回 (kind) 的中文名。审核面所有面向用户的文案都由它派生，
// 避免"技能侧说智能体"这类错字（两个 kind 走同一个泛型实现）。
func marketKindLabel(kind string) string {
	if kind == serverstore.AppKindAgent {
		return "智能体"
	}
	return "技能"
}

// requireMarketReleaseForReview 解析「某市场 App 的指定版本」，把两道前置守卫
// 收敛成一处（技能与智能体共用）：
//
//  1. **渠道守卫最先**：`requireMarketAdminApp` —— org 行与"该名字不存在"同形 404
//     （判据 marketplace-8 / A-8：市场命名空间绝不服务组织行，也不泄露存在性）；
//  2. **版本必须存在且未软删**：`GetRelease`（含归档）+ `DeletedAt == nil`。
//     软删版本对审核面而言就是"不存在"——它不能再被批准（判据：软删 v2 上 approve
//     必须 404 且状态不被改写）。
//
// 返回 false 表示响应已写，调用方直接 `return`。
func requireMarketReleaseForReview(c *gin.Context, db *sql.DB, kind, notFoundMsg string) (*serverstore.Release, bool) {
	name, version := c.Param("name"), c.Param("version")
	if requireMarketAdminApp(c, db, kind, name, notFoundMsg) == nil {
		return nil, false
	}
	rel, err := serverstore.GetRelease(db, kind, name, version)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", notFoundMsg)
			return nil, false
		}
		logMarketDependencyFailure(c, err)
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return nil, false
	}
	if rel.DeletedAt != nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", notFoundMsg)
		return nil, false
	}
	return rel, true
}

// reviewMarketPending 是市场待审版本 approve / reject 的**唯一实现**（技能与
// 智能体只差 kind、文案与审计动作）。顺序是判据的一部分：
// 渠道守卫 → 版本存在性 → 理由校验（仅 reject）→ ReviewPending → 审计。
//
//   - 理由校验必须在落定**之前**：空理由/超长理由的请求不得产生任何状态变化
//     （判据：被拒的请求后状态仍是 pending）；
//   - 落定语义（状态、归档释放、下架冻结、投影重算）全部委托
//     `serverstore.ReviewPending`，本函数**不重复判定** approved/enabled ——
//     三面（sharedskills / agentshare / marketplace）的审核语义只有一份实现。
func reviewMarketPending(c *gin.Context, db *sql.DB, kind string, approve bool,
	notFoundMsg, approveAudit, rejectAudit string) {
	name, version := c.Param("name"), c.Param("version")

	// 1) 渠道守卫 + 版本存在性（org 行与不存在同形 404）
	if _, ok := requireMarketReleaseForReview(c, db, kind, notFoundMsg); !ok {
		return
	}

	// 2) 拒绝理由：必填、≤500 字（与 sharedskills.decide / agentshare.decideBody 同口径）
	reason := ""
	if !approve {
		var body struct {
			Reason string `json:"reason"`
		}
		// 空 body（EOF）与坏 body 要分开：协议层坏 → 400 请求体格式错误；
		// 理由缺失 → 400 请填写拒绝理由。两者都是 400，但文案指路不同。
		if berr := c.ShouldBindJSON(&body); berr != nil && !errors.Is(berr, io.EOF) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		reason = strings.TrimSpace(body.Reason)
		if len([]rune(reason)) > maxRejectReasonRunes {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "拒绝理由过长(上限 500 字)")
			return
		}
		if reason == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请填写拒绝理由")
			return
		}
	}

	// 3) 落定（唯一实现：状态 + 归档释放 + 下架冻结 + 投影重算）
	if err := serverstore.ReviewPending(db, kind, name, version, approve, reason); err != nil {
		writeMarketReviewFailure(c, db, kind, name, version, notFoundMsg, approve, err)
		return
	}

	// 4) 审计（detail = name@version，与组织面 shared_skill_approve 同形）
	action := rejectAudit
	if approve {
		action = approveAudit
	}
	_ = serverstore.AuditLogApp(db, name, adminUsername(c), action, name+"@"+version)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// writeMarketReviewFailure 把 `ReviewPending` 的错误映射成稳定的 HTTP 语义。
//
// 码与文案的**真源在同族实现**里，本函数只是搬运（不新造文案）：
//   - ErrAppDelisted ⇒ 409 `APP_DELISTED`，文案与 sharedskills.decide /
//     agentshare.approveWritable 同形（"该技能/智能体已下架，无法通过审核：
//     请先重新上架再审核"）—— 审批时**不能**自动上架，出口是管理员显式重新上架；
//   - ErrReleaseArchiveCleared ⇒ 409 `ARCHIVE_CLEARED` + 同一条共享文案
//     （拒绝即释放存储，之后不能再通过）；
//   - ErrReleaseApprovedNotRejectable ⇒ 409 + serverstore 的三个共享常量
//     （码/说明/指路），与 sharedskills / agentshare / wasmapp 逐字一致；
//   - ErrNotFound ⇒ 404 同文案（版本在守卫与落定之间被删）；
//   - 其余 ⇒ 500。**分两句话**：状态已落库（只是投影没跟上）时明确告诉管理员
//     "重试一次即可自愈"；否则是通用的"更新失败"。
func writeMarketReviewFailure(c *gin.Context, db *sql.DB, kind, name, version,
	notFoundMsg string, approve bool, err error) {
	switch {
	case errors.Is(err, serverstore.ErrReleaseApprovedNotRejectable):
		serverauth.WriteError(c, http.StatusConflict, serverstore.CodeReleaseNotRejectable,
			serverstore.MsgReleaseNotRejectable+"。"+serverstore.HintReleaseNotRejectable)
	case errors.Is(err, serverstore.ErrReleaseArchiveCleared):
		serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED", archiveClearedMessage)
	case errors.Is(err, serverstore.ErrAppDelisted):
		serverauth.WriteError(c, http.StatusConflict, appstore.CodeAppDelisted,
			"该"+marketKindLabel(kind)+"已下架，无法通过审核：请先重新上架再审核")
	case errors.Is(err, serverstore.ErrNotFound):
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", notFoundMsg)
	default:
		logMarketDependencyFailure(c, err)
		// 两种失败对管理员是**不同的事实**：
		//   - 状态写失败 ⇒ 审核没发生，需要排查（通用"更新失败"）；
		//   - 状态**已落库**、只有 apps 投影重算失败 ⇒ 审核结论已经生效，重复点一次
		//     就会自愈（ReviewPending 幂等）。把他读成前者会让管理员去等作者重传。
		if marketReviewStatusCommitted(db, kind, name, version, approve) {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL",
				"审核结果已落库,但"+marketKindLabel(kind)+"投影更新失败(请重试一次)")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
	}
}

// marketReviewStatusCommitted 判定审核状态是否已经落库（只读诊断，不参与控制流；
// 任何读失败都退回"通用失败"文案，不把诊断本身变成第二个失败源）。
func marketReviewStatusCommitted(db *sql.DB, kind, name, version string, approve bool) bool {
	rel, err := serverstore.GetRelease(db, kind, name, version)
	if err != nil || rel == nil {
		return false
	}
	if approve {
		return rel.Status == serverstore.ReleaseStatusApproved
	}
	return rel.Status == serverstore.ReleaseStatusRejected
}

// ---------------------------------------------------------------------------
// 技能：approve / reject
// ---------------------------------------------------------------------------

// reviewSkillVersionAdmin 是市场技能的待审版本落定入口（approve=true 通过）。
func approveSkillVersionAdmin(c *gin.Context, db *sql.DB) {
	reviewMarketPending(c, db, serverstore.AppKindSkill, true,
		"技能不存在", "market_skill_approve", "market_skill_reject")
}

// rejectSkillVersionAdmin 拒绝待审版本（reason 必填，见 reviewMarketPending）。
func rejectSkillVersionAdmin(c *gin.Context, db *sql.DB) {
	reviewMarketPending(c, db, serverstore.AppKindSkill, false,
		"技能不存在", "market_skill_approve", "market_skill_reject")
}

// ---------------------------------------------------------------------------
// 智能体：approve / reject
// ---------------------------------------------------------------------------

func approveAgentVersionAdmin(c *gin.Context, db *sql.DB) {
	reviewMarketPending(c, db, serverstore.AppKindAgent, true,
		"智能体不存在", "market_agent_approve", "market_agent_reject")
}

func rejectAgentVersionAdmin(c *gin.Context, db *sql.DB) {
	reviewMarketPending(c, db, serverstore.AppKindAgent, false,
		"智能体不存在", "market_agent_approve", "market_agent_reject")
}

// ---------------------------------------------------------------------------
// 技能：按指定版本取字节（preview / archive / file）
// ---------------------------------------------------------------------------

// previewSkillVersionAdmin 预览**指定版本**的归档（审核人看的就是待审的那一版）。
//
// 与 name 级 `previewSkillAdmin` 共用同一个响应体构造器
// （`writeSkillArchivePreview`）：两侧的键名/文件清单/上限只有一份实现。
func previewSkillVersionAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindSkill, "技能不存在")
	if !ok {
		return
	}
	if len(rel.Archive) == 0 {
		// 只有"被拒绝过"的版本会走到这里（拒绝即释放归档）；pending/approved 必有字节。
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该版本归档已在拒绝时清理,无法预览")
		return
	}
	writeSkillArchivePreview(c, rel.AppID, rel.Version, rel.Checksum, rel.Archive)
}

// fileContentSkillVersionAdmin 按 `?path=` 返回**指定版本**归档内的一个文件。
func fileContentSkillVersionAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindSkill, "技能不存在")
	if !ok {
		return
	}
	if len(rel.Archive) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该版本归档已在拒绝时清理,无法查看文件")
		return
	}
	norm, ok := archiveFilePathParam(c)
	if !ok {
		return
	}
	writeSkillArchiveFileContent(c, rel.Archive, norm)
}

// downloadSkillVersionArchiveAdmin 下载**指定版本**的技能归档。
//
// 字节出口复用 `serveSkillArchive`（员工安装通路与管理面下载共用的一条出口）：
// 格式判定、Content-Disposition、X-Skill-Version/Checksum 头都只有一份实现。
// 空归档的 404 文案也由它给出（"技能尚未上传归档"），不在这里另造。
func downloadSkillVersionArchiveAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindSkill, "技能不存在")
	if !ok {
		return
	}
	serveSkillArchive(c, db, &serverstore.Skill{
		Name: rel.AppID, Version: rel.Version, Checksum: rel.Checksum, Archive: rel.Archive,
	})
}

// ---------------------------------------------------------------------------
// 智能体：按指定版本取字节（preview / archive / file）
// ---------------------------------------------------------------------------

// previewAgentVersionAdmin 预览**指定版本**的智能体归档（文件清单 + 编排）。
func previewAgentVersionAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindAgent, "智能体不存在")
	if !ok {
		return
	}
	if len(rel.Archive) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该版本归档已在拒绝时清理,无法预览")
		return
	}
	writeAgentArchivePreview(c, rel)
}

// fileContentAgentVersionAdmin 按 `?path=` 返回**指定版本**归档内的一个文件。
func fileContentAgentVersionAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindAgent, "智能体不存在")
	if !ok {
		return
	}
	if len(rel.Archive) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该版本归档已在拒绝时清理,无法查看文件")
		return
	}
	writeAgentArchiveFileContent(c, rel)
}

// downloadAgentVersionArchiveAdmin 下载**指定版本**的智能体归档。
func downloadAgentVersionArchiveAdmin(c *gin.Context, db *sql.DB) {
	rel, ok := requireMarketReleaseForReview(c, db, serverstore.AppKindAgent, "智能体不存在")
	if !ok {
		return
	}
	if len(rel.Archive) == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该版本归档已在拒绝时清理,无法下载")
		return
	}
	serveAgentReleaseArchive(c, db, rel.AppID, rel)
}

// ---------------------------------------------------------------------------
// 版本级取字节共用的响应构造器（name 级端点同源调用，禁止各写一份）
// ---------------------------------------------------------------------------

// writeSkillArchivePreview 由一份技能归档字节产出审核预览响应
// （files + skill_md + name/version/checksum）。name 级与版本级端点共用。
//
// `sharedskills.ListArchiveContents` 的解析错误一律 422 `ARCHIVE_INVALID`
// （与组织面预览同形）。
func writeSkillArchivePreview(c *gin.Context, name, version, checksum string, raw []byte) {
	files, content, lerr := sharedskills.ListArchiveContents(raw)
	if lerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"files": files, "skill_md": content,
		"name": name, "version": version, "checksum": checksum,
	})
}

// archiveFilePathParam 解析 `?path=` 并规范化（缺省/越界/非法一律 400）。
//
// 返回 false 表示响应已写。上限由调用方的字节生产者统一（技能侧
// `maxFilePreviewBytes`，智能体侧 `agentshare.ExtractFileContent` 自带）。
func archiveFilePathParam(c *gin.Context) (string, bool) {
	target := c.Query("path")
	if target == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少文件路径")
		return "", false
	}
	norm, nerr := archiveutil.NormalizePath(target)
	if nerr != nil || norm == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
		return "", false
	}
	return norm, true
}

// writeSkillArchiveFileContent 在给定技能归档上产出"逐文件查看"的响应。
// name 级（`fileContentSkillAdmin`）与版本级端点共用，键名是跨端契约
// （webadmin 读 `too_large`）。
func writeSkillArchiveFileContent(c *gin.Context, raw []byte, norm string) {
	content, size, found, binary, tooLarge, xerr :=
		archiveutil.ExtractFileContent(raw, norm, maxFilePreviewBytes)
	if xerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	if !found {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档中不存在该文件")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path": norm, "size": size, "binary": binary, "too_large": tooLarge, "content": content,
	})
}

// writeAgentArchivePreview 由一份智能体归档产出审核预览响应
// （files + composition + version）。name 级与版本级端点共用。
func writeAgentArchivePreview(c *gin.Context, rel *serverstore.Release) {
	files, composition, listErr := agentshare.ListArchiveContents(rel.Archive)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"files": files, "composition": composition, "version": rel.Version})
}

// writeAgentArchiveFileContent 在给定智能体归档上产出"逐文件查看"的响应
// （name 级与版本级共用；键名 `too_large` 是跨端契约，别改回驼峰）。
//
// F-40（能力中心审计 2026-10-26，P3）：修前这里与技能侧（`fileContentSkillAdmin`
// → `archiveFilePathParam` + `writeSkillArchiveFileContent`）四条口径全不一致：
//  1. `?path` **不做 NormalizePath** —— `./a/../b`、绝对路径、`..` 前缀都直接
//     送进提取器（技能侧统一 NormalizePath 后 400）；
//  2. 空 `?path` 不 400，而是拿空串去提取，落到「文件不存在」404（文案误导：
//     管理员以为自己路径打错，其实是没带参数）；
//  3. 提取器报错 ⇒ 500 INTERNAL「读取失败」，而技能侧是 **422 ARCHIVE_INVALID
//     「归档解析失败」**（同一个坏归档在两个 kind 上给出两个不同状态码）。
//
// 现在逐条对齐技能侧：共用 `archiveFilePathParam`（400 两种文案）与 422 映射。
func writeAgentArchiveFileContent(c *gin.Context, rel *serverstore.Release) {
	norm, ok := archiveFilePathParam(c)
	if !ok {
		return
	}
	content, size, found, binary, tooLarge, err := agentshare.ExtractFileContent(rel.Archive, norm)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	if !found {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件不存在")
		return
	}
	if binary {
		c.JSON(http.StatusOK, gin.H{"size": size, "binary": true})
		return
	}
	if tooLarge {
		c.JSON(http.StatusOK, gin.H{"size": size, "too_large": true})
		return
	}
	c.JSON(http.StatusOK, gin.H{"content": content, "size": size})
}
