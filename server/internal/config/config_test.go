package config

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

// Tests run with CWD = the package dir, so ../.jwt-secret does not
// exist there; JWT_SECRET must come from env in these tests.

func TestLoadMissingJWTSecret(t *testing.T) {
	t.Setenv("JWT_SECRET", "")
	if _, _, err := Load(); err == nil {
		t.Fatal("Load harus error bila JWT_SECRET kosong")
	} else if !strings.Contains(err.Error(), "JWT_SECRET") {
		t.Fatalf("error harus menyebut JWT_SECRET, dapat: %v", err)
	}
}

func TestLoadMinimal(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("AI_BASE_URL", "")
	t.Setenv("AI_API_KEY", "")
	t.Setenv("AI_MODEL", "")
	t.Setenv("GOOGLE_CLIENT_ID", "")
	t.Setenv("GITHUB_CLIENT_ID", "")
	t.Setenv("WEBBUILDER_KEY", "")
	t.Setenv("VPS_SSH_HOST", "")
	t.Setenv("VPS_SSH_USER", "")
	t.Setenv("VPS_SSH_KEY", "")
	t.Setenv("PUBLIC_URL", "")

	cfg, warnings, err := Load()
	if err != nil {
		t.Fatalf("Load minimal tidak boleh error: %v", err)
	}
	if cfg.PublicURL != DefaultPublicURL {
		t.Fatalf("PUBLIC_URL kosong harus default ke %s, dapat %q", DefaultPublicURL, cfg.PublicURL)
	}
	if cfg.AIConfigured() || cfg.OAuthConfigured() || cfg.SSHConfigured() {
		t.Fatal("grup opsional harus dilaporkan belum terkonfigurasi")
	}
	if len(warnings) == 0 {
		t.Fatal("Load minimal harus memberi peringatan untuk grup opsional yang kosong")
	}
	if os.Getenv("JWT_SECRET") == "" {
		t.Fatal("sanity: JWT_SECRET env harus terset di test ini")
	}
}

func TestLoadDatabaseURLPassthrough(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("DATABASE_URL", "postgres://user:pass@127.0.0.1:5432/webbuilder")
	cfg, _, err := Load()
	if err != nil {
		t.Fatalf("Load tidak boleh error untuk DATABASE_URL postgres: %v", err)
	}
	if cfg.DatabaseURL == "" || !cfg.Summary()["database_url_set"] {
		t.Fatal("DATABASE_URL harus diteruskan apa adanya oleh Load")
	}

	// Kosong = SQLite default; Load tidak boleh error dan tidak boleh
	// memberi peringatan fatal soal database.
	t.Setenv("DATABASE_URL", "")
	cfg, _, err = Load()
	if err != nil {
		t.Fatalf("Load tidak boleh error untuk DATABASE_URL kosong: %v", err)
	}
	if cfg.DatabaseURL != "" {
		t.Fatal("DATABASE_URL kosong harus tetap kosong (SQLite default)")
	}
}

func TestLoadPartialAIWarns(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("AI_BASE_URL", "https://api.example.com/v1")
	t.Setenv("AI_API_KEY", "")
	t.Setenv("AI_MODEL", "")
	t.Setenv("GOOGLE_CLIENT_ID", "x")
	t.Setenv("GITHUB_CLIENT_ID", "")
	t.Setenv("WEBBUILDER_KEY", "")
	t.Setenv("VPS_SSH_HOST", "")
	t.Setenv("VPS_SSH_USER", "")
	t.Setenv("VPS_SSH_KEY", "")

	cfg, warnings, err := Load()
	if err != nil {
		t.Fatalf("Load tidak boleh error untuk AI parsial: %v", err)
	}
	if cfg.AIConfigured() {
		t.Fatal("AI parsial tidak boleh dilaporkan configured")
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "AI_BASE_URL") {
			found = true
		}
	}
	if !found {
		t.Fatalf("harus ada peringatan AI parsial, dapat: %v", warnings)
	}
}

