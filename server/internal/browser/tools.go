package browser

import (
	"encoding/json"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Allowlist alat MCP yang DIBUKA untuk agent (rencana §5, seluruh daftar
// untuk Fase 2). Konstanta ini adalah daftar izin penuh; yang AKTIF di
// Fase 1 hanya ActiveTools di bawah — alat lain tercantum di sini supaya
// Fase 2 tinggal mengaktifkan, bukan menambah daftar baru.
var AllowlistTools = []string{
	// Navigasi
	"navigate_page", "new_page", "list_pages", "select_page", "close_page", "wait_for",
	// Inspeksi
	"take_snapshot", "list_console_messages", "get_console_message",
	"list_network_requests", "get_network_request", "evaluate_script",
	// Tangkapan
	"take_screenshot",
	// Emulasi
	"emulate", "resize_page",
	// Kualitas
	"lighthouse_audit", "performance_start_trace",
	"performance_stop_trace", "performance_analyze_insight",
}

// ActiveTools adalah alat yang DIEKSPOS ke agent di Fase 1: hanya satu,
// browser_list_console_messages, yang diverifikasi end-to-end. Alat
// allowlist lain BELUM aktif — sengaja tidak diekspos sampai Fase 2
// (loop verifikasi) mengujinya satu per satu.
var ActiveTools = []string{
	"list_console_messages",
}

var allowlistSet = func() map[string]bool {
	m := make(map[string]bool, len(AllowlistTools))
	for _, n := range AllowlistTools {
		m[n] = true
	}
	return m
}()

var activeSet = func() map[string]bool {
	m := make(map[string]bool, len(ActiveTools))
	for _, n := range ActiveTools {
		m[n] = true
	}
	return m
}()

// IsAllowlisted melaporkan apakah nama tool MCP ada di allowlist §5.
func IsAllowlisted(name string) bool { return allowlistSet[name] }

// IsActiveTool melaporkan apakah nama tool MCP aktif di Fase 1.
func IsActiveTool(name string) bool { return activeSet[name] }

// FilterAllowlist membuang tool server yang tidak ada di allowlist §5.
func FilterAllowlist(tools []*mcp.Tool) []*mcp.Tool {
	out := make([]*mcp.Tool, 0, len(tools))
	for _, t := range tools {
		if t != nil && IsAllowlisted(t.Name) {
			out = append(out, t)
		}
	}
	return out
}

// FilterActive membuang tool yang tidak aktif di Fase 1 (subset allowlist).
func FilterActive(tools []*mcp.Tool) []*mcp.Tool {
	out := make([]*mcp.Tool, 0, len(tools))
	for _, t := range tools {
		if t != nil && IsActiveTool(t.Name) {
			out = append(out, t)
		}
	}
	return out
}

// Spec adalah spesifikasi tool agent (cermin AgentToolSpec di handler —
// paket ini tidak boleh mengimpor handler karena handler mengimpor paket
// ini; handler mengonversi Spec ke AgentToolSpec field-per-field).
type Spec struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// SpecsFromTools mengubah daftar tool MCP mentah menjadi katalog agent:
// filter allowlist → filter aktif Fase 1 → prefix browser_ → konversi
// skema (di-cap: skema yang hilang/rusak diganti objek kosong supaya
// model tetap mendapat `properties`).
func SpecsFromTools(tools []*mcp.Tool) []Spec {
	out := []Spec{}
	for _, t := range FilterActive(FilterAllowlist(tools)) {
		out = append(out, Spec{
			Name:        "browser_" + t.Name,
			Description: t.Description,
			InputSchema: toInputSchema(t.InputSchema),
		})
	}
	return out
}

// toInputSchema menormalkan InputSchema MCP (any) menjadi map untuk
// AgentToolSpec. Skema MCP selalu objek JSON Schema; bila bukan objek
// atau gagal di-marshal, kembalikan {"type":"object","properties":{}}.
func toInputSchema(schema any) map[string]interface{} {
	if schema == nil {
		return map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
	}
	if m, ok := schema.(map[string]interface{}); ok {
		if _, hasType := m["type"]; hasType {
			return m
		}
		// Skema tanpa "type" tetap dipakai apa adanya bila punya properties.
		if _, hasProps := m["properties"]; hasProps {
			m["type"] = "object"
			return m
		}
	}
	// Bentuk lain (json.RawMessage, struct): round-trip lewat JSON.
	b, err := json.Marshal(schema)
	if err != nil {
		return map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}
	}
	if _, hasType := m["type"]; !hasType {
		m["type"] = "object"
	}
	if _, hasProps := m["properties"]; !hasProps {
		m["properties"] = map[string]interface{}{}
	}
	return m
}

// StripPrefix mengembalikan nama tool MCP dari nama agent (browser_xxx → xxx).
func StripPrefix(agentName string) (string, bool) {
	if !strings.HasPrefix(agentName, "browser_") {
		return "", false
	}
	return strings.TrimPrefix(agentName, "browser_"), true
}
