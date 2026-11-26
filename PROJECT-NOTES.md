
## Self-healing visual loop (commit: agent melihat aplikasinya)
Fondasi: build auto-fix loop (agent.ts:508-511, 4 ronde) sudah ada. Yang ditambah:
- `screenshots.ts`: `captureForReview()` -> {image base64 data-URL, runtimeErrors[], url}. Kumpulkan console.error + pageerror saat render. Beda dari captureScreenshot (yang cuma simpan file utk UI chat).
- `llm.ts`: `ContentPart` + `ChatMessage.content` bisa string ATAU array part (text+image_url) utk vision.
- `agent.ts`: tool `check_preview` -> render preview, balikin gambar+error. Gambar disuntik sbg message user multimodal di giliran berikut (tool content tak bisa bawa gambar). Guard: MAX_PREVIEW_ROUNDS (env VB_MAX_PREVIEW_ROUNDS, default 2). Final-summary gate ditahan sampai `(!touchedUi || previewRounds>=1)` biar UI change wajib dilihat sekali. Nudge sekali setelah build sukses+touchedUi+auditCompleted+previewRounds<1.
- Defensif: kalau panggilan dgn gambar ditolak upstream (model tanpa vision), retry SEKALI tanpa gambar — run yg sudah dibayar tak ikut gagal.
BELUM diverifikasi runtime: apakah model di 9router menerima data-URL base64. Butuh tes live dgn proyek nyata.
