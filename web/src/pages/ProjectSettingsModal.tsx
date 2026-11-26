import { useEffect, useState } from "react";
import { X, Link2, Lock, Trash2, Users, Webhook, BarChart3, Plus, Inbox, Copy, RefreshCw } from "lucide-react";
import { getToken } from "../lib/api";

const ORANGE = "#F6821F";

async function sreq(path: string, opts: any = {}) {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + getToken(), "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Gagal");
  return d;
}

export default function ProjectSettingsModal({ settings, pid, onClose, onSave, myRole }: any) {
  const p_role = myRole || "owner";
  const [tab, setTab] = useState("umum");
  const [memory, setMemory] = useState(settings.memory || "");
  const [seoTitle, setSeoTitle] = useState(settings.seoTitle || "");
  const [seoDesc, setSeoDesc] = useState(settings.seoDesc || "");
  const [pw, setPw] = useState("");
  const [shareUrl, setShareUrl] = useState(settings.shareToken ? "/share/" + settings.shareToken : "");

  const input = { width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box" as const, marginBottom: 12 };
  const label = { fontSize: 12, fontWeight: 700 as const, color: "#374151", marginBottom: 6, display: "block" as const };
  const tabBtn = (id: string) => ({
    border: "none", background: "none", padding: "8px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700,
    color: tab === id ? ORANGE : "#6b7280", borderBottom: tab === id ? "2px solid " + ORANGE : "2px solid transparent",
    display: "flex", alignItems: "center", gap: 4,
  });

  const tabs = [
    { id: "umum", label: "Umum", icon: null },
    ...(p_role !== "viewer" ? [
      { id: "seo", label: "SEO", icon: null },
      { id: "anggota", label: "Anggota", icon: Users },
      { id: "webhook", label: "Webhook", icon: Webhook },
      { id: "formulir", label: "Formulir", icon: Inbox },
    ] : []),
    { id: "stats", label: "Statistik", icon: BarChart3 },
  ];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "94vw", background: "#fff", borderRadius: 12, height: "fit-content", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ padding: "14px 16px 0", borderBottom: "1px solid #e5e7eb", position: "sticky", top: 0, background: "#fff" }}>
          <div style={{ fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            Pengaturan Proyek
            <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
          </div>
          <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={tabBtn(t.id)}>
                {t.icon && <t.icon size={13} />}{t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: 16 }}>
          {tab === "umum" && <UmumTab {...{ memory, setMemory, seoTitle, setSeoTitle, seoDesc, setSeoDesc, pw, setPw, shareUrl, setShareUrl, settings, pid, input, label }} onSave={onSave} />}
          {tab === "seo" && <SeoTab pid={pid} input={input} label={label} />}
          {tab === "anggota" && <AnggotaTab pid={pid} />}
          {tab === "webhook" && <WebhookTab pid={pid} />}
          {tab === "formulir" && <FormulirTab pid={pid} isOwner={p_role === "owner"} />}
          {tab === "stats" && <StatsTab pid={pid} />}
        </div>
      </div>
    </div>
  );
}

