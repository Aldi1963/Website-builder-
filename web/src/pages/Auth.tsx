import { useState, useEffect } from "react";
import { api, setToken } from "../lib/api";

export default function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "reset">("login");
  const [oauth, setOauth] = useState({ google: false, github: false });

  useEffect(() => {
    fetch("/api/auth/oauth/status").then((r) => r.json()).then(setOauth).catch(() => {});
  }, []);

  async function oauthLogin(provider: string) {
    const d = await fetch("/api/auth/oauth/" + provider).then((r) => r.json());
    if (d.url) window.location.href = d.url;
  }
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setTokenParam] = useState("");
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");

  async function submit(e: any) {
    e.preventDefault();
    setErr(""); setOkMsg("");
    try {
      if (mode === "forgot") {
        await fetch("/api/auth/forgot-password", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        }).then((r) => r.json());
        setOkMsg("Jika email terdaftar, link reset telah dikirim");
      } else if (mode === "reset") {
        const d = await fetch("/api/auth/reset-password", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token, new: password }),
        }).then((r) => r.json());
        if (d.message?.includes("berhasil")) { setMode("login"); setOkMsg("Password direset, silakan login"); }
        else setErr(d.message || "Gagal");
      } else {
        const d = mode === "login" ? await api.login(email, password) : await api.register(name, email, password);
        setToken(d.token);
        onDone();
      }
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 32, width: 360 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Web<span style={{ color: "#F6821F" }}>Builder</span></h1>
        <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Bangun website dengan AI</p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {mode === "register" && (
            <input placeholder="Nama" value={name} onChange={(e) => setName(e.target.value)} required
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          )}
          {(mode === "login" || mode === "register" || mode === "forgot") && (
            <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          )}
          {mode === "reset" && (
            <input placeholder="Token reset" value={token} onChange={(e) => setTokenParam(e.target.value)} required
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          )}
          {(mode === "login" || mode === "register" || mode === "reset") && (
            <input placeholder={mode === "reset" ? "Password baru" : "Password"} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          )}
          {err && <div style={{ color: "#dc2626", fontSize: 13 }}>{err}</div>}
          {okMsg && <div style={{ color: "#16a34a", fontSize: 13 }}>{okMsg}</div>}
          <button style={{ background: "#F6821F", color: "#fff", border: "none", borderRadius: 8, padding: 12, fontWeight: 700, cursor: "pointer" }}>
            {mode === "login" ? "Masuk" : mode === "register" ? "Daftar" : mode === "forgot" ? "Kirim Link" : "Reset Password"}
          </button>
          {(mode === "login" || mode === "register") && (oauth.google || oauth.github) && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9ca3af", fontSize: 12 }}>
                <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} /> atau <div style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {oauth.google && (
                  <button type="button" onClick={() => oauthLogin("google")}
                    style={{ flex: 1, border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    Google
                  </button>
                )}
                {oauth.github && (
                  <button type="button" onClick={() => oauthLogin("github")}
                    style={{ flex: 1, border: "1px solid #d1d5db", background: "#fff", borderRadius: 8, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    GitHub
                  </button>
                )}
              </div>
            </>
          )}
        </form>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {mode === "login" && (
            <button onClick={() => setMode("forgot")} style={{ background: "none", border: "none", color: "#6b7280", cursor: "pointer", fontSize: 13 }}>
              Lupa password?
            </button>
          )}
          {(mode === "forgot" || mode === "reset") && (
            <button onClick={() => setMode("login")} style={{ background: "none", border: "none", color: "#F6821F", cursor: "pointer", fontSize: 13 }}>
              Kembali ke login
            </button>
          )}
          {mode === "forgot" && (
            <button onClick={() => setMode("reset")} style={{ background: "none", border: "none", color: "#F6821F", cursor: "pointer", fontSize: 13 }}>
              Punya token? Reset di sini
            </button>
          )}
          {(mode === "login" || mode === "register") && (
            <button onClick={() => setMode(mode === "login" ? "register" : "login")}
              style={{ background: "none", border: "none", color: "#F6821F", cursor: "pointer", fontSize: 13 }}>
              {mode === "login" ? "Belum punya akun? Daftar" : "Sudah punya akun? Masuk"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
