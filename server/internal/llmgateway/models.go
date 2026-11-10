package llmgateway

import (
	"database/sql"
	"net/http"
	"slices"

	"github.com/gin-gonic/gin"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverauth"
	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// Model is a public model exposed by an enabled provider.
type Model struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
	// InputModalities 模型接受的输入模态(0058):'text'/'image'。客户端据此
	// 渲染图片支持与上传准入; 与桌面客户端 BootstrapConfig 对齐。
	InputModalities []string `json:"input_modalities"`
	// Protocols 是该模型可用的网关协议，双协议时 Anthropic 优先。
	// 只下发协议能力，上游地址与凭证始终留在服务端。
	Protocols []string `json:"protocols"`
}

// ListModels returns unique model names from enabled providers, ordered by
// their first model row id. Duplicate names merge protocols and intersect
// input modalities so that every routable provider supports advertised input.
// 2026-09-23(审计 G-02):排除 catalog_missing = TRUE 的行 —— 上游目录里已经
// 没有它们了(渠道同步"停用而非删除"以保住定价),客户端目录不该再展示一个
// 选中即失败的模型。
//
// R13-GH3(`search_path` 同族第三条路径):本查询读族内关系(`models` /
// `gateway_providers`)⇒ 必须经 serverstore 的**唯一 pin 实现**读。旧实现是裸池上
// 一条未限定名查询:连接/角色/库级 search_path 前置同名 shadow schema 时,客户端
// 目录里会静默出现 shadow 的诱饵模型(真 PG + 敌对 search_path 实测)。
func ListModels(db *sql.DB) ([]Model, error) {
	ms := []Model{}
	byName := map[string]int{}
	err := serverstore.WithUsageSearchPathRead(db, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT m.name, COALESCE(m.display_name, m.name), COALESCE(m.default_params, ''),
		COALESCE(m.input_modalities, '["text"]'), p.protocol
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id
		WHERE p.enabled = 1 AND m.catalog_missing = FALSE
		AND p.protocol IN ('openai', 'anthropic', 'both') ORDER BY m.id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var m Model
			var modalities, protocol string
			if err := rows.Scan(&m.ID, &m.DisplayName, &m.DefaultParams, &modalities, &protocol); err != nil {
				return err
			}
			m.InputModalities = serverstore.ParseInputModalities(modalities)
			if protocol == "both" {
				m.Protocols = []string{"anthropic", "openai"}
			} else {
				m.Protocols = []string{protocol}
			}
			if index, exists := byName[m.ID]; exists {
				current := &ms[index]
				for _, p := range m.Protocols {
					if !slices.Contains(current.Protocols, p) {
						current.Protocols = append(current.Protocols, p)
					}
				}
				// 固定双协议顺序，避免 Provider 行序改变客户端选择。
				slices.Sort(current.Protocols)
				current.InputModalities = slices.DeleteFunc(current.InputModalities, func(modality string) bool {
					return !slices.Contains(m.InputModalities, modality)
				})
				continue
			}
			byName[m.ID] = len(ms)
			ms = append(ms, m)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	// 聚合完再过滤，避免移除行后使 byName 索引失效。空模态会被旧客户端
	// 回落为 text，故不能下发没有任何共同输入能力的同名模型。
	ms = slices.DeleteFunc(ms, func(m Model) bool { return len(m.InputModalities) == 0 })
	return ms, nil
}

// ModelEnabled reports whether id is in the model list (empty id is never enabled).
func ModelEnabled(models []Model, id string) bool {
	if id == "" {
		return false
	}
	for _, m := range models {
		if m.ID == id {
			return true
		}
	}
	return false
}

func (a *API) handleModels(c *gin.Context) {
	ms, err := ListModels(a.DB)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型列表查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": ms})
}
