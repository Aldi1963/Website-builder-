package queue

import (
	"context"
	"testing"
	"time"
)

func TestInProcessDeliversJob(t *testing.T) {
	q := NewInProcess(1)
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan string, 1)
	go q.Run(ctx, func(_ context.Context, job Job) error { got <- job.ID; return nil })
	if err := q.Enqueue(ctx, Job{ID: "run-1", Kind: "agent"}); err != nil { t.Fatal(err) }
	select {
	case id := <-got:
		if id != "run-1" { t.Fatalf("got %q", id) }
	case <-time.After(time.Second):
		t.Fatal("job was not delivered")
	}
}
