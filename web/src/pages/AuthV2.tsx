import { useState, useEffect } from "react";
import { ArrowLeft, Check, GitBranch, LockKeyhole, Sparkles } from "lucide-react";
import { api, setToken } from "../lib/api";
import "./landing-auth.css";

export default function AuthV2({ onDone }: { onDone: () => void }) {
  const [mode,setMode]=useState<"login"|"register"|"forgot">("login"); const [name,setName]=useState(""); const [email,setEmail]=useState(""); const [password,setPassword]=useState(""); const [err,setErr]=useState(""); const [oauth,setOauth]=useState<any>({});
  useEffect(()=>{fetch("/api/auth/oauth/status").then(r=>r.json()).then(setOauth).catch(()=>{})},[]);
  async function submit(e:any){e.preventDefault();setErr("");try{if(mode==="forgot"){await fetch("/api/auth/forgot-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});return}const d=mode==="login"?await api.login(email,password):await api.register(name,email,password);setToken(d.token);onDone()}catch(e:any){setErr(e.message)}}
  async function oauthLogin(p:string){const d=await fetch("/api/auth/oauth/"+p).then(r=>r.json());if(d.url)location.href=d.url}
  return <main className="la-auth">
    <section className="la-auth-side">
      <a className="la-brand" href="/">web<span>builder</span><i>.</i></a>
      <div>
        <div className="la-eyebrow" style={{color:"#c9f36b",borderColor:"#51715d",background:"transparent"}}><Sparkles size={13}/> BUILD WITH INTENT</div>
        <h1>Produk bagus<br/><em>dimulai dari ide.</em></h1>
        <p>Workspace AI untuk merancang, membangun, dan membuktikan aplikasi nyata.</p>
        <div className="la-auth-points">
          <div><Check size={15}/> AI Builder untuk aplikasi nyata</div>
          <div><Check size={15}/> Database PostgreSQL otomatis</div>
          <div><Check size={15}/> Deploy sekali klik</div>
        </div>
        <div className="la-auth-chatmock" aria-hidden="true">
          <div className="la-cm-user">Buatkan aplikasi kasir dengan login, produk, dan laporan penjualan.</div>
          <div className="la-cm-assistant"><b><span className="la-cm-tile"><Sparkles size={12}/></span> AI Web Builder</b>Siap — 12 file dibuat, build lolos, preview sudah bisa dibuka. <span className="la-cm-check">✓</span></div>
        </div>
      </div>
      <small>© WebBuilder 2026</small>
    </section>
    <section className="la-auth-main">
      <form className="la-auth-form" onSubmit={submit}>
        <button type="button" className="la-auth-back" onClick={()=>location.href="/"}><ArrowLeft size={15}/> Kembali</button>
        <h2>{mode==="login"?"Selamat datang kembali":mode==="register"?"Buat workspace baru":"Reset password"}</h2>
        <p className="la-auth-sub">{mode==="register"?"Mulai dari satu ide dan bangun sesuatu yang nyata.":mode==="login"?"Masuk untuk melanjutkan project kamu.":"Masukkan email untuk menerima link reset."}</p>
        {mode!=="forgot"&&<div className="la-auth-seg" role="group" aria-label="Mode akun"><button type="button" aria-pressed={mode==="login"} onClick={()=>setMode("login")}>Masuk</button><button type="button" aria-pressed={mode==="register"} onClick={()=>setMode("register")}>Daftar</button></div>}
        {mode==="register"&&<input className="la-auth-input" placeholder="Nama lengkap" value={name} onChange={e=>setName(e.target.value)} required/>}
        <input className="la-auth-input" placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/>
        {mode!=="forgot"&&<input className="la-auth-input" placeholder="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} required/>}
        {err&&<div className="la-auth-error">{err}</div>}
        <button className="la-auth-submit" type="submit">{mode==="login"?"Masuk ke workspace":mode==="register"?"Buat akun":"Kirim link reset"}</button>
        {(mode==="login"||mode==="register")&&(oauth.google||oauth.github)&&<><div className="la-auth-divider"><hr/> ATAU <hr/></div><div className="la-auth-oauth">{oauth.google&&<button type="button" onClick={()=>oauthLogin("google")}>Google</button>}{oauth.github&&<button type="button" onClick={()=>oauthLogin("github")}><GitBranch size={15}/> GitHub</button>}</div></>}
        <div className="la-auth-links">{mode==="login"&&<button type="button" className="la-auth-text-btn" onClick={()=>setMode("forgot")}>Lupa password?</button>}<button type="button" className="la-auth-text-btn" onClick={()=>setMode(mode==="register"?"login":"register")}>{mode==="register"?"Sudah punya akun? Masuk":"Buat akun baru"}</button></div>
        <div className="la-auth-note"><LockKeyhole size={13}/> Data dan project kamu tetap privat.</div>
      </form>
    </section>
  </main>;
}
