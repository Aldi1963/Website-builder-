package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// ── Templates ──

func listTemplates(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Galeri publik: template global (owner_id NULL) + template milik user lain.
		// Files TIDAK disertakan (diambil saat "use" saja).
		q := db.Order("featured DESC, id DESC")
		if cat := c.Query("category"); cat != "" {
			q = q.Where("category = ?", cat)
		}
		if s := c.Query("q"); s != "" {
			like := "%" + s + "%"
			q = q.Where("name LIKE ? OR description LIKE ?", like, like)
		}
		var ts []models.Template
		q.Find(&ts)
		out := []gin.H{}
		for _, t := range ts {
			out = append(out, templateJSON(db, t))
		}
		c.JSON(200, gin.H{"templates": out})
	}
}

func useTemplate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t models.Template
		if err := db.First(&t, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Template tidak ada"})
			return
		}
		// cek kuota proyek (template juga proyek baru)
		uid := c.GetUint("userID")
		plan := userPlan(db, uid)
		maxProjects, _ := planQuota(db, plan)
		var pc int64
		db.Model(&models.Project{}).Where("user_id = ?", uid).Count(&pc)
		if int(pc) >= maxProjects {
			c.JSON(402, gin.H{
				"error":   "quota_exceeded",
				"message": "Batas proyek paket " + plan + " tercapai. Upgrade untuk menambah.",
			})
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		c.ShouldBindJSON(&req)
		name := req.Name
		if name == "" {
			name = t.Name
		}
		slug := makeSlug(name)
		for i := 1; ; i++ {
			try := slug
			if i > 1 {
				try = slug + "-" + itoa(i)
			}
			var n int64
			db.Model(&models.Project{}).Where("slug = ?", try).Count(&n)
			if n == 0 {
				slug = try
				break
			}
		}
		p := models.Project{UserID: c.GetUint("userID"), Name: name, Slug: slug, Framework: t.Framework, Files: t.Files}
		db.Create(&p)
		db.Model(&models.Template{}).Where("id = ?", t.ID).UpdateColumn("uses", gorm.Expr("uses + 1"))
		audit(db, c.GetUint("userID"), "template.use", t.Name, c.ClientIP())
		c.JSON(201, gin.H{"project": p})
	}
}

// ── Deployments ──

func listDeployments(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ds []models.Deployment
		db.Where("user_id = ?", c.GetUint("userID")).Order("id DESC").Limit(50).Find(&ds)
		c.JSON(200, gin.H{"deployments": ds})
	}
}

// ── Domains ──

func listDomains(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ds []models.Domain
		db.Where("user_id = ?", c.GetUint("userID")).Order("id DESC").Find(&ds)
		c.JSON(200, gin.H{"domains": ds})
	}
}

func addDomain(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Domain    string `json:"domain" binding:"required"`
			ProjectID uint   `json:"projectId"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Domain wajib"})
			return
		}
		d := models.Domain{UserID: c.GetUint("userID"), ProjectID: req.ProjectID, Domain: req.Domain}
		db.Create(&d)
		c.JSON(201, gin.H{"domain": d})
	}
}

func deleteDomain(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		db.Where("id = ? AND user_id = ?", c.Param("id"), c.GetUint("userID")).Delete(&models.Domain{})
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// ── Usage ──

// ── Billing ──

// ── Settings ──

func updateProfile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name string `json:"name"`
		}
		c.ShouldBindJSON(&req)
		if req.Name != "" {
			db.Model(&models.User{}).Where("id = ?", c.GetUint("userID")).Update("name", req.Name)
		}
		var u models.User
		db.First(&u, c.GetUint("userID"))
		c.JSON(200, gin.H{"user": u})
	}
}

func changePassword(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Old string `json:"old" binding:"required"`
			New string `json:"new" binding:"required,min=6"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		var u models.User
		db.First(&u, c.GetUint("userID"))
		if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(req.Old)); err != nil {
			c.JSON(401, gin.H{"message": "Password lama salah"})
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(req.New), 12)
		db.Model(&u).Update("password", string(hash))
		c.JSON(200, gin.H{"message": "Password diubah"})
	}
}

