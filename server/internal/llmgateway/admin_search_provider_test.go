package llmgateway

import (
	"net/http"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func TestAdminGatewaySearchProvider(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["search_provider"] != serverstore.SearchProviderAuto {
		t.Fatalf("default search_provider = %v (HTTP %d), want auto", out["search_provider"], w.Code)
	}

	for _, value := range []string{serverstore.SearchProviderAuto, serverstore.SearchProviderBailian, serverstore.SearchProviderOff} {
		body := `{"search_provider":"` + value + `"}`
		if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr); w.Code != http.StatusOK {
			t.Fatalf("set search_provider=%s: %d %s", value, w.Code, w.Body.String())
		}
		stored, ok, err := serverstore.GetSetting(db, serverstore.SearchProviderSetting)
		if err != nil || !ok || stored != value {
			t.Fatalf("search_provider=%s not persisted: %q ok=%v err=%v", value, stored, ok, err)
		}
	}

	for _, body := range []string{`{"search_provider":"deepseek"}`, `{"search_provider":""}`, `{"search_provider":"BAILIAN"}`} {
		if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s accepted: %d", body, w.Code)
		}
	}
	if got, _, _ := serverstore.GetSetting(db, serverstore.SearchProviderSetting); got != serverstore.SearchProviderOff {
		t.Fatalf("invalid PUT changed stored search_provider: %q", got)
	}
}
