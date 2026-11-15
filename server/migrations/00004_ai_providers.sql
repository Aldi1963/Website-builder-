-- +goose Up
-- 00004: provider AI per prompt (trek 1/4 adopsi).
-- Tabel ai_provider_configs menyimpan provider yang dikelola admin
-- (nama, base URL OpenAI-compatible, API key terenkripsi, daftar model
-- sebagai JSON array, flag default/aktif). Kolom provider/model di
-- agent_runs dan chat_messages mencatat pilihan per run/pesan supaya
-- riwayat konsisten walau default berubah sesudahnya. DEFAULT '' supaya
-- baris lama terbaca sebagai string kosong, sama seperti hasil GORM
-- AutoMigrate di jalur SQLite.
CREATE TABLE ai_provider_configs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  api_key VARCHAR(500) NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE agent_runs ADD COLUMN provider VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN model VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE chat_messages ADD COLUMN provider VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE chat_messages ADD COLUMN model VARCHAR(100) NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE chat_messages DROP COLUMN model;
ALTER TABLE chat_messages DROP COLUMN provider;
ALTER TABLE agent_runs DROP COLUMN model;
ALTER TABLE agent_runs DROP COLUMN provider;
DROP TABLE ai_provider_configs;
