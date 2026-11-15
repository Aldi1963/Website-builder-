package browser

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

// Pengukuran memori Chrome (Fase 3 item 3): RSS total pohon proses.
// Aturan keras: pengukuran TIDAK PERNAH menggagalkan run — bila tidak
// tersedia hasilnya -1 ("tidak tersedia"), bukan error fatal.

// Proses nyata yang di-spawn test: pohon sleep harus terukur > 0,
// dan sesudah proses mati hasilnya -1.
func TestChromeMemoryBytesLiveProcess(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	c := &Client{cmd: cmd, lastChromeMemoryBytes: -1}
	got := c.ChromeMemoryBytes()
	if got <= 0 {
		t.Fatalf("ChromeMemoryBytes proses hidup = %d, mau > 0", got)
	}
	if last := c.LastChromeMemoryBytes(); last != got {
		t.Fatalf("LastChromeMemoryBytes = %d, mau sama dengan pengukuran %d", last, got)
	}
	// Anak dari sleep ikut terhitung: spawn shell yang menelurkan sleep.
	// (Dilewati bila /bin/sh tidak ada — pengukuran pohon dasar sudah
	// terbukti di atas.)
	sh := exec.Command("/bin/sh", "-c", "sleep 30")
	if err := sh.Start(); err == nil {
		defer func() {
			_ = sh.Process.Kill()
			_, _ = sh.Process.Wait()
		}()
		c2 := &Client{cmd: sh, lastChromeMemoryBytes: -1}
		// Beri waktu anak sleep muncul di /proc.
		deadline := time.Now().Add(2 * time.Second)
		var total int64 = -1
		for time.Now().Before(deadline) {
			if total = c2.ChromeMemoryBytes(); total > 0 {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		if total <= 0 {
			t.Fatalf("ChromeMemoryBytes pohon shell+sleep = %d, mau > 0", total)
		}
	}
}

// Sesudah proses mati, pengukuran "tidak tersedia" (-1), bukan error.
func TestChromeMemoryBytesDeadProcess(t *testing.T) {
	cmd := exec.Command("sleep", "0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	_ = cmd.Wait() // proses sudah mati
	c := &Client{cmd: cmd, lastChromeMemoryBytes: -1}
	if got := c.ChromeMemoryBytes(); got != -1 {
		t.Fatalf("ChromeMemoryBytes proses mati = %d, mau -1", got)
	}
	if last := c.LastChromeMemoryBytes(); last != -1 {
		t.Fatalf("LastChromeMemoryBytes sesudah gagal ukur = %d, mau -1", last)
	}
}

// Client tanpa proses (belum Start): -1.
func TestChromeMemoryBytesNoProcess(t *testing.T) {
	c := NewClient(Config{Command: "tidak-ada"})
	if got := c.ChromeMemoryBytes(); got != -1 {
		t.Fatalf("ChromeMemoryBytes tanpa proses = %d, mau -1", got)
	}
	if got := c.LastChromeMemoryBytes(); got != -1 {
		t.Fatalf("LastChromeMemoryBytes awal = %d, mau -1", got)
	}
}

// processTreeRSS langsung: PID yang tidak ada → error (pemanggil
// mengubahnya jadi -1).
func TestProcessTreeRSSMissingPID(t *testing.T) {
	if _, err := processTreeRSS(999999); err == nil {
		t.Fatal("processTreeRSS PID tidak ada harus error")
	}
}

// Close() mengukur memori SEBELUM sesi ditutup: sesudah Close,
// LastChromeMemoryBytes harus > 0 untuk server MCP palsu yang masih
// hidup saat Close dipanggil — dan Close tetap sukses.
func TestCloseMeasuresChromeMemory(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if got := c.LastChromeMemoryBytes(); got != -1 {
		t.Fatalf("sebelum Close, LastChromeMemoryBytes = %d, mau -1", got)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close gagal: %v", err)
	}
	if got := c.LastChromeMemoryBytes(); got <= 0 {
		t.Fatalf("sesudah Close, LastChromeMemoryBytes = %d, mau > 0 (server MCP palsu hidup saat diukur)", got)
	}
}

// Close() TIDAK PERNAH gagal karena pengukuran memori tidak tersedia:
// klien yang Start-nya gagal (tanpa proses) tetap Close dengan sukses.
func TestCloseWithoutProcessStillSucceeds(t *testing.T) {
	c := NewClient(Config{Command: "tidak-ada"})
	if err := c.Close(); err != nil {
		t.Fatalf("Close tanpa proses harus sukses, dapat: %v", err)
	}
	if got := c.LastChromeMemoryBytes(); got != -1 {
		t.Fatalf("LastChromeMemoryBytes tanpa proses = %d, mau -1", got)
	}
}
