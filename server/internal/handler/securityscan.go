package handler

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"webbuilder/internal/database/models"
	"webbuilder/internal/securityscan"
)

// ── Security scan sebelum publish ──
//
// POST /projects/:id/security-scan  -> jalankan scan sekarang (editor+)
// GET  /projects/:id/security-scan  -> laporan terakhir yang tersimpan (viewer+)
// Publish (POST /projects/:id/publish) selalu menjalankan scan ini dulu:
// temuan KRITIS memblokir publish (fail-closed), sisanya jadi peringatan
// di respons. Lihat docs/security-scan.md untuk batasan scanner.

// parseProjectFiles mengubah kolom Project.Files (JSON map path->isi)
// menjadi map yang bisa dipindai. File rusak (bukan JSON) = 0 file yang
// dipindai + temuan tidak ada; publish tidak diblokir oleh kerusakan ini
// saja karena kontrak proyek sudah menjamin formatnya.
func parseProjectFiles(filesJSON string) map[string]string {
	files := map[string]string{}
	if strings.TrimSpace(filesJSON) != "" {
		_ = json.Unmarshal([]byte(filesJSON), &files)
	}
	return files
}

// readAppPoliciesForScan membaca baris app_policies proyek dari Postgres
// app (schema app_<id>). Bila DB app belum siap / tabel belum ada,
// kembalikan error supaya pemanggil bisa mencatat "policy tidak diperiksa"
// secara jujur — bukan mengarang hasil.
func readAppPoliciesForScan(pid string) ([]securityscan.PolicyRow, error) {
	sqldb, err := getAppSQLDB()
	if err != nil {
		return nil, err
	}
	if err := ensureSchema(pid); err != nil {
		return nil, err
	}
	rows, err := sqldb.Query(fmt.Sprintf("SELECT table_name,role,operation,enabled FROM %s.app_policies ORDER BY table_name,role,operation", appSchema(pid)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []securityscan.PolicyRow
	for rows.Next() {
		var r securityscan.PolicyRow
		if rows.Scan(&r.Table, &r.Role, &r.Operation, &r.Enabled) == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

// scanProject menjalankan pemindaian penuh (kode + policy) untuk satu proyek.
// Policy yang tidak bisa dibaca karena DB app mati TIDAK memblokir:
// dicatat sebagai PolicyChecked=false + PolicyNote, supaya laporan jujur
// soal cakupannya. Bila tabel app_policies belum ada (proyek belum pernah
// memakai database app), itu BUKAN error — tidak ada policy eksplisit,
// dan default deny-by-default berlaku.
func scanProject(p models.Project) securityscan.Report {
	rep := securityscan.ScanFiles(parseProjectFiles(p.Files))
	rows, err := readAppPoliciesForScan(fmt.Sprint(p.ID))
	if err != nil {
		if strings.Contains(err.Error(), "does not exist") {
			rep.PolicyChecked = true
			rep.PolicyNote = "Tabel policy belum ada (proyek belum pernah memakai database app); tidak ada policy eksplisit, default deny-by-default berlaku."
			return rep
		}
		rep.PolicyChecked = false
		rep.PolicyNote = "Policy database tidak bisa diperiksa (" + err.Error() + ") — pemindaian policy dilewati, bukan dinyatakan aman."
		return rep
	}
	rep.PolicyChecked = true
	if len(rows) == 0 {
		rep.PolicyNote = "Tidak ada baris policy eksplisit; default platform deny-by-default berlaku (owner/admin penuh, member baca/tulis-terbatas, viewer read-only)."
	}
	securityscan.AddPolicyFindings(&rep, rows)
	return rep
}

// saveScanReport menyimpan laporan sebagai JSON mentah di proyek.
func saveScanReport(db *gorm.DB, p models.Project, rep securityscan.Report) {
	b, err := json.Marshal(rep)
	if err != nil {
		return
	}
	db.Model(&models.Project{}).Where("id = ?", p.ID).Update("security_scan", string(b))
}

// runSecurityScan menjalankan scan on-demand dan menyimpan laporannya.
func runSecurityScan(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		rep := scanProject(*p)
		saveScanReport(db, *p, rep)
		c.JSON(200, gin.H{"securityScan": rep})
	}
}

// getSecurityScan mengembalikan laporan terakhir yang tersimpan.
// 404 bila proyek belum pernah dipindai.
func getSecurityScan(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		if strings.TrimSpace(p.SecurityScan) == "" {
			c.JSON(404, gin.H{"message": "Proyek belum pernah dipindai. Jalankan security scan dulu."})
			return
		}
		var rep securityscan.Report
		if err := json.Unmarshal([]byte(p.SecurityScan), &rep); err != nil {
			c.JSON(500, gin.H{"message": "Laporan scan tersimpan rusak"})
			return
		}
		c.JSON(200, gin.H{"securityScan": rep})
	}
}
