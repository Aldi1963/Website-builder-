import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import LandingV2 from "./LandingV2";

describe("LandingV2 (smoke render)", () => {
  it("merender hero + 6 kartu fitur tanpa crash", () => {
    const html = renderToString(createElement(LandingV2, { onStart: () => {} }));
    expect(html).toContain("Ide besar.");
    expect(html).toContain("AI software builder untuk produk nyata");
    expect(html).toContain("Mulai gratis");
    for (const fitur of [
      "AI coding agent",
      "Live preview",
      "Database nyata",
      "Deploy sekali klik",
      "Version control",
      "Aman by default",
    ]) {
      expect(html).toContain(fitur);
    }
  });

  it("tidak memanggil onStart saat render", () => {
    let called = 0;
    renderToString(createElement(LandingV2, { onStart: () => { called++; } }));
    expect(called).toBe(0);
  });
});
