import { ArrowRight, Bot, Database, Eye, GitBranch, Globe2, Menu, Play, Rocket, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState } from "react";
import "./landing-auth.css";

export default function LandingV2({ onStart }: { onStart: (prompt?: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [prompt, setPrompt] = useState("");
  function submitPrompt() {
    const t = prompt.trim();
    if (t) onStart(t);
  }
  const features = [[Bot,"AI coding agent","Dari ide sampai kode yang bisa dijalankan."],[Eye,"Live preview","Lihat perubahan secara realtime di desktop dan mobile."],[Database,"Database nyata","Schema, migration, auth, dan CRUD PostgreSQL."],[Rocket,"Deploy sekali klik","Build terverifikasi sebelum aplikasi dipublikasikan."],[GitBranch,"Version control","Checkpoint, diff, restore, dan GitHub workflow."],[ShieldCheck,"Aman by default","Isolasi project, permission, dan secret boundary."]] as const;
  const examples = ["Aplikasi POS untuk toko kecil", "Dashboard keuangan UMKM", "Toko online dengan katalog"];
  return <main className="la-landing">
    <nav className="la-nav"><div className="la-nav-inner"><a className="la-brand" href="/">web<span>builder</span><i>.</i></a><div className="la-nav-links"><a href="#product">Produk</a><a href="#workflow">Cara kerja</a><a href="#pricing">Harga</a></div><button className="la-nav-cta" onClick={() => onStart()}>Mulai gratis <ArrowRight size={15}/></button><button className="la-menu-btn" onClick={()=>setMenu(!menu)} aria-label="Menu">{menu?<X/>:<Menu/>}</button></div></nav>
    {menu&&<div className="la-mobile-menu"><a href="#product" onClick={()=>setMenu(false)}>Produk</a><a href="#workflow" onClick={()=>setMenu(false)}>Cara kerja</a><a href="#pricing" onClick={()=>setMenu(false)}>Harga</a><button className="la-nav-cta" onClick={() => onStart()}>Mulai gratis <ArrowRight size={15}/></button></div>}
    <section className="la-hero">
      <div className="la-float-card la-float-left" aria-hidden="true"><b>Penjualan hari ini</b><p>Rp 12.480.000 · 86 transaksi</p><div className="la-float-bars"><i style={{height:"40%"}}/><i style={{height:"65%"}}/><i style={{height:"50%"}}/><i style={{height:"85%"}}/><i style={{height:"100%"}}/></div></div>
      <div className="la-float-card la-float-right" aria-hidden="true"><span className="la-float-badge"><i/>Deploy berhasil</span><p style={{marginTop:8}}>toko-kamu.webbuilder.app sudah live · 41 detik</p></div>
      <div className="la-hero-inner">
      <div className="la-eyebrow"><Sparkles size={14}/> AI software builder untuk produk nyata</div>
      <h1 className="la-hero-title"><span>Ide besar.</span><span><em>Langsung jadi.</em></span></h1>
      <p className="la-hero-sub">Deskripsikan aplikasi yang kamu bayangkan. AI menyusun arsitektur, menulis kode, membuat database, menjalankan test, dan menyiapkan preview.</p>
      <div className="la-prompt"><div className="la-prompt-head"><span className="la-live-dot"/> AI Builder <span className="la-free-chip">FREE</span><small>Siap menerima ide</small></div><textarea className="la-prompt-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitPrompt(); } }} placeholder="Buat aplikasi POS untuk toko kecil dengan login kasir, inventory, transaksi, dan laporan penjualan..." rows={3} /><div className="la-prompt-foot"><span>Enter untuk menjalankan</span><button className="la-prompt-send" onClick={submitPrompt} aria-label="Kirim ide"><ArrowRight size={16}/></button></div></div>
      <div className="la-chips"><small>Coba:</small>{examples.map((ex)=><button key={ex} type="button" className="la-chip" onClick={()=>setPrompt("Buat " + ex.toLowerCase() + " dengan login, data, dan laporan.")}>{ex}</button>)}</div>
      <a className="la-hero-ghost" href="#workflow"><Play size={15}/> Lihat cara kerja</a>
      </div>
    </section>
    <section className="la-trust"><span>BUILT FOR</span><b>founders</b><b>designers</b><b>developers</b><b>teams</b></section>
    <section id="product" className="la-section"><div className="la-section-head"><span className="la-kicker">SATU WORKSPACE</span><h2>Semua yang dibutuhkan<br/><em>untuk meluncur.</em></h2><p>Bukan sekadar generator landing page. WebBuilder bekerja seperti tim produk kecil yang membaca, membangun, mengetes, dan memperbaiki aplikasi.</p></div><div className="la-feature-grid">{features.map(([Icon,title,desc])=><article className="la-feature-card" key={title}><div className="la-feature-icon"><Icon size={19}/></div><h3>{title}</h3><p>{desc}</p></article>)}</div></section>
    <section id="workflow" className="la-section la-workflow"><span className="la-kicker">WORKFLOW</span><h2>Dari prompt ke produk<br/><em>tanpa kehilangan kendali.</em></h2><div className="la-steps"><div><b>01</b><h3>Describe</h3><p>Tulis tujuan, user, dan fitur dengan bahasa biasa.</p></div><div><b>02</b><h3>Build</h3><p>Agent membuat file, schema, auth, dan alur data.</p></div><div><b>03</b><h3>Prove</h3><p>Build, database verify, runtime, dan acceptance test.</p></div></div></section>
    <section id="pricing" className="la-cta-band"><Globe2 size={22}/><h2>Bangun sesuatu yang<br/><em>bisa dipakai.</em></h2><p>Mulai dari satu ide. Iterasi bersama AI sampai siap digunakan user.</p><button className="la-cta-btn" onClick={() => onStart()}>Mulai gratis <ArrowRight size={17}/></button></section>
    <footer className="la-footer"><a className="la-brand" href="/">web<span>builder</span><i>.</i></a><nav><a href="#product">Produk</a><a href="#workflow">Cara kerja</a><a href="#pricing">Harga</a></nav><span>AI software builder · 2026</span></footer>
  </main>;
}
