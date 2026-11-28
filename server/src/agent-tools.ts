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
      name: 'ask_user',
      description: 'TANYA ke user lalu HENTIKAN run sampai user menjawab di chat. Pakai HANYA bila kamu benar-benar membutuhkan informasi yang tidak bisa kamu keputuskan sendiri dan mengubah hasil — misalnya kredensial/login web yang akan kamu isi sendiri di preview, atau pilihan alur yang menentukan struktur data. JANGAN dipakai untuk warna/font/selera atau hal yang bisa kamu asumsikan. Setelah user menjawab, run dilanjutkan otomatis dengan jawabannya.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pertanyaan singkat, jelas, dalam bahasa user. Contoh: "Email dan password apa yang harus saya pakai untuk masuk ke web ini?"' },
          hint: { type: 'string', description: 'Petunjuk opsional: format yang diharapkan atau kenapa kamu bertanya. Contoh: "Saya akan mengisinya di form login preview untuk memverifikasi alur."' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'interact_preview',
      description: 'Kontrol browser preview NYATA: buka halaman, klik tombol, isi input (termasuk email/password yang user berikan lewat ask_user), pilih opsi, tekan Enter, atau baca teks. Pakai ini untuk MEMBUKTI alur login/checkout/form benar-benar jalan, bukan sekadar build hijau. Jangan pernah menampilkan nilai kredensial di ringkasan. Mulai dengan action open bila session baru.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'click', 'fill', 'select', 'press', 'text'], description: 'Aksi browser' },
          path: { type: 'string', description: 'Path halaman untuk action open, mis. /login' },
          selector: { type: 'string', description: 'CSS selector elemen (mis. input[type=email], button:has-text("Masuk"))' },
          value: { type: 'string', description: 'Nilai untuk fill/select' },
          key: { type: 'string', description: 'Tombol keyboard untuk press, default Enter' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run',
      description: 'Jalankan perintah di folder proyek untuk verifikasi/testing (mis. npm test, node script.js --help, git status). Hanya perintah whitelist yang diizinkan; timeout 2 menit. Jangan dipakai untuk mengubah file proyek — gunakan write_file.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Perintah whitelist, mis. npm test' },
          argv: { type: 'array', items: { type: 'string' }, description: 'Alternatif: array argumen, mis. ["npm","test"]' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate',
      description: 'Jalankan hingga 3 subagen riset PARALEL untuk memecah tugas besar (mis. satu analisis backend, satu UI, satu QA). Subagen hanya berpikir/riset, tidak menulis file. Gunakan hasilnya untuk menyusun rencana lalu eksekusi sendiri lewat write_file.',
      parameters: {
        type: 'object',
        properties: {
          subtasks: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, prompt: { type: 'string' } }, required: ['label', 'prompt'] }, description: 'Maks 3 subtugas riset' },
        },
        required: ['subtasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Buat aset gambar (ilustrasi, ikon, hero, foto stok) lewat model gambar dan simpan ke folder public/ proyek. Pakai untuk aset visual nyata, jangan mengarang URL gambar eksternal. Kembalikan path /nama-file.png untuk dipakai di komponen.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Deskripsi gambar dalam bahasa Inggris/Indonesia' },
          filename: { type: 'string', description: 'Nama file, mis. hero.png' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_docs',
      description: 'Baca dokumentasi RESMI (Midtrans, Stripe, Google, GoPay, Clipku) untuk memastikan endpoint, parameter, dan alur OAuth/payment benar. WAJIB dipakai sebelum menulis kode integrasi pihak ketiga — jangan mengarang endpoint.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL dokumentasi resmi' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_state',
      description: 'Simpan/memuat checklist pekerjaan proyek yang bertahan lintas sesi chat. Pakai action save di awal tugas besar (goal + items) dan update status✓ saat item selesai, supaya sesi berikutnya lanjut dari titik yang benar.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'load', 'clear'] },
          goal: { type: 'string', description: 'Tujuan utama proyek' },
          items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'] }, description: 'Daftar tugas' },
        },
        required: ['action'],
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

