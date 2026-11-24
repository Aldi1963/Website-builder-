-- +goose Up
-- 00002: tabel queue_jobs untuk adapter queue berbasis DB
-- (server/internal/queue.DBQueue). Satu tabel di DB yang sama, tanpa layanan baru.
-- idempotency_key UNIQUE: enqueue ganda dengan key sama tidak membuat duplikat.
CREATE TABLE queue_jobs (
    id VARCHAR(255) NOT NULL PRIMARY KEY,
    kind VARCHAR(100) NOT NULL,
    payload BYTEA NOT NULL DEFAULT '',
    idempotency_key VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    leased_until TIMESTAMPTZ,
    leased_by VARCHAR(100),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_queue_jobs_idempotency_key ON queue_jobs (idempotency_key);
CREATE INDEX idx_queue_jobs_claim ON queue_jobs (status, run_after);

-- +goose Down
DROP TABLE IF EXISTS queue_jobs CASCADE;