func TestLoadWebbuilderKeyValidation(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("AI_BASE_URL", "")
	t.Setenv("AI_API_KEY", "")
	t.Setenv("AI_MODEL", "")
	t.Setenv("GOOGLE_CLIENT_ID", "x")
	t.Setenv("VPS_SSH_HOST", "")
	t.Setenv("VPS_SSH_USER", "")
	t.Setenv("VPS_SSH_KEY", "")

	// Kunci tidak valid: diabaikan + peringatan, bukan error.
	t.Setenv("WEBBUILDER_KEY", "bukan-base64-32-byte")
	cfg, warnings, err := Load()
	if err != nil {
		t.Fatalf("kunci tidak valid tidak boleh fatal: %v", err)
	}
	if cfg.WebbuilderKey != "" {
		t.Fatal("kunci tidak valid harus dikosongkan (fallback ke file/generate)")
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "WEBBUILDER_KEY") {
			found = true
		}
	}
	if !found {
		t.Fatalf("harus ada peringatan WEBBUILDER_KEY, dapat: %v", warnings)
	}

	// Kunci valid: base64 dari tepat 32 byte, diterima apa adanya.
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	t.Setenv("WEBBUILDER_KEY", base64.StdEncoding.EncodeToString(raw))
	cfg, _, err = Load()
	if err != nil {
		t.Fatalf("kunci valid tidak boleh error: %v", err)
	}
	if cfg.WebbuilderKey == "" {
		t.Fatal("kunci valid harus dipertahankan")
	}
}

func TestLoadQueueDefaults(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("WEBBUILDER_QUEUE", "")
	t.Setenv("WEBBUILDER_QUEUE_WORKERS", "")
	cfg, _, err := Load()
	if err != nil {
		t.Fatalf("Load tidak boleh error untuk queue default: %v", err)
	}
	if cfg.QueueBackend != "db" {
		t.Fatalf("WEBBUILDER_QUEUE kosong harus default ke \"db\", dapat %q", cfg.QueueBackend)
	}
	if cfg.QueueWorkers != 2 {
		t.Fatalf("WEBBUILDER_QUEUE_WORKERS kosong harus default 2, dapat %d", cfg.QueueWorkers)
	}
	if !cfg.Summary()["queue_db"] {
		t.Fatal("Summary harus melaporkan queue_db=true untuk default db")
	}
}

func TestLoadQueueInvalidBackendErrors(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("WEBBUILDER_QUEUE", "redis")
	if _, _, err := Load(); err == nil {
		t.Fatal("WEBBUILDER_QUEUE di luar db|inprocess harus error (fail-fast)")
	} else if !strings.Contains(err.Error(), "WEBBUILDER_QUEUE") {
		t.Fatalf("error harus menyebut WEBBUILDER_QUEUE, dapat: %v", err)
	}
}

func TestLoadQueueInProcessAndWorkers(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("WEBBUILDER_QUEUE", "inprocess")
	t.Setenv("WEBBUILDER_QUEUE_WORKERS", "3")
	cfg, _, err := Load()
	if err != nil {
		t.Fatalf("Load tidak boleh error untuk inprocess: %v", err)
	}
	if cfg.QueueBackend != "inprocess" || cfg.QueueWorkers != 3 {
		t.Fatalf("harapkan inprocess/3, dapat %q/%d", cfg.QueueBackend, cfg.QueueWorkers)
	}
	if cfg.Summary()["queue_db"] {
		t.Fatal("Summary harus melaporkan queue_db=false untuk inprocess")
	}

	// Workers di luar 1..8: peringatan + kembali ke default 2.
	t.Setenv("WEBBUILDER_QUEUE_WORKERS", "99")
	cfg, warnings, err := Load()
	if err != nil {
		t.Fatalf("workers tidak valid tidak boleh fatal: %v", err)
	}
	if cfg.QueueWorkers != 2 {
		t.Fatalf("workers 99 harus kembali ke default 2, dapat %d", cfg.QueueWorkers)
	}
	found := false
	for _, w := range warnings {
		if strings.Contains(w, "WEBBUILDER_QUEUE_WORKERS") {
			found = true
		}
	}
	if !found {
		t.Fatalf("harus ada peringatan WEBBUILDER_QUEUE_WORKERS, dapat: %v", warnings)
	}
}
