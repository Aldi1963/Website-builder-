package models

import "time"

type User struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Name         string    `gorm:"size:255;not null" json:"name"`
	Email        string    `gorm:"size:255;uniqueIndex;not null" json:"email"`
	Password     string    `gorm:"size:255" json:"-"`
	Avatar       string    `gorm:"size:500;default:''" json:"avatar"`
	IsAdmin      bool      `gorm:"default:false" json:"isAdmin"`
	Suspended    bool      `gorm:"default:false" json:"suspended"`
	ReferralCode string    `gorm:"size:20;uniqueIndex" json:"referralCode"`
	ReferredByID *uint     `gorm:"index" json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Project struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	UserID       uint      `gorm:"index;not null" json:"userId"`
	Name         string    `gorm:"size:255;not null" json:"name"`
	Slug         string    `gorm:"size:100;uniqueIndex;not null" json:"slug"`
	Framework    string    `gorm:"size:20;default:'react'" json:"framework"`
	Files        string    `gorm:"type:text;default:'{}'" json:"files"`
	Published    bool      `gorm:"default:false" json:"published"`
	PublishState string    `gorm:"size:20;default:'draft'" json:"publishState"`
	BuildStatus  string    `gorm:"size:20;default:'unknown'" json:"buildStatus"`
	BuildError   string    `gorm:"type:text;default:''" json:"buildError,omitempty"`
	BuiltAt      *time.Time `json:"builtAt,omitempty"`
	PublishedAt  *time.Time `json:"publishedAt,omitempty"`
	Memory       string    `gorm:"type:text;default:''" json:"memory"`
	Blueprint    string    `gorm:"type:text;default:''" json:"blueprint"`
	ShareToken   string    `gorm:"size:64;default:''" json:"-"`
	SitePassword string    `gorm:"size:255;default:''" json:"-"`
	SEOTitle     string    `gorm:"size:255;default:''" json:"seoTitle"`
	SEODesc      string    `gorm:"size:500;default:''" json:"seoDesc"`
	SEOOGImage   string    `gorm:"size:500;default:''" json:"seoOgImage"`
	SEOFavicon   string    `gorm:"size:500;default:''" json:"seoFavicon"`
	FormToken    string    `gorm:"size:64;index;default:''" json:"-"`
	FormEnabled  bool      `gorm:"default:true" json:"formEnabled"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type ChatSession struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	Title     string    `gorm:"size:255" json:"title"`
	CreatedAt time.Time `json:"createdAt"`
}

