// Package config loads the server's environment configuration in one
// place and fails fast at startup when a mandatory variable is missing.
//
// It is intentionally read-only with respect to behaviour: every default
// and fallback here mirrors what the handlers already do today
// (main.go, internal/handler/ai.go, auth.go, crypto.go, customdomain.go,
// platform.go). The only new behaviour is that problems are reported
// once, at startup, instead of surfacing later as per-request 500s.
//
// Wiring (NOT yet applied — main.go is owned by the coordinator):
// call Load at the top of main, before the database is opened, and pass
// the returned Config into the handlers that currently call os.Getenv.
// Until then this package is compiled and tested but unused.
//
// Mandatory: JWT_SECRET (or the ../.jwt-secret file, as main.go does
// today). Everything else is optional and degrades gracefully when
// unset; Load reports those cases as warnings, never as errors, so a
// partially configured server keeps the behaviour it has today.
package config

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// DefaultPublicURL is the public base URL used for OAuth redirect URIs
// when PUBLIC_URL is unset. Mirrors the fallback in auth.go.
const DefaultPublicURL = "https://build.clipku.my.id"

// jwtSecretFile is the fallback location for the JWT secret, relative to
// the server working directory. Mirrors main.go.
const jwtSecretFile = "../.jwt-secret"

// Config holds every environment variable the Go server reads.
//
// Tenant-execution variables (WEBBUILDER_ENABLE_TENANT_EXEC,
// WEBBUILDER_TENANT_EXEC_TIMEOUT_SECONDS,
// WEBBUILDER_TENANT_EXEC_MAX_OUTPUT_BYTES) are intentionally NOT
// duplicated here: they are owned by server/internal/runtime/config.go,
// which reads them with its own defaults (off / 60s / 1 MiB). They are
// documented in .env.example, but this package does not validate them.
type Config struct {
	// Required (or provided via jwtSecretFile).
	JWTSecret string

	// Database selection. Empty means "SQLite at DefaultSQLitePath"
	// (server/internal/database). postgres://... selects Postgres;
	// sqlite://... / file:... select SQLite at a path. The value is
	// carried through as-is: validity is enforced by
	// database.OpenWithDSN at startup, not here.
	DatabaseURL string

	// AI provider (OpenAI-compatible). All three together enable AI.
	AIBaseURL string
	AIAPIKey  string
	AIModel   string

	// Public URL + OAuth client IDs (public identifiers only; the
	// matching client secrets are stored in the database, not env).
	PublicURL      string
	GoogleClientID string
	GitHubClientID string

	// Base64 of a 32-byte AES-256-GCM key for AI keys at rest. Empty
	// means "use $HOME/.webbuilder-key, generating one if missing"
	// (see handler/crypto.go).
	WebbuilderKey string

	// Custom-domain SSL via certbot over SSH. All three together.
	VPSSSHHost string
	VPSSSHUser string
	VPSSSHKey  string

	// Agent queue backend: "db" (default, durable — tabel queue_jobs di DB
	// yang sama) atau "inprocess" (fallback eksplisit, job hilang saat
	// restart). Nilai lain ditolak Load dengan error (fail-fast).
	QueueBackend string

	// Agent queue workers: jumlah consumer paralel yang menjalankan job
	// agent (default 2, dibatasi 1..8). Setiap consumer mengeksekusi satu
	// job dalam satu waktu; dua worker menjaga dua project berbeda tetap
	// bisa berjalan bersamaan tanpa membanjiri mesin dengan build npm.
	QueueWorkers int
}

