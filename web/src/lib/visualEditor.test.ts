import { describe, it, expect } from "vitest";
import {
  findLiteralOccurrences,
  applyLiteralEdit,
  findStyleTarget,
  applyStyleEdit,
  mergeStyleInner,
  rankOccurrences,
  excludeHeadOccurrences,
  hasTagOccurrence,
  escapeJsxText,
  escapeStringLiteral,
} from "./visualEditor";

const FILES = {
  "src/App.tsx": `export default function App() {
  return (
    <div>
      <h1 className="title">Selamat Datang</h1>
      <p>Selamat Datang di toko kami</p>
      <img src="https://example.com/hero.jpg" alt="Hero" />
    </div>
  );
}
`,
  "src/data.ts": `export const heroTitle = "Selamat Datang";
export const items = [{ label: "Selamat Datang" }];
`,
  "src/components/Card.tsx": `export function Card() {
  return <h2 style={{ color: "#111111" }}>Promo Hari Ini</h2>;
}
`,
};

describe("findLiteralOccurrences", () => {
  it("menemukan teks JSX dan string literal di semua file", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    expect(occ.map((o) => `${o.file}:${o.line}:${o.kind}`)).toEqual([
      "src/App.tsx:4:jsx-text",
      "src/App.tsx:5:jsx-text",
      "src/data.ts:1:string",
      "src/data.ts:2:string",
    ]);
  });

  it("mengembalikan kosong untuk teks yang tidak ada / kosong", () => {
    expect(findLiteralOccurrences(FILES, "Tidak Ada")).toEqual([]);
    expect(findLiteralOccurrences(FILES, "   ")).toEqual([]);
  });

  it("mengklasifikasi nilai atribut src sebagai attribute", () => {
    const occ = findLiteralOccurrences(
      FILES,
      "https://example.com/hero.jpg",
      true,
    );
    expect(occ).toHaveLength(1);
    expect(occ[0].kind).toBe("attribute");
    expect(occ[0].file).toBe("src/App.tsx");
  });

  it("tidak mencari teks UI di file CSS", () => {
    const files = { ...FILES, "src/index.css": ".a{content:\"Selamat Datang\"}" };
    expect(findLiteralOccurrences(files, "Selamat Datang")).toHaveLength(4);
    expect(
      findLiteralOccurrences(files, "Selamat Datang", true),
    ).toHaveLength(5);
  });

  it("rankOccurrences mendahulukan baris yang memuat tag yang diklik", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    expect(occ[0].file).toBe("src/App.tsx");
    const ranked = rankOccurrences(occ, "p");
    expect(ranked[0].context).toContain("<p>");
    expect(ranked).toHaveLength(occ.length);
    // Tanpa tag yang cocok, urutan asal dipertahankan.
    expect(rankOccurrences(occ, "table")).toEqual(occ);
  });

  it("excludeHeadOccurrences membuang <title>/<meta> kecuali tag itu sendiri", () => {
    const files = {
      ...FILES,
      "index.html": `<title>Selamat Datang</title>\n<meta content="Selamat Datang">`,
    };
    const occ = findLiteralOccurrences(files, "Selamat Datang");
    expect(occ.length).toBeGreaterThan(4);
    const kept = excludeHeadOccurrences(occ, "h1");
    expect(kept.every((o) => !o.context.toLowerCase().includes("<title"))).toBe(true);
    expect(kept.every((o) => !o.context.toLowerCase().includes("<meta"))).toBe(true);
    expect(kept).toHaveLength(4);
    expect(excludeHeadOccurrences(occ, "title")).toEqual(occ);
  });

  it("hasTagOccurrence mendeteksi teks terpecah (tanpa kemunculan ber-tag)", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    expect(hasTagOccurrence(occ, "h1")).toBe(true);
    expect(hasTagOccurrence(occ, "h2")).toBe(false);
  });
});

