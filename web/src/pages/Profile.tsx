import { useEffect, useState } from "react";
import { X, Key, ShieldCheck, Copy, Trash2 } from "lucide-react";
import { getToken } from "../lib/api";

const ORANGE = "#F6821F";

async function preq(path: string, opts: any = {}) {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Gagal");
  return d;
}

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 };
const input = { width: "100%", padding: 10, border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, boxSizing: "border-box" as const };
const btn = { background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer", fontSize: 13 };
const btnGhost = { border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 };

export default function Profile({ onClose }: { onClose: () => void }) {
  const [fa2, setFa2] = useState(false);
  const [setup, setSetup] = useState<any>(null);
  const [code, setCode] = useState("");
  const [disPw, setDisPw] = useState("");
  const [keys, setKeys] = useState<any[]>([]);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState("");

  async function load() {
    try {
      const d = await preq("/me/2fa"); setFa2(d.enabled);
      const k = await preq("/api-keys"); setKeys(k.keys || []);
    } catch { }
  }
  useEffect(() => { load(); }, []);

  async function startSetup() {
    const d = await preq("/me/2fa/setup", { method: "POST" });
    setSetup(d);
  }
  async function verifySetup() {
    await preq("/me/2fa/verify", { method: "POST", body: JSON.stringify({ code }) });
    setSetup(null); setCode(""); load(); alert("2FA aktif");
  }
  async function disable2fa() {
    await preq("/me/2fa/disable", { method: "POST", body: JSON.stringify({ password: disPw }) });
    setDisPw(""); load(); alert("2FA dimatikan");
  }
  async function createKey() {
    if (!keyName.trim()) return;
    const d = await preq("/api-keys", { method: "POST", body: JSON.stringify({ name: keyName }) });
    setNewKey(d.key); setKeyName(""); load();
  }
  async function delKey(id: number) {
    if (!confirm("Hapus key?")) return;
    await preq(`/api-keys/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#f9fafb", zIndex: 90, display: "flex", flexDirection: "column", fontFamily: "system-ui" }}>
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <strong style={{ fontSize: 16, flex: 1 }}>Profil & Keamanan</strong>
        <button onClick={onClose} style={{ ...btnGhost, display: "flex" }}><X size={16} /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, maxWidth: 640, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <div style={{ ...card, marginBottom: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <ShieldCheck size={17} style={{ color: ORANGE }} /> Autentikasi 2 Faktor (2FA)
          </h3>
          <p style={{ fontSize: 12, color: "#6b7280" }}>Status: <strong>{fa2 ? "Aktif" : "Nonaktif"}</strong></p>
          {!fa2 && !setup && <button onClick={startSetup} style={btn}>Aktifkan 2FA</button>}
          {setup && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 13 }}>Scan QR ini di aplikasi authenticator (Google Authenticator / Authy), atau masukkan secret:</p>
              <img src={"https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(setup.qr)}
                alt="QR 2FA" style={{ border: "1px solid #e5e7eb", borderRadius: 8 }} />
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                <code style={{ fontSize: 11, background: "#f3f4f6", padding: "6px 8px", borderRadius: 6, wordBreak: "break-all" }}>{setup.secret}</code>
                <button onClick={() => navigator.clipboard.writeText(setup.secret)} style={btnGhost}><Copy size={13} /></button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Kode 6 digit" style={{ ...input, flex: 1 }} maxLength={6} />
                <button onClick={verifySetup} style={btn}>Verifikasi</button>
              </div>
            </div>
          )}
          {fa2 && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input type="password" value={disPw} onChange={(e) => setDisPw(e.target.value)} placeholder="Password untuk mematikan" style={{ ...input, flex: 1 }} />
              <button onClick={disable2fa} style={{ ...btnGhost, color: "#dc2626" }}>Matikan</button>
            </div>
          )}
        </div>

        <div style={card}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <Key size={17} style={{ color: ORANGE }} /> API Key Pribadi
          </h3>
          {newKey && (
            <div style={{ background: "#fff7ed", border: "1px solid #fdba74", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Simpan key ini — hanya tampil sekali:</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <code style={{ fontSize: 11, wordBreak: "break-all", flex: 1 }}>{newKey}</code>
                <button onClick={() => navigator.clipboard.writeText(newKey)} style={btnGhost}><Copy size={13} /></button>
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Nama key (mis: CI/CD)" style={{ ...input, flex: 1 }} />
            <button onClick={createKey} style={btn}>Buat</button>
          </div>
          {keys.map((k: any) => (
            <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid #f3f4f6", fontSize: 13 }}>
              <div style={{ flex: 1 }}>
                <strong>{k.name}</strong>
                <div style={{ fontSize: 11, color: "#6b7280" }}><code>{k.prefix}…</code> · {new Date(k.createdAt).toLocaleDateString("id-ID")}</div>
              </div>
              <button onClick={() => delKey(k.id)} style={{ ...btnGhost, color: "#dc2626" }}><Trash2 size={13} /></button>
            </div>
          ))}
          {keys.length === 0 && <p style={{ fontSize: 12, color: "#9ca3af" }}>Belum ada key.</p>}
        </div>
      </div>
    </div>
  );
}
