// Visual editor klik-elemen: logika murni pemetaan DOM -> file sumber.
//
// DESAIN (jujur, lihat juga docs/visual-editor.md):
// Elemen yang diklik di preview TIDAK membawa jejak file sumber — React
// hasil build tidak menyimpan "teks ini dari baris X file Y". Pendekatan
// yang dipakai di sini adalah pencocokan literal: teks yang dirender
// (atau src gambar) dicari apa adanya di file sumber proyek. Kode hasil
// AI hampir selalu me-render heading/label sebagai teks JSX atau string
// literal, sehingga pencocokan ini menutup kasus umum. Bila teks yang sama
// muncul di beberapa tempat, pemakai memilih kemunculan mana (file +
// baris + konteks ditampilkan). Bila tidak ditemukan sama sekali (mis.
// teks hasil gabungan expression, teks dari array data yang dipecah, atau
// teks dengan whitespace berbeda), edit visual menolak dengan pesan jelas
// dan pemakai diarahkan ke edit kode / chat AI — tidak ada tebakan diam-diam.
//
// Semua fungsi di sini murni (tanpa DOM/fetch/React) supaya bisa diuji
// dengan vitest dan dipakai ulang oleh skrip E2E.

export interface VisualSelection {
  tag: string;
  id?: string;
  cls?: string;
  /** Teks render elemen (innerText, sudah di-trim, maks 120 karakter). */
  text?: string;
  /** Untuk IMG: nilai atribut src. */
  src?: string;
  alt?: string;
  /** Gaya terhitung elemen saat diklik (dari getComputedStyle di bridge). */
  color?: string;
  fontSize?: string;
  backgroundColor?: string;
}

export type OccurrenceKind = "jsx-text" | "string" | "attribute";

export interface TextOccurrence {
  file: string;
  /** Offset byte awal literal di isi file. */
  start: number;
  /** Offset byte akhir literal di isi file. */
  end: number;
  line: number;
  /** Baris sumber yang memuat kemunculan (di-trim, maks 120 karakter). */
  context: string;
  kind: OccurrenceKind;
}

export interface StyleTarget {
  file: string;
  /** Offset '<' tag pembuka JSX yang membungkus teks. */
  tagStart: number;
  /** Offset tepat setelah '>' tag pembuka. */
  tagEnd: number;
  tagName: string;
  /** Rentang isi style={{ ... }} yang sudah ada (offset isi di dalam kurung kurawal), bila ada. */
  styleInnerStart: number;
  styleInnerEnd: number;
}

export type EditResult =
  | { ok: true; files: Record<string, string>; file: string }
  | { ok: false; error: string };

export interface StylePatch {
  color?: string;
  fontSize?: number;
  backgroundColor?: string;
}

// File yang dicari literal teksnya: sumber aplikasi. CSS dikeluarkan dari
// pencarian teks (teks UI tidak tinggal di CSS); pencarian src gambar
// memakai daftar yang sama + CSS (background-image: url(...)).
const TEXT_EXTS = [".tsx", ".ts", ".jsx", ".js", ".html"];
const SRC_EXTS = [...TEXT_EXTS, ".css"];

function isTextFile(path: string): boolean {
  return TEXT_EXTS.some((ext) => path.endsWith(ext));
}

function isSrcFile(path: string): boolean {
  return SRC_EXTS.some((ext) => path.endsWith(ext));
}

/** Baris ke-n (1-based) dari offset, plus isi baris itu. */
function lineInfo(content: string, offset: number): { line: number; context: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  let lineEnd = content.indexOf("\n", offset);
  if (lineEnd === -1) lineEnd = content.length;
  const context = content.slice(lineStart, lineEnd).trim().slice(0, 120);
  return { line, context };
}

/**
 * Klasifikasi konteks literal di sumber: di dalam string ber-quote,
 * nilai atribut JSX/HTML (quote yang didahului '='), atau teks JSX bebas.
 */
function classifyOccurrence(content: string, start: number): OccurrenceKind {
  const prev = start > 0 ? content[start - 1] : "";
  if (prev === '"' || prev === "'" || prev === "`") {
    const beforeQuote = start > 1 ? content[start - 2] : "";
    if (beforeQuote === "=") return "attribute";
    return "string";
  }
  return "jsx-text";
}

/**
 * Cari semua kemunculan literal `needle` di file sumber proyek.
 * Urutan deterministik: nama file menaik, lalu offset menaik.
 */
export function findLiteralOccurrences(
  files: Record<string, string>,
  needle: string,
  forSrc = false,
): TextOccurrence[] {
  const out: TextOccurrence[] = [];
  const text = (needle || "").trim();
  if (!text) return out;
  const names = Object.keys(files)
    .filter((n) => (forSrc ? isSrcFile(n) : isTextFile(n)))
    .sort();
  for (const file of names) {
    const content = files[file] || "";
    let from = 0;
    for (;;) {
      const idx = content.indexOf(text, from);
      if (idx === -1) break;
      const { line, context } = lineInfo(content, idx);
      out.push({
        file,
        start: idx,
        end: idx + text.length,
        line,
        context,
        kind: classifyOccurrence(content, idx),
      });
      from = idx + Math.max(1, text.length);
    }
  }
  return out;
}