type ChatMessage struct {
	ID        uint   `gorm:"primaryKey" json:"id"`
	SessionID uint   `gorm:"index;not null" json:"sessionId"`
	Role      string `gorm:"size:20;not null" json:"role"`
	Content   string `gorm:"type:text" json:"content"`
	// Provider adalah nama tampil provider AI yang dipakai untuk pesan ini
	// (mis. "9router"); Model adalah ID modelnya (mis. "cx/gpt-5.6-luna").
	// Disimpan per pesan supaya riwayat konsisten walau default admin atau
	// pilihan user berubah sesudahnya. Kosong ("") = pesan lama, sebelum
	// trek pemilih provider/model per prompt.
	Provider string `gorm:"size:100;default:''" json:"provider,omitempty"`
	Model    string `gorm:"size:100;default:''" json:"model,omitempty"`
	// Verification menyimpan hasil verifikasi browser run ini sebagai JSON
	// mentah — objek yang sama persis dengan field `verification` di event
	// SSE `result` (attempted/passed/rounds/consoleErrors/failedRequests/
	// screenshotPath/screenshotUrl), supaya kartu verifikasi bertahan
	// setelah reload. Kosong ("") = tidak ada verifikasi (pesan lama,
	// pesan user, run tanpa verifikasi) — tidak ada kartu.
	// Disimpan sebagai string JSON seperti kolom JSON lain di codebase
	// (Project.Files, AgentRun.ChangedFiles), bukan serializer GORM.
	Verification string    `gorm:"type:text;default:''" json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

type ProjectVersion struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	Label     string    `gorm:"size:255" json:"label"`
	Files     string    `gorm:"type:text" json:"files"`
	CreatedAt time.Time `json:"createdAt"`
}

type ProjectMigration struct {
	ID           uint       `gorm:"primaryKey" json:"id"`
	ProjectID    uint       `gorm:"index;not null" json:"projectId"`
	Name         string     `gorm:"size:255" json:"name"`
	UpSQL        string     `gorm:"type:text" json:"upSql"`
	DownSQL      string     `gorm:"type:text" json:"downSql"`
	Status       string     `gorm:"size:30" json:"status"`
	Error        string     `gorm:"type:text" json:"error,omitempty"`
	AppliedAt    *time.Time `json:"appliedAt"`
	RolledBackAt *time.Time `json:"rolledBackAt"`
	CreatedAt    time.Time  `json:"createdAt"`
}

type ProjectEnv struct {
	ID        uint   `gorm:"primaryKey" json:"id"`
	ProjectID uint   `gorm:"index;not null" json:"projectId"`
	Key       string `gorm:"size:100;not null" json:"key"`
	Value     string `gorm:"type:text" json:"-"`
}

type AIUsage struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Tokens    int       `json:"tokens"`
	Model     string    `gorm:"size:100" json:"model"`
	CreatedAt time.Time `json:"createdAt"`
}

type Template struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	OwnerID     *uint     `gorm:"index" json:"-"`
	Name        string    `gorm:"size:255;not null" json:"name"`
	Description string    `gorm:"type:text" json:"description"`
	Category    string    `gorm:"size:50" json:"category"`
	Framework   string    `gorm:"size:20;default:'react'" json:"framework"`
	Files       string    `gorm:"type:text" json:"-"`
	Uses        int       `gorm:"default:0" json:"uses"`
	Featured    bool      `gorm:"default:false" json:"featured"`
	CreatedAt   time.Time `json:"createdAt"`
}

type FormSubmission struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	Data      string    `gorm:"type:text" json:"data"`
	IP        string    `gorm:"size:50" json:"ip"`
	CreatedAt time.Time `json:"createdAt"`
}

type Deployment struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Status    string    `gorm:"size:20;default:'ready'" json:"status"`
	URL       string    `gorm:"size:255" json:"url"`
	Files     string    `gorm:"type:text" json:"-"`
	CreatedAt time.Time `json:"createdAt"`
}

type Domain struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index" json:"projectId"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Domain    string    `gorm:"size:255;not null" json:"domain"`
	Verified  bool      `gorm:"default:false" json:"verified"`
	CreatedAt time.Time `json:"createdAt"`
}

type AIConfig struct {
	ID      uint   `gorm:"primaryKey" json:"id"`
	BaseURL string `gorm:"size:500" json:"baseUrl"`
	APIKey  string `gorm:"size:500" json:"-"`
	Model   string `gorm:"size:100" json:"model"`
}

// AIProviderConfig adalah satu provider AI yang dikelola admin (Settings >
// Provider AI): nama tampil, base URL OpenAI-compatible, API key
// (terenkripsi AES-256-GCM dengan pola yang sama seperti AIConfig.APIKey),
// dan daftar model yang tersedia di provider itu (JSON array di Models).
// Satu baris boleh ditandai default (IsDefault) — itulah provider yang
// dipakai bila user tidak memilih apa pun di composer. Enabled=false
// menyembunyikan provider dari pemilih tanpa menghapus konfigurasinya.
// Provider pertama dibuat otomatis dari konfigurasi AI lama (AIConfig /
// env AI_*) bila tabel masih kosong — lihat ensureDefaultProviderSeeded —
// supaya default lama tetap berlaku tanpa migrasi manual.
type AIProviderConfig struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:100;not null" json:"name"`
	BaseURL   string    `gorm:"size:500;not null" json:"baseUrl"`
	APIKey    string    `gorm:"size:500" json:"-"`
	Models    string    `gorm:"type:text;default:'[]'" json:"-"`
	IsDefault bool      `gorm:"default:false" json:"isDefault"`
	Enabled   bool      `gorm:"default:true" json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TableName menyamakan nama tabel GORM dengan migrasi goose 00004
// (ai_provider_configs). Tanpa ini GORM menurunkan "a_iprovider_configs"
// dari nama struct, sehingga di Postgres (skema dari goose) semua query
// provider gagal "relation does not exist", sementara SQLite (AutoMigrate)
// diam-diam memakai nama yang salah itu.
func (AIProviderConfig) TableName() string { return "ai_provider_configs" }

type PasswordReset struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Token     string    `gorm:"size:64;uniqueIndex" json:"-"`
	ExpiresAt time.Time `json:"-"`
	Used      bool      `gorm:"default:false" json:"-"`
}

type GitHubConfig struct {
	ID     uint   `gorm:"primaryKey" json:"id"`
	UserID uint   `gorm:"uniqueIndex;not null" json:"userId"`
	Token  string `gorm:"size:500" json:"-"`
	Repo   string `gorm:"size:255" json:"repo"`
}

type AuditLog struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index" json:"userId"`
	Action    string    `gorm:"size:100" json:"action"`
	Detail    string    `gorm:"size:500" json:"detail"`
	IP        string    `gorm:"size:50" json:"ip"`
	CreatedAt time.Time `json:"createdAt"`
}

