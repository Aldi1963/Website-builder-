package browser

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// memory.go — pengukuran memori Chrome per run (rencana §6 Fase 3 item 3).
//
// Proses Chrome adalah anak dari subproses server MCP (Client.cmd):
// chrome-devtools-mcp men-start Chrome headless sebagai anaknya, dan
// Chrome sendiri menelurkan banyak anak (renderer, GPU, network, ...).
// Yang diukur di sini adalah RSS TOTAL pohon proses yang berakar di PID
// server MCP (node + Chrome + semua anaknya) — itulah biaya memori
// satu run browser apa adanya.
//
// Ambang rencana: bila RSS pohon satu run >512 MiB, dokumentasikan
// batas worker bersamaan. Queue workers default 2 → maks 2 Chrome
// bersamaan → kebutuhan puncak ~1 GiB hanya untuk Chrome (di luar
// server + build). Karena itu JANGAN membunuh Chrome di tengah run
// karena memori — hanya ukur + catat (Close mencatat ke slog;
// handler bisa membaca LastChromeMemoryBytes untuk agent_tool_calls).
//
// Aturan keras: pengukuran TIDAK PERNAH menggagalkan run. Bila /proc
// tidak ada, PID sudah mati, atau RSS tidak terbaca, hasilnya -1
// ("tidak tersedia") dan run lanjut seperti biasa.

// ChromeMemoryHighBytes adalah ambang rencana Fase 3: RSS pohon
// Chrome satu run di atas nilai ini dicatat sebagai "melebihi_512mib"
// di log Close() dan menjadi masukan batas worker bersamaan.
const ChromeMemoryHighBytes = 512 * 1024 * 1024

// ChromeMemoryBytes mengukur RSS total pohon proses browser saat ini
// (byte). Mengembalikan -1 bila pengukuran tidak tersedia (Client
// belum start / proses sudah mati / /proc tidak ada) — BUKAN error
// fatal. Hasil terakhir yang berhasil disimpan dan bisa dibaca lewat
// LastChromeMemoryBytes, termasuk sesudah Close().
func (c *Client) ChromeMemoryBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.chromeMemoryBytesLocked()
}

// chromeMemoryBytesLocked sama seperti ChromeMemoryBytes, tetapi
// mengasumsikan c.mu sudah dipegang (dipakai Close()).
func (c *Client) chromeMemoryBytesLocked() int64 {
	if c.cmd == nil || c.cmd.Process == nil {
		return -1
	}
	n, err := processTreeRSS(c.cmd.Process.Pid)
	if err != nil {
		slog.Info("browser: pengukuran memori Chrome tidak tersedia", "pid", c.cmd.Process.Pid, "error", err)
		return -1
	}
	c.lastChromeMemoryBytes = n
	return n
}

// LastChromeMemoryBytes mengembalikan RSS pohon proses browser dari
// pengukuran terakhir (byte), atau -1 bila belum pernah terukur /
// tidak tersedia. Dipakai handler untuk mencatat memori run ke
// agent_tool_calls sesudah Close().
func (c *Client) LastChromeMemoryBytes() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastChromeMemoryBytes
}

// processTreeRSS menjumlahkan RSS (byte) seluruh proses di pohon yang
// berakar di rootPID, termasuk root itu sendiri, dengan berjalan di
// /proc. Proses yang mati di tengah pembacaan dilewati diam-diam;
// error hanya bila /proc tidak bisa dibaca sama sekali atau rootPID
// tidak ditemukan (sudah mati sebelum diukur).
func processTreeRSS(rootPID int) (int64, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return -1, fmt.Errorf("browser: /proc tidak bisa dibaca: %w", err)
	}
	type procInfo struct {
		ppid int
		rss  int64
	}
	infos := make(map[int]procInfo)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue // bukan direktori PID
		}
		ppid, rss, err := readProcStatus(pid)
		if err != nil {
			continue // proses mati di tengah jalan: lewati
		}
		infos[pid] = procInfo{ppid: ppid, rss: rss}
	}
	if _, ok := infos[rootPID]; !ok {
		return -1, fmt.Errorf("browser: PID %d tidak ada di /proc (proses sudah mati?)", rootPID)
	}
	children := make(map[int][]int)
	for pid, info := range infos {
		children[info.ppid] = append(children[info.ppid], pid)
	}
	var total int64
	seen := make(map[int]bool)
	queue := []int{rootPID}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		total += infos[pid].rss
		queue = append(queue, children[pid]...)
	}
	return total, nil
}

// readProcStatus membaca PPid + VmRSS dari /proc/<pid>/status.
// VmRSS yang tidak ada (mis. kernel thread) dihitung 0.
func readProcStatus(pid int) (ppid int, rssBytes int64, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PPid:") {
			ppid, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
		}
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(strings.TrimPrefix(line, "VmRSS:"))
			if len(fields) > 0 {
				if kb, perr := strconv.ParseInt(fields[0], 10, 64); perr == nil {
					rssBytes = kb * 1024
				}
			}
		}
	}
	return ppid, rssBytes, nil
}
