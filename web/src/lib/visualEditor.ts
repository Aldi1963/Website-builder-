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
// Pengecualian: teks yang TERPECAH oleh elemen inline di dalam satu
// elemen (mis. <h1>Kopi<br/><em>Nikmat.</em></h1>) dipetakan oleh
// findSplitTextOccurrences ke sekumpulan node teks penyusunnya; edit
// membagi teks baru ke node-node itu dengan markup dipertahankan
// (lihat bagian "Teks terpecah" di bawah).
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
  return styleTargetFromTag(content, occ.file, best.tagStart, best.tagEnd, best.tagName);
}

/**
 * Bangun StyleTarget dari tag pembuka yang offset-nya sudah diketahui
 * (dipakai findStyleTarget dan splitStyleTarget).
 */
export function styleTargetFromTag(
  content: string,
  file: string,
  tagStart: number,
  tagEnd: number,
  tagName: string,
): StyleTarget {
  const tagText = content.slice(tagStart, tagEnd);
  const styleRe = /style\s*=\s*\{\{([\s\S]*?)\}\}/;
  const sm = styleRe.exec(tagText);
  return {
    file,
    tagStart,
    tagEnd,
    tagName,
    styleInnerStart: sm ? tagStart + sm.index + sm[0].indexOf("{{") + 2 : -1,
    styleInnerEnd: sm ? tagStart + sm.index + sm[0].lastIndexOf("}}") : -1,
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
export function occurrenceLabel(occ: TextOccurrence | SplitTextOccurrence): string {
  if (occ.kind === "split-text") {
    return `${occ.file}:${occ.line} [split-text <${occ.tagName}>] — ${occ.context}`;
  }
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

// ── Teks terpecah (split text) ──────────────────────────────────────────
// Heading seperti <h1>Kopi<br/><em>Nikmat.</em></h1> me-render "Kopi
// Nikmat." tapi literal itu tidak pernah muncul utuh di sumber, sehingga
// pencocokan literal di atas gagal. Bagian ini memetakan teks render ke
// SEKUMPULAN node teks di dalam SATU elemen (tag yang diklik): teks JSX
// bebas, string expression {"..."}, dan elemen inline (br/em/strong/span
// dan sejenisnya, rekursif). Saat menulis kembali, teks baru DIBAGI ke
// node-node aslinya mengikuti jumlah kata tiap segmen — struktur markup
// dipertahankan, tidak diratakan: <em> tetap <em>, <br/> tetap ada.
// Segmen yang kehabisan kata dikosongkan (pembungkus inline-nya dibiarkan
// kosong, bukan dihapus). Kasus yang tidak bisa dipetakan dengan aman
// (expression/variabel, elemen blok di dalam, template ${...}) dibiarkan
// tidak bisa diedit — tidak ada tebakan diam-diam.

/** Satu node teks penyusun teks terpecah. */
export interface SplitTextSegment {
  /** Offset awal inti teks di isi file (tanpa whitespace JSX di sekitarnya). */
  start: number;
  /** Offset akhir inti teks di isi file. */
  end: number;
  kind: "jsx-text" | "string";
  /** Karakter quote untuk kind "string" ('"' | "'" | "`"). */
  quote?: string;
  /** Nilai render node PENUH (termasuk spasi di ujung — spasi inilah
   * yang memisahkan segmen di teks render, mis. "Belajar " sebelum <span>). */
  text: string;
  /** Nilai render INTI (span start..end) — dipakai cek kebasi saat edit.
   * Untuk kind "string" sama dengan text. */
  coreText: string;
}

/** Satu elemen yang teks render-nya terpecah menjadi beberapa segmen. */
export interface SplitTextOccurrence {
  file: string;
  line: number;
  /** Baris sumber yang memuat tag pembuka elemen (di-trim, maks 120 karakter). */
  context: string;
  kind: "split-text";
  /** Tag elemen yang diklik (apa adanya dari DOM, mis. "H1"). */
  tag: string;
  /** Offset '<' tag pembuka elemen. */
  tagStart: number;
  /** Offset tepat setelah '>' tag pembuka elemen. */
  tagEnd: number;
  /** Nama tag seperti tertulis di sumber (mis. "h1"). */
  tagName: string;
  /** Segmen teks penyusun, urut sesuai kemunculan di sumber. */
  segments: SplitTextSegment[];
  /** Teks render gabungan (whitespace dinormalisasi). */
  renderedText: string;
}

/** Samakan whitespace render (innerText) dan sumber: "Kopi\nNikmat." → "Kopi Nikmat.". */
export function normalizeRenderedText(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

/** Decode entity HTML yang umum di teks JSX/HTML untuk perbandingan. */
export function decodeJsxEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? m : String.fromCodePoint(cp);
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos":
      case "#39": return "'";
      case "nbsp": return " ";
      default: return m;
    }
  });
}

