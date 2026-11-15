package queue

import (
	"context"
	"testing"
	"time"
)

func TestManagerTracksSuccessAndIsIdempotent(t *testing.T) {
	q := NewInProcess(2)
	defer q.Close()
	m := NewManager(q)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx, func(_ context.Context, _ Job) error { return nil })
	job := Job{ID: "same", Kind: "agent"}
	if err := m.Enqueue(ctx, job); err != nil { t.Fatal(err) }
	if err := m.Enqueue(ctx, job); err != nil { t.Fatal(err) }
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s, ok := m.Get(job.ID)
		if ok && s.State == StateSuccess { if s.Attempts != 1 { t.Fatalf("attempts=%d", s.Attempts) }; return }
		time.Sleep(time.Millisecond * 10)
	}
	t.Fatal("job did not finish")
}

func TestManagerCancel(t *testing.T) {
	q := NewInProcess(1)
	defer q.Close()
	m := NewManager(q)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx, func(ctx context.Context, _ Job) error { <-ctx.Done(); return ctx.Err() })
	if err := m.Enqueue(ctx, Job{ID: "cancel-me"}); err != nil { t.Fatal(err) }
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) { if m.Cancel("cancel-me") { return }; time.Sleep(time.Millisecond * 10) }
	if _, ok := m.Get("missing"); ok { t.Fatal("missing job exists") }
	t.Fatal("job was not cancellable")
}
