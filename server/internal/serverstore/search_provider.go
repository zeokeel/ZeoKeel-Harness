package serverstore

// SearchProviderSetting selects how the gateway enables web search for
// Anthropic-compatible Messages requests.
//
// Values:
//   - auto (default): preserve the existing behavior; the gateway only adds
//     provider-specific search metadata when the upstream is recognized as
//     Bailian.
//   - bailian: explicitly treat the Anthropic upstream as Bailian and add the
//     billing marker Bailian requires for its native web_search tool.
//   - off: disable the client search provider; the gateway adds no marker.
//
// The value is a deployment setting rather than a model/provider column because
// it is a routing policy, not part of an upstream credential or model catalog.
const SearchProviderSetting = "web.search_provider"

// Supported search-provider modes. Keep these strings in sync with the
// bootstrap payload and the webadmin selector.
const (
	SearchProviderAuto    = "auto"
	SearchProviderBailian = "bailian"
	SearchProviderOff     = "off"
)

// NormalizeSearchProvider returns the effective mode. Missing or unknown
// stored values fall back to auto, matching the upgrade-safe default.
func NormalizeSearchProvider(raw string) string {
	switch raw {
	case SearchProviderBailian, SearchProviderOff:
		return raw
	default:
		return SearchProviderAuto
	}
}

// ValidSearchProvider reports whether a value may be written by the admin
// surface. Empty means "use the default" and is intentionally invalid here so
// explicit writes cannot silently erase the policy.
func ValidSearchProvider(raw string) bool {
	return raw == SearchProviderAuto || raw == SearchProviderBailian || raw == SearchProviderOff
}