// Load reads the environment (plus the JWT-secret fallback file) and
// returns the config, a list of non-fatal warnings, and an error only
// when a mandatory value is missing. Warnings never contain secret
// values — only variable names and what is wrong with them.
func Load() (Config, []string, error) {
	var cfg Config
	var warnings []string

	// JWT secret: env first, ../.jwt-secret file second (as main.go).
	cfg.JWTSecret = strings.TrimSpace(os.Getenv("JWT_SECRET"))
	if cfg.JWTSecret == "" {
		if b, err := os.ReadFile(jwtSecretFile); err == nil {
			cfg.JWTSecret = strings.TrimSpace(string(b))
		}
	}
	if cfg.JWTSecret == "" {
		return Config{}, nil, fmt.Errorf("JWT_SECRET tidak diset (env atau file %s) — server menolak start", jwtSecretFile)
	}

	cfg.DatabaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))

	cfg.AIBaseURL = strings.TrimRight(strings.TrimSpace(os.Getenv("AI_BASE_URL")), "/")
	cfg.AIAPIKey = strings.TrimSpace(os.Getenv("AI_API_KEY"))
	cfg.AIModel = strings.TrimSpace(os.Getenv("AI_MODEL"))
	if n := countSet(cfg.AIBaseURL, cfg.AIAPIKey, cfg.AIModel); n > 0 && n < 3 {
		warnings = append(warnings, "AI provider tidak lengkap (AI_BASE_URL/AI_API_KEY/AI_MODEL): AI dinonaktifkan sampai ketiganya diset")
	}
	if cfg.AIBaseURL != "" {
		if u, err := url.Parse(cfg.AIBaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			warnings = append(warnings, "AI_BASE_URL bukan URL http(s) absolut yang valid — AI akan gagal saat dipakai")
		}
	}

	cfg.PublicURL = strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_URL")), "/")
	if cfg.PublicURL == "" {
		cfg.PublicURL = DefaultPublicURL
	}
	cfg.GoogleClientID = strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
	cfg.GitHubClientID = strings.TrimSpace(os.Getenv("GITHUB_CLIENT_ID"))
	if cfg.GoogleClientID == "" && cfg.GitHubClientID == "" {
		warnings = append(warnings, "GOOGLE_CLIENT_ID dan GITHUB_CLIENT_ID kosong — login OAuth dinonaktifkan")
	}

	cfg.WebbuilderKey = strings.TrimSpace(os.Getenv("WEBBUILDER_KEY"))
	if cfg.WebbuilderKey != "" {
		if raw, err := base64.StdEncoding.DecodeString(cfg.WebbuilderKey); err != nil || len(raw) != 32 {
			warnings = append(warnings, "WEBBUILDER_KEY bukan base64 dari tepat 32 byte — diabaikan, kunci baru akan digenerate (lihat handler/crypto.go)")
			cfg.WebbuilderKey = ""
		}
	}

	cfg.VPSSSHHost = strings.TrimSpace(os.Getenv("VPS_SSH_HOST"))
	cfg.VPSSSHUser = strings.TrimSpace(os.Getenv("VPS_SSH_USER"))
	cfg.VPSSSHKey = strings.TrimSpace(os.Getenv("VPS_SSH_KEY"))
	if n := countSet(cfg.VPSSSHHost, cfg.VPSSSHUser, cfg.VPSSSHKey); n > 0 && n < 3 {
		warnings = append(warnings, "VPS_SSH_* tidak lengkap (VPS_SSH_HOST/VPS_SSH_USER/VPS_SSH_KEY): SSL domain otomatis dinonaktifkan")
	}

	// Agent queue: backend + jumlah worker. Default "db" (durable).
	cfg.QueueBackend = strings.ToLower(strings.TrimSpace(os.Getenv("WEBBUILDER_QUEUE")))
	if cfg.QueueBackend == "" {
		cfg.QueueBackend = "db"
	}
	if cfg.QueueBackend != "db" && cfg.QueueBackend != "inprocess" {
		return Config{}, nil, fmt.Errorf("WEBBUILDER_QUEUE tidak valid %q (harapkan \"db\" atau \"inprocess\")", cfg.QueueBackend)
	}
	cfg.QueueWorkers = 2
	if raw := strings.TrimSpace(os.Getenv("WEBBUILDER_QUEUE_WORKERS")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 8 {
			warnings = append(warnings, "WEBBUILDER_QUEUE_WORKERS tidak valid (harapkan 1..8) — dipakai default 2")
		} else {
			cfg.QueueWorkers = n
		}
	}

	return cfg, warnings, nil
}

// AIConfigured reports whether the AI provider trio is fully set.
func (c Config) AIConfigured() bool {
	return c.AIBaseURL != "" && c.AIAPIKey != "" && c.AIModel != ""
}

// OAuthConfigured reports whether at least one OAuth provider ID is set.
func (c Config) OAuthConfigured() bool {
	return c.GoogleClientID != "" || c.GitHubClientID != ""
}

// SSHConfigured reports whether the custom-domain SSL trio is fully set.
func (c Config) SSHConfigured() bool {
	return c.VPSSSHHost != "" && c.VPSSSHUser != "" && c.VPSSSHKey != ""
}

// Summary describes which optional groups are configured, without
// revealing any secret value. Safe to log at startup.
func (c Config) Summary() map[string]bool {
	return map[string]bool{
		"jwt_secret":       c.JWTSecret != "",
		"database_url_set": c.DatabaseURL != "",
		"ai_configured":    c.AIConfigured(),
		"public_url":       c.PublicURL != "",
		"oauth":            c.OAuthConfigured(),
		"webbuilder_key":   c.WebbuilderKey != "",
		"vps_ssh":          c.SSHConfigured(),
		"queue_db":         c.QueueBackend == "db",
	}
}

func countSet(values ...string) int {
	n := 0
	for _, v := range values {
		if v != "" {
			n++
		}
	}
	return n
}
