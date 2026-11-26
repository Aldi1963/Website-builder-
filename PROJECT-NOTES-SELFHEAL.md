# WebBuilder — catatan sesi ini

## Self-healing visual (commit 438d682 + a400604)
- `check_preview` mengambil screenshot + error runtime, lalu menyuntik gambar ke model sebagai pesan user multimodal.
- Guard a400604: model tidak boleh mengakhiri run dengan teks sebelum `check_preview` dipanggil bila ada perubahan UI + build sukses + audit selesai.
- Verifikasi E2E project `d2d512ab27`: status `Melihat preview aplikasi…` muncul, ringkasan akhir streaming, screenshot 200, `done: {ok:true}`, tanpa error.
- Test regresi: `node --test server/tests/agent-preview-gate.test.mjs` (RED sebelum patch, GREEN sesudah).
- Fix `providers.ts`: `firstNonBlank` melewati setting kosong supaya fallback `VB_LLM_KEY`/`HERMES_9ROUTER_API_KEY` dari env tetap terbaca.
- Key LLM lokal mesin ini: `/home/hatch/workspace/bin/vb-llm.env` (mode 600, di luar repo / gitignored). Jangan commit.

## Cara jalankan server lokal dengan key
- `. /home/hatch/workspace/bin/vb-llm.env && cd server && PORT=3000 VB_MODEL=cx/gpt-5.6-luna node src/index.ts`
- Supervisor `vb-supervise.sh` sudah me-source file env itu saat start_server.
