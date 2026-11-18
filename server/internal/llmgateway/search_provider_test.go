package llmgateway

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

func searchBody(extra string) []byte {
	base := `{"model":"qwen3.8-flash","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]`
	if extra == "" {
		return []byte(base + `}`)
	}
	return []byte(base + `,` + extra + `}`)
}

func systemTexts(t *testing.T, raw []byte) []string {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("invalid injected JSON: %v (%s)", err, raw)
	}
	system, _ := body["system"].([]any)
	out := make([]string, 0, len(system))
	for _, item := range system {
		block, _ := item.(map[string]any)
		if text, _ := block["text"].(string); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func rewriteMarkerForTest(t *testing.T, raw []byte, mode, host string) []byte {
	t.Helper()
	if !shouldAddSearchProviderMarker(mode, host) {
		return raw
	}
	var changed bool
	out, err := rewriteJSONObjectBody(nil, raw, func(body map[string]any) error {
		if !hasWebSearchTool(body) || hasBailianSearchMarker(body) {
			return errBodyNoChange
		}
		if !appendBailianSearchMarker(body) {
			return errBodyNoChange
		}
		changed = true
		return nil
	})
	if err != nil {
		t.Fatalf("rewrite failed: %v", err)
	}
	if !changed {
		return raw
	}
	return out
}

func TestSearchProviderMarkerInjectionMatrix(t *testing.T) {
	bailian := "https://ws.example.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1"
	other := "https://api.deepseek.com/anthropic/v1"
	cases := []struct {
		name string
		raw  []byte
		mode string
		host string
		want bool
	}{
		{"auto bailian host", searchBody(""), serverstore.SearchProviderAuto, bailian, true},
		{"auto dashscope host", searchBody(""), serverstore.SearchProviderAuto, "https://dashscope.aliyuncs.com/apps/anthropic/v1", true},
		{"auto non-bailian host", searchBody(""), serverstore.SearchProviderAuto, other, false},
		{"off", searchBody(""), serverstore.SearchProviderOff, bailian, false},
		{"explicit bailian custom proxy", searchBody(""), serverstore.SearchProviderBailian, other, true},
		{"no web_search tool", []byte(`{"model":"m","max_tokens":1,"messages":[]}`), serverstore.SearchProviderBailian, bailian, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteMarkerForTest(t, tc.raw, tc.mode, tc.host)
			marked := strings.Contains(string(got), bailianSearchBillingMarker)
			if marked != tc.want {
				t.Fatalf("marker = %v, want %v; body=%s", marked, tc.want, got)
			}
			if !tc.want && string(got) != string(tc.raw) {
				t.Fatalf("unexpected rewrite for unmarked case:\n got %s\nwant %s", got, tc.raw)
			}
		})
	}
}

func TestSearchProviderMarkerPreservesSystemShapes(t *testing.T) {
	bailian := "https://ws.example.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1"
	cases := []struct {
		name string
		raw  []byte
		want []string
	}{
		{"absent", searchBody(""), []string{bailianSearchBillingMarker}},
		{"empty string", searchBody(`"system":""`), []string{bailianSearchBillingMarker}},
		{"string", searchBody(`"system":"existing system"`), []string{"existing system", bailianSearchBillingMarker}},
		{"array", []byte(`{"model":"m","max_tokens":1,"messages":[],"tools":[{"type":"web_search_20250305","name":"web_search"}],"system":[{"type":"text","text":"existing"}]}`), []string{"existing", bailianSearchBillingMarker}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteMarkerForTest(t, tc.raw, serverstore.SearchProviderBailian, bailian)
			gotTexts := systemTexts(t, got)
			if len(gotTexts) != len(tc.want) {
				t.Fatalf("system texts = %#v, want %#v", gotTexts, tc.want)
			}
			for i := range tc.want {
				if gotTexts[i] != tc.want[i] {
					t.Fatalf("system[%d] = %q, want %q", i, gotTexts[i], tc.want[i])
				}
			}
		})
	}
}

func TestSearchProviderMarkerDoesNotDuplicateExistingMarker(t *testing.T) {
	bailian := "https://ws.example.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1"
	raw := []byte(`{"model":"m","max_tokens":1,"messages":[],"tools":[{"type":"web_search_20250305","name":"web_search"}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_entrypoint=cli;"}]}`)
	got := rewriteMarkerForTest(t, raw, serverstore.SearchProviderBailian, bailian)
	if string(got) != string(raw) {
		t.Fatalf("existing marker body was rewritten: got %s want %s", got, raw)
	}
	if strings.Count(string(got), bailianSearchBillingMarker) != 1 {
		t.Fatalf("marker duplicated: %s", got)
	}
}