function UmumTab(p: any) {
  const { input, label } = p;
  async function makeShare() {
    const d = await sreq(`/projects/${p.pid}/share`, { method: "POST" });
    if (d.shareUrl) p.setShareUrl(d.shareUrl);
  }
  async function removeShare() {
    await sreq(`/projects/${p.pid}/share`, { method: "DELETE" });
    p.setShareUrl("");
  }
  return (
    <>
      <label style={label}>Memory AI (konteks proyek)</label>
      <textarea value={p.memory} onChange={(e) => p.setMemory(e.target.value)} rows={4}
        placeholder="Contoh:&#10;- Brand: Toko Berkah&#10;- Warna utama: biru navy&#10;- Target: ibu rumah tangga"
        style={{ ...input, resize: "vertical" }} />

      <label style={label}>SEO Title</label>
      <input value={p.seoTitle} onChange={(e) => p.setSeoTitle(e.target.value)} placeholder="Judul situs" style={input} />

      <label style={label}>SEO Description</label>
      <input value={p.seoDesc} onChange={(e) => p.setSeoDesc(e.target.value)} placeholder="Deskripsi situs" style={input} />

      <label style={label}><Lock size={12} style={{ display: "inline", verticalAlign: -2 }} /> Password situs (kosongkan = tanpa password)</label>
      <input type="password" value={p.pw} onChange={(e) => p.setPw(e.target.value)} placeholder={p.settings.hasPassword ? "Sudah diproteksi — isi untuk ganti" : "Tanpa password"} style={input} />

      <label style={label}><Link2 size={12} style={{ display: "inline", verticalAlign: -2 }} /> Share Link (preview tanpa publish)</label>
      {p.shareUrl ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input value={window.location.origin + p.shareUrl} readOnly style={{ ...input, marginBottom: 0, background: "#f9fafb" }} />
          <button onClick={removeShare} title="Hapus link" style={{ border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 8, padding: "0 12px", cursor: "pointer" }}>
            <Trash2 size={14} style={{ color: "#dc2626" }} />
          </button>
        </div>
      ) : (
        <button onClick={makeShare} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
          Buat Share Link
        </button>
      )}

      <button onClick={() => p.onSave({ memory: p.memory, seoTitle: p.seoTitle, seoDesc: p.seoDesc, ...(p.pw ? { sitePassword: p.pw } : {}) })}
        style={{ width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
        Simpan
      </button>
    </>
  );
}

function SeoTab({ pid, input, label }: any) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ogImage, setOgImage] = useState("");
  const [favicon, setFavicon] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/projects/${pid}/seo`, { headers: { Authorization: "Bearer " + getToken() } });
      const d = await r.json().catch(() => ({}));
      setTitle(d.title || "");
      setDescription(d.description || "");
      setOgImage(d.ogImage || "");
      setFavicon(d.favicon || "");
    } catch {}
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/projects/${pid}/seo`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + getToken(), "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, ogImage, favicon }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || "Gagal menyimpan");
      setMsg({ ok: true, text: "Pengaturan SEO tersimpan." });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message || "Gagal menyimpan pengaturan SEO." });
    }
    setSaving(false);
  }

  if (loading) return <p style={{ fontSize: 13, color: "#6b7280" }}>Memuat...</p>;
  return (
    <div>
      <label style={label}>Judul (title)</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Judul situs untuk hasil pencarian" style={input} />
      <label style={label}>Deskripsi (meta description)</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
        placeholder="Deskripsi singkat situs (maks ~160 karakter)" style={{ ...input, resize: "vertical" }} />
      <label style={label}>OG Image (URL)</label>
      <input value={ogImage} onChange={(e) => setOgImage(e.target.value)} placeholder="https://.../og-image.png" style={input} />
      <label style={label}>Favicon (URL)</label>
      <input value={favicon} onChange={(e) => setFavicon(e.target.value)} placeholder="https://.../favicon.ico" style={input} />
      {msg && (
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, padding: "8px 12px", borderRadius: 8,
          background: msg.ok ? "#dcfce7" : "#fef2f2", color: msg.ok ? "#15803d" : "#b91c1c" }}>
          {msg.text}
        </div>
      )}
      <button onClick={save} disabled={saving}
        style={{ width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, fontWeight: 700, cursor: "pointer", fontSize: 13, opacity: saving ? 0.7 : 1 }}>
        {saving ? "Menyimpan..." : "Simpan"}
      </button>
    </div>
  );
}