/** Escape untuk teks JSX bebas: & < { } harus ditulis aman di JSX.
 * Satu pass per karakter: replace berantai akan merusak hasilnya
 * karena {"{"} yang disisipkan mengandung '}' yang ikut ter-replace. */
export function escapeJsxText(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "{") out += '{"{"}';
    else if (ch === "}") out += '{"}"}';
    else out += ch;
  }
  return out;
}

/** Escape untuk isi string literal ber-quote `quote` (", ', atau `). */
export function escapeStringLiteral(value: string, quote: string): string {
  let out = value.replace(/\\/g, "\\\\");
  if (quote === "`") {
    out = out.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  } else {
    out = out.split(quote).join("\\" + quote);
  }
  return out;
}

/** Escape untuk nilai atribut ber-quote `quote`. */
export function escapeAttributeValue(value: string, quote: string): string {
  if (quote === '"') return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return value.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
}

function escapeForOccurrence(
  content: string,
  occ: TextOccurrence,
  newText: string,
): string {
  if (occ.kind === "jsx-text") return escapeJsxText(newText);
  const quote = content[occ.start - 1] || '"';
  if (occ.kind === "attribute") return escapeAttributeValue(newText, quote);
  return escapeStringLiteral(newText, quote);
}

/**
 * Ganti SATU kemunculan literal (berdasarkan offset, bukan replace global)
 * dengan teks baru. Teks baru di-escape sesuai konteks sumbernya.
 */
export function applyLiteralEdit(
  files: Record<string, string>,
  occ: TextOccurrence,
  oldText: string,
  newText: string,
): EditResult {
  const content = files[occ.file];
  if (content === undefined) return { ok: false, error: `File ${occ.file} tidak ditemukan` };
  if (content.slice(occ.start, occ.end) !== oldText) {
    return {
      ok: false,
      error: `Isi file ${occ.file} berubah sejak elemen dipilih; pilih ulang elemennya`,
    };
  }
  if (newText === oldText) return { ok: false, error: "Tidak ada perubahan" };
  const escaped = escapeForOccurrence(content, occ, newText);
  const next = content.slice(0, occ.start) + escaped + content.slice(occ.end);
  return { ok: true, files: { ...files, [occ.file]: next }, file: occ.file };
}

