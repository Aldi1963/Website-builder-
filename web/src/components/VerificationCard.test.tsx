import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import VerificationCard, { parseResultVerification } from "./VerificationCard";

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