function AnggotaTab({ pid }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  async function load() {
    try { const d = await sreq(`/projects/${pid}/members`); setMembers(d.members || []); } catch { }
  }
  useEffect(() => { load(); }, []);
  async function add() {
    if (!email.trim()) return;
    await sreq(`/projects/${pid}/members`, { method: "POST", body: JSON.stringify({ email, role }) });
    setEmail(""); load();
  }
  async function del(mid: number) {
    if (!confirm("Hapus anggota?")) return;
    await sreq(`/projects/${pid}/members/${mid}`, { method: "DELETE" });
    load();
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email user..."
          style={{ flex: 1, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, minWidth: 0 }} />
        <select value={role} onChange={(e) => setRole(e.target.value)}
          style={{ padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13 }}>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button onClick={add} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><Plus size={14} /></button>
      </div>
      {members.map((m: any) => (
        <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderTop: "1px solid #f3f4f6", fontSize: 13 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{m.name}</strong>
            <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis" }}>{m.email}</div>
          </div>
          <span style={{ fontSize: 11, background: "#f3f4f6", padding: "3px 8px", borderRadius: 10 }}>{m.role}</span>
          <button onClick={() => del(m.id)} style={{ border: "none", background: "none", cursor: "pointer" }}><Trash2 size={14} style={{ color: "#dc2626" }} /></button>
        </div>
      ))}
      {members.length === 0 && <p style={{ fontSize: 12, color: "#9ca3af" }}>Belum ada anggota. Viewer hanya bisa lihat, editor bisa ubah.</p>}
    </div>
  );
}

function WebhookTab({ pid }: any) {
  const [hooks, setHooks] = useState<any[]>([]);
  const [url, setUrl] = useState("");
  async function load() {
    try { const d = await sreq(`/projects/${pid}/webhooks`); setHooks(d.webhooks || []); } catch { }
  }
  useEffect(() => { load(); }, []);
  async function add() {
    if (!url.trim()) return;
    await sreq(`/projects/${pid}/webhooks`, { method: "POST", body: JSON.stringify({ url }) });
    setUrl(""); load();
  }
  async function del(wid: number) {
    if (!confirm("Hapus webhook?")) return;
    await sreq(`/projects/${pid}/webhooks/${wid}`, { method: "DELETE" });
    load();
  }
  return (
    <div>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 10px" }}>Terima POST saat proyek di-deploy. Header: <code>X-Webhook-Secret</code></p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..."
          style={{ flex: 1, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, minWidth: 0 }} />
        <button onClick={add} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer" }}><Plus size={14} /></button>
      </div>
      {hooks.map((h: any) => (
        <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderTop: "1px solid #f3f4f6", fontSize: 12 }}>
          <code style={{ flex: 1, wordBreak: "break-all" }}>{h.url}</code>
          <button onClick={() => del(h.id)} style={{ border: "none", background: "none", cursor: "pointer" }}><Trash2 size={14} style={{ color: "#dc2626" }} /></button>
        </div>
      ))}
      {hooks.length === 0 && <p style={{ fontSize: 12, color: "#9ca3af" }}>Belum ada webhook.</p>}
    </div>
  );
}