describe("applyLiteralEdit", () => {
  it("mengganti hanya kemunculan yang dipilih (offset), bukan semua", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const res = applyLiteralEdit(FILES, occ[1], "Selamat Datang", "Halo Dunia");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files["src/App.tsx"]).toContain("<p>Halo Dunia di toko kami</p>");
    expect(res.files["src/App.tsx"]).toContain("<h1 className=\"title\">Selamat Datang</h1>");
    expect(res.files["src/data.ts"]).toContain('"Selamat Datang"');
  });

  it("meng-escape karakter khusus JSX pada teks baru", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const res = applyLiteralEdit(FILES, occ[0], "Selamat Datang", "Diskon 50% {besar} <gratis>");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files["src/App.tsx"]).toContain(
      'Diskon 50% {"{"}besar{"}"} &lt;gratis&gt;',
    );
  });

  it("menolak bila isi file berubah sejak pemilihan", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const changed = {
      ...FILES,
      "src/App.tsx": FILES["src/App.tsx"].replace("Selamat Datang", "Lain"),
    };
    const res = applyLiteralEdit(changed, occ[0], "Selamat Datang", "Halo");
    expect(res.ok).toBe(false);
  });

  it("mengganti src gambar di atribut", () => {
    const occ = findLiteralOccurrences(FILES, "https://example.com/hero.jpg", true);
    const res = applyLiteralEdit(
      FILES,
      occ[0],
      "https://example.com/hero.jpg",
      "https://example.com/baru.png",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files["src/App.tsx"]).toContain('src="https://example.com/baru.png"');
  });
});

describe("escape helpers", () => {
  it("escapeJsxText mengamankan & < > { }", () => {
    expect(escapeJsxText("a & b <c> {d}")).toBe('a &amp; b &lt;c&gt; {"{"}d{"}"}');
  });

  it("escapeStringLiteral mengamankan quote dan backslash", () => {
    expect(escapeStringLiteral('a"b\\c', '"')).toBe('a\\"b\\\\c');
    expect(escapeStringLiteral("a'b", "'")).toBe("a\\'b");
  });
});

describe("findStyleTarget + applyStyleEdit", () => {
  it("menemukan tag pembuka h1 untuk teks JSX langsung", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const target = findStyleTarget(FILES, occ[0], "h1");
    expect(target).not.toBeNull();
    expect(target?.tagName).toBe("h1");
    expect(target?.styleInnerStart).toBe(-1);
  });

  it("menolak style untuk teks dari string literal (data/array)", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const target = findStyleTarget(FILES, occ[2], "h1");
    expect(target).toBeNull();
  });

  it("menolak bila nama tag tidak cocok dengan tag pembungkus", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const target = findStyleTarget(FILES, occ[0], "p");
    expect(target).toBeNull();
  });

  it("menyisipkan style inline baru pada tag pembuka", () => {
    const occ = findLiteralOccurrences(FILES, "Selamat Datang");
    const target = findStyleTarget(FILES, occ[0], "h1");
    expect(target).not.toBeNull();
    const res = applyStyleEdit(FILES, target!, { color: "#ff0000", fontSize: 32 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files["src/App.tsx"]).toContain(
      '<h1 className="title" style={{ color: "#ff0000", fontSize: 32 }}>Selamat Datang</h1>',
    );
  });

  it("menggabungkan patch ke style yang sudah ada (patch menang)", () => {
    const occ = findLiteralOccurrences(FILES, "Promo Hari Ini");
    const target = findStyleTarget(FILES, occ[0], "h2");
    expect(target).not.toBeNull();
    expect(target?.styleInnerStart).toBeGreaterThanOrEqual(0);
    const res = applyStyleEdit(FILES, target!, {
      color: "#00aa00",
      backgroundColor: "#ffffff",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files["src/components/Card.tsx"]).toContain('color: "#00aa00"');
    expect(res.files["src/components/Card.tsx"]).toContain('backgroundColor: "#ffffff"');
    expect(res.files["src/components/Card.tsx"]).not.toContain("#111111");
  });
});

describe("mergeStyleInner", () => {
  it("menimpa properti lama dan menambah properti baru", () => {
    expect(mergeStyleInner('color: "#111", fontSize: 14', { color: "#222" })).toBe(
      'color: "#222", fontSize: 14',
    );
    expect(mergeStyleInner("", { fontSize: 20 })).toBe("fontSize: 20");
  });
});
