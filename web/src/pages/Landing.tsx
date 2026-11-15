import { useState } from "react";
import {
  Bot,
  Eye,
  TerminalSquare,
  Database,
  Lock,
  GitBranch,
  Rocket,
  Globe,
  MessageSquareText,
  Code2,
  Check,
  ChevronDown,
  Menu,
  X,
} from "lucide-react";

const ORANGE = "#F6821F";

export default function Landing({ onStart }: { onStart: () => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);

  const features = [
    { icon: Bot, title: "AI Builder", desc: "Describe your idea in plain words. AI generates the full application for you." },
    { icon: Eye, title: "Live Preview", desc: "See your app update in real time as AI builds it. Desktop, tablet, and mobile views." },
    { icon: TerminalSquare, title: "AI Coding Agent", desc: "An agent that reads, writes, and refactors code — not just a chatbot." },
    { icon: Database, title: "Database", desc: "PostgreSQL built in. AI designs tables, relations, and migrations for you." },
    { icon: Lock, title: "Authentication", desc: "Login, signup, OAuth, and protected routes — generated automatically." },
    { icon: GitBranch, title: "GitHub", desc: "Connect your repo. Sync code, commit, and collaborate like a real project." },
    { icon: Rocket, title: "Deployment", desc: "One click to deploy. Get a live URL instantly with build logs." },
    { icon: Globe, title: "Custom Domains", desc: "Connect your own domain with automatic SSL certificates." },
  ];

  const steps = [
    { icon: MessageSquareText, no: "1", title: "Describe your idea", desc: "Tell AI what you want to build — a store, dashboard, blog, or anything." },
    { icon: Code2, no: "2", title: "AI builds it", desc: "AI writes the code, creates the database, and wires everything together." },
    { icon: Rocket, no: "3", title: "Launch", desc: "Preview, refine with chat, then deploy to a live URL in one click." },
  ];

  const plans = [
    {
      name: "Free",
      price: "Rp 0",
      period: "/ selamanya",
      desc: "Untuk mencoba dan belajar.",
      cta: "Mulai Gratis",
      features: ["3 proyek", "AI request terbatas", "Live preview", "Community support"],
      highlight: false,
    },
    {
      name: "Pro",
      price: "Rp 99rb",
      period: "/ bulan",
      desc: "Untuk builder serius.",
      cta: "Pilih Pro",
      features: ["Proyek tanpa batas", "AI request lebih banyak", "Deployment + custom domain", "Prioritas support"],
      highlight: true,
    },
    {
      name: "Team",
      price: "Rp 299rb",
      period: "/ bulan",
      desc: "Untuk tim dan agensi.",
      cta: "Hubungi Kami",
      features: ["Semua fitur Pro", "Kolaborasi tim", "Shared workspace", "Limit lebih tinggi"],
      highlight: false,
    },
  ];

  const faqs = [
    { q: "Apakah saya perlu bisa coding?", a: "Tidak. Cukup jelaskan ide Anda dengan kata-kata, AI yang menulis kodenya. Tapi Anda tetap bisa melihat dan mengedit kode kapan saja." },
    { q: "Framework apa yang didukung?", a: "React, Vue, dan Svelte. Setiap proyek dibuat sebagai struktur multi-file yang rapi, bukan satu file raksasa." },
    { q: "Apakah ada database?", a: "Ya. Setiap proyek mendapat database PostgreSQL gratis dan otomatis — tanpa perlu memasukkan connection string sendiri." },
    { q: "Bisakah saya pakai domain sendiri?", a: "Bisa. Paket Pro ke atas mendukung custom domain dengan SSL otomatis." },
    { q: "Apakah kode saya bisa diunduh?", a: "Ya. Anda bisa mengunduh proyek sebagai ZIP atau sinkron ke GitHub kapan saja." },
  ];

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", color: "#111827", background: "#ffffff", minHeight: "100vh" }}>
      {/* ── Navbar ── */}
      <header style={{ position: "sticky", top: 0, zIndex: 50, background: "#ffffff", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800, fontSize: 20 }}>
            Web<span style={{ color: ORANGE }}>Builder</span>
          </div>
          <nav style={{ display: "flex", gap: 24, alignItems: "center" }} className="nav-desktop">
            <a href="#fitur" style={navLink}>Fitur</a>
            <a href="#harga" style={navLink}>Harga</a>
            <a href="#faq" style={navLink}>FAQ</a>
            <button onClick={onStart} style={primaryBtn}>Mulai Gratis</button>
          </nav>
          <button
            onClick={() => setMobileMenu(!mobileMenu)}
            style={{ background: "none", border: "none", cursor: "pointer", display: "none" }}
            className="nav-mobile-btn"
            aria-label="Menu"
          >
            {mobileMenu ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
        {mobileMenu && (
          <div style={{ borderTop: "1px solid #e5e7eb", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, background: "#fff" }}>
            <a href="#fitur" style={navLink} onClick={() => setMobileMenu(false)}>Fitur</a>
            <a href="#harga" style={navLink} onClick={() => setMobileMenu(false)}>Harga</a>
            <a href="#faq" style={navLink} onClick={() => setMobileMenu(false)}>FAQ</a>
            <button onClick={onStart} style={{ ...primaryBtn, width: "100%" }}>Mulai Gratis</button>
          </div>
        )}
      </header>

      {/* ── Hero ── */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "72px 16px", textAlign: "center" }}>
        <h1 style={{ fontSize: "clamp(32px, 6vw, 56px)", fontWeight: 800, lineHeight: 1.15, margin: "0 0 16px" }}>
          Build Anything With <span style={{ color: ORANGE }}>AI</span>
        </h1>
        <p style={{ fontSize: "clamp(15px, 2.5vw, 19px)", color: "#6b7280", maxWidth: 600, margin: "0 auto 32px", lineHeight: 1.6 }}>
          Describe your idea. AI builds the application for you.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <button onClick={onStart} style={{ ...primaryBtn, padding: "14px 32px", fontSize: 16 }}>
            Start Building
          </button>
          <a href="#fitur" style={{ ...secondaryBtn, padding: "14px 32px", fontSize: 16, textDecoration: "none", display: "inline-block" }}>
            View Examples
          </a>
        </div>
      </section>

      {/* ── Fitur ── */}
      <section id="fitur" style={{ background: "#f9fafb", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 16px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 8px" }}>Semua yang Anda butuhkan</h2>
          <p style={{ color: "#6b7280", textAlign: "center", margin: "0 0 40px" }}>Platform lengkap dari ide sampai deployment.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
            {features.map((f) => (
              <div key={f.title} style={card}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "#fff7ed", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                  <f.icon size={20} color={ORANGE} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{f.title}</div>
                <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.55 }}>{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Cara kerja ── */}
      <section style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 16px" }}>
        <h2 style={{ fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 8px" }}>Cara kerja</h2>
        <p style={{ color: "#6b7280", textAlign: "center", margin: "0 0 40px" }}>Tiga langkah menuju aplikasi jadi.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          {steps.map((s) => (
            <div key={s.no} style={{ ...card, textAlign: "center" }}>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: "#fff7ed", color: ORANGE, fontWeight: 800, fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                {s.no}
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.55 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="harga" style={{ background: "#f9fafb", borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "64px 16px" }}>
          <h2 style={{ fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 8px" }}>Harga</h2>
          <p style={{ color: "#6b7280", textAlign: "center", margin: "0 0 40px" }}>Mulai gratis, upgrade saat butuh lebih.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, maxWidth: 900, margin: "0 auto" }}>
            {plans.map((p) => (
              <div
                key={p.name}
                style={{
                  ...card,
                  border: p.highlight ? `2px solid ${ORANGE}` : "1px solid #e5e7eb",
                  position: "relative",
                }}
              >
                {p.highlight && (
                  <div style={{ position: "absolute", top: -13, left: "50%", transform: "translateX(-50%)", background: ORANGE, color: "#fff", fontSize: 12, fontWeight: 700, padding: "3px 14px", borderRadius: 20 }}>
                    Populer
                  </div>
                )}
                <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>{p.name}</div>
                <div style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 30, fontWeight: 800 }}>{p.price}</span>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>{p.period}</span>
                </div>
                <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>{p.desc}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {p.features.map((f) => (
                    <div key={f} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <Check size={16} color={ORANGE} style={{ flexShrink: 0 }} />
                      <span>{f}</span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={onStart}
                  style={p.highlight ? { ...primaryBtn, width: "100%" } : { ...secondaryBtn, width: "100%" }}
                >
                  {p.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={{ maxWidth: 760, margin: "0 auto", padding: "64px 16px" }}>
        <h2 style={{ fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 32px" }}>FAQ</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {faqs.map((f, i) => (
            <div key={i} style={{ border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                style={{ width: "100%", background: "none", border: "none", padding: "16px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left", fontSize: 15, fontWeight: 600 }}
              >
                <span>{f.q}</span>
                <ChevronDown size={18} color="#6b7280" style={{ transform: openFaq === i ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }} />
              </button>
              {openFaq === i && (
                <div style={{ padding: "0 18px 16px", fontSize: 14, color: "#6b7280", lineHeight: 1.6 }}>{f.a}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#f9fafb" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>
            Web<span style={{ color: ORANGE }}>Builder</span>
          </div>
          <div style={{ display: "flex", gap: 20, fontSize: 13 }}>
            <a href="#fitur" style={navLink}>Fitur</a>
            <a href="#harga" style={navLink}>Harga</a>
            <a href="#faq" style={navLink}>FAQ</a>
          </div>
          <div style={{ fontSize: 13, color: "#9ca3af" }}>© 2026 WebBuilder</div>
        </div>
      </footer>

      <style>{`
        @media (max-width: 640px) {
          .nav-desktop { display: none !important; }
          .nav-mobile-btn { display: block !important; }
        }
      `}</style>
    </div>
  );
}

const navLink: React.CSSProperties = { color: "#4b5563", textDecoration: "none", fontSize: 14, fontWeight: 500 };
const primaryBtn: React.CSSProperties = {
  background: ORANGE,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 20px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  background: "#fff",
  color: "#111827",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "10px 20px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};
const card: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 20,
};