// Record deployment on publish
func recordDeployment(db *gorm.DB, p models.Project) *models.Deployment {
	d := &models.Deployment{
		ProjectID: p.ID, UserID: p.UserID, Status: "building",
		URL: "/pub/" + p.Slug, Files: p.Files,
	}
	db.Create(d)
	// Simulasi build pipeline: validasi file lalu tandai ready
	var files map[string]string
	json.Unmarshal([]byte(p.Files), &files)
	d.Status = "ready"
	if len(files) == 0 {
		d.Status = "failed"
	}
	db.Save(d)
	return d
}

// Rollback ke deployment tertentu
func rollbackDeployment(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var d models.Deployment
		if err := db.Where("id = ? AND user_id = ?", c.Param("id"), uid).First(&d).Error; err != nil {
			c.JSON(404, gin.H{"message": "Deployment tidak ada"})
			return
		}
		var p models.Project
		if err := db.Where("id = ?", d.ProjectID).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Proyek tidak ada"})
			return
		}
		p.Files = d.Files
		db.Save(&p)
		db.Create(&models.ProjectVersion{ProjectID: p.ID, Label: "Rollback", Files: p.Files})
		c.JSON(200, gin.H{"message": "Rollback ke deployment #" + fmt.Sprint(d.ID)})
	}
}

// ── AI Config (admin) ──

func isAdmin(db *gorm.DB, uid uint) bool {
	var u models.User
	db.Select("is_admin").First(&u, uid)
	return u.IsAdmin
}

func getAIConfig(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdmin(db, c.GetUint("userID")) {
			c.JSON(403, gin.H{"message": "Khusus admin"})
			return
		}
		var cfg models.AIConfig
		db.First(&cfg, 1)
		c.JSON(200, gin.H{
			"baseUrl": cfg.BaseURL, "model": cfg.Model,
			"hasKey": cfg.APIKey != "",
		})
	}
}

func listAIModels(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdmin(db, c.GetUint("userID")) {
			c.JSON(403, gin.H{"message": "Khusus admin"})
			return
		}
		base := c.Query("baseUrl")
		if base == "" {
			var cfg models.AIConfig
			db.First(&cfg, 1)
			base = cfg.BaseURL
		}
		if base == "" {
			base = strings.TrimRight(os.Getenv("AI_BASE_URL"), "/")
		}
		if base == "" {
			c.JSON(400, gin.H{"message": "Base URL belum diatur"})
			return
		}
		// Key: dari DB kalau ada, kalau tidak coba env (token gateway).
		key := ""
		var cfg models.AIConfig
		db.First(&cfg, 1)
		if cfg.APIKey != "" {
			if dec, err := keyEnc.Decrypt(cfg.APIKey); err == nil {
				key = dec
			} else {
				key = cfg.APIKey
			}
		}
		if key == "" {
			key = os.Getenv("AI_API_KEY")
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()
		ids, err := fetchModelsFromProvider(ctx, base, key)
		if err != nil {
			c.JSON(502, gin.H{"message": err.Error()})
			return
		}
		c.JSON(200, gin.H{"models": ids, "count": len(ids)})
	}
}

func testAIConfig(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdmin(db, c.GetUint("userID")) {
			c.JSON(403, gin.H{"message": "Khusus admin"})
			return
		}
		var req struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
			Model   string `json:"model"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.BaseURL == "" || req.Model == "" {
			c.JSON(400, gin.H{"message": "Base URL dan model wajib diisi"})
			return
		}
		if req.APIKey == "" {
			var cfg models.AIConfig
			db.First(&cfg, 1)
			if cfg.APIKey != "" {
				if dec, err := keyEnc.Decrypt(cfg.APIKey); err == nil {
					req.APIKey = dec
				} else {
					req.APIKey = cfg.APIKey
				}
			}
		}
		if req.APIKey == "" {
			c.JSON(400, gin.H{"message": "Masukkan API key dulu"})
			return
		}
		p := &AIProvider{BaseURL: strings.TrimRight(req.BaseURL, "/"), APIKey: req.APIKey, Model: req.Model}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 40*time.Second)
		defer cancel()
		// Alasan ASLI provider ditampilkan — tanpa ini admin hanya melihat
		// "layanan sibuk" dan tidak tahu modelnya tidak tersedia/kuota habis.
		reply, err := probeChatCompletion(ctx, p.BaseURL, p.APIKey, p.Model)
		if err != nil {
			c.JSON(502, gin.H{"message": err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Koneksi berhasil", "reply": reply, "model": p.Model})
	}
}

func setAIConfig(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdmin(db, c.GetUint("userID")) {
			c.JSON(403, gin.H{"message": "Khusus admin"})
			return
		}
		var req struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
			Model   string `json:"model"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Konfigurasi AI tidak valid"})
			return
		}
		if req.BaseURL == "" || req.Model == "" {
			c.JSON(400, gin.H{"message": "Base URL dan model wajib diisi"})
			return
		}
		var cfg models.AIConfig
		db.FirstOrCreate(&cfg, models.AIConfig{ID: 1})
		updates := map[string]interface{}{"base_url": req.BaseURL, "model": req.Model}
		if req.APIKey != "" {
			enc, err := keyEnc.Encrypt(req.APIKey)
			if err != nil {
				c.JSON(500, gin.H{"message": "Gagal enkripsi key"})
				return
			}
			updates["api_key"] = enc
		}
		db.Model(&cfg).Updates(updates)
		c.JSON(200, gin.H{"message": "Tersimpan (key terenkripsi AES-256)"})
	}
}

