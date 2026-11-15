import { useEffect, useState } from "react";
import { api, setToken, getToken } from "../lib/api";
import { Plus, LogOut, FolderOpen, LayoutTemplate, Rocket, Globe, BarChart3, CreditCard, Settings, Trash2, ShieldCheck, Bell } from "lucide-react";
import AdminPanel from "./AdminPanel";
import Profile from "./Profile";
import "../dashboard.css";

const ORANGE = "#F6821F";

function useIsMobile() {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setM(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return m;
}

async function req(path: string, opts: any = {}) {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Gagal");
  return d;
}

  const ext = {
    templates: (q = "", cat = "") => req("/templates" + (q || cat ? `?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}` : "")),
  useTemplate: (id: number, name: string) => req(`/templates/${id}/use`, { method: "POST", body: JSON.stringify({ name }) }),
  publishTemplate: (projectId: number, name: string, description: string, category: string) => req("/templates", { method: "POST", body: JSON.stringify({ projectId, name, description, category }) }),
  delTemplate: (id: number) => req(`/templates/${id}`, { method: "DELETE" }),
  verifyDomain: (id: number) => req(`/domains/${id}/verify`, { method: "POST" }),
  domainDns: (id: number) => req(`/domains/${id}/dns`),
  domainSsl: (id: number) => req(`/domains/${id}/ssl`, { method: "POST" }),
  deployments: () => req("/deployments"),
  domains: () => req("/domains"),
  addDomain: (domain: string) => req("/domains", { method: "POST", body: JSON.stringify({ domain }) }),
  delDomain: (id: number) => req(`/domains/${id}`, { method: "DELETE" }),
  usage: () => req("/usage"),
  billing: () => req("/billing"),
  updateProfile: (name: string) => req("/me", { method: "PUT", body: JSON.stringify({ name }) }),
  changePassword: (oldPw: string, newPw: string) => req("/me/password", { method: "PUT", body: JSON.stringify({ old: oldPw, new: newPw }) }),
  getAiConfig: () => req("/admin/ai-config"),
  setAiConfig: (baseUrl: string, apiKey: string, model: string) => req("/admin/ai-config", { method: "PUT", body: JSON.stringify({ baseUrl, apiKey, model }) }),
  notifications: () => req("/notifications"),
  readNotifications: () => req("/notifications/read", { method: "POST" }),
  checkout: (plan: string) => req("/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) }),
  paymentStatus: (orderId: string) => req(`/billing/status/${orderId}`),
};


export default function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [sharedProjects, setSharedProjects] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("projects");
  const [data, setData] = useState<any>(null);
  const [newDomain, setNewDomain] = useState("");
  const [profileName, setProfileName] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [msg, setMsg] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useIsMobile();
  const [aiBase, setAiBase] = useState("");
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiHasKey, setAiHasKey] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [notifs, setNotifs] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);
  const [checkingOut, setCheckingOut] = useState("");
  const [payInfo, setPayInfo] = useState<any>(null);
  const [tplQ, setTplQ] = useState("");
  const [tplCat, setTplCat] = useState("");
  const [showPubTpl, setShowPubTpl] = useState(false);
  const [pubTpl, setPubTpl] = useState({ projectId: "", name: "", description: "", category: "" });
  const [previewDep, setPreviewDep] = useState<any>(null);
  const [previewPid, setPreviewPid] = useState("");
  const [quickStart, setQuickStart] = useState("");

  async function handleQuickStart(promptText?: string) {
    const text = (promptText || quickStart).trim();
    if (!text) return;
    const words = text.split(" ").slice(0, 5).join(" ");
    const projName = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Proyek Baru";
    try {
      const d = await api.createProject(projName, "react");
      sessionStorage.setItem("wb_initial_prompt", text);
      onOpen(String(d.project.id));
    } catch (e: any) { alert("Gagal membuat proyek: " + e.message); }
  }

  async function checkout(plan: string) {
    if (!confirm("Upgrade ke " + plan + "?")) return;
    setCheckingOut(plan);
    try {
      const d = await ext.checkout(plan);
      setPayInfo(d);
    } catch (e: any) { alert(e.message); }
    setCheckingOut("");
  }

  async function checkPayment(orderId: string) {
    const d = await ext.paymentStatus(orderId);
    alert("Status: " + d.status);
    if (d.status === "paid") { setPayInfo(null); setTab("billing"); }
  }

  useEffect(() => {
    api.projects().then((d) => { setProjects(d.projects || []); setSharedProjects(d.shared || []); }).finally(() => setLoading(false));
    api.me().then((d) => { setProfileName(d.user?.name || ""); setIsAdmin(!!d.user?.isAdmin); }).catch(() => {});
    loadNotifs();
  }, []);

  async function loadNotifs() {
    try {
      const d = await ext.notifications();
      setNotifs(d.notifications || []); setUnread(d.unread || 0);
    } catch { }
  }

  async function readNotifs() {
    await ext.readNotifications().catch(() => {});
    setUnread(0);
  }

  function loadTemplates() { ext.templates(tplQ, tplCat).then(setData).catch(() => {}); }
  useEffect(() => {
    setData(null);
    setMsg("");
    if (tab === "templates") loadTemplates();
    if (tab === "deploy") ext.deployments().then(setData).catch(() => {});
    if (tab === "domains") ext.domains().then(setData).catch(() => {});
    if (tab === "usage") ext.usage().then(setData).catch(() => {});
    if (tab === "billing") ext.billing().then(setData).catch(() => {});
    if (tab === "settings") ext.getAiConfig().then((d) => {
      setAiBase(d.baseUrl || ""); setAiModel(d.model || ""); setAiHasKey(d.hasKey);
    }).catch(() => {});
  }, [tab]);

  async function create() {
    if (!name.trim()) return;
    const d = await api.createProject(name, "react");
    onOpen(String(d.project.id));
  }

  async function useTpl(id: number, tname: string) {
    const d = await ext.useTemplate(id, tname);
    onOpen(String(d.project.id));
  }

  async function addDom() {
    if (!newDomain.trim()) return;
    const sel = document.getElementById("dom-proj") as HTMLSelectElement | null;
    try {
      await req("/domains", { method: "POST", body: JSON.stringify({ domain: newDomain.trim(), projectId: sel?.value ? Number(sel.value) : 0 }) });
      setNewDomain("");
      ext.domains().then(setData);
      setMsg("Domain ditambah. Atur CNAME di DNS lalu verifikasi.");
    } catch (e: any) { setMsg(e.message); }
  }

  async function saveProfile() {
    try {
      await ext.updateProfile(profileName);
      setMsg("Profil disimpan");
    } catch (e: any) { setMsg(e.message); }
  }

  async function saveAi() {
    try {
      await ext.setAiConfig(aiBase, aiKey, aiModel);
      setAiKey("");
      setMsg("Konfigurasi AI tersimpan");
      const d = await ext.getAiConfig();
      setAiHasKey(d.hasKey);
    } catch (e: any) { setMsg(e.message); }
  }

  async function savePw() {
    try {
      await ext.changePassword(oldPw, newPw);
      setOldPw(""); setNewPw("");
      setMsg("Password diubah");
    } catch (e: any) { setMsg(e.message); }
  }

  const menu = [
    { id: "projects", label: "Projects", icon: FolderOpen },
    { id: "templates", label: "Templates", icon: LayoutTemplate },
    { id: "deploy", label: "Deployments", icon: Rocket },
    { id: "domains", label: "Domains", icon: Globe },
    { id: "usage", label: "Usage", icon: BarChart3 },
    { id: "billing", label: "Billing", icon: CreditCard },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 };

  return (
    <div className="wb-dashboard" style={{ display: "flex", height: "100vh", background: "#f9fafb", fontFamily: "system-ui", overflowX: "clip", maxWidth: "100vw" }}>
      {/* Mobile topbar */}
      {isMobile && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 30, background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setDrawerOpen(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20 }}>☰</button>
          <h1 style={{ fontSize: 17, fontWeight: 800, margin: 0, flex: 1 }}>Web<span style={{ color: ORANGE }}>Builder</span></h1>
          <div style={{ position: "relative" }}>
            <button onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs) readNotifs(); }} style={{ background: "none", border: "none", cursor: "pointer", position: "relative", padding: 4 }}>
              <Bell size={19} />
              {unread > 0 && <span style={{ position: "absolute", top: 0, right: 0, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 10, padding: "1px 5px" }}>{unread}</span>}
            </button>
            {showNotifs && (
              <div style={{ position: "absolute", right: 0, top: 32, width: 300, maxWidth: "80vw", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 100, maxHeight: 320, overflowY: "auto" }}>
                {notifs.length === 0 ? <p style={{ padding: 16, fontSize: 13, color: "#6b7280" }}>Tidak ada notifikasi.</p> :
                  notifs.map((n: any) => (
                    <div key={n.id} style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", background: n.read ? "#fff" : "#fff7ed" }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{n.title}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{n.body}</div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Sidebar / drawer */}
      <div className="wb-dashboard-sidebar" style={{
        width: 220, background: "#fff", borderRight: "1px solid #e5e7eb", display: "flex", flexDirection: "column",
        ...(isMobile ? {
          position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 40,
          transform: drawerOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.2s", boxShadow: "2px 0 12px rgba(0,0,0,0.1)",
        } : {}),
      }}>
        <div style={{ padding: "16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center" }}>
          <h1 className="wb-dashboard-logo" style={{ fontSize: 18, fontWeight: 800, margin: 0, flex: 1 }}>web<span>builder</span><i>.</i></h1>
          {!isMobile && <div style={{ position: "relative" }}>
            <button onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs) readNotifs(); }} style={{ background: "none", border: "none", cursor: "pointer", position: "relative", padding: 4 }}>
              <Bell size={19} />
              {unread > 0 && <span style={{ position: "absolute", top: 0, right: 0, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 10, padding: "1px 5px" }}>{unread}</span>}
            </button>
            {showNotifs && (
              <div style={{ position: "absolute", right: 0, top: 32, width: 300, maxWidth: "80vw", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 100, maxHeight: 320, overflowY: "auto" }}>
                {notifs.length === 0 ? <p style={{ padding: 16, fontSize: 13, color: "#6b7280" }}>Tidak ada notifikasi.</p> :
                  notifs.map((n: any) => (
                    <div key={n.id} style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", background: n.read ? "#fff" : "#fff7ed" }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{n.title}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{n.body}</div>
                    </div>
                  ))}
              </div>
            )}
          </div>}
        </div>
        <div style={{ flex: 1, padding: 8, overflowY: "auto" }}>
          {menu.map((m) => (
            <button key={m.id} onClick={() => { setTab(m.id); setDrawerOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: tab === m.id ? "#fff7ed" : "transparent", color: tab === m.id ? ORANGE : "#374151", fontSize: 14, fontWeight: tab === m.id ? 600 : 400, marginBottom: 2, textAlign: "left" }}>
              <m.icon size={17} />{m.label}
            </button>
          ))}
          {isAdmin && (
            <button onClick={() => { window.location.href = "/admin"; }}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "#374151", fontSize: 14, marginBottom: 2, textAlign: "left" }}>
              <ShieldCheck size={17} />Admin Panel
            </button>
          )}
          <button onClick={() => { setShowProfile(true); setDrawerOpen(false); }}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "#374151", fontSize: 14, marginBottom: 2, textAlign: "left" }}>
            <Settings size={17} />Profil & Keamanan
          </button>
        </div>
        <div style={{ padding: 12, borderTop: "1px solid #e5e7eb" }}>
          <button onClick={() => { setToken(""); window.location.reload(); }}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "#6b7280", fontSize: 14 }}>
            <LogOut size={17} /> Keluar
          </button>
        </div>
      </div>

      {/* Drawer backdrop */}
      {isMobile && drawerOpen && (
        <div onClick={() => setDrawerOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 35 }} />
      )}

      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      {showProfile && <Profile onClose={() => setShowProfile(false)} />}

      <div style={{ flex: 1, overflowY: "auto", overflowX: "clip", padding: isMobile ? 68 : 28, paddingLeft: isMobile ? 16 : 28, paddingRight: isMobile ? 16 : 28, maxWidth: "100vw", boxSizing: "border-box" }}>
        {msg && <div style={{ ...card, marginBottom: 16, borderColor: ORANGE, fontSize: 13 }}>{msg}</div>}

        {tab === "projects" && (
          <>
            <div className="wb-page-intro"><div><span className="wb-kicker">WORKSPACE</span><h2 style={{ fontSize: 30, fontWeight: 800, margin: "7px 0 5px", letterSpacing: "-.05em" }}>Project kamu</h2><p style={{ margin: 0, color: "#69736b", fontSize: 13 }}>Bangun, uji, dan luncurkan produk dari satu tempat.</p></div><span className="wb-project-count">{projects.length} project</span></div>
            <div style={{ ...card, marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Buat proyek baru</h3>
              <div style={{ display: "flex", gap: 8, maxWidth: "100%" }}>
                <input placeholder="Nama proyek" value={name} onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                  style={{ flex: "1 1 0", minWidth: 0, border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14 }} />
                <button onClick={create} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <Plus size={16} /> Buat
                </button>
              </div>
            </div>
            {loading ? <p>Memuat...</p> : projects.length === 0 && sharedProjects.length === 0 ? (
              <div style={{ ...card, borderStyle: "dashed", textAlign: "center", padding: "48px 24px" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🚀</div>
                <h3 style={{ fontSize: 20, fontWeight: 800, color: "#111827", margin: "0 0 6px" }}>Mulai bangun aplikasimu</h3>
                <p style={{ color: "#6b7280", fontSize: 14, margin: "0 0 24px", lineHeight: 1.5 }}>
                  Deskripsikan aplikasi yang kamu inginkan, dan AI akan membangunnya untukmu dalam hitungan detik.
                </p>
                <div style={{ display: "flex", gap: 8, maxWidth: 500, margin: "0 auto 20px" }}>
                  <input
                    value={quickStart}
                    onChange={(e) => setQuickStart(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleQuickStart()}
                    placeholder="Contoh: buat aplikasi todo list yang keren..."
                    style={{ flex: 1, border: "2px solid #e5e7eb", borderRadius: 10, padding: "11px 14px", fontSize: 14, outline: "none" }}
                    onFocus={(e) => (e.target.style.borderColor = ORANGE)}
                    onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
                  />
                  <button
                    onClick={() => handleQuickStart()}
                    style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 10, padding: "11px 20px", fontWeight: 700, cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" }}
                  >
                    Buat →
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                  {["Landing page startup", "Aplikasi manajemen tugas", "Dashboard analytics", "Toko online sederhana", "Blog personal", "Form registrasi"].map((t) => (
                    <button
                      key={t}
                      onClick={() => handleQuickStart(t)}
                      style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 20, padding: "6px 14px", fontSize: 13, cursor: "pointer", color: "#374151" }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
                {projects.map((p) => (
                  <button key={p.id} onClick={() => onOpen(String(p.id))}
                    style={{ ...card, textAlign: "left", cursor: "pointer", padding: 18 }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = ORANGE)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#e5e7eb")}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "#6b7280" }}>{p.framework} · /{p.slug}</div>
                  </button>
                ))}
              </div>
              {sharedProjects.length > 0 && (
                <>
                  <h3 style={{ fontSize: 14, fontWeight: 700, margin: "20px 0 12px", color: "#6b7280" }}>Dibagikan ke saya</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
                    {sharedProjects.map((p) => (
                      <button key={"s" + p.id} onClick={() => onOpen(String(p.id))}
                        style={{ ...card, textAlign: "left", cursor: "pointer", padding: 18 }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = ORANGE)}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#e5e7eb")}>
                        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{p.name}</div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>{p.role} · oleh {p.owner}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              </>
            )}
          </>
        )}

        {tab === "templates" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, flex: 1 }}>Templates</h2>
              <button onClick={() => setShowPubTpl(!showPubTpl)}
                style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
                + Jadikan Template
              </button>
            </div>
            {showPubTpl && (
              <div style={{ ...card, marginBottom: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px" }}>Publish proyek sebagai template</h3>
                <select value={pubTpl.projectId} onChange={(e) => setPubTpl({ ...pubTpl, projectId: e.target.value })}
                  style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }}>
                  <option value="">Pilih proyek...</option>
                  {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input placeholder="Nama template" value={pubTpl.name} onChange={(e) => setPubTpl({ ...pubTpl, name: e.target.value })}
                  style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
                <input placeholder="Deskripsi" value={pubTpl.description} onChange={(e) => setPubTpl({ ...pubTpl, description: e.target.value })}
                  style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <input placeholder="Kategori (mis: toko, portofolio)" value={pubTpl.category} onChange={(e) => setPubTpl({ ...pubTpl, category: e.target.value })}
                    style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: 10, fontSize: 13, minWidth: 0 }} />
                  <button onClick={async () => {
                    try {
                      await ext.publishTemplate(Number(pubTpl.projectId), pubTpl.name, pubTpl.description, pubTpl.category);
                      setShowPubTpl(false); setPubTpl({ projectId: "", name: "", description: "", category: "" });
                      loadTemplates(); setMsg("Template dipublish");
                    } catch (e: any) { alert(e.message); }
                  }} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
                    Publish
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input placeholder="Cari template..." value={tplQ} onChange={(e) => setTplQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadTemplates()}
                style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, minWidth: 0 }} />
              <input placeholder="Kategori" value={tplCat} onChange={(e) => setTplCat(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadTemplates()}
                style={{ width: 130, border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14 }} />
              <button onClick={loadTemplates} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer", fontSize: 13 }}>Cari</button>
            </div>
            {!data ? <p>Memuat...</p> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                {data.templates?.map((t: any) => (
                  <div key={t.id} style={card}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 12, color: ORANGE, fontWeight: 700 }}>{t.category || "Umum"}</span>
                      {t.featured && <span style={{ fontSize: 10, fontWeight: 700, background: "#fff7ed", color: ORANGE, padding: "2px 8px", borderRadius: 10 }}>FEATURED</span>}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{t.name}</div>
                    <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>{t.description}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>{t.uses || 0}x dipakai · {t.framework}{t.ownerName ? ` · oleh ${t.ownerName}` : ""}</div>
                    <button onClick={() => useTpl(t.id, t.name)}
                      style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, cursor: "pointer", fontSize: 13, width: "100%" }}>
                      Gunakan Template
                    </button>
                  </div>
                ))}
                {(!data.templates || data.templates.length === 0) && <p style={{ color: "#9ca3af" }}>Tidak ada template.</p>}
              </div>
            )}
          </>
        )}

        {tab === "deploy" && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Deployments</h2>
            {!data ? <p>Memuat...</p> : data.deployments?.length === 0 ? (
              <div style={{ ...card, textAlign: "center", color: "#6b7280" }}>Belum ada deployment. Publish proyek dari Builder.</div>
            ) : (
              <>
              <div style={{ display: "grid", gap: 10 }}>
                {data.deployments?.map((d: any) => (
                  <div key={d.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, padding: 16, flexWrap: "wrap" }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: d.status === "ready" ? "#22c55e" : ORANGE, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>Deployment #{d.id}</div>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>{d.url} · {new Date(d.createdAt).toLocaleString("id-ID")}</div>
                    </div>
                    <span style={{ fontSize: 12, background: "#f3f4f6", padding: "4px 10px", borderRadius: 12 }}>{d.status}</span>
                    <button onClick={() => { setPreviewPid(String(d.projectId)); setPreviewDep(d); }}
                      style={{ fontSize: 12, border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 600 }}>
                      Preview
                    </button>
                    <button onClick={async () => {
                      if (!confirm("Rollback ke deployment #" + d.id + "? File proyek akan dikembalikan.")) return;
                      await fetch(`/api/deployments/${d.id}/rollback`, { method: "POST", headers: { Authorization: "Bearer " + localStorage.getItem("wb-token") } });
                      alert("Rollback selesai");
                    }} style={{ fontSize: 12, border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 600 }}>
                      Rollback
                    </button>
                  </div>
                ))}
              </div>
              {previewDep && <DeployPreviewModal pid={previewPid} dep={previewDep} onClose={() => setPreviewDep(null)} />}
              </>
            )}
          </>
        )}

        {tab === "domains" && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Domains</h2>
            <div style={{ ...card, marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px" }}>Tambah domain</h3>
              <input placeholder="contoh.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addDom()}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 8, boxSizing: "border-box" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <select id="dom-proj" style={{ flex: 1, border: "1px solid #d1d5db", borderRadius: 8, padding: 10, fontSize: 13, minWidth: 0 }}>
                  <option value="">Pilih proyek (opsional)...</option>
                  {projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={addDom} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>Tambah</button>
              </div>
            </div>
            {!data ? <p>Memuat...</p> : (
              <div style={{ display: "grid", gap: 10 }}>
                {data.domains?.map((d: any) => (
                  <DomainRow key={d.id} d={d} onDone={() => ext.domains().then(setData)} ext={ext} />
                ))}
              </div>
            )}
          </>
        )}

        {tab === "usage" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, flex: 1 }}>Usage</h2>
              {data?.plan && <span style={{ fontSize: 12, fontWeight: 700, background: "#fff7ed", color: ORANGE, padding: "4px 12px", borderRadius: 12 }}>Paket {data.plan}</span>}
            </div>
            {!data ? <p>Memuat...</p> : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 }}>
                  <QuotaCard label="Token AI bulan ini" used={data.tokensUsed ?? data.tokens} limit={data.tokensLimit ?? data.limits?.tokens} />
                  <QuotaCard label="Proyek" used={data.projectsUsed ?? data.projects} limit={data.projectsLimit ?? data.limits?.projects} />
                  <QuotaCard label="Request AI" used={data.aiCalls ?? data.requests} limit={0} />
                </div>
                {(data.tokensUsed >= data.tokensLimit || data.projectsUsed >= data.projectsLimit) && (
                  <div style={{ ...card, borderColor: ORANGE, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, fontSize: 13, minWidth: 200 }}>Kuota paket <strong>{data.plan}</strong> tercapai. Upgrade untuk lanjut.</div>
                    <button onClick={() => setTab("billing")} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
                      Upgrade
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === "billing" && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Billing</h2>
            {!data ? <p>Memuat...</p> : (
              <>
                <div style={{ ...card, marginBottom: 16 }}>Paket saat ini: <strong style={{ color: ORANGE }}>{data.plan}</strong>
                  {data.expiresAt && <span style={{ fontSize: 12, color: "#6b7280" }}> · sampai {new Date(data.expiresAt).toLocaleDateString("id-ID")}</span>}
                </div>
                {payInfo?.payUrl && (
                  <div style={{ ...card, marginBottom: 16, borderColor: ORANGE }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Selesaikan pembayaran</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <a href={payInfo.payUrl} target="_blank" rel="noreferrer"
                        style={{ background: ORANGE, color: "#fff", borderRadius: 8, padding: "10px 18px", fontWeight: 700, textDecoration: "none", fontSize: 13 }}>
                        Bayar Sekarang
                      </a>
                      <button onClick={() => checkPayment(payInfo.orderId)} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "10px 18px", fontWeight: 600, cursor: "pointer", fontSize: 13 }}>
                        Cek Status
                      </button>
                    </div>
                  </div>
                )}
                {data.payments?.length > 0 && (
                  <div style={{ ...card, marginBottom: 16 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 10px" }}>Riwayat Pembayaran</h3>
                    {data.payments.map((py: any) => (
                      <div key={py.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: "1px solid #f3f4f6" }}>
                        <span>{py.orderId} · {py.plan}</span>
                        <span style={{ fontWeight: 700, color: py.status === "paid" ? "#16a34a" : "#6b7280" }}>{py.status}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                  {data.plans?.map((p: any) => (
                    <div key={p.name} style={{ ...card, borderWidth: p.popular ? 2 : 1, borderColor: p.popular ? ORANGE : "#e5e7eb" }}>
                      {p.popular && <div style={{ fontSize: 11, fontWeight: 700, color: ORANGE, marginBottom: 8 }}>POPULER</div>}
                      <div style={{ fontWeight: 800, fontSize: 18 }}>{p.name}</div>
                      <div style={{ fontSize: 14, color: "#6b7280", margin: "4px 0 12px" }}>{p.price}</div>
                      {p.features?.map((f: string) => <div key={f} style={{ fontSize: 13, padding: "4px 0", color: "#374151" }}>✓ {f}</div>)}
                      {p.id && p.id !== "free" && data.plan !== p.id && (
                        <button onClick={() => checkout(p.id)} disabled={checkingOut === p.id}
                          style={{ marginTop: 12, width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
                          {checkingOut === p.id ? "Memproses..." : "Upgrade"}
                        </button>
                      )}
                      {data.plan === p.id && (
                        <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: ORANGE }}>Paket aktif</div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {tab === "settings" && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 20px" }}>Settings</h2>
            <div style={{ ...card, marginBottom: 16, maxWidth: 500 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px" }}>Profil</h3>
              <input placeholder="Nama" value={profileName} onChange={(e) => setProfileName(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }} />
              <button onClick={saveProfile} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>Simpan</button>
            </div>
            <div style={{ ...card, maxWidth: 500, marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px" }}>Ubah Password</h3>
              <input type="password" placeholder="Password lama" value={oldPw} onChange={(e) => setOldPw(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 8, boxSizing: "border-box" }} />
              <input type="password" placeholder="Password baru" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }} />
              <button onClick={savePw} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>Ubah</button>
            </div>
            <div style={{ ...card, maxWidth: 500 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 4px" }}>AI Global (Admin)</h3>
              <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 12px" }}>API key tersimpan terenkripsi di server, tidak tampil di UI.</p>
              <input placeholder="Base URL (mis: https://proxy.clidi.net/v1)" value={aiBase} onChange={(e) => setAiBase(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 8, boxSizing: "border-box" }} />
              <input type="password" placeholder={aiHasKey ? "API key tersimpan (isi untuk ganti)" : "API Key"} value={aiKey} onChange={(e) => setAiKey(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 8, boxSizing: "border-box" }} />
              <input placeholder="Model (mis: gpt-4o-mini)" value={aiModel} onChange={(e) => setAiModel(e.target.value)}
                style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 14px", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }} />
              <button onClick={saveAi} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer" }}>Simpan AI</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DomainRow({ d, onDone, ext }: any) {
  const [dns, setDns] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 };
  async function verify() {
    setBusy("verify");
    try {
      const r = await ext.verifyDomain(d.id);
      alert(r.verified ? "Terverifikasi! " + r.detail : "Belum terverifikasi: " + r.detail);
      onDone();
    } catch (e: any) { alert(e.message); }
    setBusy("");
  }
  async function showDns() {
    try { setDns(await ext.domainDns(d.id)); } catch (e: any) { alert(e.message); }
  }
  async function ssl() {
    if (!confirm("Terbitkan SSL untuk " + d.domain + "?")) return;
    setBusy("ssl");
    try {
      const r = await ext.domainSsl(d.id);
      alert(r.message);
    } catch (e: any) { alert(e.message); }
    setBusy("");
  }
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Globe size={16} style={{ color: "#F6821F", flexShrink: 0 }} />
        <div style={{ flex: 1, fontWeight: 600, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{d.domain}</div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 10,
          background: d.verified ? "#dcfce7" : "#fef3c7", color: d.verified ? "#15803d" : "#b45309",
        }}>{d.verified ? "Terverifikasi" : "Belum verifikasi"}</span>
        <button onClick={() => ext.delDomain(d.id).then(onDone)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#dc2626" }}><Trash2 size={16} /></button>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {!d.verified && (
          <>
            <button onClick={showDns} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              Panduan DNS
            </button>
            <button onClick={verify} disabled={busy === "verify"}
              style={{ background: "#F6821F", color: "#fff", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {busy === "verify" ? "Memeriksa..." : "Verifikasi"}
            </button>
          </>
        )}
        {d.verified && (
          <button onClick={ssl} disabled={busy === "ssl"}
            style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            {busy === "ssl" ? "Memproses..." : "Terbitkan SSL"}
          </button>
        )}
      </div>
      {dns && (
        <div style={{ marginTop: 10, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, fontSize: 12 }}>
          {dns.txt}
          <div style={{ marginTop: 6, color: "#6b7280" }}>Target CNAME: <code>{dns.cname_target}</code></div>
        </div>
      )}
    </div>
  );
}

function QuotaCard({ label, used, limit }: any) {
  const u = Number(used) || 0;
  const l = Number(limit) || 0;
  const pct = l > 0 ? Math.min(100, Math.round((u / l) * 100)) : 0;
  const over = l > 0 && u >= l;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{u.toLocaleString("id-ID")}
        {l > 0 && <span style={{ fontSize: 14, color: "#9ca3af", fontWeight: 400 }}> / {l.toLocaleString("id-ID")}</span>}
      </div>
      {l > 0 && (
        <div style={{ marginTop: 10, height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: pct + "%", height: "100%", background: over ? "#dc2626" : pct > 80 ? "#F6821F" : "#22c55e", borderRadius: 4 }} />
        </div>
      )}
      {l > 0 && <div style={{ fontSize: 11, color: over ? "#dc2626" : "#9ca3af", marginTop: 4 }}>{pct}% terpakai{over ? " — habis!" : ""}</div>}
    </div>
  );
}

function DeployPreviewModal({ pid, dep, onClose }: any) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    fetch(`/api/projects/${pid}/deployments/${dep.id}/files`, {
      headers: { Authorization: "Bearer " + localStorage.getItem("wb-token") },
    }).then((r) => r.json()).then((d) => {
      setHtml(buildPreview(d.files || {}));
    }).catch(() => setHtml("<p style='padding:40px'>Gagal memuat.</p>"));
  }, []);
  function buildPreview(files: any): string {
    const keys = Object.keys(files);
    const entry = keys.find((k) => k.includes("App.")) || keys[0];
    if (!entry) return "<p style='padding:40px;color:#999'>Kosong.</p>";
    const code = String(files[entry] || "").replace(/<\/script>/g, "<\\/script>");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>body{font-family:system-ui;margin:0}</style></head>
<body><div id="root"></div>
<script type="text/babel" data-presets="react">${code}</script>
</body></html>`;
  }
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", justifyContent: "center", alignItems: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 1000, maxWidth: "96vw", height: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 14, flex: 1 }}>Preview Deployment #{dep.id}</strong>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>snapshot read-only</span>
          <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        {html ? (
          <iframe title="preview" srcDoc={html} sandbox="allow-scripts" style={{ flex: 1, border: "none", width: "100%" }} />
        ) : <p style={{ padding: 40, color: "#9ca3af" }}>Memuat...</p>}
      </div>
    </div>
  );
}
