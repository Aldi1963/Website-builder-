// Kartu verifikasi browser di chat (event SSE "result", lihat Builder.tsx).
//
// Server mengirim verification {attempted, passed, rounds, consoleErrors,
// failedRequests, screenshotPath} + screenshotUrl (kontrak baru, URL relatif
// endpoint penyajian). Kartu ini HANYA memakai screenshotUrl; screenshotPath
// absolut server TIDAK PERNAH dipakai sebagai src — parseResultVerification
// di bawah bahkan tidak menyimpannya di state klien.
//
// Auth: endpoint penyajian butuh header Bearer (token localStorage wb-token),
// jadi <img src> langsung tidak bisa — gambar dimuat lewat fetch + blob
// object URL, pola yang sama dengan pemanggilan API lain di codebase.
// Klik gambar membuka versi ukuran penuh di tab baru (bukan lightbox baru).
import { useEffect, useState } from "react";
import { getToken } from "../lib/api";
import type { ChatVerification } from "../lib/store/builderStore";

/** URL screenshot yang aman dipakai sebagai sumber gambar: hanya URL relatif
 *  same-origin ("/api/..."). URL absolut maupun protocol-relative ("//...")
 *  ditolak supaya path absolut server atau host luar tidak pernah jadi src. */
function safeScreenshotUrl(u: unknown): string | undefined {
  if (typeof u !== "string" || !u.startsWith("/") || u.startsWith("//")) return undefined;
  return u;
}

/** Normalisasi chunk event SSE "result" menjadi data kartu, atau null bila
 *  kartu tidak boleh tampil:
 *  - verifikasi tidak dicoba (attempted=false), atau
 *  - backend lama yang belum mengirim screenshotUrl — tanpa URL tidak ada
 *    gambar untuk ditampilkan, jadi kartu diabaikan (bukan crash).
 *  screenshotPath (absolut server) sengaja dibuang di sini. */
export function parseResultVerification(chunk: any): ChatVerification | null {
  const v = chunk?.verification;
  if (!v || typeof v !== "object" || !v.attempted) return null;
  const screenshotUrl =
    safeScreenshotUrl(v.screenshotUrl) ?? safeScreenshotUrl(chunk?.screenshotUrl);
  if (!screenshotUrl) return null;
  return {
    attempted: true,
    passed: !!v.passed,
    rounds: Number(v.rounds || 0),
    consoleErrors: Array.isArray(v.consoleErrors) ? v.consoleErrors.map(String) : [],
    failedRequests: Array.isArray(v.failedRequests) ? v.failedRequests.map(String) : [],
    screenshotUrl,
  };
}

export default function VerificationCard({ verification }: { verification: ChatVerification }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgState, setImgState] = useState<"loading" | "ready" | "error">("loading");
  const url = verification.screenshotUrl;

  useEffect(() => {
    if (!url) return;
    let alive = true;
    let objectUrl = "";
    setImgState("loading");
    fetch(url, { headers: { Authorization: "Bearer " + getToken() } })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setImgUrl(objectUrl);
        setImgState("ready");
      })
      .catch(() => {
        if (alive) setImgState("error");
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  const passed = verification.passed;
  const border = passed ? "#bbf7d0" : "#fecaca";
  const bg = passed ? "#f0fdf4" : "#fffafa";
  const titleColor = passed ? "#166534" : "#991b1b";
  const textColor = passed ? "#14532d" : "#7f1d1d";
  const iconBg = passed ? "#dcfce7" : "#fee2e2";
  const iconColor = passed ? "#16a34a" : "#dc2626";
  const stats: string[] = [
    `${verification.consoleErrors.length} console error`,
    `${verification.failedRequests.length} request gagal`,
  ];
  if (verification.rounds > 0) stats.push(`${verification.rounds} putaran`);
  const details = [...verification.consoleErrors, ...verification.failedRequests].slice(0, 4);

  return (
    <div style={{ border: `1px solid ${border}`, background: bg, borderRadius: 12, padding: 12, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: iconBg, color: iconColor, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 800, fontSize: 13 }}>
          {passed ? "✓" : "!"}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ display: "block", fontSize: 13, color: titleColor }}>
            {passed ? "Verifikasi browser lolos" : "Verifikasi browser menemukan masalah"}
          </strong>
          <span style={{ display: "block", marginTop: 3, fontSize: 11, lineHeight: 1.45, color: textColor }}>
            {stats.join(" · ")}
          </span>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        {imgState === "loading" && (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, background: "#ffffff", color: "#64748b", fontSize: 11, padding: "18px 12px", textAlign: "center" }}>
            Memuat screenshot…
          </div>
        )}
        {imgState === "ready" && imgUrl && (
          <img
            src={imgUrl}
            alt="Screenshot hasil verifikasi browser"
            title="Klik untuk memperbesar"
            onClick={() => window.open(imgUrl, "_blank", "noopener")}
            style={{ width: "100%", display: "block", borderRadius: 8, border: "1px solid #e2e8f0", cursor: "zoom-in" }}
          />
        )}
        {imgState === "error" && (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, background: "#ffffff", color: "#64748b", fontSize: 11, padding: "18px 12px", textAlign: "center" }}>
            Screenshot tidak tersedia (gagal dimuat). Ringkasan di atas tetap berlaku.
          </div>
        )}
      </div>
      {!passed && details.length > 0 && (
        <details style={{ fontSize: 10, color: titleColor, marginTop: 10 }}>
          <summary style={{ cursor: "pointer", userSelect: "none" }}>Detail error</summary>
          <div style={{ marginTop: 6, maxHeight: 90, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.35 }}>
            {details.join("\n")}
          </div>
        </details>
      )}
    </div>
  );
}
