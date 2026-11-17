package llmgateway

import (
	"log"
	"net/url"
	"strings"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
)

// bailianSearchBillingMarker is the system text Bailian requires for native
// Anthropic web_search. It is not an HTTP header: Bailian reads this marker
// from the request's system prompt.
const bailianSearchBillingMarker = "x-anthropic-billing-header: cc_entrypoint=cli;"

// addSearchProviderMarker adds Bailian's native-search marker to an
// Anthropic-compatible Messages body when this deployment routes web_search
// through a Bailian upstream.
//
// The marker is only relevant to requests carrying a web_search tool. Normal
// chat, non-Bailian upstreams, and the explicit "off" mode are left
// byte-for-byte untouched so unrelated prompt caching and upstream behavior
// are not disturbed. Body rewriting goes through rewriteJSONObjectBody so the
// in-flight memory gate and encoder settings stay centralized.
func (a *API) addSearchProviderMarker(raw []byte, up *Upstream) []byte {
	if len(raw) == 0 || up == nil {
		return raw
	}
	mode := serverstore.SearchProviderAuto
	if value, ok, err := serverstore.GetSetting(a.DB, serverstore.SearchProviderSetting); err == nil && ok {
		mode = serverstore.NormalizeSearchProvider(value)
	}
	if !shouldAddSearchProviderMarker(mode, up.BaseURL) {
		return raw
	}
	changed := false
	out, err := rewriteJSONObjectBody(a.DB, raw, func(body map[string]any) error {
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
		log.Printf("gateway: search provider marker rewrite failed: %v", err)
		return raw
	}
	if !changed {
		return raw
	}
	return out
}

// shouldAddSearchProviderMarker owns the deployment/host routing decision.
// Explicit bailian mode deliberately bypasses the host check so a customer-owned
// reverse proxy can still be marked; auto only recognizes Bailian's hosted
// Anthropic endpoints.
func shouldAddSearchProviderMarker(mode, upstreamBaseURL string) bool {
	switch mode {
	case serverstore.SearchProviderOff:
		return false
	case serverstore.SearchProviderBailian:
		return true
	default:
		return isBailianHost(upstreamBaseURL)
	}
}

// isBailianHost recognizes Bailian's hosted Anthropic-compatible endpoints.
func isBailianHost(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	for _, suffix := range []string{".maas.aliyuncs.com", ".dashscope.aliyuncs.com", ".dashscope-intl.aliyuncs.com"} {
		if host == strings.TrimPrefix(suffix, ".") || strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

// hasWebSearchTool reports whether the request advertises an Anthropic native
// web_search tool. Both name and type are checked because clients may send a
// dated type (web_search_20250305) and older/newer variants.
func hasWebSearchTool(body map[string]any) bool {
	tools, ok := body["tools"].([]any)
	if !ok {
		return false
	}
	for _, item := range tools {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if typ, _ := tool["type"].(string); strings.HasPrefix(typ, "web_search") {
			return true
		}
	}
	return false
}

// hasBailianSearchMarker avoids adding a duplicate marker when a client already
// sent one (for example via a channel-specific system prompt).
func hasBailianSearchMarker(body map[string]any) bool {
	switch system := body["system"].(type) {
	case string:
		return strings.Contains(system, "x-anthropic-billing-header")
	case []any:
		for _, item := range system {
			block, _ := item.(map[string]any)
			if text, _ := block["text"].(string); strings.Contains(text, "x-anthropic-billing-header") {
				return true
			}
		}
	}
	return false
}

// appendBailianSearchMarker appends one text block while preserving every
// existing system shape. It returns false for a shape this gateway cannot
// safely rewrite; callers then leave the body untouched.
func appendBailianSearchMarker(body map[string]any) bool {
	marker := map[string]any{"type": "text", "text": bailianSearchBillingMarker}
	switch system := body["system"].(type) {
	case nil:
		body["system"] = []any{marker}
	case string:
		if strings.TrimSpace(system) == "" {
			body["system"] = []any{marker}
		} else {
			body["system"] = []any{map[string]any{"type": "text", "text": system}, marker}
		}
	case []any:
		body["system"] = append(system, marker)
	default:
		return false
	}
	return true
}
