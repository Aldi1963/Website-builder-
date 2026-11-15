package queue

import (
	"context"
	"errors"
	"sync"
)

var ErrClosed = errors.New("queue closed")

type Job struct {
	ID      string
	Kind    string
	Payload []byte
}

type Handler func(context.Context, Job) error

// Queue is the stable boundary for agent jobs. The in-process implementation
// keeps the current deployment simple; a Redis/Asynq adapter can implement the
// same interface without changing API handlers or the frontend.
type Queue interface {
	Enqueue(context.Context, Job) error
	Run(context.Context, Handler)
	Close()
}

type InProcess struct {
	jobs   chan Job
	closed chan struct{}
	once   sync.Once
}

func NewInProcess(size int) *InProcess {
	if size < 1 {
		size = 32
	}
	return &InProcess{jobs: make(chan Job, size), closed: make(chan struct{})}
}

func (q *InProcess) Enqueue(ctx context.Context, job Job) error {
	select {
	case <-q.closed:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	case q.jobs <- job:
		return nil
	}
}

func (q *InProcess) Run(ctx context.Context, handler Handler) {
	for {
		select {
		case <-q.closed:
			return
		case <-ctx.Done():
			return
		case job := <-q.jobs:
			if handler != nil {
				_ = handler(ctx, job)
			}
		}
	}
}

func (q *InProcess) Close() { q.once.Do(func() { close(q.closed) }) }
