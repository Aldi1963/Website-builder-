package browser

import (
	"encoding/json"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Allowlist alat MCP yang DIBUKA untuk agent (rencana §5, seluruh daftar
// untuk Fase 2). ActiveTools di bawah = seluruh daftar ini.
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

// InputTools adalah alat INPUT browser (Fase 4): mengubah state halaman
// (klik elemen, isi form, tekan tombol). SENGAJA dipisah dari
// AllowlistTools §5 di atas supaya gating-nya terpisah: keempat alat ini
// hanya aktif bila flag WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS nyala
// (lihat InputToolsEnabled di client.go). Bila flag mati, mereka tidak
// lolos FilterAllowlist/FilterActive dan CallTool menolaknya —
// katalog agent berjalan seperti Fase 2 (19 alat baca saja).
// wait_for TIDAK masuk sini: ia alat tunggu baca-saja (kategori
// "navigation", readOnlyHint di server MCP 1.13.0) dan sudah ada di
// allowlist §5; menunggu teks muncul bukan interaksi.
var InputTools = []string{
	"click", "fill", "fill_form", "press_key",
}

// ActiveTools adalah alat yang DIEKSPOS ke agent di Fase 2: SELURUH
// allowlist §5. Filter Fase 1 (hanya list_console_messages) dihapus —
// alat lain sudah diuji satu per satu lewat loop verifikasi (lihat
// server/internal/browser/verify.go + test integrasi Chrome). Alat di
// luar allowlist tetap tertutup: FilterAllowlist membuangnya sebelum
// SpecsFromTools, dan CallTool menolak nama yang tidak aktif.
var ActiveTools = append([]string{}, AllowlistTools...)

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

var inputSet = func() map[string]bool {
	m := make(map[string]bool, len(InputTools))
	for _, n := range InputTools {
		m[n] = true
	}
	return m
}()

// IsAllowlisted melaporkan apakah nama tool MCP ada di allowlist §5.
func IsAllowlisted(name string) bool { return allowlistSet[name] }

// IsInteractionTool melaporkan apakah nama tool MCP adalah alat input
// (Fase 4: click, fill, fill_form, press_key). Dipakai gating flag
// input (IsActiveTool, FilterAllowlist) dan cap interaksi
// (reserveInteractionCall di client.go) — terpisah dari IsActiveTool
// supaya alat baca (termasuk wait_for) tidak ikut dibatasi.
func IsInteractionTool(name string) bool { return inputSet[name] }

// IsActiveTool melaporkan apakah nama tool MCP aktif: seluruh allowlist
// §5 SELALU aktif, sedangkan alat input (Fase 4) aktif HANYA bila flag
// WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS nyala (InputToolsEnabled).
// Membaca env setiap kali supaya perubahan env langsung berlaku (pola
// yang sama seperti Enabled di client.go).
func IsActiveTool(name string) bool {
	if activeSet[name] {
		return true
	}
	return IsInteractionTool(name) && InputToolsEnabled()
}

// MissingActiveTools mengembalikan nama alat aktif yang TIDAK ada di
// daftar tools/list server MCP. Dipakai pipeline supaya alat yang hilang
// (mis. server MCP versi lama tanpa lighthouse_audit) dilaporkan
// fail-closed dengan pesan jelas, bukan diam-diam hilang dari katalog.
// Alat input hanya diperiksa bila flag input nyala — bila flag mati,
// alat itu memang tidak diharapkan ada di katalog.
func MissingActiveTools(serverTools []*mcp.Tool) []string {
	seen := make(map[string]bool, len(serverTools))
	for _, t := range serverTools {
		if t != nil {
			seen[t.Name] = true
		}
	}
	active := ActiveTools
	if InputToolsEnabled() {
		active = append(append([]string{}, ActiveTools...), InputTools...)
	}
	missing := []string{}
	for _, name := range active {
		if !seen[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

// FilterAllowlist membuang tool server yang tidak ada di allowlist §5.
// Alat input (Fase 4) lolos filter ini HANYA bila flag input nyala;
// bila flag mati, mereka dibuang seperti tool di luar allowlist
// (katalog Fase 2: 19 alat baca saja).
func FilterAllowlist(tools []*mcp.Tool) []*mcp.Tool {
	out := make([]*mcp.Tool, 0, len(tools))
	for _, t := range tools {
		if t == nil {
			continue
		}
		if IsAllowlisted(t.Name) || (IsInteractionTool(t.Name) && InputToolsEnabled()) {
			out = append(out, t)
		}
	}
	return out
}

// FilterActive membuang tool yang tidak aktif: seluruh allowlist §5
// ditambah alat input (Fase 4) HANYA bila flag input nyala (lihat
// IsActiveTool). Bila flag mati, alat input dibuang di sini walau sudah
// lolos FilterAllowlist.
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
// filter allowlist → filter aktif → prefix browser_ → konversi skema
// (di-cap: skema yang hilang/rusak diganti objek kosong supaya model
// tetap mendapat `properties`). Alat aktif yang tidak ada di daftar
// server TIDAK muncul di sini — panggil MissingActiveTools untuk
// melaporkannya (fail-closed), jangan mengarang speknya. Alat input
// (Fase 4) hanya muncul bila flag WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS
// nyala; bila flag mati, katalog berisi 19 alat baca Fase 2 saja.
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
