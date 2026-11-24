import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import VerificationCard, { parseHistoryMessage, parseResultVerification } from "./VerificationCard";

const baseVerification = {
  attempted: true,
  passed: true,
  rounds: 2,
  consoleErrors: [],
  failedRequests: [],
  screenshotPath: "/var/lib/webbuilder/runs/7/screenshot-1.png",
  screenshotUrl: "/api/projects/1/runtime/screenshots/verification/7/screenshot-1.png",
};

describe("parseResultVerification", () => {
  it("null bila verifikasi tidak dicoba", () => {
    expect(parseResultVerification({ status: "completed", verification: { ...baseVerification, attempted: false } })).toBeNull();
  });

  it("null bila tidak ada objek verification", () => {
    expect(parseResultVerification({ status: "completed" })).toBeNull();
  });

  it("null bila backend lama tanpa screenshotUrl (kartu diabaikan, bukan crash)", () => {
    const { screenshotUrl, ...legacy } = baseVerification;
    expect(parseResultVerification({ status: "completed", verification: legacy })).toBeNull();
  });

  it("null bila hanya ada screenshotPath absolut server", () => {
    const { screenshotUrl, ...onlyPath } = baseVerification;
    expect(parseResultVerification({ status: "completed", verification: onlyPath })).toBeNull();
  });

  it("menolak screenshotUrl absolut dan protocol-relative", () => {
    expect(parseResultVerification({ status: "completed", verification: { ...baseVerification, screenshotUrl: "https://contoh.com/shot.png" } })).toBeNull();
    expect(parseResultVerification({ status: "completed", verification: { ...baseVerification, screenshotUrl: "//contoh.com/shot.png" } })).toBeNull();
  });

  it("menerima screenshotUrl relatif dan menormalisasi hitungan", () => {
    const v = parseResultVerification({
      status: "completed",
      verification: { ...baseVerification, passed: false, consoleErrors: ["TypeError: x"], failedRequests: ["GET /api/data 500", "GET /img.png 404"] },
    });
    expect(v).toEqual({
      attempted: true,
      passed: false,
      rounds: 2,
      consoleErrors: ["TypeError: x"],
      failedRequests: ["GET /api/data 500", "GET /img.png 404"],
      screenshotUrl: "/api/projects/1/runtime/screenshots/verification/7/screenshot-1.png",
    });
    // screenshotPath absolut server tidak pernah ikut tersimpan.
    expect(v && "screenshotPath" in v).toBe(false);
  });

  it("memakai screenshotUrl top-level sebagai fallback", () => {
    const { screenshotUrl, ...v } = baseVerification;
    const parsed = parseResultVerification({ status: "completed", verification: v, screenshotUrl: "/api/projects/1/runtime/screenshots/verification/7/screenshot-1.png" });
    expect(parsed?.screenshotUrl).toBe("/api/projects/1/runtime/screenshots/verification/7/screenshot-1.png");
  });
});

describe("VerificationCard (smoke render)", () => {
  it("kartu lolos: judul + hitungan + placeholder muat, tanpa path absolut server", () => {
    const html = renderToString(createElement(VerificationCard, { verification: parseResultVerification({ verification: baseVerification })! }));
    expect(html).toContain("Verifikasi browser lolos");
    expect(html).toContain("0 console error");
    expect(html).toContain("0 request gagal");
    expect(html).toContain("2 putaran");
    expect(html).toContain("Memuat screenshot");
    expect(html).not.toContain("/var/lib/webbuilder");
    expect(html).not.toContain("screenshot-1.png");
  });

  it("kartu gagal: judul + hitungan + detail error", () => {
    const failed = parseResultVerification({
      verification: { ...baseVerification, passed: false, consoleErrors: ["TypeError: x is not a function"], failedRequests: ["GET /api/data 500"] },
    })!;
    const html = renderToString(createElement(VerificationCard, { verification: failed }));
    expect(html).toContain("Verifikasi browser menemukan masalah");
    expect(html).toContain("1 console error");
    expect(html).toContain("1 request gagal");
    expect(html).toContain("TypeError: x is not a function");
    expect(html).toContain("GET /api/data 500");
  });
});

