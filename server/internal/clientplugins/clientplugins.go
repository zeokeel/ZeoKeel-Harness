// Package clientplugins implements the minimal enterprise client-plugin catalog:
// the admin uploads one DSH bundle tarball, every authenticated desktop client
// receives it through bootstrap and installs it with the profile plugin manager.
//
// There is deliberately no per-user/department assignment and no version history:
// one row per plugin, re-upload replaces it (the version must change), deleting a
// row stops distribution. See migrations-pg/0091_client_plugins.sql.
package clientplugins

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

const (
	// maxBundleBytes bounds the decoded .tgz (a client UI bundle is a few MB;
	// 24 MiB leaves headroom for assets without letting one upload exhaust DB).
	maxBundleBytes = 24 << 20
	// maxUploadBody is the base64 envelope bound (~4/3 of the decoded cap).
	maxUploadBody = 34 << 20
	// maxUncompressed bounds the tar payload (zip-bomb guard; bundle assets are
	// already compressed in the tarball, so a real bundle is far below it).
	maxUncompressed = 96 << 20
	// maxEntries bounds the tar member count.
	maxEntries = 20000
)

var (
	packageNameRe = regexp.MustCompile(`^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
	versionRe     = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`)
)

// Handlers is the route-facing handler set (paths declared in internal/router).
type Handlers struct {
	List       gin.HandlerFunc // GET    /api/server/admin/plugins
	Upload     gin.HandlerFunc // POST   /api/server/admin/plugins
	SetEnabled gin.HandlerFunc // PUT    /api/server/admin/plugins/:id/enabled
	Remove     gin.HandlerFunc // DELETE /api/server/admin/plugins/:id
	Bundle     gin.HandlerFunc // GET    /api/client/v2/plugins/:id/:version/bundle
}

// NewHandlers wires the handlers to db.
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{
		List:       list(db),
		Upload:     upload(db),
		SetEnabled: setEnabled(db),
		Remove:     remove(db),
		Bundle:     bundle(db),
	}
}

func rowJSON(p serverstore.ClientPlugin) gin.H {
	return gin.H{
		"id":           p.ID,
		"package_name": p.PackageName,
		"display_name": p.DisplayName,
		"description":  p.Description,
		"version":      p.Version,
		"sha256":       p.Sha256,
		"size":         p.Size,
		"enabled":      p.Enabled,
		"updated_by":   p.UpdatedBy,
		"updated_at":   p.UpdatedAt,
	}
}

func list(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := serverstore.ListClientPlugins(db)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			out = append(out, rowJSON(r))
		}
		c.JSON(http.StatusOK, gin.H{"plugins": out})
	}
}

type uploadRequest struct {
	// BundleBase64 is the npm-pack .tgz (base64). JSON keeps the endpoint in the
	// same shape as the other archive uploads and lets one middleware limit apply.
	BundleBase64 string `json:"bundle_base64"`
	// ID optionally overrides the derived URL-safe key.
	ID string `json:"id"`
}

// bundleMeta is what the server learns from a tarball before storing it.
type bundleMeta struct {
	PackageName string
	DisplayName string
	Description string
	Version     string
	Sha256      string
	Size        int64
	Slug        string
}

func upload(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBody)
		var req uploadRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if strings.TrimSpace(req.BundleBase64) == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 bundle_base64")
			return
		}
		data, err := base64.StdEncoding.DecodeString(req.BundleBase64)
		if err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "bundle_base64 不是合法 base64")
			return
		}
		if len(data) == 0 || len(data) > maxBundleBytes {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "插件包为空或超过 24MB")
			return
		}
		meta, err := inspectBundle(data)
		if err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
		id := meta.Slug
		if strings.TrimSpace(req.ID) != "" {
			id = strings.TrimSpace(req.ID)
		}
		if !serverstore.ClientPluginIDRe.MatchString(id) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "插件标识不合法(小写字母数字连字符)")
			return
		}
		p := &serverstore.ClientPlugin{
			ID:          id,
			PackageName: meta.PackageName,
			DisplayName: meta.DisplayName,
			Description: meta.Description,
			Version:     meta.Version,
			Sha256:      meta.Sha256,
			Size:        meta.Size,
			Content:     data,
			Enabled:     true,
			UpdatedBy:   adminUsername(c),
		}
		// 覆盖时保持既有 enabled 状态：管理员停用一个插件后上传新版，不应该
		// 静默把它重新打开（"停用"是全局开关，不是上传的副作用）。
		if existing, err := serverstore.GetClientPlugin(db, id); err == nil {
			p.Enabled = existing.Enabled
		} else if !errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if err := serverstore.UpsertClientPlugin(db, p); err != nil {
			switch {
			case errors.Is(err, serverstore.ErrDuplicate):
				serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "该插件已存在同版本，或该包名已被另一个插件标识占用；请提升 version 后重传")
			case errors.Is(err, serverstore.ErrValidation):
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "插件参数不合法")
			default:
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			}
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "client_plugin_upload", id)
		// 重新读一遍拿 now() 的 updated_at。
		stored, err := serverstore.GetClientPlugin(db, id)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		c.JSON(http.StatusCreated, gin.H{"plugin": rowJSON(*stored)})
	}
}

func setEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 enabled 字段")
			return
		}
		if err := serverstore.SetClientPluginEnabled(db, c.Param("id"), *req.Enabled); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "client_plugin_enabled", c.Param("id"))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func remove(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if err := serverstore.DeleteClientPlugin(db, id); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "client_plugin_delete", id)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// bundle streams one .tgz to an authenticated employee. There is no per-user
// assignment: every logged-in client may fetch every enabled row.
func bundle(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, err := serverstore.GetClientPlugin(db, c.Param("id"))
		if err != nil {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
			return
		}
		if !p.Enabled || p.Version != c.Param("version") {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在或版本已更新")
			return
		}
		c.Header("X-Checksum-Sha256", p.Sha256)
		c.Data(http.StatusOK, "application/gzip", p.Content)
	}
}

func adminUsername(c *gin.Context) string {
	if u := serverauth.CurrentUser(c); u != nil {
		return u.Username
	}
	return ""
}

// ---------------------------------------------------------------------------
// Tarball inspection
// ---------------------------------------------------------------------------

type packageManifest struct {
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	Description string            `json:"description"`
	Scripts     map[string]string `json:"scripts"`
	Dsh         struct {
		Bundle struct {
			Patch json.RawMessage `json:"patch"`
		} `json:"bundle"`
	} `json:"dsh"`
}

// inspectBundle validates a npm-pack .tgz and derives the catalog row fields.
//
// 校验的是"服务端下发到全员机器的代码"的最小安全面：只接受普通文件、根
// package.json 里必须有 dsh.bundle.patch、拒绝安装期脚本、限制解压体积与成员数。
// 不校验签名（本版是 TLS + 管理员 RBAC + sha256），但任何一条不过都不会落库。
func inspectBundle(data []byte) (*bundleMeta, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("不是合法的 gzip(.tgz)")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)

	files := make(map[string]bool)
	var manifest *packageManifest
	var manifestName string
	var total int64
	entries := 0
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("不是合法的 tar(.tgz)")
		}
		entries++
		if entries > maxEntries {
			return nil, errors.New("压缩包成员过多")
		}
		name := path.Clean(hdr.Name)
		if name == "." || strings.HasPrefix(name, "../") || path.IsAbs(name) {
			return nil, errors.New("压缩包包含非法路径")
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg, tar.TypeRegA:
			// ok
		default:
			return nil, errors.New("压缩包只能包含普通文件")
		}
		if hdr.Size < 0 || hdr.Size > maxUncompressed-total {
			return nil, errors.New("压缩包解压体积超限")
		}
		total += hdr.Size
		body, err := io.ReadAll(io.LimitReader(tr, hdr.Size))
		if err != nil {
			return nil, errors.New("读取压缩包失败")
		}
		files[name] = true
		// npm pack 把包内容放在 package/ 下；也接受无前缀的裸 tarball。
		if name == "package.json" || name == "package/package.json" {
			if manifest != nil && len(name) > len(manifestName) {
				continue
			}
			var m packageManifest
			if err := json.Unmarshal(body, &m); err != nil {
				return nil, errors.New("package.json 不是合法 JSON")
			}
			manifest = &m
			manifestName = name
		}
	}
	if manifest == nil {
		return nil, errors.New("压缩包缺少 package.json")
	}
	if !packageNameRe.MatchString(manifest.Name) {
		return nil, errors.New("package.json 的 name 不合法")
	}
	if !versionRe.MatchString(manifest.Version) {
		return nil, errors.New("package.json 的 version 不合法")
	}
	for _, key := range []string{"preinstall", "install", "postinstall", "prepare"} {
		if strings.TrimSpace(manifest.Scripts[key]) != "" {
			return nil, errors.New("插件包不得带安装期脚本(" + key + ")")
		}
	}
	patches, err := parsePatchPaths(manifest.Dsh.Bundle.Patch)
	if err != nil || len(patches) == 0 {
		return nil, errors.New("不是 DSH bundle：package.json 缺少 dsh.bundle.patch")
	}
	for _, target := range patches {
		clean := path.Clean(target)
		if clean == "." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
			return nil, errors.New("dsh.bundle.patch 指向包外路径")
		}
		if !files[clean] && !files["package/"+clean] {
			return nil, errors.New("dsh.bundle.patch 指向的文件不在包内: " + clean)
		}
	}
	description := strings.TrimSpace(manifest.Description)
	if len(description) > 500 {
		description = description[:500]
	}
	sum := sha256.Sum256(data)
	return &bundleMeta{
		PackageName: manifest.Name,
		DisplayName: manifest.Name,
		Description: description,
		Version:     manifest.Version,
		Sha256:      hex.EncodeToString(sum[:]),
		Size:        int64(len(data)),
		Slug:        pluginSlug(manifest.Name),
	}, nil
}

func parsePatchPaths(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		if strings.TrimSpace(one) == "" {
			return nil, nil
		}
		return []string{one}, nil
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(many))
	for _, item := range many {
		if strings.TrimSpace(item) != "" {
			out = append(out, item)
		}
	}
	return out, nil
}

// pluginSlug derives the URL-safe key from a package name:
// `@scope/pkg` -> `scope-pkg`, invalid characters -> `-`, repeated/trailing
// dashes trimmed, capped at 64 chars.
func pluginSlug(name string) string {
	s := strings.ToLower(strings.TrimPrefix(name, "@"))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 64 {
		out = strings.Trim(out[:64], "-")
	}
	if out == "" {
		out = "plugin"
	}
	return out
}
