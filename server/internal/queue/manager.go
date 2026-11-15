package queue

import (
	"context"
	"errors"
	"sync"
	"time"
)

type State string

const (
	StateQueued   State = "queued"
	StateRunning  State = "running"
	StateSuccess  State = "success"
	StateFailed   State = "failed"
	StateCanceled State = "canceled"
)

type Snapshot struct {
	Job       Job
	State     State
	Attempts  int
	Error     string
	CreatedAt time.Time
	StartedAt *time.Time
	FinishedAt *time.Time
}

type Manager struct {
	queue Queue
	mu    sync.RWMutex
	jobs  map[string]Snapshot
	cancel map[string]context.CancelFunc
}

func NewManager(q Queue) *Manager {
	return &Manager{queue: q, jobs: make(map[string]Snapshot), cancel: make(map[string]context.CancelFunc)}
}

func (m *Manager) Enqueue(ctx context.Context, job Job) error {
	if job.ID == "" { return errors.New("job id is required") }
	m.mu.Lock()
	if existing, ok := m.jobs[job.ID]; ok && existing.State != StateFailed && existing.State != StateCanceled {
		m.mu.Unlock()
		return nil
	}
	m.jobs[job.ID] = Snapshot{Job: job, State: StateQueued, CreatedAt: time.Now()}
	m.mu.Unlock()
	if err := m.queue.Enqueue(ctx, job); err != nil {
		m.mu.Lock(); s := m.jobs[job.ID]; s.State = StateFailed; s.Error = err.Error(); m.jobs[job.ID] = s; m.mu.Unlock()
		return err
	}
	return nil
}

func (m *Manager) Run(ctx context.Context, handler Handler) {
	m.queue.Run(ctx, func(parent context.Context, job Job) error {
		jobCtx, cancel := context.WithCancel(parent)
		m.mu.Lock()
		now := time.Now(); s := m.jobs[job.ID]; s.State = StateRunning; s.Attempts++; s.StartedAt = &now; m.jobs[job.ID] = s; m.cancel[job.ID] = cancel
		m.mu.Unlock()
		err := handler(jobCtx, job)
		wasCanceled := jobCtx.Err() != nil
		cancel()
		m.mu.Lock(); defer m.mu.Unlock(); delete(m.cancel, job.ID)
		s = m.jobs[job.ID]; finish := time.Now(); s.FinishedAt = &finish
		if wasCanceled || errors.Is(err, context.Canceled) { s.State = StateCanceled } else if err != nil { s.State = StateFailed; s.Error = err.Error() } else { s.State = StateSuccess }
		m.jobs[job.ID] = s
		return err
	})
}

func (m *Manager) Cancel(id string) bool {
	m.mu.RLock(); cancel, ok := m.cancel[id]; m.mu.RUnlock()
	if ok { cancel(); return true }
	m.mu.Lock(); defer m.mu.Unlock(); s, ok := m.jobs[id]; if !ok { return false }; s.State = StateCanceled; m.jobs[id] = s; return true
}

func (m *Manager) Get(id string) (Snapshot, bool) { m.mu.RLock(); defer m.mu.RUnlock(); s, ok := m.jobs[id]; return s, ok }