// Get effective AI provider (DB config > env)
func getEffectiveAIProvider(db *gorm.DB) *AIProvider {
	var cfg models.AIConfig
	db.First(&cfg, 1)
	if cfg.BaseURL != "" && cfg.APIKey != "" {
		key := cfg.APIKey
		if dec, err := keyEnc.Decrypt(key); err == nil {
			key = dec
		} else {
			// legacy plaintext key: migrate to encrypted on the fly
			if enc, eerr := keyEnc.Encrypt(key); eerr == nil {
				db.Model(&cfg).Update("api_key", enc)
			}
		}
		return &AIProvider{BaseURL: strings.TrimRight(cfg.BaseURL, "/"), APIKey: key, Model: cfg.Model}
	}
	return getAIProvider()
}

// ── Public published project ──

// Bundle sederhana: gabung semua file JS/JSX, resolve import lokal.
// Hapus import dari file lokal, ubah export default menjadi assignment.
func bundleFiles(files map[string]string) string {
	// Kumpulkan komponen: nama file -> kode bersih
	cleaned := map[string]string{}
	order := []string{}
	for path, code := range files {
		lower := strings.ToLower(path)
		if !(strings.HasSuffix(lower, ".js") || strings.HasSuffix(lower, ".jsx") ||
			strings.HasSuffix(lower, ".ts") || strings.HasSuffix(lower, ".tsx")) {
			continue
		}
		lines := strings.Split(code, "\n")
		var out []string
		for _, ln := range lines {
			t := strings.TrimSpace(ln)
			// skip import dari file lokal (./ atau ../)
			if strings.HasPrefix(t, "import ") && (strings.Contains(t, "'./") || strings.Contains(t, "\"./") ||
				strings.Contains(t, "'../") || strings.Contains(t, "\"../")) {
				continue
			}
			// export default X -> const __default_X = X (nanti di-assign)
			if strings.HasPrefix(t, "export default ") {
				out = append(out, strings.Replace(t, "export default ", "const __EXPORT_DEFAULT__ = ", 1))
				continue
			}
			if strings.HasPrefix(t, "export ") {
				out = append(out, strings.Replace(t, "export ", "", 1))
				continue
			}
			out = append(out, ln)
		}
		cleaned[path] = strings.Join(out, "\n")
		order = append(order, path)
	}
	// Entry: App.* dulu, lalu yang lain
	entry := ""
	for _, p := range order {
		if strings.Contains(p, "App.") {
			entry = p
			break
		}
	}
	if entry == "" && len(order) > 0 {
		entry = order[0]
	}
	var sb strings.Builder
	for _, p := range order {
		if p == entry {
			continue
		}
		sb.WriteString("\n// --- " + p + " ---\n")
		sb.WriteString(cleaned[p])
		sb.WriteString("\n")
	}
	if entry != "" {
		sb.WriteString("\n// --- " + entry + " (entry) ---\n")
		sb.WriteString(cleaned[entry])
		sb.WriteString("\n")
	}
	// Mount: cari komponen App atau __EXPORT_DEFAULT__
	sb.WriteString(`
;(function(){
  var AppComp = (typeof App !== "undefined") ? App : (typeof __EXPORT_DEFAULT__ !== "undefined" ? __EXPORT_DEFAULT__ : null);
  if (AppComp && document.getElementById("root")) {
    var root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(React.createElement(AppComp));
  }
})();`)
	return sb.String()
}

