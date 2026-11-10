package llmgateway

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func addProtocolModel(t *testing.T, db *sql.DB, providerName, protocol, modelName string, enabled int, modalities []string) (int64, int64) {
	t.Helper()
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: providerName, BaseURL: "https://upstream.example.com", Protocol: protocol, Enabled: enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	mid, err := serverstore.AddModel(db, &serverstore.Model{
		Name: modelName, ProviderID: pid, DisplayName: providerName,
		DefaultParams: `{"context_length":8192}`, InputModalities: modalities,
	})
	if err != nil {
		t.Fatal(err)
	}
	return pid, mid
}

func TestListModelsProtocols(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	addProtocolModel(t, db, "openai-provider", "openai", "chat-model", 1, []string{"text", "image"})
	addProtocolModel(t, db, "anthropic-provider", "anthropic", "messages-model", 1, []string{"text"})
	addProtocolModel(t, db, "both-provider", "both", "dual-model", 1, []string{"text", "image"})
	// 同名模型保留首行元数据，协议按固定顺序合并，图片能力取交集。
	addProtocolModel(t, db, "shared-first", "openai", "shared-model", 1, []string{"text", "image"})
	addProtocolModel(t, db, "shared-second", "anthropic", "shared-model", 1, []string{"text"})
	addProtocolModel(t, db, "shared-third", "both", "shared-model", 1, []string{"text", "image"})
	addProtocolModel(t, db, "disabled-provider", "anthropic", "chat-model", 0, []string{"text"})
	missingProviderID, _ := addProtocolModel(t, db, "missing-provider", "anthropic", "chat-model", 1, []string{"text"})
	if removed, err := serverstore.RemoveMissingProviderModels(db, missingProviderID, nil); err != nil || removed != 1 {
		t.Fatalf("目录缺失处理: removed=%d err=%v", removed, err)
	}
	previousDecrypt := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	InvalidateUpstreams()
	t.Cleanup(func() {
		DecryptSecret = previousDecrypt
		InvalidateUpstreams()
	})
	for _, candidate := range []struct {
		model, protocol string
		count           int
	}{
		{"chat-model", "openai", 1}, {"chat-model", "anthropic", 0},
		{"messages-model", "openai", 0}, {"messages-model", "anthropic", 1},
		{"dual-model", "openai", 1}, {"dual-model", "anthropic", 1},
		{"shared-model", "openai", 2}, {"shared-model", "anthropic", 2},
	} {
		upstreams, err := MatchModelsByProtocol(db, candidate.model, candidate.protocol)
		if err != nil || len(upstreams) != candidate.count {
			t.Fatalf("%s/%s 路由数=%d err=%v, want %d", candidate.model, candidate.protocol, len(upstreams), err, candidate.count)
		}
	}
	models, err := ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	// 通过真实 JSON 线格式断言，使新增字段前的旧实现也能编译并行为失败。
	raw, err := json.Marshal(models)
	if err != nil {
		t.Fatal(err)
	}
	var got []struct {
		ID              string   `json:"id"`
		DisplayName     string   `json:"display_name"`
		DefaultParams   string   `json:"default_params"`
		InputModalities []string `json:"input_modalities"`
		Protocols       []string `json:"protocols"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("模型应按名称去重并排除不可用候选，got=%s", raw)
	}
	wantIDs := []string{"chat-model", "messages-model", "dual-model", "shared-model"}
	wantProtocols := [][]string{{"openai"}, {"anthropic"}, {"anthropic", "openai"}, {"anthropic", "openai"}}
	for i, m := range got {
		if m.ID != wantIDs[i] || !reflect.DeepEqual(m.Protocols, wantProtocols[i]) {
			t.Errorf("模型 %d: id=%q protocols=%v, want %q %v", i, m.ID, m.Protocols, wantIDs[i], wantProtocols[i])
		}
	}
	if got[3].DisplayName != "shared-first" || got[3].DefaultParams != `{"context_length":8192}` || !reflect.DeepEqual(got[3].InputModalities, []string{"text"}) {
		t.Errorf("同名模型元数据或保守输入模态不符: %+v", got[3])
	}
	if !reflect.DeepEqual(got[0].InputModalities, []string{"text", "image"}) {
		t.Errorf("停用/缺失候选不应影响启用模型的图片能力: %+v", got[0])
	}
}

func TestListModelsExcludesInvalidProtocols(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	addProtocolModel(t, db, "valid-provider", "openai", "visible-model", 1, []string{"text"})
	unknownID, _ := addProtocolModel(t, db, "unknown-provider", "openai", "invalid-model", 1, []string{"text"})
	emptyID, _ := addProtocolModel(t, db, "empty-provider", "openai", "empty-model", 1, []string{"text"})
	// 模拟历史库/损坏数据；路由层同样拒绝这些协议。
	if _, err := db.Exec(`ALTER TABLE gateway_providers DROP CONSTRAINT gateway_providers_protocol_check`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET protocol = 'unknown' WHERE id = ?`, unknownID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET protocol = '' WHERE id = ?`, emptyID); err != nil {
		t.Fatal(err)
	}
	models, err := ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "visible-model" {
		t.Fatalf("未知/空协议不能下发给客户端: %+v", models)
	}
}

func TestListModelsExcludesDisjointInputModalities(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	addProtocolModel(t, db, "text-provider", "openai", "disjoint-model", 1, []string{"text"})
	addProtocolModel(t, db, "image-provider", "anthropic", "disjoint-model", 1, []string{"image"})
	addProtocolModel(t, db, "usable-provider", "both", "usable-model", 1, []string{"text", "image"})
	// 交集一旦为空，后续候选不能把已失去的能力重新加回。
	addProtocolModel(t, db, "later-provider", "both", "disjoint-model", 1, []string{"text", "image"})
	models, err := ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "usable-model" || !reflect.DeepEqual(models[0].InputModalities, []string{"text", "image"}) {
		t.Fatalf("无公共输入模态的模型不能下发，其他模型应保留: %+v", models)
	}
}
