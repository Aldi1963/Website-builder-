import { describe, expect, it } from "vitest";
import {
  defaultProvider,
  resolveComposerSelection,
  validModelFor,
  type AIProviderOption,
} from "./aiProviders";

function provider(partial: Partial<AIProviderOption> & { id: number }): AIProviderOption {
  return {
    name: `Provider #${partial.id}`,
    baseUrl: "https://x.example/v1",
    models: [],
    isDefault: false,
    enabled: true,
    hasKey: true,
    ...partial,
  };
}

describe("resolveComposerSelection", () => {
  const nine = provider({ id: 1, name: "9router", models: ["cx/gpt-5.6-luna", "oc/deepseek/deepseek-v4.1-flash"], isDefault: true });
  const ollama = provider({ id: 2, name: "Ollama", models: ["llama3.1:latest"], hasKey: false });
  const list = [nine, ollama];

  it("tanpa simpanan: default + model pertama", () => {
    expect(resolveComposerSelection(list, null)).toEqual({ providerId: 1, model: "cx/gpt-5.6-luna" });
  });

  it("simpanan valid dipakai apa adanya", () => {
    expect(resolveComposerSelection(list, { providerId: 2, model: "llama3.1:latest" })).toEqual({
      providerId: 2,
      model: "llama3.1:latest",
    });
  });

  it("model simpanan yang sudah tidak terdaftar jatuh ke model pertama provider itu", () => {
    expect(resolveComposerSelection(list, { providerId: 1, model: "model-lama" })).toEqual({
      providerId: 1,
      model: "cx/gpt-5.6-luna",
    });
  });

  it("provider simpanan yang sudah hilang jatuh ke default", () => {
    expect(resolveComposerSelection(list, { providerId: 99, model: "x" })).toEqual({
      providerId: 1,
      model: "cx/gpt-5.6-luna",
    });
  });

  it("tanpa provider: providerId 0 + model kosong", () => {
    expect(resolveComposerSelection([], null)).toEqual({ providerId: 0, model: "" });
    expect(defaultProvider([])).toBeNull();
  });

  it("provider tanpa daftar model: model kosong (composer menampilkan input teks)", () => {
    const empty = provider({ id: 3, name: "Kosong", models: [], isDefault: true });
    expect(resolveComposerSelection([empty], null)).toEqual({ providerId: 3, model: "" });
    expect(validModelFor(empty, "apa-saja")).toBe("");
  });

  it("validModelFor: pilihan terdaftar dipertahankan, kalau tidak model pertama", () => {
    expect(validModelFor(nine, "oc/deepseek/deepseek-v4.1-flash")).toBe("oc/deepseek/deepseek-v4.1-flash");
    expect(validModelFor(nine, "tidak-ada")).toBe("cx/gpt-5.6-luna");
    expect(validModelFor(null, "x")).toBe("");
  });
});
