import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import App from "./App";
import AdminPanel from "./pages/AdminPanel";
import AuthV2 from "./pages/AuthV2";
import { getToken } from "./lib/api";
// index.css berisi gaya halaman auth (.wb-auth) dan landing. Tanpa impor ini
// halaman login /admin tampil mentah: input polos, tombol menyempil, teks
// kontras rendah. App juga mengimpornya, tapi rute /admin tidak me-render
// App sehingga main harus mengimpornya sendiri.
import "./index.css";

// Route /admin dijaga AdminGate di entry point (BUKAN AdminRoute di App):
// non-admin melihat layar "Akses ditolak" + tombol "Ganti akun", bukan
// redirect diam-diam ke "/". AdminRoute me-redirect non-admin dan error
// /api/me apa pun ke "/", jadi perilakunya tidak setara — jangan pindah
// ke AdminRoute tanpa mengubah UX denied di sana juga.
function AdminGate() {
  const [state, setState] = useState<"checking" | "login" | "denied" | "ok">("checking");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!getToken()) {
      setState("login");
      return;
    }
    fetch("/api/me", { headers: { Authorization: "Bearer " + getToken() } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("unauthorized"))))
      .then((d) => {
        setEmail(d?.user?.email || "");
        setState(d?.user?.isAdmin ? "ok" : "denied");
      })
      .catch(() => setState("login"));
  }, []);

  if (state === "checking") {
    return <div style={{ padding: 40, fontFamily: "system-ui", color: "#718078" }}>Memeriksa akses admin…</div>;
  }
  if (state === "login") {
    return <AuthV2 onDone={() => setState("checking")} />;
  }
  if (state === "denied") {
    return (
      <div style={{ padding: 40, fontFamily: "system-ui", maxWidth: 460 }}>
        <h2 style={{ margin: "0 0 8px" }}>Akses ditolak</h2>
        <p style={{ color: "#718078", fontSize: 13, lineHeight: 1.6 }}>
          Akun <b>{email || "ini"}</b> bukan administrator. Masuk dengan akun admin untuk membuka panel ini.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              localStorage.removeItem("wb-token");
              setState("login");
            }}
            style={{ background: "#173d2a", color: "#fff", border: 0, borderRadius: 6, padding: "10px 14px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}
          >
            Ganti akun
          </button>
          <a href="/" style={{ padding: "10px 14px", border: "1px solid #dbe3d8", borderRadius: 6, color: "#142118", fontSize: 13, textDecoration: "none" }}>
            Kembali ke workspace
          </a>
        </div>
      </div>
    );
  }
  return <AdminPanel onClose={() => { window.location.href = "/"; }} />;
}

const isAdminRoute = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}>{isAdminRoute ? <AdminGate /> : <App />}</QueryClientProvider></StrictMode>
);