describe("parseHistoryMessage (riwayat chat -> store, kartu tampil setelah reload)", () => {
  const historyWithVerification = {
    role: "assistant",
    content: "",
    verification: { ...baseVerification, passed: false, consoleErrors: ["TypeError: x"], failedRequests: ["GET /api/data 500"] },
  };
  const historyPlain = { role: "user", content: "Buatkan aplikasi kasir" };

  it("riwayat dengan verification: hasil parse IDENTIK dengan jalur live (SSE result)", () => {
    const fromHistory = parseHistoryMessage(historyWithVerification);
    const fromLive = parseResultVerification({ status: "completed", verification: historyWithVerification.verification });
    expect(fromHistory.verification).toEqual(fromLive);
    expect(fromHistory.role).toBe("assistant");
    expect(fromHistory.content).toBe("");
  });

  it("riwayat tanpa verification: pesan biasa, tanpa field verification", () => {
    const parsed = parseHistoryMessage(historyPlain);
    expect(parsed).toEqual({ role: "user", content: "Buatkan aplikasi kasir" });
    expect("verification" in parsed).toBe(false);
  });

  it("verification null / tidak dicoba / backend lama tanpa screenshotUrl: tanpa kartu", () => {
    expect(parseHistoryMessage({ role: "assistant", content: "ok", verification: null }).verification).toBeUndefined();
    expect(parseHistoryMessage({ role: "assistant", content: "ok", verification: { ...baseVerification, attempted: false } }).verification).toBeUndefined();
    const { screenshotUrl, ...legacy } = baseVerification;
    expect(parseHistoryMessage({ role: "assistant", content: "ok", verification: legacy }).verification).toBeUndefined();
  });

  it("riwayat campuran: hanya pesan ber-verification yang membawa kartu", () => {
    const parsed = [historyPlain, historyWithVerification, { role: "assistant", content: "✅ Kode diterapkan." }].map(parseHistoryMessage);
    expect(parsed[0].verification).toBeUndefined();
    expect(parsed[1].verification?.passed).toBe(false);
    expect(parsed[1].verification?.consoleErrors).toEqual(["TypeError: x"]);
    expect(parsed[2].verification).toBeUndefined();
  });
});

describe("riwayat campuran merender kartu (parse -> VerificationCard)", () => {
  it("pesan ber-verification merender kartu (judul/statistik/gambar), pesan biasa tidak", () => {
    const history = [
      { role: "user", content: "Buatkan aplikasi kasir" },
      { role: "assistant", content: "✅ Kode diterapkan dan diverifikasi." },
      { role: "assistant", content: "", verification: { ...baseVerification, passed: true, rounds: 1 } },
      { role: "assistant", content: "", verification: { ...baseVerification, passed: false, rounds: 2, consoleErrors: ["TypeError: x"], failedRequests: ["GET /api/data 500"] } },
    ];
    const msgs = history.map(parseHistoryMessage);
    // Render tiap pesan seperti cabang render Builder.tsx: kartu hanya bila
    // m.verification ada — pesan biasa dirender sebagai teks saja.
    const html = msgs
      .map((m) =>
        renderToString(
          createElement("div", null, m.content, m.verification ? createElement(VerificationCard, { verification: m.verification }) : null),
        ),
      )
      .join("\n");
    expect(html).toContain("Buatkan aplikasi kasir");
    expect(html).toContain("✅ Kode diterapkan dan diverifikasi.");
    expect(html).toContain("Verifikasi browser lolos");
    expect(html).toContain("1 putaran");
    expect(html).toContain("Verifikasi browser menemukan masalah");
    expect(html).toContain("2 putaran");
    expect(html).toContain("1 console error");
    expect(html).toContain("1 request gagal");
    expect(html).toContain("TypeError: x");
    expect(html).toContain("GET /api/data 500");
    // Placeholder gambar (fetch screenshot tidak jalan di renderToString):
    // tepat 2 kartu -> tepat 2 placeholder "Memuat screenshot".
    expect(html.split("Memuat screenshot").length - 1).toBe(2);
    // Pesan biasa tidak membawa kartu: tidak ada judul kartu di sekitarnya
    // (judul hanya muncul 2x, sesuai 2 pesan ber-verification).
    expect(html.split("Verifikasi browser").length - 1).toBe(2);
  });
});