/**
 * Nilai render sebuah node teks JSX mentah, mengikuti aturan whitespace
 * JSX: baris di-trim, baris kosong dibuang, baris digabung satu spasi;
 * teks tanpa newline dipertahankan apa adanya.
 */
export function jsxTextValue(raw: string): string {
  let value: string;
  if (raw.includes("\n")) {
    value = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
  } else {
    value = raw;
  }
  return decodeJsxEntities(value);
}

/** Urai escape umum di isi string literal JS/TS untuk perbandingan. */
export function unescapeStringContent(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\" || i + 1 >= raw.length) {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "0") out += "\0";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "v") out += "\v";
    else out += next;
    i++;
  }
  return out;
}

// Elemen inline yang boleh memecah teks di dalam satu elemen. <br/> dan
// <wbr/> adalah pemisah (bukan wadah teks); sisanya wadah yang isinya
// ikut dirender sebagai bagian teks elemen luar.
const INLINE_SPLIT_TAGS = new Set([
  "em", "strong", "span", "b", "i", "u", "s", "small", "mark", "code",
  "a", "sub", "sup", "abbr", "cite", "q", "time", "dfn", "kbd", "samp",
  "var", "bdi", "bdo", "del", "ins",
]);
const INLINE_SEPARATOR_TAGS = new Set(["br", "wbr"]);

interface ParsedTag {
  name: string;
  /** Offset tepat setelah '>' tag. */
  end: number;
  selfClosing: boolean;
}

/**
 * Parse satu tag pembuka/penutup mulai di `pos` (content[pos] === "<").
 * Atribut dihormati: '>' di dalam quote atau di dalam {...} tidak
 * mengakhiri tag. Mengembalikan null bila bukan tag yang valid.
 */
function parseTagAt(content: string, pos: number): ParsedTag | null {
  const m = /^<\/?([A-Za-z][A-Za-z0-9._-]*)/.exec(content.slice(pos, pos + 64));
  if (!m) return null;
  let i = pos + m[0].length;
  let quote = "";
  let braceDepth = 0;
  while (i < content.length) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      braceDepth++;
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
    } else if (ch === ">" && braceDepth === 0) {
      const selfClosing = content[i - 1] === "/";
      return { name: m[1], end: i + 1, selfClosing };
    }
    i++;
  }
  return null;
}

interface ParsedChildren {
  segments: SplitTextSegment[];
  /** Offset tepat setelah tag penutup elemen. */
  endPos: number;
}

/**
 * Parse isi (children) sebuah elemen mulai di `pos` sampai tag penutup
 * `</stopTag>`. Mengembalikan null bila isi mengandung sesuatu yang
 * tidak bisa dipetakan dengan aman (expression/variabel, elemen blok
 * atau elemen tak dikenal, string template ${...}).
 */
