package llmgateway

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// TestMessagesSearchProviderMarkerE2E exercises the real /v1/messages wiring:
// the marker must be added by forwardAnthropic (not by a test-local copy of the
// mutate closure), and off must leave the outbound body unchanged.
func TestMessagesSearchProviderMarkerE2E(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	r, db, token := newMessagesGateway(t, f)
	body := `{"model":"deepseek-v4-flash","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: hello"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}`

	if err := serverstore.SetSetting(db, serverstore.SearchProviderSetting, serverstore.SearchProviderBailian); err != nil {
		t.Fatal(err)
	}
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("bailian messages status = %d, body = %s", w.Code, w.Body.String())
	}
	got, _ := f.gotBody.Load("/v1/messages")
	upstreamBody, _ := got.(string)
	if !strings.Contains(upstreamBody, bailianSearchBillingMarker) {
		t.Fatalf("bailian search request did not reach upstream with marker: %s", upstreamBody)
	}
	if !strings.Contains(upstreamBody, `"web_search_20250305"`) {
		t.Fatalf("web_search tool was lost: %s", upstreamBody)
	}

	if err := serverstore.SetSetting(db, serverstore.SearchProviderSetting, serverstore.SearchProviderOff); err != nil {
		t.Fatal(err)
	}
	w = doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("off messages status = %d, body = %s", w.Code, w.Body.String())
	}
	got, _ = f.gotBody.Load("/v1/messages")
	offBody, _ := got.(string)
	if strings.Contains(offBody, "x-anthropic-billing-header") {
		t.Fatalf("off request unexpectedly carried marker: %s", offBody)
	}
	if !strings.Contains(offBody, fmt.Sprintf(`"model":%q`, "deepseek-v4-flash")) {
		t.Fatalf("off request lost model: %s", offBody)
	}
}
