// Definisi tool agent, dipisahkan agar bisa ditest tanpa menjalankan agent penuh.
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Daftar file di workspace proyek.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi satu file dari workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relatif, contoh src/routes/index.tsx' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Cari teks/kode di seluruh file proyek (regex, case-insensitive). Gunakan untuk menemukan semua pemakaian sebuah fungsi/komponen SEBELUM mengubahnya. Hasil dibatasi 40 baris.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pola regex regex-compatible, contoh: renderLms|useAuth' },
          path: { type: 'string', description: 'Filter opsional: hanya file yang path-nya mengandung teks ini' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Tulis/perbarui file utuh (bukan patch). Selalu kirim isi lengkap file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Isi lengkap file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Hapus file dari workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build',
      description: 'Jalankan build produksi (vite build). Gunakan untuk memverifikasi kode.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audit',
      description: 'Tinjau keamanan, data, UI, dan aksesibilitas seluruh kode proyek setelah implementasi. Hasil dikirim sebagai temuan terstruktur.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_preview',
      description: 'Ambil screenshot preview aplikasi + error runtime (console/pageerror) agar kamu bisa MELIHAT hasil render nyata dan memperbaiki masalah visual/fungsional. Panggil setelah build sukses bila ada perubahan UI. Kamu akan menerima gambar sebagai pesan berikutnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_schema',
      description: 'Buat atau ubah tabel di database proyek (Postgres terkelola, permanen). Satu pernyataan per panggilan; hanya CREATE TABLE (pakai IF NOT EXISTS), CREATE [UNIQUE] INDEX, ALTER TABLE, COMMENT ON. DROP/TRUNCATE/GRANT/ekstensi/administratif ditolak.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sql: { type: 'string', description: 'Satu pernyataan SQL DDL. Contoh: CREATE TABLE IF NOT EXISTS notes (id serial primary key, user_email text not null, title text not null, body text, created_at timestamptz default now())' } },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_query',
      description: 'Jalankan satu pernyataan SELECT/INSERT/UPDATE/DELETE/WITH di database proyek untuk memverifikasi skema atau seed data. DDL dan operasi administratif ditolak.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sql: { type: 'string', description: 'Satu pernyataan SQL.' } },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install',
      description: 'Pasang dependency npm ke workspace proyek. Tanpa packages = install dari package.json. Berikan nama package (contoh ["ws", "baileys"]) untuk menambah dependency baru — package.json dan lock akan diperbarui otomatis. Gunakan ini SATU-SATUNYA bila butuh library baru; jangan menulis package.json sendiri.',
      parameters: {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string' }, description: 'Nama package npm yang valid' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_secret',
      description: 'Simpan kredensial/rahasia proyek (token API, password, kunci) sebagai environment variable HANYA di server preview — tidak pernah ditulis ke file proyek atau terkirim ke client. Nilai hanya bisa ditulis, tidak bisa dibaca kembali. Contoh: WA_SESSION_TOKEN, API_KEY.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Nama env var, huruf kapital/angka/underscore' },
          value: { type: 'string', description: 'Nilai rahasia' },
        },
        required: ['key', 'value'],
      },
    },
  },
]