function parseSplitChildren(
  content: string,
  pos: number,
  stopTag: string,
  depth: number,
): ParsedChildren | null {
  if (depth > 8) return null;
  const segments: SplitTextSegment[] = [];
  let i = pos;
  const stopLower = stopTag.toLowerCase();
  while (i < content.length) {
    if (content.startsWith("</", i)) {
      const tag = parseTagAt(content, i);
      if (!tag) return null;
      if (tag.name.toLowerCase() === stopLower) {
        return { segments, endPos: tag.end };
      }
      // Tag penutup <br/>/<wbr/> tanpa pasangan (penulisan HTML): abaikan.
      if (INLINE_SEPARATOR_TAGS.has(tag.name.toLowerCase())) {
        i = tag.end;
        continue;
      }
      return null;
    }
    if (content.startsWith("<!--", i)) {
      const end = content.indexOf("-->", i + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    if (content[i] === "<") {
      const tag = parseTagAt(content, i);
      if (!tag) return null;
      const nameLower = tag.name.toLowerCase();
      if (INLINE_SEPARATOR_TAGS.has(nameLower)) {
        // <br/> menyumbang satu spasi pada teks render.
        segments.push({ start: tag.end, end: tag.end, kind: "jsx-text", text: " ", coreText: "" });
        i = tag.end;
        continue;
      }
      if (!INLINE_SPLIT_TAGS.has(nameLower)) return null;
      if (tag.selfClosing) return null; // mis. <span/> kosong: bukan teks.
      const inner = parseSplitChildren(content, tag.end, tag.name, depth + 1);
      if (!inner) return null;
      segments.push(...inner.segments);
      i = inner.endPos;
      continue;
    }
    if (content[i] === "{") {
      // Komentar JSX {/* ... */} bukan teks: lewati.
      if (content.startsWith("{/*", i)) {
        const end = content.indexOf("*/}", i + 3);
        if (end === -1) return null;
        i = end + 3;
        continue;
      }
      // String expression {"..."} / {'...'} / {`...`} = satu segmen teks.
      const q = content[i + 1];
      if (q === '"' || q === "'" || q === "`") {
        let j = i + 2;
        let closed = false;
        while (j < content.length) {
          const ch = content[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === q) { closed = true; break; }
          if (q === "`" && ch === "$" && content[j + 1] === "{") return null;
          if (ch === "\n" && q !== "`") return null;
          j++;
        }
        if (!closed || content[j + 1] !== "}") return null;
        const raw = content.slice(i + 2, j);
        const text = unescapeStringContent(raw);
        segments.push({ start: i + 2, end: j, kind: "string", quote: q, text, coreText: text });
        i = j + 2;
        continue;
      }
      return null; // expression/variabel — tidak bisa dipetakan aman.
    }
    // Node teks JSX bebas sampai '<' atau '{' berikutnya.
    let j = i;
    while (j < content.length && content[j] !== "<" && content[j] !== "{") j++;
    const raw = content.slice(i, j);
    const fullValue = jsxTextValue(raw);
    if (fullValue.trim() !== "") {
      // Inti teks = raw tanpa whitespace di ujung; teks baru ditulis ke
      // inti ini, spasi di ujung raw dibiarkan (itu pemisah antar-segmen
      // di teks render). Nilai penuh disimpan untuk pencocokan render.
      let start = i;
      let end = j;
      while (start < end && /\s/.test(content[start])) start++;
      while (end > start && /\s/.test(content[end - 1])) end--;
      segments.push({
        start,
        end,
        kind: "jsx-text",
        text: fullValue,
        coreText: jsxTextValue(content.slice(start, end)),
      });
    } else if (raw !== "" && !raw.includes("\n")) {
      // Node yang hanya berisi spasi TANPA newline dirender sebagai
      // spasi (mis. <span>A</span> <span>B</span>). Tanpa newline,
      // JSX mempertahankannya; dengan newline, JSX membuangnya.
      // Segmen lebar-nol: pemisah saja, bukan target edit.
      segments.push({ start: j, end: j, kind: "jsx-text", text: fullValue, coreText: "" });
    }
    i = j;
  }
  return null; // tag penutup tidak pernah ditemukan.
}

function splitRenderedText(segments: SplitTextSegment[]): string {
  return normalizeRenderedText(segments.map((s) => s.text).join(""));
}

/**
 * Cari elemen-elemen dengan tag `tag` yang teks render-nya (gabungan
 * segmen-segmen di dalamnya) sama dengan `renderedText` setelah
 * normalisasi whitespace. Urutan deterministik: nama file menaik, lalu
 * offset menaik. Hanya file sumber teks (.tsx/.ts/.jsx/.js/.html).
 */
export function findSplitTextOccurrences(
  files: Record<string, string>,
  renderedText: string,
  tag: string,
): SplitTextOccurrence[] {
  const out: SplitTextOccurrence[] = [];
  const needle = normalizeRenderedText(renderedText);
  if (!needle || !tag) return out;
  const want = tag.toLowerCase();
  const names = Object.keys(files).filter(isTextFile).sort();
  const openRe = new RegExp(`<${want}(?=[\\s/>])`, "gi");
  for (const file of names) {
    const content = files[file] || "";
    openRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(content)) !== null) {
      // parseTagAt (bukan regex) supaya '>' di dalam nilai atribut
      // tidak memotong tag pembuka terlalu dini.
      const parsedTag = parseTagAt(content, m.index);
      if (!parsedTag) continue;
      if (parsedTag.selfClosing) continue; // tanpa isi.
      const tagStart = m.index;
      const tagEnd = parsedTag.end;
      const tagName = parsedTag.name;
      const parsed = parseSplitChildren(content, tagEnd, tagName, 0);
      if (!parsed) continue;
      if (splitRenderedText(parsed.segments) !== needle) continue;
      const { line, context } = lineInfo(content, tagStart);
      out.push({
        file,
        line,
        context,
        kind: "split-text",
        tag,
        tagStart,
        tagEnd,
        tagName,
        segments: parsed.segments,
        renderedText: needle,
      });
    }
  }
  return out;
}

