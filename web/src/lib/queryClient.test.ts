import { describe, it, expect } from "vitest";
import { queryClient } from "./queryClient";

describe("queryClient", () => {
  it("memakai default query yang disepakati", () => {
    const opts = queryClient.getDefaultOptions().queries;
    // staleTime 15 detik, tanpa refetch saat fokus kembali, retry 1x.
    expect(opts?.staleTime).toBe(15_000);
    expect(opts?.refetchOnWindowFocus).toBe(false);
    expect(opts?.retry).toBe(1);
  });
});
