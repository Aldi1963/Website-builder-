package securityscan

import "testing"

func TestScanCleanProjectPasses(t *testing.T) {
	files := map[string]string{
		"src/App.tsx": `import { useState } from "react";
const apiKey = import.meta.env.VITE_API_KEY;
export default function App() {
  const [q, setQ] = useState("");
  return <div>{q}</div>;
}`,
		"src/api.ts": `export async function load(id: string) {
  const res = await cloudDb.query("SELECT * FROM items WHERE id = $1", [id]);
  return res;
}`,
		".env.example": "VITE_API_KEY=YOUR_API_KEY_HERE\n",
		"package.json": `{"name":"app"}`,
	}
	rep := ScanFiles(files)
	if rep.Blocked || !rep.Passed {
		t.Fatalf("proyek bersih harus lolos, dapat: %+v", rep.Findings)
	}
	if rep.Summary.Total != 0 {
		t.Fatalf("proyek bersih harus 0 temuan, dapat %d: %+v", rep.Summary.Total, rep.Findings)
	}
}

// fakeStripeLiveKey dirangkai saat jalan (bukan literal utuh di file)
// supaya push protection GitHub tidak mengira ini secret sungguhan.
const fakeStripeLiveKey = "sk_live_" + "abcdefghijklmnop1234567890"

func TestScanSecretLiteralBlocked(t *testing.T) {
	files := map[string]string{
		"src/config.ts": `export const STRIPE_KEY = "` + fakeStripeLiveKey + `";`,
		"src/other.ts":  "const x = 1;\n",
	}
	rep := ScanFiles(files)
	if !rep.Blocked || rep.Summary.Critical == 0 {
		t.Fatalf("secret literal harus memblokir, dapat: %+v", rep.Summary)
	}
	if rep.Findings[0].Category != CategorySecret {
		t.Fatalf("kategori harus secret, dapat %s", rep.Findings[0].Category)
	}
}

func TestScanSecretPlaceholderNotFlagged(t *testing.T) {
	files := map[string]string{
		"src/config.ts": `const apiKey = "YOUR_API_KEY_HERE";
const password = "changeme";
const token = "xxx";
const key2 = "test-key-123";`,
	}
	rep := ScanFiles(files)
	if rep.Summary.Total != 0 {
		t.Fatalf("placeholder tidak boleh ditandai, dapat: %+v", rep.Findings)
	}
}

func TestScanEnvReferenceNotFlagged(t *testing.T) {
	files := map[string]string{
		"src/config.ts": "const apiKey = process.env.OPENAI_API_KEY;\nconst k2 = import.meta.env.VITE_SUPABASE_KEY;\n",
	}
	rep := ScanFiles(files)
	if rep.Summary.Total != 0 {
		t.Fatalf("referensi env tidak boleh ditandai, dapat: %+v", rep.Findings)
	}
}

func TestScanSQLInjectionTemplateLiteral(t *testing.T) {
	files := map[string]string{
		"src/api.ts": "export async function cari(nama: string) {\n  return cloudDb.query(`SELECT * FROM users WHERE name = '${nama}'`);\n}\n",
	}
	rep := ScanFiles(files)
	if !rep.Blocked {
		t.Fatalf("SQL template literal dengan interpolasi harus memblokir, dapat: %+v", rep.Findings)
	}
	found := false
	for _, f := range rep.Findings {
		if f.Category == CategorySQLI {
			found = true
		}
	}
	if !found {
		t.Fatalf("harus ada temuan sql-injection, dapat: %+v", rep.Findings)
	}
}

func TestScanSQLInjectionConcat(t *testing.T) {
	files := map[string]string{
		"src/api.ts": "const q = \"SELECT * FROM items WHERE id = \" + userId;\ncloudDb.query(q);\n",
	}
	rep := ScanFiles(files)
	if !rep.Blocked {
		t.Fatalf("konkatenasi SQL harus memblokir, dapat: %+v", rep.Findings)
	}
}

func TestScanParameterizedQueryPasses(t *testing.T) {
	files := map[string]string{
		"src/api.ts": "export async function cari(nama: string) {\n  return cloudDb.query(\"SELECT * FROM users WHERE name = $1\", [nama]);\n}\n",
	}
	rep := ScanFiles(files)
	if rep.Summary.Total != 0 {
		t.Fatalf("query berparameter tidak boleh ditandai, dapat: %+v", rep.Findings)
	}
}

