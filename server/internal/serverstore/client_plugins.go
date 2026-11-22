package serverstore

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
)

// ClientPlugin 是 client_plugins 的一行：全员统一下发的桌面客户端插件。
//
// 没有按人/部门分配、没有版本历史 —— 同一 id 再上传即覆盖（version 必须变化），
// 删除即停止下发。Content 只在下载路径读取，管理端列表/ bootstrap 不加载它
// （典型 UI bundle 约 2.3MB，列表接口不应把整张表读进内存）。
type ClientPlugin struct {
	ID          string    `json:"id"`
	PackageName string    `json:"package_name"`
	DisplayName string    `json:"display_name"`
	Description string    `json:"description"`
	Version     string    `json:"version"`
	Sha256      string    `json:"sha256"`
	Size        int64     `json:"size"`
	Enabled     bool      `json:"enabled"`
	UpdatedBy   string    `json:"updated_by"`
	UpdatedAt   time.Time `json:"updated_at"`
	Content     []byte    `json:"-"`
}

// ClientPluginIDRe 是 URL 路径段/客户端键的合法形状（与 connectorIDRe 同规则）。
var ClientPluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

const clientPluginColumns = "id, package_name, display_name, description, version, sha256, size, enabled, updated_by, updated_at"

func scanClientPlugin(rows interface{ Scan(...any) error }) (*ClientPlugin, error) {
	var p ClientPlugin
	if err := rows.Scan(&p.ID, &p.PackageName, &p.DisplayName, &p.Description,
		&p.Version, &p.Sha256, &p.Size, &p.Enabled, &p.UpdatedBy, &p.UpdatedAt); err != nil {
		return nil, err
	}
	return &p, nil
}

// ListClientPlugins returns all rows (admin list; no content).
func ListClientPlugins(db *sql.DB) ([]ClientPlugin, error) {
	rows, err := db.Query("SELECT " + clientPluginColumns + " FROM client_plugins ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClientPlugin
	for rows.Next() {
		p, err := scanClientPlugin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// ListEnabledClientPlugins returns enabled rows for bootstrap (no content).
func ListEnabledClientPlugins(db *sql.DB) ([]ClientPlugin, error) {
	rows, err := db.Query("SELECT " + clientPluginColumns + " FROM client_plugins WHERE enabled = true ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClientPlugin
	for rows.Next() {
		p, err := scanClientPlugin(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// GetClientPlugin returns one row including content (download path).
func GetClientPlugin(db *sql.DB, id string) (*ClientPlugin, error) {
	rows := db.QueryRow("SELECT "+clientPluginColumns+", content FROM client_plugins WHERE id = ?", id)
	var p ClientPlugin
	err := rows.Scan(&p.ID, &p.PackageName, &p.DisplayName, &p.Description,
		&p.Version, &p.Sha256, &p.Size, &p.Enabled, &p.UpdatedBy, &p.UpdatedAt, &p.Content)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}

// UpsertClientPlugin creates or replaces a plugin row.
//
// 同 id 覆盖时 version 必须变化：客户端按 (package_name, version) 判断是否已装，
// 同版本不同内容会被跳过 —— 那正是"管理端上传成功、员工端永远装不上"的形态。
// package_name 是全局唯一的（同一 npm 包不能以两个 key 下发）。
func UpsertClientPlugin(db *sql.DB, p *ClientPlugin) error {
	if !ClientPluginIDRe.MatchString(p.ID) || strings.TrimSpace(p.PackageName) == "" ||
		strings.TrimSpace(p.Version) == "" || len(p.Content) == 0 || strings.TrimSpace(p.Sha256) == "" {
		return ErrValidation
	}
	var existingVersion string
	err := db.QueryRow("SELECT version FROM client_plugins WHERE id = ?", p.ID).Scan(&existingVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && existingVersion == p.Version {
		return ErrDuplicate
	}
	var otherID string
	err = db.QueryRow("SELECT id FROM client_plugins WHERE package_name = ? AND id <> ?", p.PackageName, p.ID).Scan(&otherID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		return ErrDuplicate
	}
	_, err = db.Exec(`INSERT INTO client_plugins
		(id, package_name, display_name, description, version, sha256, size, content, enabled, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
		ON CONFLICT (id) DO UPDATE SET
			package_name = EXCLUDED.package_name,
			display_name = EXCLUDED.display_name,
			description = EXCLUDED.description,
			version = EXCLUDED.version,
			sha256 = EXCLUDED.sha256,
			size = EXCLUDED.size,
			content = EXCLUDED.content,
			enabled = EXCLUDED.enabled,
			updated_by = EXCLUDED.updated_by,
			updated_at = now()`,
		p.ID, p.PackageName, p.DisplayName, p.Description, p.Version, p.Sha256, p.Size, p.Content,
		p.Enabled, p.UpdatedBy)
	return err
}

// SetClientPluginEnabled toggles the global distribution switch.
func SetClientPluginEnabled(db *sql.DB, id string, enabled bool) error {
	res, err := db.Exec("UPDATE client_plugins SET enabled = ?, updated_at = now() WHERE id = ?", enabled, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteClientPlugin removes one row (bootstrap stops sending it).
func DeleteClientPlugin(db *sql.DB, id string) error {
	res, err := db.Exec("DELETE FROM client_plugins WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
