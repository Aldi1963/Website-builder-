import { lazy, Suspense, useState, useEffect } from "react";
import AuthV2 from "./pages/AuthV2";
import LandingV2 from "./pages/LandingV2";
import "./index.css";
import { getToken, setToken, jwtPayload } from "./lib/api";
import { useCreateProject, projectIdFromCreateResponse } from "./lib/hooks/useProjects";
import { useMe, usePublicSettings } from "./lib/hooks/useDashboard";

// Code-splitting: halaman berat dimuat on-demand, bukan di bundle awal.
// AuthV2/LandingV2 tetap statis karena dipakai di layar pertama.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Builder = lazy(() => import("./pages/Builder"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));

const PageFallback = (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", color: "#64748b" }}>Memuat halaman...</div>
);

const ORANGE = "#F6821F";

export default function App() {
  const [logged, setLogged] = useState(!!getToken());
  const [pid, setPid] = useState<string | null>(null);
  const [showLanding, setShowLanding] = useState(!getToken());
  const [pub, setPub] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  // Prompt dari landing page (ala Lovable): dibuat project otomatis setelah login
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const createProjectMut = useCreateProject();
  const meQuery = useMe(!!getToken());
  const pubQuery = usePublicSettings();

  function handleLandingStart(p?: string) {
    if (p?.trim()) setPendingPrompt(p.trim());
    setShowLanding(false);
  }

  async function handleAuthDone() {
    setLogged(true);
    setShowLanding(false);
    if (pendingPrompt) {
      const prompt = pendingPrompt;
      setCreatingProject(true);
      try {
        const words = prompt.split(/\s+/).slice(0, 6).join(" ");
        const name = (words || "Proyek baru").slice(0, 40);
        const d = await createProjectMut.mutateAsync({ name, framework: "react" });
        const newPid = projectIdFromCreateResponse(d);
        if (newPid) {
          setPid(newPid);
          // pendingPrompt diteruskan ke Builder sebagai initialPrompt, dibersihkan saat kembali
        } else {
          setPendingPrompt(null);
        }
      } catch {
        setPendingPrompt(null);
      } finally {
        setCreatingProject(false);
      }
    }
  }

  useEffect(() => {
    if (pubQuery.data) setPub(pubQuery.data);
  }, [pubQuery.data]);

  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data.user);
  }, [meQuery.data, logged]);

  const imp = jwtPayload().impersonated_by;

  function exitImpersonate() {
    const adminTok = localStorage.getItem("wb-token-admin");
    if (adminTok) {
      setToken(adminTok);
      localStorage.removeItem("wb-token-admin");
    } else {
      localStorage.removeItem("wb-token");
    }
    window.location.href = "/admin";
  }

  if (window.location.pathname === "/api-docs") return <Suspense fallback={PageFallback}><ApiDocs /></Suspense>;

  if (window.location.pathname === "/oauth") {
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) {
      setToken(t);
      window.location.href = "/";
    }
    return <div style={{ padding: 40, fontFamily: "system-ui" }}>Memproses login...</div>;
  }

  if (!logged) {
    if (showLanding) return <LandingV2 onStart={handleLandingStart} />;
    return <AuthV2 onDone={handleAuthDone} />;
  }

  if (creatingProject) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui", color: "#64748b" }}>Membuat proyek...</div>;
  }

  // Maintenance: non-admin diblokir
  if (pub?.maintenance && !me?.isAdmin) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f9fafb", fontFamily: "system-ui", padding: 20, textAlign: "center" }}>
        <div>
          <div style={{ fontSize: 44, marginBottom: 12 }}>🔧</div>
          <h2 style={{ margin: "0 0 8px" }}>Sedang Maintenance</h2>
          <p style={{ color: "#6b7280" }}>WebBuilder sedang dalam perbaikan. Coba lagi nanti.</p>
        </div>
      </div>
    );
  }

  const banner = (
    <>
      {imp && (
        <div style={{ background: "#7c2d12", color: "#fff", fontSize: 13, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8, fontFamily: "system-ui" }}>
          <span style={{ flex: 1 }}>Mode support — login sebagai <strong>{me?.email || "user"}</strong></span>
          <button onClick={exitImpersonate} style={{ background: "#fff", color: "#7c2d12", border: "none", borderRadius: 6, padding: "4px 12px", fontWeight: 700, cursor: "pointer", fontSize: 12 }}>
            Kembali ke Admin
          </button>
        </div>
      )}
      {pub?.announcement && !imp && (
        <div style={{ background: "#fff7ed", borderBottom: "1px solid #fed7aa", color: "#9a3412", fontSize: 13, padding: "8px 16px", textAlign: "center", fontFamily: "system-ui" }}>
          📢 {pub.announcement}
        </div>
      )}
    </>
  );

  if (window.location.pathname === "/admin") return <>{banner}<AdminRoute onBack={() => { window.history.pushState({}, "", "/"); window.location.reload(); }} /></>;
  if (pid) return <>{banner}<Suspense fallback={PageFallback}><Builder pid={pid} initialPrompt={pendingPrompt || undefined} onBack={() => { setPid(null); setPendingPrompt(null); }} /></Suspense></>;
  return <>{banner}<Suspense fallback={PageFallback}><Dashboard onOpen={setPid} /></Suspense></>;
}

function AdminRoute({ onBack }: { onBack: () => void }) {
  const meQuery = useMe();
  const ok = meQuery.isError ? false : meQuery.data ? !!meQuery.data.user?.isAdmin : null;
  if (ok === null) return <div style={{ padding: 40, fontFamily: "system-ui" }}>Memuat...</div>;
  if (!ok) { window.location.href = "/"; return null; }
  return <Suspense fallback={PageFallback}><AdminPanel onClose={onBack} /></Suspense>;
}