type PlatformSetting struct {
	Key   string `gorm:"primaryKey;size:100" json:"key"`
	Value string `gorm:"type:text" json:"value"`
}

type Notification struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Title     string    `gorm:"size:255" json:"title"`
	Body      string    `gorm:"size:500" json:"body"`
	Read      bool      `gorm:"default:false" json:"read"`
	CreatedAt time.Time `json:"createdAt"`
}

type ProjectMember struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	Role      string    `gorm:"size:20;default:'viewer'" json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

type UserAPIKey struct {
	ID        uint       `gorm:"primaryKey" json:"id"`
	UserID    uint       `gorm:"index;not null" json:"userId"`
	Name      string     `gorm:"size:100" json:"name"`
	KeyHash   string     `gorm:"size:64;uniqueIndex" json:"-"`
	Prefix    string     `gorm:"size:12" json:"prefix"`
	LastUsed  *time.Time `json:"lastUsed"`
	CreatedAt time.Time  `json:"createdAt"`
}

type ProjectWebhook struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	URL       string    `gorm:"size:500" json:"url"`
	Events    string    `gorm:"size:255;default:'deploy'" json:"events"`
	Secret    string    `gorm:"size:64" json:"-"`
	CreatedAt time.Time `json:"createdAt"`
}

type VisitStat struct {
	ID        uint   `gorm:"primaryKey" json:"id"`
	ProjectID uint   `gorm:"index;not null" json:"projectId"`
	Date      string `gorm:"size:10;index" json:"date"`
	Count     int    `gorm:"default:0" json:"count"`
}

type BlockedWord struct {
	ID   uint   `gorm:"primaryKey" json:"id"`
	Word string `gorm:"size:100;uniqueIndex" json:"word"`
}

type UserTOTP struct {
	UserID    uint      `gorm:"primaryKey" json:"userId"`
	Secret    string    `gorm:"size:100" json:"-"`
	Enabled   bool      `gorm:"default:false" json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
}

type AIProposal struct {
	ID        uint      `gorm:"primaryKey"`
	ProjectID uint      `gorm:"index;not null"`
	Files     string    `gorm:"type:text"`
	CreatedAt time.Time `json:"createdAt"`
}

func (AIProposal) TableName() string { return "ai_proposals" }