func ServePublished(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p models.Project
		if err := db.Where("slug = ? AND published = ?", c.Param("slug"), true).First(&p).Error; err != nil {
			c.String(404, "Tidak ditemukan")
			return
		}
		if p.SitePassword != "" {
			pw := c.Query("pw")
			if pw == "" {
				pw = c.PostForm("pw")
			}
			if bcrypt.CompareHashAndPassword([]byte(p.SitePassword), []byte(pw)) != nil {
				c.String(401, "Situs diproteksi")
				return
			}
		}
		dist := filepath.Join(projectRuntimeRoot(p.ID), "dist")
		indexPath := filepath.Join(dist, "index.html")
		raw, err := os.ReadFile(indexPath)
		if err != nil {
			c.String(409, "Artifact production belum tersedia. Jalankan build project terlebih dahulu.")
			return
		}
		assetPrefix := "/pub-assets/" + p.Slug + "/"
		html := strings.ReplaceAll(string(raw), `src="/assets/`, `src="`+assetPrefix)
		html = strings.ReplaceAll(html, `href="/assets/`, `href="`+assetPrefix)
		// SDK cloud berada di root dist (bukan /assets). Tanpa penulisan ulang ini
		// halaman publish meminta /wb-cloud.js ke host dan menerima 404, sehingga
		// window.cloudDb/cloudAuth tidak ada dan aplikasi crash.
		html = strings.ReplaceAll(html, `src="/wb-cloud.js"`, `src="`+assetPrefix+`wb-cloud.js"`)
		if !strings.Contains(html, "wb-cloud.js") {
			html = strings.Replace(html, "<head>", "<head>\n  <script src=\""+assetPrefix+"wb-cloud.js\"></script>", 1)
		}
		trackVisit(db, p.ID)
		c.Data(200, "text/html; charset=utf-8", []byte(html))
	}
}

func ServePublishedAsset(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p models.Project
		if err := db.Where("slug = ? AND published = ?", c.Param("slug"), true).First(&p).Error; err != nil {
			c.Status(404)
			return
		}
		asset := filepath.Clean(strings.TrimPrefix(c.Param("filepath"), "/"))
		if asset == "." || filepath.IsAbs(asset) || strings.HasPrefix(asset, ".."+string(os.PathSeparator)) {
			c.Status(404)
			return
		}
		root := filepath.Join(projectRuntimeRoot(p.ID), "dist")
		// Aset build ada di dist/assets/*, sedangkan SDK (wb-cloud.js) dan file
		// statis lain ada di root dist. Cari keduanya, tetap di dalam dist.
		candidates := []string{filepath.Join(root, "assets", asset), filepath.Join(root, asset)}
		for _, path := range candidates {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil || strings.HasPrefix(rel, "..") {
				continue
			}
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				c.File(path)
				return
			}
		}
		c.Status(404)
	}
}

func ServeShared(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p models.Project
		if err := db.Where("share_token = ?", c.Param("token")).First(&p).Error; err != nil {
			c.String(404, "Link tidak valid")
			return
		}
		dist := filepath.Join(projectRuntimeRoot(p.ID), "dist")
		indexPath := filepath.Join(dist, "index.html")
		if raw, err := os.ReadFile(indexPath); err == nil {
			assetPrefix := "/share-assets/" + c.Param("token") + "/"
			html := strings.ReplaceAll(string(raw), `src="/assets/`, `src="`+assetPrefix)
			html = strings.ReplaceAll(html, `href="/assets/`, `href="`+assetPrefix)
			c.Data(200, "text/html; charset=utf-8", []byte(html))
			return
		}
		c.String(http.StatusConflict, "Artifact production belum tersedia. Jalankan build project terlebih dahulu.")
	}
}

