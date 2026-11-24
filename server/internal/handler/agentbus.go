// Event bus SSE untuk agent run.
//
// Masalah yang dipecahkan: pipeline agent sekarang dieksekusi oleh consumer
// queue di goroutine latar (bukan di dalam request HTTP POST /chat), tetapi
// kontrak SSE ke frontend tidak boleh berubah — POST yang sama, event yang
// sama, urutan yang sama. Bus ini menjadi perantaranya:
//
//   - Consumer mem-publish setiap event SSE (message, changes, result, ...)
//     ke topik run ID.
//   - Handler postChat berlangganan topik itu dan me-relay event ke HTTP
//     stream sampai topik ditutup (job selesai) atau client putus.
//
// Setiap event disimpan dulu sebagai teks JSON (sama seperti yang ditulis
// sendAgentSSE) supaya byte yang sampai ke client identik dengan jalur
// inline lama. Satu pengecualian: baris data-only "[ERROR] ..." dari jalur
// error provider (tanpa nama event) dipertahankan lewat field Raw.
//
// Replay: Subscribe memutar ulang log event run itu dulu, jadi event yang
// terbit di antara Enqueue dan Subscribe tidak hilang. Log dibatasi
// agentBusLogCap per run; topik yang sudah ditutup dibersihkan secara lazy
// bila jumlah topik membengkak. Bus ini in-memory: bila proses mati, stream
// HTTP ikut mati — tetapi job dan status run tetap ada di DB dan akan
// dieksekusi/di-retry consumer sesudah restart (lihat agentqueue.go).
package handler

import (
	"encoding/json"
	"sync"
	"time"
)

// agentBusLogCap membatasi berapa event yang disimpan per run untuk replay.
// Pipeline yang sangat panjang tetap aman: chunk message dipotong log ini,
// tetapi subscriber live menerima semuanya lewat channel.
const agentBusLogCap = 1000

// agentBusEvent adalah satu baris SSE yang sudah diserialisasi.
// Type kosong + Raw terisi berarti baris data-only (tanpa "event:").
type agentBusEvent struct {
	Type string
	Data string
	Raw  string
}

// newAgentBusEvent membuat event dari payload yang sama seperti yang
// diterima sendAgentSSE (string mentah atau map/struct).
func newAgentBusEvent(event string, payload any) agentBusEvent {
	b, _ := json.Marshal(payload)
	return agentBusEvent{Type: event, Data: string(b)}
}

type agentBusTopic struct {
	log      []agentBusEvent
	subs     map[chan agentBusEvent]struct{}
	closed   bool
	closedAt time.Time
}

type agentEventBus struct {
	mu     sync.Mutex
	topics map[uint]*agentBusTopic
}

func newAgentEventBus() *agentEventBus {
	return &agentEventBus{topics: map[uint]*agentBusTopic{}}
}

// Publish mengirim event ke semua subscriber topik runID dan menyimpannya
// ke log replay. Publish ke topik yang sudah ditutup diabaikan. Publish
// tidak pernah memblokir consumer: subscriber yang lambat (channel penuh)
// dilewati untuk event live itu — log replay tetap utuh untuk subscriber
// yang datang belakangan.
func (b *agentEventBus) Publish(runID uint, ev agentBusEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.topics[runID]
	if !ok {
		t = &agentBusTopic{subs: map[chan agentBusEvent]struct{}{}}
		b.topics[runID] = t
	}
	if t.closed {
		return
	}
	if len(t.log) < agentBusLogCap {
		t.log = append(t.log, ev)
	}
	for ch := range t.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// Subscribe mengembalikan channel event runID. Log yang sudah ada diputar
// ulang dulu (dalam urutan), lalu event live mengalir. Bila topik sudah
// ditutup, channel langsung ditutup sesudah replay. Fungsi unsubscribe
// menghapus subscriber dari topik.
func (b *agentEventBus) Subscribe(runID uint) (<-chan agentBusEvent, func()) {
	// Buffer menampung seluruh log replay (dibatasi agentBusLogCap) supaya
	// Subscribe tidak blokir; event live sesudahnya mengantre di belakang.
	ch := make(chan agentBusEvent, agentBusLogCap+64)
	b.mu.Lock()
	t, ok := b.topics[runID]
	if !ok {
		t = &agentBusTopic{subs: map[chan agentBusEvent]struct{}{}}
		b.topics[runID] = t
	}
	for _, ev := range t.log {
		ch <- ev
	}
	closed := t.closed
	if !closed {
		t.subs[ch] = struct{}{}
	}
	topicCount := len(b.topics)
	b.mu.Unlock()
	if closed {
		close(ch)
		return ch, func() {}
	}
	// Bersihkan topik lama secara lazy: bila topik sudah banyak, buang yang
	// sudah ditutup lebih dari 10 menit lalu (subscriber baru untuk run lama
	// membaca status dari baris AgentRun di DB, bukan dari bus).
	if topicCount > 512 {
		go b.sweep(10 * time.Minute)
	}
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if t, ok := b.topics[runID]; ok {
			delete(t.subs, ch)
		}
	}
}

// Close menutup topik runID: semua subscriber yang masih menunggu menerima
// penutupan channel (relay SSE mengakhirinya dengan [DONE]). Publish
// sesudah Close diabaikan.
func (b *agentEventBus) Close(runID uint) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.topics[runID]
	if !ok || t.closed {
		return
	}
	t.closed = true
	t.closedAt = time.Now()
	for ch := range t.subs {
		close(ch)
	}
	t.subs = map[chan agentBusEvent]struct{}{}
}

// sweep membuang topik yang sudah ditutup lebih lama dari olderThan.
func (b *agentEventBus) sweep(olderThan time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for id, t := range b.topics {
		if t.closed && now.Sub(t.closedAt) > olderThan {
			delete(b.topics, id)
		}
	}
}
