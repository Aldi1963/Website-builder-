import { useEffect, useState } from "react";
import { X, ShieldCheck, Users, ScrollText, Activity, LayoutTemplate, SlidersHorizontal, Ban, Search, Plus, Trash2, CreditCard, Zap, UserCheck, Megaphone, Download, Bell } from "lucide-react";
import { getToken, setToken } from "../lib/api";

const ORANGE = "#F6821F";

async function areq(path: string, opts: any = {}) {
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

export default function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState("stats");
  const [loadedTab, setLoadedTab] = useState("");
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");

  const tabs = [
    { id: "stats", label: "Statistik", icon: Activity },
    { id: "users", label: "Pengguna", icon: Users },
    { id: "revenue", label: "Pendapatan", icon: CreditCard },
    { id: "aiusage", label: "AI Usage", icon: Zap },
    { id: "audit", label: "Audit Log", icon: ScrollText },
    { id: "broadcast", label: "Broadcast", icon: Megaphone },
    { id: "templates", label: "Template", icon: LayoutTemplate },
    { id: "platform", label: "Platform", icon: SlidersHorizontal },
    { id: "moderasi", label: "Moderasi", icon: Ban },
  ];

  async function load(t: string) {
    setData(null);
    setLoadedTab("");
    try {
      if (t === "stats") setData(await areq("/admin/stats"));
      else if (t === "users") setData(await areq("/admin/users" + (q ? "?q=" + encodeURIComponent(q) : "")));
      else if (t === "revenue") setData(await areq("/admin/revenue"));
      else if (t === "aiusage") setData(await areq("/admin/ai-usage"));
      else if (t === "audit") setData(await areq("/admin/audit"));
      else if (t === "broadcast") setData({ ok: true });
      else if (t === "templates") setData(await areq("/admin/templates"));
      else if (t === "platform") setData(await areq("/admin/settings"));
      else if (t === "moderasi") setData(await areq("/admin/blocked"));
      setLoadedTab(t);
    } catch (e: any) { setData({ error: e.message }); setLoadedTab(t); }
  }

  useEffect(() => { load(tab); }, [tab]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#f9fafb", zIndex: 90, display: "flex", flexDirection: "column", fontFamily: "system-ui" }}>
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={20} style={{ color: ORANGE }} />
        <strong style={{ fontSize: 16 }}>Admin Panel</strong>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ ...btnGhost, display: "flex" }}><X size={16} /></button>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "12px 16px", overflowX: "auto", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ ...btnGhost, whiteSpace: "nowrap", background: tab === t.id ? ORANGE : "#fff", color: tab === t.id ? "#fff" : "#374151", borderColor: tab === t.id ? ORANGE : "#e5e7eb", display: "flex", alignItems: "center", gap: 6 }}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16, maxWidth: 1000, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        {(!data || loadedTab !== tab) ? <p>Memuat...</p> : data.error ? <p style={{ color: "#dc2626" }}>{data.error}</p> : (
          <>
            {tab === "stats" && <StatsView d={data} />}
            {tab === "users" && <UsersView d={data} q={q} setQ={setQ} reload={() => load("users")} />}
            {tab === "revenue" && <RevenueView d={data} />}
            {tab === "aiusage" && <AIUsageView d={data} />}
            {tab === "audit" && <AuditView d={data} />}
            {tab === "broadcast" && <BroadcastView />}
            {tab === "templates" && <TemplatesView d={data} reload={() => load("templates")} />}
            {tab === "platform" && <PlatformView d={data} />}
            {tab === "moderasi" && <ModerasiView d={data} reload={() => load("moderasi")} />}
          </>
        )}
      </div>
    </div>
  );
}

function StatsView({ d }: any) {
  const items = [
    ["Pengguna", d.users], ["Proyek", d.projects], ["Deployment", d.deployments], ["AI Calls", d.aiCalls],
    ["Memori (MB)", d.memMB], ["Goroutine", d.goroutines],
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
      {items.map(([l, v]) => (
        <div key={l as string} style={card}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{v}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{l}</div>
        </div>
      ))}
    </div>
  );
}

