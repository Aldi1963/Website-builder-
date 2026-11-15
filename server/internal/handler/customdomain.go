package handler

import (
	"context"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── Custom domain ──

var siteHostCache = struct {
	sync.Mutex
	val string
	exp time.Time
}{}

func resolveSiteHost(db *gorm.DB) string {
	raw := strings.TrimSpace(getSetting(db, "site_url"))
	if raw != "" {
		if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname())
		}
		if h, _, err := net.SplitHostPort(raw); err == nil && h != "" {
			return strings.ToLower(h)
		}
	}
	return "build.clipku.my.id"
}

// siteHost: hostname aplikasi dari setting site_url (cache 60 detik)
func siteHost(db *gorm.DB) string {
	siteHostCache.Lock()
	defer siteHostCache.Unlock()
	if time.Now().Before(siteHostCache.exp) && siteHostCache.val != "" {
		return siteHostCache.val
	}
	siteHostCache.val = resolveSiteHost(db)
	siteHostCache.exp = time.Now().Add(60 * time.Second)
	return siteHostCache.val
}

func isAppHost(db *gorm.DB, host string) bool {
	host = strings.ToLower(host)
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	if net.ParseIP(host) != nil {
		return true
	}
	return host == siteHost(db)
}

// customDomainMiddleware: jika Host request cocok Domain terverifikasi,
// sajikan deployment publish terbaru persis seperti /pub/:slug
func customDomainMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		host := strings.ToLower(c.Request.Host)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if isAppHost(db, host) {
			c.Next()
			return
		}
		var d models.Domain
		if err := db.Where("domain = ? AND verified = ?", host, true).First(&d).Error; err != nil {
			c.Next()
			return
		}
		var p models.Project
		if err := db.Where("id = ? AND published = ?", d.ProjectID, true).First(&p).Error; err != nil {
			c.String(404, "Situs tidak tersedia")
			c.Abort()
			return
		}
		// Pakai fungsi yang sama dengan /pub/:slug
		c.Params = gin.Params{gin.Param{Key: "slug", Value: p.Slug}}
		ServePublished(db)(c)
		c.Abort()
	}
}

func domainOwner(db *gorm.DB, c *gin.Context, d *models.Domain) bool {
	uid := c.GetUint("userID")
	return d.UserID == uid || isAdmin(db, uid)
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// POST /api/domains/:id/verify — cek CNAME domain ke host aplikasi
func verifyDomain(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var d models.Domain
		if err := db.First(&d, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Domain tidak ditemukan"})
			return
		}
		if !domainOwner(db, c, &d) {
			c.JSON(403, gin.H{"message": "Bukan domain kamu"})
			return
		}
		target := siteHost(db)
		verified := false
		detail := ""
		cname, err := net.LookupCNAME(d.Domain)
		if err != nil {
			detail = "DNS belum mengarah ke " + target + " (" + shortErr(err) + ")"
		} else {
			got := strings.TrimSuffix(strings.ToLower(cname), ".")
			if got == target {
				verified = true
				detail = "CNAME " + d.Domain + " → " + got + " terverifikasi"
			} else {
				detail = "CNAME mengarah ke " + got + ", harus ke " + target
			}
		}
		db.Model(&d).Update("verified", verified)
		c.JSON(200, gin.H{"verified": verified, "detail": detail})
	}
}

// GET /api/domains/:id/dns — panduan DNS untuk user
func domainDNSGuide(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var d models.Domain
		if err := db.First(&d, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Domain tidak ditemukan"})
			return
		}
		if !domainOwner(db, c, &d) {
			c.JSON(403, gin.H{"message": "Bukan domain kamu"})
			return
		}
		target := siteHost(db)
		c.JSON(200, gin.H{
			"domain":       d.Domain,
			"cname_target": target,
			"txt":          "tambahkan CNAME " + d.Domain + " → " + target + " di DNS kamu",
		})
	}
}

// POST /api/domains/:id/ssl — best-effort terbitkan SSL via certbot di VPS (SSH)
func requestDomainSSL(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var d models.Domain
		if err := db.First(&d, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Domain tidak ditemukan"})
			return
		}
		if !domainOwner(db, c, &d) {
			c.JSON(403, gin.H{"message": "Bukan domain kamu"})
			return
		}
		vhost, vuser, vkey := os.Getenv("VPS_SSH_HOST"), os.Getenv("VPS_SSH_USER"), os.Getenv("VPS_SSH_KEY")
		if vhost == "" || vuser == "" || vkey == "" {
			c.JSON(200, gin.H{"ok": false, "message": "SSL otomatis belum dikonfigurasi di server. Hubungi admin."})
			return
		}
		keyFile := vkey
		if _, err := os.Stat(vkey); err != nil {
			// Anggap isi key langsung, tulis ke file sementara
			f, err := os.CreateTemp("", "vpskey-*")
			if err != nil {
				c.JSON(500, gin.H{"ok": false, "message": "Gagal siapkan key SSH"})
				return
			}
			f.WriteString(vkey)
			f.Close()
			os.Chmod(f.Name(), 0600)
			defer os.Remove(f.Name())
			keyFile = f.Name()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "ssh",
			"-i", keyFile,
			"-o", "StrictHostKeyChecking=no",
			"-o", "ConnectTimeout=10",
			"-o", "BatchMode=yes",
			vuser+"@"+vhost,
			"sudo", "certbot", "--nginx",
			"-d", d.Domain,
			"--non-interactive", "--agree-tos", "--register-unsafely-without-email",
		)
		out, err := cmd.CombinedOutput()
		if ctx.Err() == context.DeadlineExceeded {
			c.JSON(200, gin.H{"ok": false, "message": "Timeout saat penerbitan SSL (60 detik)"})
			return
		}
		if err != nil {
			c.JSON(200, gin.H{"ok": false, "message": "Gagal terbitkan SSL", "detail": shortErrStr(string(out))})
			return
		}
		audit(db, c.GetUint("userID"), "domain.ssl", d.Domain, c.ClientIP())
		c.JSON(200, gin.H{"ok": true, "message": "SSL diterbitkan untuk " + d.Domain})
	}
}

func shortErrStr(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[:200]
	}
	if s == "" {
		return "tidak ada detail"
	}
	return s
}
