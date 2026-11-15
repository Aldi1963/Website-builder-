import { describe, it, expect, beforeEach } from "vitest";
import { getToken, setToken, jwtPayload } from "./api";

// localStorage tidak ada di environment node vitest; stub minimal in-memory.
function stubLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
}

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("getToken / setToken", () => {
  beforeEach(stubLocalStorage);

  it("round-trip token lewat localStorage", () => {
    expect(getToken()).toBe("");
    setToken("abc.def.ghi");
    expect(getToken()).toBe("abc.def.ghi");
  });
});

describe("jwtPayload", () => {
  beforeEach(stubLocalStorage);

  it("mendekode klaim dari JWT (base64url)", () => {
    const tok = `header.${b64url({ uid: 42, exp: 9999999999 })}.sig`;
    setToken(tok);
    expect(jwtPayload()).toEqual({ uid: 42, exp: 9999999999 });
  });

  it("token kosong / rusak mengembalikan {} (tidak throw)", () => {
    setToken("");
    expect(jwtPayload()).toEqual({});
    setToken("bukan-jwt");
    expect(jwtPayload()).toEqual({});
    setToken("a.b.c");
    expect(jwtPayload()).toEqual({});
  });
});