type AgentRun struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	ProjectID     uint       `gorm:"index;not null" json:"projectId"`
	UserID        uint       `gorm:"index;not null" json:"userId"`
	Mode          string     `gorm:"size:30;not null" json:"mode"`
	Status        string     `gorm:"size:20;index;not null" json:"status"`
	Phase         string     `gorm:"size:40" json:"phase"`
	Request       string     `gorm:"type:text" json:"request"`
	// Provider/Model: pilihan provider + model per prompt yang dipakai run
	// ini (lihat ChatMessage). Dicatat supaya riwayat run konsisten dan
	// pergantian model antar prompt bisa dibuktikan dari DB.
	Provider      string     `gorm:"size:100;default:''" json:"provider,omitempty"`
	Model         string     `gorm:"size:100;default:''" json:"model,omitempty"`
	Summary       string     `gorm:"type:text" json:"summary"`
	Error         string     `gorm:"type:text" json:"error,omitempty"`
	Attempt       int        `gorm:"default:0" json:"attempt"`
	CurrentOutput string     `gorm:"type:text" json:"currentOutput,omitempty"`
	Intent        string     `gorm:"size:30" json:"intent,omitempty"`
	Assumptions   string     `gorm:"type:text" json:"assumptions,omitempty"`
	ChangedFiles  string     `gorm:"type:text" json:"changedFiles,omitempty"`
	Checks        string     `gorm:"type:text" json:"checks,omitempty"`
	NextSteps     string     `gorm:"type:text" json:"nextSteps,omitempty"`
	ErrorCode     string     `gorm:"size:60" json:"errorCode,omitempty"`
	StartedAt     time.Time  `json:"startedAt"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
}

type AgentToolCall struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	RunID     uint      `gorm:"index;not null" json:"runId"`
	Tool      string    `gorm:"size:60;not null" json:"tool"`
	Phase     string    `gorm:"size:40" json:"phase"`
	Status    string    `gorm:"size:20;not null" json:"status"`
	Input     string    `gorm:"type:text" json:"input,omitempty"`
	Output    string    `gorm:"type:text" json:"output,omitempty"`
	Error     string    `gorm:"type:text" json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type FileComment struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	FilePath  string    `gorm:"size:255;index" json:"filePath"`
	Line      int       `gorm:"default:0" json:"line"`
	UserID    uint      `gorm:"index" json:"userId"`
	UserName  string    `gorm:"size:100" json:"userName"`
	Body      string    `gorm:"type:text" json:"body"`
	Resolved  bool      `gorm:"default:false" json:"resolved"`
	CreatedAt time.Time `json:"createdAt"`
}

type Subscription struct {
	ID        uint       `gorm:"primaryKey" json:"id"`
	UserID    uint       `gorm:"uniqueIndex;not null" json:"userId"`
	Plan      string     `gorm:"size:20;default:'free'" json:"plan"`
	Status    string     `gorm:"size:20;default:'active'" json:"status"`
	ExpiresAt *time.Time `json:"expiresAt"`
	CreatedAt time.Time  `json:"createdAt"`
}

type Payment struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"index;not null" json:"userId"`
	OrderID   string    `gorm:"size:100;uniqueIndex" json:"orderId"`
	Plan      string    `gorm:"size:20" json:"plan"`
	Amount    int64     `json:"amount"`
	Status    string    `gorm:"size:20;default:'pending'" json:"status"`
	PayURL    string    `gorm:"size:500" json:"payUrl"`
	CreatedAt time.Time `json:"createdAt"`
}

// AppFile: file storage untuk aplikasi hasil generate (per project).
type AppFile struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	ProjectID uint      `gorm:"index;not null" json:"projectId"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Path      string    `gorm:"size:500" json:"-"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

// AppCronJob: scheduled HTTP call milik aplikasi hasil generate.
type AppCronJob struct {
	ID        uint       `gorm:"primaryKey" json:"id"`
	ProjectID uint       `gorm:"index;not null" json:"projectId"`
	Name      string     `gorm:"size:255;not null" json:"name"`
	Schedule  string     `gorm:"size:100;not null" json:"schedule"`
	URL       string     `gorm:"size:1000;not null" json:"url"`
	Method    string     `gorm:"size:10;default:'GET'" json:"method"`
	Active    bool       `gorm:"default:true" json:"active"`
	LastRunAt *time.Time `json:"lastRunAt"`
	CreatedAt time.Time  `json:"createdAt"`
}

// AgentContext menyimpan konteks percakapan terstruktur per project agar follow-up
// seperti "buat mobile juga" tidak kehilangan target fitur sebelumnya.
type AgentContext struct {
	ID              uint      `gorm:"primaryKey" json:"id"`
	ProjectID       uint      `gorm:"uniqueIndex;not null" json:"projectId"`
	Intent          string    `gorm:"size:30" json:"intent"`
	ActiveFeature   string    `gorm:"size:255" json:"activeFeature"`
	TargetPage      string    `gorm:"size:255" json:"targetPage"`
	TargetFiles     string    `gorm:"type:text" json:"targetFiles"`
	LastPlan        string    `gorm:"type:text" json:"lastPlan"`
	PendingQuestion string    `gorm:"type:text" json:"pendingQuestion"`
	LastError       string    `gorm:"type:text" json:"lastError"`
	UpdatedAt       time.Time `json:"updatedAt"`
}
