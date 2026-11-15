package observability

import (
	"context"
	"io"
	"log/slog"
	"os"
	"sync"
)

// logger.go — structured logging dengan log/slog (stdlib, JSON handler).
//
// Konvensi: semua log aplikasi memakai logger dari paket ini, bukan
// log.Printf biasa, supaya setiap baris log adalah satu objek JSON dengan
// field yang konsisten (time, level, msg, request_id, ...). request_id
// disuntikkan middleware (lihat middleware.go) dan merambat lewat
// context.Context, jadi handler cukup memanggil FromContext(ctx).

// Logger adalah alias untuk *slog.Logger supaya call site tidak perlu
// mengimpor log/slog hanya untuk menyebut tipe logger.
type Logger = *slog.Logger

type ctxKey struct{}

var (
	defaultMu     sync.RWMutex
	defaultLogger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
)

// NewLogger membuat logger JSON yang menulis ke w.
func NewLogger(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level}))
}

// Default mengembalikan logger global paket ini.
func Default() *slog.Logger {
	defaultMu.RLock()
	defer defaultMu.RUnlock()
	return defaultLogger
}

// SetDefault mengganti logger global (dipakai main.go saat wiring; di test
// untuk mengarahkan log ke buffer).
func SetDefault(l *slog.Logger) {
	if l == nil {
		return
	}
	defaultMu.Lock()
	defer defaultMu.Unlock()
	defaultLogger = l
}

// WithLogger menyimpan logger di context.
func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}

// FromContext mengembalikan logger dari context, atau logger global bila
// context tidak membawa logger.
func FromContext(ctx context.Context) *slog.Logger {
	if ctx != nil {
		if l, ok := ctx.Value(ctxKey{}).(*slog.Logger); ok && l != nil {
			return l
		}
	}
	return Default()
}

// WithRequestID mengembalikan context yang log-nya membawa request_id.
// Dipakai middleware logging supaya request_id yang sudah dibuat
// RequestContext() (handler/requestid.go) merambat ke semua log dalam
// request tersebut.
func WithRequestID(ctx context.Context, requestID string) context.Context {
	return WithLogger(ctx, FromContext(ctx).With("request_id", requestID))
}