func ServeSharedAsset(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p models.Project
		if err := db.Where("share_token = ?", c.Param("token")).First(&p).Error; err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		asset := strings.TrimPrefix(c.Param("filepath"), "/")
		asset = strings.TrimPrefix(asset, "assets/")
		asset = filepath.Clean(asset)
		if asset == "." || strings.HasPrefix(asset, ".."+string(os.PathSeparator)) || filepath.IsAbs(asset) {
			c.Status(http.StatusNotFound)
			return
		}
		path := filepath.Join(projectRuntimeRoot(p.ID), "dist", "assets", asset)
		if _, err := os.Stat(path); err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		c.File(path)
	}
}

func serveLegacyShared(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var p models.Project
		if err := db.Where("share_token = ?", c.Param("token")).First(&p).Error; err != nil {
			c.String(404, "Link tidak valid")
			return
		}
		var files map[string]string
		json.Unmarshal([]byte(p.Files), &files)
		if len(files) == 0 {
			c.String(404, "Belum ada file")
			return
		}
		code := strings.ReplaceAll(bundleFiles(files), "</script>", "<\\/script>")
		html := `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>` + p.Name + ` (Preview)</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>body{font-family:system-ui;margin:0}</style></head>
<body><div id="root"></div>
<script type="text/babel" data-presets="react,typescript">` + code + `</script>
</body></html>`
		c.Data(200, "text/html", []byte(html))
	}
}

// ── Prompt enhancer ──

func enhancePrompt(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Prompt string `json:"prompt" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Prompt wajib"})
			return
		}
		provider := getEffectiveAIProvider(db)
		if !provider.configured() {
			c.JSON(500, gin.H{"message": "AI belum dikonfigurasi"})
			return
		}
		sys := `Kamu adalah prompt enhancer. User memberi prompt pendek untuk membuat website.
Buatkan spesifikasi lengkap: nama proyek, daftar fitur (dengan detail), halaman yang dibutuhkan, dan catatan teknis.
Format output sebagai teks terstruktur dalam Bahasa Indonesia. Jangan tulis kode.`
		var out strings.Builder
		err := provider.streamChat(sys, req.Prompt, func(chunk string) {
			out.WriteString(chunk)
		})
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal: " + err.Error()})
			return
		}
		recordAIUsage(db, c.GetUint("userID"), provider.Model, sys+req.Prompt, out.String())
		c.JSON(200, gin.H{"enhanced": out.String()})
	}
}

// ── File upload (AI context) ──

func uploadFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		f, err := c.FormFile("file")
		if err != nil {
			c.JSON(400, gin.H{"message": "File wajib"})
			return
		}
		if f.Size > 5*1024*1024 {
			c.JSON(400, gin.H{"message": "Maksimal 5MB"})
			return
		}
		src, _ := f.Open()
		defer src.Close()
		// Deteksi gambar: kirim sebagai base64 untuk vision
		ct := f.Header.Get("Content-Type")
		isImage := strings.HasPrefix(ct, "image/")
		if !isImage {
			lower := strings.ToLower(f.Filename)
			isImage = strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".jpg") ||
				strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".webp")
		}
		if isImage {
			data, _ := io.ReadAll(io.LimitReader(src, 5*1024*1024))
			b64 := base64.StdEncoding.EncodeToString(data)
			mime := ct
			if mime == "" || !strings.HasPrefix(mime, "image/") {
				mime = "image/png"
			}
			c.JSON(200, gin.H{
				"filename": f.Filename,
				"size":     f.Size,
				"isImage":  true,
				"dataUrl":  "data:" + mime + ";base64," + b64,
				"preview":  "[Gambar: " + f.Filename + "]",
				"full":     "",
			})
			return
		}
		buf := new(strings.Builder)
		// Read as text (limit 50KB for AI context)
		limited := make([]byte, 50*1024)
		n, _ := src.Read(limited)
		text := string(limited[:n])
		// Basic check: if binary, reject as context
		for _, b := range []byte(text[:min(n, 1000)]) {
			if b == 0 {
				c.JSON(400, gin.H{"message": "File binary tidak didukung sebagai konteks"})
				return
			}
		}
		buf.WriteString(text)
		c.JSON(200, gin.H{
			"filename": f.Filename,
			"size":     f.Size,
			"preview":  buf.String()[:min(buf.Len(), 2000)],
			"full":     buf.String(),
		})
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