function UsersView({ d, q, setQ, reload }: any) {
  const [edit, setEdit] = useState<any>(null);
  const [pw, setPw] = useState("");
  const [plan, setPlan] = useState("free");
  const [days, setDays] = useState(30);

  async function save() {
    await areq(`/admin/users/${edit.id}`, {
      method: "PUT",
      body: JSON.stringify({ isAdmin: edit.isAdmin, suspended: edit.suspended, ...(pw ? { password: pw } : {}) }),
    });
    await areq(`/admin/users/${edit.id}/plan`, {
      method: "POST",
      body: JSON.stringify({ plan, days: Number(days), suspend: edit.suspended }),
    });
    setEdit(null); setPw(""); reload();
  }

  async function impersonate(id: number) {
    if (!confirm("Login sebagai user ini?")) return;
    try {
      const d = await areq(`/admin/users/${id}/impersonate`, { method: "POST" });
      localStorage.setItem("wb-token-admin", getToken());
      setToken(d.token);
      window.location.href = "/";
    } catch (e: any) { alert(e.message); }
  }

  async function downloadCSV() {
    try {
      const r = await fetch("/api/admin/export/users", { headers: { Authorization: "Bearer " + getToken() } });
      const blob = await r.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "users_export.csv";
      a.click();
    } catch (e: any) { alert("Gagal download CSV: " + e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={15} style={{ position: "absolute", left: 10, top: 11, color: "#9ca3af" }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reload()}
            placeholder="Cari email/nama..." style={{ ...input, paddingLeft: 32 }} />
        </div>
        <button onClick={reload} style={btnGhost}>Cari</button>
        <button onClick={downloadCSV} style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 4 }} title="Download Data CSV">
          <Download size={14} /> CSV
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {(d.users || []).map((u: any) => (
          <div key={u.id} style={{ ...card, padding: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name} {u.isAdmin && <span style={{ fontSize: 10, background: "#fff7ed", color: ORANGE, padding: "2px 6px", borderRadius: 8 }}>ADMIN</span>} {u.suspended && <span style={{ fontSize: 10, background: "#fef2f2", color: "#dc2626", padding: "2px 6px", borderRadius: 8 }}>SUSPENDED</span>}</div>
              <div style={{ fontSize: 12, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email} · {u.projects} proyek</div>
            </div>
            <button onClick={() => { setEdit({ ...u }); setPlan("free"); setDays(30); }} style={btnGhost}>Kelola</button>
            <button onClick={() => impersonate(u.id)} title="Login sebagai user" style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 4 }}>
              <UserCheck size={14} />
            </button>
          </div>
        ))}
      </div>
      {edit && (
        <div onClick={() => setEdit(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 95, display: "flex", justifyContent: "center", paddingTop: 60 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 400, maxWidth: "92vw", height: "fit-content" }}>
            <h3 style={{ margin: "0 0 12px" }}>{edit.email}</h3>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={edit.isAdmin} onChange={(e) => setEdit({ ...edit, isAdmin: e.target.checked })} /> Admin
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 12 }}>
              <input type="checkbox" checked={edit.suspended} onChange={(e) => setEdit({ ...edit, suspended: e.target.checked })} /> Suspended
            </label>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Ubah Paket Langganan</label>
              <select value={plan} onChange={(e) => setPlan(e.target.value)} style={{ ...input, marginBottom: 6 }}>
                <option value="free">Free</option>
                <option value="pro">Pro (Rp99k/bln)</option>
                <option value="team">Team (Rp299k/bln)</option>
              </select>
              <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} placeholder="Hari aktif (misal 30)" style={input} />
            </div>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password baru (opsional)" style={{ ...input, marginBottom: 12 }} />
            <button onClick={save} style={{ ...btn, width: "100%" }}>Simpan</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RevenueView({ d }: any) {
  const max = Math.max(1, ...((d.byDay || []).map((x: any) => x.total)));

  async function downloadCSV() {
    try {
      const r = await fetch("/api/admin/export/revenue", { headers: { Authorization: "Bearer " + getToken() } });
      const blob = await r.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "revenue_export.csv";
      a.click();
    } catch (e: any) { alert("Gagal download CSV: " + e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button onClick={downloadCSV} style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 4 }}>
          <Download size={14} /> Export CSV
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>Rp{(d.total || 0).toLocaleString("id-ID")}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>Total pendapatan</div>
        </div>
        {(d.byPlan || []).map((p: any) => (
          <div key={p.plan} style={card}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>Rp{(p.total || 0).toLocaleString("id-ID")}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>{p.plan} · {p.count}x</div>
          </div>
        ))}
      </div>
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>30 hari terakhir</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120 }}>
          {(d.byDay || []).map((x: any) => (
            <div key={x.date} title={x.date + ": Rp" + x.total.toLocaleString("id-ID")}
              style={{ flex: 1, background: ORANGE, borderRadius: "3px 3px 0 0", height: Math.max(3, (x.total / max) * 110) }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AIUsageView({ d }: any) {
  return (
    <div>
      <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 12px" }}>Pemakaian AI bulan {d.month}</p>
      <div style={{ display: "grid", gap: 8 }}>
        {(d.users || []).map((u: any) => (
          <div key={u.userId} style={{ ...card, padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name}</div>
              <div style={{ fontSize: 12, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
            </div>
            <span style={{ fontSize: 11, background: "#fff7ed", color: ORANGE, padding: "3px 8px", borderRadius: 10, fontWeight: 700 }}>{u.plan}</span>
            <span style={{ fontSize: 12, color: "#6b7280" }}>{u.calls}x · {(u.tokens || 0).toLocaleString("id-ID")} token</span>
          </div>
        ))}
        {(!d.users || d.users.length === 0) && <p style={{ color: "#9ca3af" }}>Belum ada pemakaian bulan ini.</p>}
      </div>
    </div>
  );
}

function AuditView({ d }: any) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {(d.logs || []).map((l: any) => (
        <div key={l.id} style={{ ...card, padding: 10, fontSize: 12 }}>
          <strong>{l.action}</strong> <span style={{ color: "#6b7280" }}>{l.detail}</span>
          <div style={{ color: "#9ca3af", fontSize: 11 }}>user #{l.userId} · {l.ip} · {new Date(l.createdAt).toLocaleString("id-ID")}</div>
        </div>
      ))}
      {(d.logs || []).length === 0 && <p style={{ color: "#9ca3af" }}>Belum ada log.</p>}
    </div>
  );
}

function BroadcastView() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function sendBroadcast() {
    if (!title.trim() || !body.trim() || sending) return;
    if (!confirm("Kirim notifikasi ini ke SELURUH pengguna?")) return;
    setSending(true);
    try {
      const d = await areq("/admin/broadcast", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      alert(d.message || "Notifikasi terkirim");
      setTitle("");
      setBody("");
    } catch (e: any) { alert("Gagal: " + e.message); }
    setSending(false);
  }

  return (
    <div style={{ ...card, maxWidth: 500, margin: "0 auto" }}>
      <h3 style={{ margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
        <Megaphone size={18} style={{ color: ORANGE }} /> Broadcast Notifikasi Massal
      </h3>
      <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 16px" }}>
        Kirim pengumuman penting langsung ke lonceng notifikasi seluruh akun pengguna.
      </p>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Judul Notifikasi</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Contoh: Perbaikan Sistem & Fitur Baru 🚀" style={input} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Isi Pesan</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Jelaskan pengumuman secara singkat dan jelas..." style={{ ...input, fontFamily: "inherit" }} />
      </div>
      <button onClick={sendBroadcast} disabled={sending || !title.trim() || !body.trim()} style={{ ...btn, width: "100%", display: "flex", justifyContent: "center", alignItems: "center", gap: 6 }}>
        <Bell size={15} /> {sending ? "Mengirim..." : "Kirim ke Semua User"}
      </button>
    </div>
  );
}

function TemplatesView({ d, reload }: any) {
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState({ name: "", description: "", category: "", framework: "react", files: "{}" });

  function openNew() { setForm({ name: "", description: "", category: "", framework: "react", files: "{}" }); setEdit("new"); }
  function openEdit(t: any) { setForm({ name: t.name, description: t.description || "", category: t.category || "", framework: t.framework || "react", files: t.files || "{}" }); setEdit(t.id); }

  async function save() {
    await areq("/admin/templates", { method: "POST", body: JSON.stringify(edit === "new" ? form : { ...form, id: edit }) });
    setEdit(null); reload();
  }
  async function del(id: number) {
    if (!confirm("Hapus template?")) return;
    await areq(`/admin/templates/${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <div>
      <button onClick={openNew} style={{ ...btn, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}><Plus size={14} /> Template Baru</button>
      <div style={{ display: "grid", gap: 8 }}>
        {(d.templates || []).map((t: any) => (
          <div key={t.id} style={{ ...card, padding: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>{t.category} · {t.framework}</div>
            </div>
            <button onClick={() => openEdit(t)} style={btnGhost}>Edit</button>
            <button onClick={() => del(t.id)} style={{ ...btnGhost, color: "#dc2626" }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      {edit && (
        <div onClick={() => setEdit(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 95, display: "flex", justifyContent: "center", paddingTop: 40 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 560, maxWidth: "94vw", maxHeight: "85vh", overflowY: "auto" }}>
            <h3 style={{ margin: "0 0 12px" }}>{edit === "new" ? "Template Baru" : "Edit Template"}</h3>
            {["name", "description", "category", "framework"].map((f) => (
              <input key={f} value={(form as any)[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                placeholder={f} style={{ ...input, marginBottom: 8 }} />
            ))}
            <textarea value={form.files} onChange={(e) => setForm({ ...form, files: e.target.value })} rows={8}
              placeholder='JSON files: {"src/App.tsx": "..."}' style={{ ...input, fontFamily: "monospace", fontSize: 11, marginBottom: 12 }} />
            <button onClick={save} style={{ ...btn, width: "100%" }}>Simpan</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Provider AI per prompt (trek 1/4): daftar provider yang bisa dipilih
// user di composer chat. Key disimpan terenkripsi di server (tidak pernah
// dikembalikan ke klien); daftar model bisa dimuat dari provider
// (GET {base}/models) supaya 100 model 9router langsung bisa dipilih.
function AIProvidersSection() {
  const [providers, setProviders] = useState<any[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<any>({ id: 0, name: "", baseUrl: "", apiKey: "", modelsText: "", isDefault: false });
  async function load() {
    try {
      const d = await areq("/admin/ai-providers");
      setProviders(d.providers || []);
    } catch (e: any) { setStatus("Gagal memuat provider: " + e.message); }
  }
  useEffect(() => { load(); }, []);
  function modelsFromText(t: string) {
    return t.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  }
  async function save() {
    if (!form.name.trim() || !form.baseUrl.trim()) { setStatus("Nama dan base URL wajib diisi."); return; }
    setBusy(true); setStatus("");
    try {
      const body: any = { name: form.name.trim(), baseUrl: form.baseUrl.trim(), models: modelsFromText(form.modelsText), isDefault: !!form.isDefault };
      if (form.apiKey) body.apiKey = form.apiKey;
      if (form.id) await areq(`/admin/ai-providers/${form.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await areq("/admin/ai-providers", { method: "POST", body: JSON.stringify(body) });
      setForm({ id: 0, name: "", baseUrl: "", apiKey: "", modelsText: "", isDefault: false });
      await load();
      setStatus("Provider tersimpan (API key terenkripsi).");
    } catch (e: any) { setStatus("Gagal menyimpan: " + e.message); }
    finally { setBusy(false); }
  }
  async function del(id: number) {
    if (!confirm("Hapus provider ini?")) return;
    setBusy(true);
    try { await areq(`/admin/ai-providers/${id}`, { method: "DELETE" }); await load(); setStatus("Provider dihapus."); }
    catch (e: any) { setStatus("Gagal menghapus: " + e.message); }
    finally { setBusy(false); }
  }
  async function fetchModels(id: number) {
    setBusy(true); setStatus("");
    try {
      const d = await areq(`/admin/ai-providers/${id}/fetch-models`, { method: "POST" });
      await load();
      setStatus(`Daftar model dimuat: ${d.count} model.`);
    } catch (e: any) { setStatus("Gagal memuat model: " + e.message); }
    finally { setBusy(false); }
  }
  async function test(id: number, model: string) {
    setBusy(true); setStatus("");
    try {
      const d = await areq(`/admin/ai-providers/${id}/test`, { method: "POST", body: JSON.stringify({ model }) });
      setStatus(`Tes ${d.model}: ${d.reply}`);
    } catch (e: any) { setStatus("Tes gagal: " + e.message); }
    finally { setBusy(false); }
  }
  function edit(p: any) {
    setForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: "", modelsText: (p.models || []).join("\n"), isDefault: !!p.isDefault });
    setStatus("");
  }
  return (
    <section style={card}>
      <h3 style={{ margin: "0 0 6px" }}>Provider AI (pemilih per prompt)</h3>
      <p style={{ margin: "0 0 14px", color: "#6b7280", fontSize: 12 }}>
        Provider di sini muncul di dropdown composer chat; user bisa ganti provider + model di tiap prompt.
        Provider pertama dibuat otomatis dari konfigurasi AI Global di atas. API key disimpan terenkripsi dan tidak pernah ditampilkan.
      </p>
      {providers.map((p: any) => (
        <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 10px", marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <strong style={{ fontSize: 13 }}>{p.name}</strong>
            {p.isDefault && <span style={{ fontSize: 10, fontWeight: 700, color: "#15803d", background: "#dcfce7", borderRadius: 12, padding: "2px 7px", marginLeft: 6 }}>DEFAULT</span>}
            {!p.enabled && <span style={{ fontSize: 10, fontWeight: 700, color: "#b91c1c", background: "#fee2e2", borderRadius: 12, padding: "2px 7px", marginLeft: 6 }}>NONAKTIF</span>}
            <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl} · {(p.models || []).length} model{p.hasKey ? " · key tersimpan" : " · tanpa key"}</div>
          </div>
          <button type="button" onClick={() => fetchModels(p.id)} disabled={busy} style={{ ...btnGhost, padding: "6px 10px" }}>Muat model</button>
          <button type="button" onClick={() => test(p.id, (p.models || [])[0] || "")} disabled={busy || !(p.models || []).length} style={{ ...btnGhost, padding: "6px 10px" }}>Tes</button>
          <button type="button" onClick={() => edit(p)} disabled={busy} style={{ ...btnGhost, padding: "6px 10px" }}>Edit</button>
          <button type="button" onClick={() => del(p.id)} disabled={busy} style={{ ...btnGhost, padding: "6px 10px", color: "#dc2626" }}><Trash2 size={14} /></button>
        </div>
      ))}
      {providers.length === 0 && <p style={{ fontSize: 12, color: "#6b7280" }}>Belum ada provider. Tambahkan di bawah — atau isi konfigurasi AI Global di atas lalu muat ulang halaman (provider Default dibuat otomatis).</p>}
      <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 12, marginTop: 4 }}>
        <h4 style={{ margin: "0 0 10px", fontSize: 13 }}>{form.id ? "Edit Provider" : "Tambah Provider"}</h4>
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Nama</label>
        <input aria-label="Nama provider" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="mis. 9router" style={{ ...input, marginBottom: 10 }} />
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Base URL (OpenAI-compatible)</label>
        <input aria-label="Base URL provider" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://ai.clipku.com/v1 atau http://localhost:11434/v1 (Ollama)" style={{ ...input, marginBottom: 10 }} />
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>API Key {form.id ? "(kosongkan untuk mempertahankan)" : "(boleh kosong untuk Ollama lokal)"}</label>
        <input aria-label="API key provider" type="password" autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.id ? "Key tersimpan — isi hanya untuk mengganti" : "Tempel API key provider"} style={{ ...input, marginBottom: 10 }} />
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Daftar model (satu per baris — atau kosongkan lalu klik “Muat model”)</label>
        <textarea aria-label="Daftar model provider" value={form.modelsText} onChange={(e) => setForm({ ...form, modelsText: e.target.value })} rows={4} placeholder={"cx/gpt-5.6-luna\noc/deepseek/deepseek-v4.1-flash"} style={{ ...input, fontFamily: "monospace", fontSize: 12, marginBottom: 10 }} />
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
          <input type="checkbox" checked={!!form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Jadikan provider default
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={busy} onClick={save} style={btn}>{busy ? "Memproses…" : form.id ? "Simpan Perubahan" : "Tambah Provider"}</button>
          {form.id ? <button disabled={busy} onClick={() => setForm({ id: 0, name: "", baseUrl: "", apiKey: "", modelsText: "", isDefault: false })} style={btnGhost}>Batal</button> : null}
        </div>
        {status && <p role="status" style={{ margin: "10px 0 0", color: status.includes("Gagal") || status.includes("gagal") ? "#dc2626" : "#15803d", fontSize: 12 }}>{status}</p>}
      </div>
    </section>
  );
}

function PlatformView({ d }: any) {
  const [form, setForm] = useState<any>(d.settings || {});
  const [ai, setAi] = useState<any>({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "", hasKey: false });
  const [aiStatus, setAiStatus] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelFilter, setModelFilter] = useState("deepseek");
  const filteredModels = models.filter((m) => m.toLowerCase().includes(modelFilter.trim().toLowerCase()));
  const dsCount = models.filter((m) => m.toLowerCase().includes("deepseek")).length;
  async function loadModels() {
    setModelsBusy(true); setAiStatus("");
    try {
      const r = await areq("/admin/ai-models?baseUrl=" + encodeURIComponent(ai.baseUrl));
      setModels(r.models || []);
      if (!(r.models || []).length) setAiStatus("Provider tidak mengembalikan model.");
    } catch (e: any) { setAiStatus("Gagal memuat model: " + e.message); }
    finally { setModelsBusy(false); }
  }
  useEffect(() => {
    areq("/admin/ai-config").then((cfg) => setAi((old: any) => ({ ...old, ...cfg, apiKey: "" }))).catch((e) => setAiStatus(e.message));
  }, []);
  async function saveAI() {
    setAiBusy(true); setAiStatus("");
    try {
      await areq("/admin/ai-config", { method: "PUT", body: JSON.stringify({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }) });
      setAi((old: any) => ({ ...old, apiKey: "", hasKey: old.apiKey ? true : old.hasKey }));
      setAiStatus("Konfigurasi AI tersimpan (API key terenkripsi).");
    } catch (e: any) { setAiStatus(e.message); }
    finally { setAiBusy(false); }
  }
  async function testAI() {
    setAiBusy(true); setAiStatus("");
    try {
      const result = await areq("/admin/ai-config/test", { method: "POST", body: JSON.stringify({ baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }) });
      setAiStatus("Terhubung: " + result.reply);
    } catch (e: any) { setAiStatus("Tes gagal: " + e.message); }
    finally { setAiBusy(false); }
  }
  const aiProviders: any = {
    "DeepSeek via gateway (siap pakai)": { baseUrl: "https://ai.clipku.com/v1", model: "oc/deepseek/deepseek-v4.1-flash" },
    "DeepSeek official": { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
    "OpenAI": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    "OpenRouter": { baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" },
  };
  function selectAIProvider(name: string) { setAi((old: any) => ({ ...old, ...aiProviders[name] })); }
  const fields = [
    ["site_url", "URL Situs"],
    ["smtp_host", "SMTP Host"],
    ["smtp_port", "SMTP Port"],
    ["smtp_user", "SMTP User"],
    ["smtp_password", "SMTP Password"],
    ["smtp_from", "SMTP From"],
    ["oauth_google_client_id", "Google Client ID"],
    ["oauth_google_client_secret", "Google Client Secret"],
    ["oauth_github_client_id", "GitHub Client ID"],
    ["oauth_github_client_secret", "GitHub Client Secret"],
    ["maintenance_mode", "Maintenance Mode (1 = on, 0 = off)"],
    ["announcement", "Pengumuman (banner atas)"],
    ["quota_projects_free", "Batas proyek — Free"],
    ["quota_projects_pro", "Batas proyek — Pro"],
    ["quota_projects_team", "Batas proyek — Team"],
    ["quota_tokens_free", "Kuota token AI/bln — Free"],
    ["quota_tokens_pro", "Kuota token AI/bln — Pro"],
    ["quota_tokens_team", "Kuota token AI/bln — Team"],
  ];
  async function save() {
    await areq("/admin/settings", { method: "PUT", body: JSON.stringify(form) });
    alert("Tersimpan");
  }
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={card}>
        <h3 style={{ margin: "0 0 6px" }}>AI Provider</h3>
        <p style={{ margin: "0 0 14px", color: "#6b7280", fontSize: 12 }}>Pilih model untuk chat dan pembuatan project. API key disimpan terenkripsi di server.</p>
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Provider</label>
        <select aria-label="AI Provider" onChange={(e) => e.target.value && selectAIProvider(e.target.value)} defaultValue="" style={{ ...input, marginBottom: 10 }}>
          <option value="">— pilih preset provider —</option>
          {Object.keys(aiProviders).map((name) => <option key={name}>{name}</option>)}
        </select>
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Base URL</label>
        <input aria-label="AI Base URL" value={ai.baseUrl} onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })} style={{ ...input, marginBottom: 10 }} />
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>Model</label>
        <input aria-label="AI Model" value={ai.model} onChange={(e) => setAi({ ...ai, model: e.target.value })} style={{ ...input, marginBottom: 6 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <button type="button" onClick={loadModels} disabled={modelsBusy} style={{ ...btnGhost, padding: "6px 10px" }}>
            {modelsBusy ? "Memuat model…" : "Muat daftar model"}
          </button>
          {models.length > 0 && <span style={{ fontSize: 11, color: "#6b7280" }}>{models.length} model tersedia · {dsCount} DeepSeek</span>}
        </div>
        {models.length > 0 && (
          <>
            <input aria-label="Cari model" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="Cari model, mis. deepseek" style={{ ...input, marginBottom: 6 }} />
            <select aria-label="Pilih model" value={models.includes(ai.model) ? ai.model : ""} onChange={(e) => e.target.value && setAi({ ...ai, model: e.target.value })} style={{ ...input, marginBottom: 10 }}>
              <option value="">— pilih model ({filteredModels.length}) —</option>
              {filteredModels.slice(0, 200).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </>
        )}
        <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>API Key {ai.hasKey && <span style={{ color: "#15803d" }}>(sudah tersimpan; kosongkan untuk mempertahankan)</span>}</label>
        <input aria-label="AI API Key" type="password" autoComplete="new-password" value={ai.apiKey} onChange={(e) => setAi({ ...ai, apiKey: e.target.value })} placeholder={ai.hasKey ? "Key tersimpan — isi hanya untuk mengganti" : "Tempel API key provider"} style={{ ...input, marginBottom: 10 }} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={aiBusy} onClick={testAI} style={btn}>{aiBusy ? "Memproses…" : "Tes Koneksi"}</button>
          <button disabled={aiBusy} onClick={saveAI} style={btnGhost}>Simpan AI Provider</button>
        </div>
        {aiStatus && <p role="status" style={{ margin: "10px 0 0", color: aiStatus.includes("gagal") || aiStatus.includes("Gagal") ? "#dc2626" : "#15803d", fontSize: 12 }}>{aiStatus}</p>}
      </section>
      <AIProvidersSection />
      <section style={card}>
        <h3 style={{ margin: "0 0 14px" }}>Pengaturan Platform</h3>
      {fields.map(([k, l]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 700, display: "block", marginBottom: 4 }}>{l}</label>
          <input value={form[k] || ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            type={(k.includes("password") || k.includes("secret")) ? "password" : "text"} style={input} />
        </div>
      ))}
      <button onClick={save} style={{ ...btn, width: "100%" }}>Simpan Pengaturan</button>
      </section>
    </div>
  );
}

function ModerasiView({ d, reload }: any) {
  const [word, setWord] = useState("");
  async function add() {
    if (!word.trim()) return;
    await areq("/admin/blocked", { method: "POST", body: JSON.stringify({ word: word.trim() }) });
    setWord(""); reload();
  }
  async function del(id: number) {
    await areq(`/admin/blocked/${id}`, { method: "DELETE" });
    reload();
  }
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Kata yang diblokir..."
          style={{ ...input, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button onClick={add} style={btn}>Tambah</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {(d.words || []).map((w: any) => (
          <span key={w.id} style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 20, padding: "6px 12px", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            {w.word}
            <X size={13} style={{ cursor: "pointer", color: "#dc2626" }} onClick={() => del(w.id)} />
          </span>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#6b7280", marginTop: 12 }}>Pesan chat AI yang mengandung kata ini akan ditolak.</p>
    </div>
  );
}