function FormulirTab({ pid, isOwner }: any) {
  const [cfg, setCfg] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [showSnippet, setShowSnippet] = useState(false);

  async function load() {
    try {
      const c = await sreq(`/projects/${pid}/form-settings`);
      setCfg(c);
      const s = await sreq(`/projects/${pid}/forms?limit=20`);
      setSubs(s.items || []); setTotal(s.total || 0);
    } catch { }
  }
  useEffect(() => { load(); }, []);

  async function toggle() {
    const c = await sreq(`/projects/${pid}/form-settings`, { method: "PUT", body: JSON.stringify({ enabled: !cfg.enabled }) });
    setCfg(c);
  }
  async function regen() {
    if (!confirm("Buat token baru? Endpoint lama tidak berlaku lagi.")) return;
    const c = await sreq(`/projects/${pid}/form-settings`, { method: "PUT", body: JSON.stringify({ regenerate: true }) });
    setCfg(c);
  }
  async function del(id: number) {
    if (!confirm("Hapus data ini?")) return;
    await sreq(`/projects/${pid}/forms/${id}`, { method: "DELETE" });
    load();
  }
  function copy(t: string) { navigator.clipboard.writeText(t).catch(() => {}); }

  if (!cfg) return <p style={{ fontSize: 13, color: "#6b7280" }}>Memuat...</p>;
  const snippet = `<form id="kontak">\n  <input name="nama" placeholder="Nama" required />\n  <input name="email" type="email" placeholder="Email" required />\n  <textarea name="pesan" placeholder="Pesan"></textarea>\n  <button>Kirim</button>\n</form>\n<script>\ndocument.getElementById('kontak').addEventListener('submit', async (e) => {\n  e.preventDefault();\n  const data = Object.fromEntries(new FormData(e.target));\n  await fetch('${cfg.endpoint}', {\n    method: 'POST', headers: {'Content-Type': 'application/json'},\n    body: JSON.stringify({ data })\n  });\n  alert('Terkirim!');\n});\n<\/script>`;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Terima data form</span>
        {isOwner && (
          <button onClick={toggle} style={{
            border: "none", borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            background: cfg.enabled ? "#dcfce7" : "#f3f4f6", color: cfg.enabled ? "#15803d" : "#6b7280",
          }}>{cfg.enabled ? "Aktif" : "Nonaktif"}</button>
        )}
      </div>
      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6, display: "block" }}>Endpoint publik</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={cfg.endpoint} readOnly style={{ flex: 1, minWidth: 0, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, background: "#f9fafb" }} />
        <button onClick={() => copy(cfg.endpoint)} title="Salin" style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "0 12px", cursor: "pointer" }}><Copy size={14} /></button>
        {isOwner && <button onClick={regen} title="Token baru" style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "0 12px", cursor: "pointer" }}><RefreshCw size={14} /></button>}
      </div>
      <button onClick={() => setShowSnippet(!showSnippet)} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", marginBottom: 12 }}>
        {showSnippet ? "Sembunyikan" : "Contoh kode HTML"}
      </button>
      {showSnippet && (
        <pre style={{ background: "#1f2937", color: "#e5e7eb", fontSize: 11, padding: 12, borderRadius: 8, overflowX: "auto", marginBottom: 12 }}>{snippet}</pre>
      )}
      <p style={{ fontSize: 11, color: "#9ca3af", margin: "0 0 12px" }}>Minta AI: "tambahkan form kontak yang kirim ke endpoint formulir" — AI otomatis tahu endpointnya.</p>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Data masuk ({total})</div>
      {subs.length === 0 ? <p style={{ fontSize: 12, color: "#9ca3af" }}>Belum ada data.</p> :
        subs.map((s: any) => (
          <div key={s.id} style={{ border: "1px solid #f3f4f6", borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: "#9ca3af" }}>{new Date(s.createdAt).toLocaleString("id-ID")}</span>
              {isOwner && <button onClick={() => del(s.id)} style={{ border: "none", background: "none", cursor: "pointer" }}><Trash2 size={13} style={{ color: "#dc2626" }} /></button>}
            </div>
            {Object.entries(typeof s.data === "string" ? JSON.parse(s.data || "{}") : (s.data || {})).map(([k, v]: any) => (
              <div key={k}><strong>{k}:</strong> {String(v)}</div>
            ))}
          </div>
        ))}
    </div>
  );
}

function StatsTab({ pid }: any) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { sreq(`/projects/${pid}/stats`).then(setD).catch(() => {}); }, []);
  if (!d) return <p style={{ fontSize: 13, color: "#6b7280" }}>Memuat...</p>;
  const max = Math.max(1, ...((d.visits || []).map((v: any) => v.count)));
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{d.total || 0}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>Total kunjungan (30 hari)</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
        {(d.visits || []).slice().reverse().map((v: any) => (
          <div key={v.date} title={v.date + ": " + v.count} style={{ flex: 1, background: ORANGE, borderRadius: "3px 3px 0 0", height: Math.max(3, (v.count / max) * 110) }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>Kunjungan halaman publish per hari</div>
    </div>
  );
}
