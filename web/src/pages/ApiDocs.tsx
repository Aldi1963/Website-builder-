const ORANGE = "#F6821F";

const endpoints = [
  ["POST", "/api/auth/register", "Daftar akun baru"],
  ["POST", "/api/auth/login", "Login (header X-OTP jika 2FA aktif)"],
  ["POST", "/api/auth/forgot-password", "Minta link reset password"],
  ["GET", "/api/projects", "List proyek + proyek yang dishare"],
  ["POST", "/api/projects", "Buat proyek"],
  ["GET", "/api/projects/:id", "Detail proyek"],
  ["GET", "/api/projects/:id/files", "List file"],
  ["PUT", "/api/projects/:id/files", "Simpan file"],
  ["POST", "/api/projects/:id/chat", "Chat AI (SSE)"],
  ["POST", "/api/projects/:id/publish", "Publish proyek"],
  ["GET", "/api/projects/:id/deployments", "Riwayat deployment"],
  ["POST", "/api/projects/:id/deployments/:did/rollback", "Rollback"],
  ["GET", "/api/projects/:id/members", "List anggota"],
  ["POST", "/api/projects/:id/members", "Undang anggota"],
  ["GET", "/api/projects/:id/webhooks", "List webhook"],
  ["GET", "/api/projects/:id/stats", "Statistik kunjungan"],
  ["GET", "/api/projects/:id/tables", "List tabel database"],
  ["GET", "/api/notifications", "Notifikasi"],
  ["GET", "/api/api-keys", "List API key pribadi"],
  ["POST", "/api/api-keys", "Buat API key"],
  ["GET", "/api/templates", "List template"],
  ["GET", "/api/me/2fa", "Status 2FA"],
];

export default function ApiDocs() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 24, fontFamily: "system-ui", overflowX: "clip" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>Web<span style={{ color: ORANGE }}>Builder</span> API</h1>
      <p style={{ fontSize: 14, color: "#6b7280" }}>
        Autentikasi: <code>Authorization: Bearer &lt;token&gt;</code> atau API key pribadi (<code>wb_...</code> sebagai Bearer).
        Semua response JSON.
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        {endpoints.map(([m, p, d]) => (
          <div key={p + m} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{
                fontSize: 11, fontWeight: 800, padding: "3px 8px", borderRadius: 6,
                background: m === "GET" ? "#eff6ff" : m === "POST" ? "#fff7ed" : m === "PUT" ? "#fefce8" : "#fef2f2",
                color: m === "GET" ? "#2563eb" : m === "POST" ? ORANGE : m === "PUT" ? "#a16207" : "#dc2626",
              }}>{m}</span>
              <code style={{ fontSize: 13, wordBreak: "break-all" }}>{p}</code>
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{d}</div>
          </div>
        ))}
      </div>
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Webhook</h2>
      <p style={{ fontSize: 13, color: "#6b7280" }}>
        Event <code>deploy</code> dikirim via POST ke URL webhook terdaftar dengan header <code>X-Webhook-Secret</code>.
        Body: <code>{`{"event":"deploy","data":{"url":"/pub/slug","deploymentId":1}}`}</code>
      </p>
    </div>
  );
}
