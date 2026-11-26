-- +goose Up
-- 00003: kolom verification di chat_messages — hasil verifikasi browser
-- run itu, disimpan sebagai JSON mentah (objek yang sama persis dengan
-- field `verification` di event SSE `result`: attempted/passed/rounds/
-- consoleErrors/failedRequests/screenshotPath/screenshotUrl) supaya kartu
-- verifikasi bertahan setelah reload. DEFAULT '' supaya baris lama
-- (tanpa verifikasi) terbaca sebagai string kosong, sama seperti hasil
-- GORM AutoMigrate di jalur SQLite.
ALTER TABLE chat_messages ADD COLUMN verification text DEFAULT '';

-- +goose Down
ALTER TABLE chat_messages DROP COLUMN verification;