/**
 * Target gaya untuk teks terpecah: tag pembukanya sudah diketahui dari
 * kemunculan (tidak perlu dicari mundur dari teks).
 */
export function splitStyleTarget(
  files: Record<string, string>,
  occ: SplitTextOccurrence,
): StyleTarget | null {
  const content = files[occ.file];
  if (content === undefined) return null;
  return styleTargetFromTag(content, occ.file, occ.tagStart, occ.tagEnd, occ.tagName);
}

function segmentCoreValue(content: string, seg: SplitTextSegment): string {
  const raw = content.slice(seg.start, seg.end);
  return seg.kind === "string" ? unescapeStringContent(raw) : jsxTextValue(raw);
}

/**
 * Terapkan edit teks pada kemunculan teks terpecah: kata-kata teks baru
 * dibagi ke segmen-segmen aslinya mengikuti jumlah kata tiap segmen
 * (kata sisa — bila teks baru lebih panjang — masuk ke segmen terakhir;
 * segmen yang kehabisan kata dikosongkan, pembungkusnya dibiarkan).
 * Markup dipertahankan: <em> tetap <em>, <br/> tetap ada.
 */
export function applySplitTextEdit(
  files: Record<string, string>,
  occ: SplitTextOccurrence,
  newText: string,
): EditResult {
  const content = files[occ.file];
  if (content === undefined) return { ok: false, error: `File ${occ.file} tidak ditemukan` };
  const trimmed = (newText || "").trim();
  if (!trimmed) return { ok: false, error: "Teks baru kosong" };
  if (normalizeRenderedText(newText) === occ.renderedText) {
    return { ok: false, error: "Tidak ada perubahan" };
  }
  // Cek kebasi: inti tiap segmen harus masih berisi nilai yang sama
  // seperti saat elemen dipilih (spasi di luar inti bukan bagian cek).
  for (const seg of occ.segments) {
    if (seg.start === seg.end) continue; // pemisah <br/> / spasi: tanpa isi.
    if (segmentCoreValue(content, seg) !== seg.coreText) {
      return {
        ok: false,
        error: `Isi file ${occ.file} berubah sejak elemen dipilih; pilih ulang elemennya`,
      };
    }
  }
  const words = trimmed.split(/\s+/);
  // Segmen yang hanya berisi spasi (mis. {" "}) bukan target kata: dibiarkan.
  const targets = occ.segments.filter((s) => s.text.trim() !== "");
  const counts = targets.map((s) => s.text.trim().split(/\s+/).length);
  const assigned: string[] = targets.map(() => "");
  let at = 0;
  for (let k = 0; k < targets.length; k++) {
    const take = Math.min(counts[k], words.length - at);
    if (take > 0) {
      assigned[k] = words.slice(at, at + take).join(" ");
      at += take;
    }
  }
  if (at < words.length && targets.length > 0) {
    const last = targets.length - 1;
    assigned[last] = assigned[last]
      ? `${assigned[last]} ${words.slice(at).join(" ")}`
      : words.slice(at).join(" ");
  }
  // Terapkan dari offset terbesar ke terkecil agar offset lain tidak bergeser.
  const jobs = targets
    .map((seg, k) => ({ seg, value: assigned[k] }))
    .sort((a, b) => b.seg.start - a.seg.start);
  let next = content;
  for (const { seg, value } of jobs) {
    const escaped =
      seg.kind === "jsx-text"
        ? escapeJsxText(value)
        : escapeStringLiteral(value, seg.quote || '"');
    next = next.slice(0, seg.start) + escaped + next.slice(seg.end);
  }
  return { ok: true, files: { ...files, [occ.file]: next }, file: occ.file };
}