func TestScanXSSHighButNotBlocking(t *testing.T) {
	files := map[string]string{
		"src/App.tsx": "export function View({ html }: any) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n",
	}
	rep := ScanFiles(files)
	if rep.Blocked {
		t.Fatalf("XSS high saja tidak boleh memblokir (warning), dapat: %+v", rep.Findings)
	}
	if rep.Summary.High == 0 {
		t.Fatalf("harus ada temuan high, dapat: %+v", rep.Summary)
	}
}

func TestScanAuthBypass(t *testing.T) {
	files := map[string]string{
		"src/auth.ts": "export const skipAuth = true;\nexport const isAuthenticated = true;\n",
	}
	rep := ScanFiles(files)
	if rep.Summary.High < 2 {
		t.Fatalf("harus ada 2 temuan auth high, dapat: %+v", rep.Findings)
	}
	if rep.Blocked {
		t.Fatalf("temuan high saja tidak boleh memblokir")
	}
}

func TestScanCommentNotFlagged(t *testing.T) {
	files := map[string]string{
		"src/App.tsx": "// contoh: const apiKey = \"sk-...\" (bukan secret sungguhan)\n// JANGAN pakai kunci live di sini\nexport const x = 1;\n",
	}
	rep := ScanFiles(files)
	if rep.Summary.Total != 0 {
		t.Fatalf("pola di komentar tidak boleh ditandai, dapat: %+v", rep.Findings)
	}
}

func TestScanSkipsDistAndLockfiles(t *testing.T) {
	files := map[string]string{
		"dist/assets/index.js": "const k=\"" + fakeStripeLiveKey + "\";",
		"package-lock.json":    "{\"k\":\"" + fakeStripeLiveKey + "\"}",
		"src/App.tsx":          "export const x = 1;\n",
	}
	rep := ScanFiles(files)
	if rep.Summary.Total != 0 {
		t.Fatalf("dist/lockfile tidak boleh dipindai, dapat: %+v", rep.Findings)
	}
}

func TestCheckPoliciesSensitiveTableRead(t *testing.T) {
	rows := []PolicyRow{
		{Table: "app_users", Role: "viewer", Operation: "select", Enabled: true},
		{Table: "items", Role: "member", Operation: "select", Enabled: true},
	}
	rep := ScanFiles(map[string]string{"src/App.tsx": "export const x = 1;\n"})
	AddPolicyFindings(&rep, rows)
	if !rep.Blocked {
		t.Fatalf("baca app_users oleh viewer harus memblokir, dapat: %+v", rep.Findings)
	}
	if rep.PolicyRows != 2 {
		t.Fatalf("PolicyRows harus 2, dapat %d", rep.PolicyRows)
	}
}

func TestCheckPoliciesRawQueryLowRole(t *testing.T) {
	rows := []PolicyRow{{Table: "items", Role: "member", Operation: "query", Enabled: true}}
	f := CheckPolicies(rows)
	if len(f) != 1 || f[0].Severity != SeverityCritical {
		t.Fatalf("query mentah untuk member harus kritis, dapat: %+v", f)
	}
}

func TestCheckPoliciesDefaultsNotFlagged(t *testing.T) {
	// Tanpa baris policy eksplisit (deny-by-default) = tidak ada temuan.
	if f := CheckPolicies(nil); len(f) != 0 {
		t.Fatalf("tanpa policy harus 0 temuan, dapat: %+v", f)
	}
	// Baris yang dimatikan juga bukan temuan.
	rows := []PolicyRow{{Table: "app_users", Role: "viewer", Operation: "select", Enabled: false}}
	if f := CheckPolicies(rows); len(f) != 0 {
		t.Fatalf("policy disabled harus 0 temuan, dapat: %+v", f)
	}
	// Owner/admin boleh penuh — bukan temuan.
	rows = []PolicyRow{
		{Table: "app_users", Role: "owner", Operation: "select", Enabled: true},
		{Table: "items", Role: "member", Operation: "delete", Enabled: true},
	}
	f := CheckPolicies(rows)
	if len(f) != 1 || f[0].ID != "policy-delete-low-role" {
		t.Fatalf("hanya delete member yang harus ditandai, dapat: %+v", f)
	}
}

func TestReportAlwaysCarriesLimitations(t *testing.T) {
	rep := ScanFiles(map[string]string{"src/App.tsx": "export const x = 1;\n"})
	if rep.Limitations == "" {
		t.Fatal("laporan harus selalu membawa batasan scanner")
	}
	if rep.ScannedFiles != 1 {
		t.Fatalf("ScannedFiles harus 1, dapat %d", rep.ScannedFiles)
	}
}