const JSX_TAG_RE = /<([A-Za-z][A-Za-z0-9._-]*)\s*((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * Cari tag pembuka JSX yang membungkus kemunculan teks: tag terdalam
 * sebelum kemunculan yang nama-nya cocok dengan tag yang diklik dan
 * belum ditutup sebelum kemunculan. Hanya berlaku untuk teks JSX
 * langsung — teks dari string/array data tidak punya tag pembungkus
 * yang bisa diberi style inline.
 */
export function findStyleTarget(
  files: Record<string, string>,
  occ: TextOccurrence,
  tag: string,
): StyleTarget | null {
  if (occ.kind !== "jsx-text") return null;
  const content = files[occ.file];
  if (content === undefined) return null;
  const want = tag.toLowerCase();
  const before = content.slice(0, occ.start);
  let match: RegExpExecArray | null;
  let best: { tagStart: number; tagEnd: number; tagName: string } | null = null;
  JSX_TAG_RE.lastIndex = 0;
  while ((match = JSX_TAG_RE.exec(before)) !== null) {
    const name = match[1];
    const selfClosing = match[3] === "/";
    if (selfClosing) continue;
    if (name.toLowerCase() !== want) continue;
    // Tag penutup untuk nama ini di antara tag pembuka dan kemunculan
    // berarti teks bukan anak langsung tag ini.
    const between = content.slice(match.index + match[0].length, occ.start);
    if (new RegExp(`</${name}\\s*>`, "i").test(between)) continue;
    best = { tagStart: match.index, tagEnd: match.index + match[0].length, tagName: name };
  }
  if (!best) return null;
  // Tag penutup setelah kemunculan harus ada (elemen memang membungkus teks).
  const after = content.slice(occ.end);
  if (!new RegExp(`</${best.tagName}\\s*>`, "i").test(after)) return null;
  const tagText = content.slice(best.tagStart, best.tagEnd);
  const styleRe = /style\s*=\s*\{\{([\s\S]*?)\}\}/;
  const sm = styleRe.exec(tagText);
  return {
    file: occ.file,
    tagStart: best.tagStart,
    tagEnd: best.tagEnd,
    tagName: best.tagName,
    styleInnerStart: sm ? best.tagStart + sm.index + sm[0].indexOf("{{") + 2 : -1,
    styleInnerEnd: sm ? best.tagStart + sm.index + sm[0].lastIndexOf("}}") : -1,
  };
}

/** Bangun isi style={{ ... }} dari patch: properti baru menimpa yang lama. */
export function mergeStyleInner(inner: string, patch: StylePatch): string {
  let out = inner.trim();
  const setProp = (current: string, prop: string, value: string): string => {
    const re = new RegExp(`${prop}\\s*:[^,]+,?\\s*`, "");
    if (re.test(current)) return current.replace(re, `${prop}: ${value}, `).trim();
    return current ? `${current.replace(/,\s*$/, "")}, ${prop}: ${value}` : `${prop}: ${value}`;
  };
  if (patch.color !== undefined) out = setProp(out, "color", JSON.stringify(patch.color));
  if (patch.backgroundColor !== undefined) {
    out = setProp(out, "backgroundColor", JSON.stringify(patch.backgroundColor));
  }
  if (patch.fontSize !== undefined) out = setProp(out, "fontSize", String(patch.fontSize));
  return out.replace(/,\s*$/, "").trim();
}

/**
 * Terapkan patch gaya sebagai style inline pada tag pembuka target.
 * Bila tag sudah punya style={{...}}, properti digabung (patch menang);
 * bila belum, atribut style disisipkan sebelum '>' penutup tag.
 */
export function applyStyleEdit(
  files: Record<string, string>,
  target: StyleTarget,
  patch: StylePatch,
): EditResult {
  const content = files[target.file];
  if (content === undefined) return { ok: false, error: `File ${target.file} tidak ditemukan` };
  if (
    !patch.color &&
    !patch.backgroundColor &&
    patch.fontSize === undefined
  ) {
    return { ok: false, error: "Tidak ada perubahan gaya" };
  }
  let next: string;
  if (target.styleInnerStart >= 0 && target.styleInnerEnd > target.styleInnerStart) {
    const inner = content.slice(target.styleInnerStart, target.styleInnerEnd);
    const merged = mergeStyleInner(inner, patch);
    next =
      content.slice(0, target.styleInnerStart) +
      merged +
      content.slice(target.styleInnerEnd);
  } else {
    const styleText = ` style={{ ${mergeStyleInner("", patch)} }}`;
    next =
      content.slice(0, target.tagEnd - 1) + styleText + content.slice(target.tagEnd - 1);
  }
  return { ok: true, files: { ...files, [target.file]: next }, file: target.file };
}

/**
 * Label ringkas satu kemunculan untuk pemilih (file:baris + jenis +
 * konteks). Jenis disertakan karena satu baris bisa memuat dua
 * kemunculan berlabel sama (mis. aria-label + teks anak di satu <a>).
 */
export function occurrenceLabel(occ: TextOccurrence): string {
  return `${occ.file}:${occ.line} [${occ.kind}] — ${occ.context}`;
}

/**
 * Urutkan kemunculan untuk pemilih: yang baris sumbernya memuat tag
 * pembuka elemen yang diklik (`<h1`, `<p`, …) didahulukan — itulah
 * hampir selalu elemen yang benar-benar diklik, bukan <title> atau
 * <span> lain yang kebetulan memuat teks yang sama. Stabil: urutan
 * asal dipertahankan di dalam tiap kelompok.
 */
export function rankOccurrences(
  occurrences: TextOccurrence[],
  tag: string,
): TextOccurrence[] {
  const needle = `<${tag.toLowerCase()}`;
  const withTag: TextOccurrence[] = [];
  const withoutTag: TextOccurrence[] = [];
  for (const occ of occurrences) {
    if (occ.context.toLowerCase().includes(needle)) withTag.push(occ);
    else withoutTag.push(occ);
  }
  return [...withTag, ...withoutTag];
}

/**
 * Buang kemunculan di <title>/<meta> (bagian <head>): elemen-elemen
 * itu tidak dirender sehingga TIDAK MUNGKIN menjadi elemen yang diklik
 * di preview — menawarkannya sebagai pilihan default (pernah terjadi:
 * klik <h1> malah mengubah <title>) adalah jebakan. Pengecualian:
 * bila yang diklik memang TITLE/META, jangan buang apa pun.
 */
export function excludeHeadOccurrences(
  occurrences: TextOccurrence[],
  tag: string,
): TextOccurrence[] {
  const t = tag.toLowerCase();
  if (t === "title" || t === "meta") return occurrences;
  return occurrences.filter((occ) => {
    const ctx = occ.context.toLowerCase();
    return !ctx.includes("<title") && !ctx.includes("<meta");
  });
}

/**
 * Apakah ada kemunculan yang barisnya memuat tag elemen yang diklik?
 * Bila tidak ada sama sekali, teks yang diklik kemungkinan terpecah
 * menjadi beberapa bagian di sumber (mis. <br/> atau <em> di dalam
 * heading) sehingga TIDAK ADA kemunculan yang benar untuk diedit.
 */
export function hasTagOccurrence(
  occurrences: TextOccurrence[],
  tag: string,
): boolean {
  const needle = `<${tag.toLowerCase()}`;
  return occurrences.some((occ) => occ.context.toLowerCase().includes(needle));
}
