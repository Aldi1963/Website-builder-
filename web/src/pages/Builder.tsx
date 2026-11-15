import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "../lib/api";
import ProjectSettingsModal from "./ProjectSettingsModal";
import { useBuilderStore } from "../lib/store/builderStore";
import {
  useAddComment,
  useAgentRunDetail,
  useAgentRuns,
  useApplyProposal,
  useBlueprint,
  useChatHistory,
  useCheckpointVersion,
  useComments,
  useCreateProjectFile,
  useCreateTable,
  useDeleteProjectFile,
  useEnhancePrompt,
  useGenerateImage,
  useGitHubPushPull,
  useGitHubSettings,
  useProject,
  useProjectSettings,
  useProjectVersions,
  usePublishProject,
  useRejectProposal,
  useRenameProjectFile,
  useResolveComment,
  useRestoreVersion,
  useRuntimeActions,
  useRuntimeStatus,
  useSaveBlueprint,
  useSaveGitHubSettings,
  useSavePolicy,
  useSaveProject,
  useSaveProjectSettings,
  useTables,
  usePolicies,
  useUpdateAgentRun,
  useUploadFile,
  fetchAgentRuns,
  fetchProjectVersions,
  fetchRuntimeStatus,
  fetchSmokeTest,
  fetchTableDetail,
  fetchVersionFiles,
  downloadProjectExport,
} from "../lib/hooks";
import { projectKeys } from "../lib/hooks/queryKeys";

// Code-splitting: Monaco dan Sandpack TIDAK masuk bundle awal — keduanya
// dimuat on-demand saat Builder dirender (React.lazy + Suspense).
// SandpackConsole sengaja tidak diimpor: tidak pernah dipakai.
const Editor = lazy(() => import("@monaco-editor/react"));
const SandpackProvider = lazy(() =>
  import("@codesandbox/sandpack-react").then((m) => ({ default: m.SandpackProvider })),
);
const SandpackPreview = lazy(() =>
  import("@codesandbox/sandpack-react").then((m) => ({ default: m.SandpackPreview })),
);
import {
  ArrowLeft, ChevronRight, ChevronDown, File, Folder, FolderOpen,
  Play, Send, X, Plus, RefreshCw, Monitor,
  Smartphone, Tablet, Terminal as TerminalIcon, MessageSquare, Code2, Database, History, Check, XCircle,
  MousePointerClick, Settings, Link2, Lock, Image as ImageIcon, GitBranch as Github, Sparkles,
  Rocket, RotateCcw, Mic, MicOff, Download,
} from "lucide-react";

const ORANGE = "#F6821F";

function useIsMobile() {
  const [m, setM] = useState(false);
  useEffect(() => {
    const fn = () => setM(window.innerWidth < 768);
    fn();
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return m;
}

interface FileNode { path: string; children?: FileNode[] }

function sanitizeSandpackSource(source: string): string {
  // Sandpack compiles generated files in its browser transformer. import.meta is
  // valid in Vite modules but some generated code is evaluated as a classic
  // script by the preview transformer, causing: "Cannot use import.meta outside
  // a module". Replace the common Vite forms without touching runtime mode.
  return source
    .replace(/import\.meta\.env\.([A-Za-z0-9_]+)/g, "({ MODE: 'development', DEV: true, PROD: false, BASE_URL: '/' }).$1")
    .replace(/import\.meta\.env\[['\"]([^'\"]+)['\"]\]/g, "({ MODE: 'development', DEV: true, PROD: false, BASE_URL: '/' })['$1']")
    .replace(/import\.meta\.url/g, "window.location.href")
    .replace(/import\.meta/g, "({ MODE: 'development', DEV: true, PROD: false, BASE_URL: '/', url: window.location.href })");
}

function parseGeneratedSQL(text: string): string[] {
  const blocks: string[] = [];
  const re = /<<<SQL>>>\\s*([\\s\\S]*?)(?:<<<END>>>|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const sql = match[1].trim();
    if (sql) blocks.push(sql);
  }
  return blocks;
}

function buildTree(paths: string[]): FileNode[] {
  const root: FileNode[] = [];
  for (const p of [...paths].sort()) {
    const parts = p.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const full = parts.slice(0, i + 1).join("/");
      let node = cur.find((n) => n.path === full);
      if (!node) {
        node = { path: full };
        if (!isFile) node.children = [];
        cur.push(node);
      }
      if (node.children) cur = node.children;
    }
  }
  return root;
}

const smartSuggestions = [
  { icon: "🌙", label: "Mode Gelap", prompt: "Tambahkan fitur toggle mode gelap/terang (dark mode) dengan state React" },
  { icon: "📱", label: "Resp. Mobile", prompt: "Pastikan tampilan responsive untuk layar mobile dan tablet dengan breakpoint CSS rapi" },
  { icon: "📝", label: "Form Kontak", prompt: "Tambahkan section form kontak / masukan dengan validasi input" },
  { icon: "🔍", label: "Bar Pencarian", prompt: "Tambahkan bar pencarian dan filter data interaktif" },
  { icon: "🎨", label: "Tema Modern", prompt: "Ubah styling dan tema warna UI menjadi modern ala Linear dengan aksen #F6821F" },
  { icon: "📊", label: "Kartu Stats", prompt: "Tambahkan section dashboard statistik / matriks data dengan ringkasan angka" },
];

const slashCommands = [
  { cmd: "/fix", desc: "Perbaiki error preview", prompt: "Perbaiki error dan pastikan preview berjalan tanpa masalah" },
  { cmd: "/dark", desc: "Tambah Toggle Dark Mode", prompt: "Tambahkan fitur toggle mode gelap/terang (dark mode) dengan state React" },
  { cmd: "/theme", desc: "Ubah tema ke warna modern", prompt: "Ubah styling dan tema warna UI menjadi modern ala Linear dengan aksen #F6821F" },
  { cmd: "/clean", desc: "Refactor & rapikan kode", prompt: "Refactor kode, pecah file besar, dan rapikan struktur komponen" },
  { cmd: "/mobile", desc: "Optimalkan tampilan mobile", prompt: "Pastikan tampilan responsive untuk layar mobile dan tablet dengan breakpoint CSS rapi" },
  { cmd: "/form", desc: "Tambah Form Kontak", prompt: "Tambahkan section form kontak / masukan dengan validasi input" },
  { cmd: "/stats", desc: "Tambah Dashboard Stats", prompt: "Tambahkan section dashboard statistik / matriks data dengan ringkasan angka" },
];

// Ambil beberapa baris terakhir dari pesan error panjang untuk ditampilkan di chat.
function lastLinesText(text: string, n: number) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  return lines.slice(-n).join("\n");
}

function parseFileBadges(content: string) {
  const fileRegex = /<<<FILE:\s*([^\s>]+)>>>/g;
  const matches: string[] = [];
  let match;
  while ((match = fileRegex.exec(content)) !== null) {
    if (match[1] && !matches.includes(match[1].trim())) {
      matches.push(match[1].trim());
    }
  }
  return matches;
}

// Parse blok <<<FILE: path>>>...<<<END>>> secara incremental, termasuk blok
// yang masih ditulis (belum ada <<<END>>>). Robust terhadap chunk terpotong.
function extractLiveFiles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = text.split("<<<FILE:");
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const hEnd = part.indexOf(">>>");
    if (hEnd < 0) continue; // header belum lengkap
    const rawPath = part.slice(0, hEnd).trim();
    if (!rawPath || /\s/.test(rawPath)) continue; // path tidak valid
    const path = rawPath.replace(/^\//, "");
    let content = part.slice(hEnd + 3).replace(/^\r?\n/, "");
    const eEnd = content.indexOf("<<<END>>>");
    if (eEnd >= 0) content = content.slice(0, eEnd);
    out[path] = content;
  }
  return out;
}

function isBuildFailureMessage(content: string) {
  return /Placeholder\.tsx|auto-fix|quality check|quality gate/i.test(content);
}

function renderBuildFailureCard(content: string, onFix: () => void) {
  const file = content.match(/(?:src\/)?pages\/Placeholder\.tsx/i)?.[0] || "Placeholder.tsx";
  return <div style={{ border: "1px solid #fecaca", background: "#fffafa", borderRadius: 12, padding: 12, marginBottom: 8 }}>
    <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
      <div style={{ width: 26, height: 26, borderRadius: 8, background: "#fee2e2", color: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>!</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <strong style={{ display: "block", fontSize: 13, color: "#991b1b" }}>Build belum siap</strong>
        <span style={{ display: "block", marginTop: 3, fontSize: 11, lineHeight: 1.45, color: "#7f1d1d" }}>Ada file lama yang menghambat pemeriksaan aplikasi.</span>
        <code style={{ display: "block", marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "#451a1a", color: "#fecaca", fontSize: 10, overflowX: "auto", whiteSpace: "nowrap" }}>{file}</code>
      </div>
    </div>
    <div style={{ display: "flex", gap: 7, marginTop: 11, alignItems: "center" }}>
      <button onClick={onFix} style={{ border: "none", background: "#dc2626", color: "#fff", borderRadius: 7, padding: "7px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Hapus & build ulang</button>
      <details style={{ fontSize: 10, color: "#991b1b" }}><summary style={{ cursor: "pointer", userSelect: "none" }}>Detail teknis</summary><div style={{ marginTop: 6, maxHeight: 90, overflowY: "auto", whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{content.slice(0, 900)}</div></details>
    </div>
  </div>;
}

function renderMarkdown(content: string) {
  let text = content
    .replace(/<<<FILE:\s*[^\s>]+\s*>>>[\s\S]*?(?:<<<END>>>|$)/g, "")
    .replace(/<<<MEMORY:[\s\S]*?>>>/g, "")
    .replace(/<<<SQL>>>[\s\S]*?(?:<<<END>>>|$)/g, "")
    .trim();

  const lines = text.split("\n");
  const elements: any[] = [];
  let inCodeBlock = false;
  let codeBlockBuf: string[] = [];

  lines.forEach((line, idx) => {
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        elements.push(
          <pre key={"code-" + idx} style={{ background: "#1e1e2e", color: "#cdd6f4", padding: "8px 12px", borderRadius: 8, fontSize: 11, fontFamily: "monospace", overflowX: "auto", margin: "6px 0", whiteSpace: "pre" }}>
            {codeBlockBuf.join("\n")}
          </pre>
        );
        codeBlockBuf = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      return;
    }
    if (inCodeBlock) {
      codeBlockBuf.push(line);
      return;
    }

    const formatted = line
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code style='background:rgba(0,0,0,0.06);padding:2px 5px;border-radius:4px;font-family:monospace;font-size:11px'>$1</code>");

    if (line.trim().startsWith("- ") || line.trim().startsWith("* ")) {
      elements.push(
        <li key={idx} style={{ marginLeft: 16, marginBottom: 2 }} dangerouslySetInnerHTML={{ __html: formatted.trim().slice(2) }} />
      );
    } else if (/^\d+\.\s/.test(line.trim())) {
      elements.push(
        <li key={idx} style={{ marginLeft: 16, marginBottom: 2, listStyleType: "decimal" }} dangerouslySetInnerHTML={{ __html: formatted.trim().replace(/^\d+\.\s/, "") }} />
      );
    } else if (/^#{1,4}\s/.test(line.trim())) {
      const level = (line.trim().match(/^#+/) || ["###"])[0].length;
      const txt = formatted.trim().replace(/^#+\s/, "");
      const fs = level <= 2 ? 15 : 13;
      elements.push(
        <h4 key={idx} style={{ margin: "8px 0 4px", fontSize: fs, fontWeight: 700 }} dangerouslySetInnerHTML={{ __html: txt }} />
      );
    } else if (line.trim() !== "") {
      elements.push(
        <p key={idx} style={{ margin: "4px 0" }} dangerouslySetInnerHTML={{ __html: formatted }} />
      );
    }
  });

  return <div>{elements}</div>;
}

export default function Builder({ pid, onBack, initialPrompt }: { pid: string; onBack: () => void; initialPrompt?: string }) {
  // Project-scoped store: reset seluruh state builder saat pid berganti.
  const initProject = useBuilderStore((s) => s.initProject);
  useEffect(() => { initProject(pid); }, [pid]);
  const project = useBuilderStore((s) => s.project);
  const setProject = useBuilderStore((s) => s.setProject);
  const myRole = useBuilderStore((s) => s.myRole);
  const setMyRole = useBuilderStore((s) => s.setMyRole);
  const canEdit = myRole !== "viewer";
  const publishing = useBuilderStore((s) => s.publishing);
  const setPublishing = useBuilderStore((s) => s.setPublishing);
  const pubUrl = useBuilderStore((s) => s.pubUrl);
  const setPubUrl = useBuilderStore((s) => s.setPubUrl);
  const comments = useBuilderStore((s) => s.comments);
  const setComments = useBuilderStore((s) => s.setComments);
  const showComments = useBuilderStore((s) => s.showComments);
  const setShowComments = useBuilderStore((s) => s.setShowComments);
  const newComment = useBuilderStore((s) => s.newComment);
  const setNewComment = useBuilderStore((s) => s.setNewComment);

  // Komentar: daftar dimuat oleh useComments; mutasi menginvalidasi cache
  // sehingga daftar segar tanpa pemanggilan fetch manual.
  const commentsQuery = useComments(pid);
  const addCommentMut = useAddComment(pid);
  const resolveCommentMut = useResolveComment(pid);
  const publishMut = usePublishProject(pid);
  useEffect(() => {
    if (commentsQuery.data) setComments(commentsQuery.data.comments || []);
  }, [commentsQuery.data]);

  async function sendComment() {
    if (!newComment.trim() || !activeTab) return;
    try {
      await addCommentMut.mutateAsync({ filePath: activeTab, body: newComment.trim() });
      setNewComment("");
    } catch {}
  }

  async function toggleResolveComment(id: number) {
    try {
      await resolveCommentMut.mutateAsync(id);
    } catch {}
  }

  async function doPublish() {
    if (publishing || !canEdit) return;
    if (!confirm("Publish proyek ini?")) return;
    setPublishing(true);
    try {
      const d = await publishMut.mutateAsync();
      setPubUrl(d.url || "");
      alert("Dipublish! " + (d.url || ""));
    } catch (e: any) {
      alert("Gagal: " + e.message);
    } finally {
      setPublishing(false);
    }
  }
  const files = useBuilderStore((s) => s.files);
  const setFiles = useBuilderStore((s) => s.setFiles);
  const openTabs = useBuilderStore((s) => s.openTabs);
  const setOpenTabs = useBuilderStore((s) => s.setOpenTabs);
  const activeTab = useBuilderStore((s) => s.activeTab);
  const setActiveTab = useBuilderStore((s) => s.setActiveTab);
  const view = useBuilderStore((s) => s.view);
  const setView = useBuilderStore((s) => s.setView);
  const msgs = useBuilderStore((s) => s.msgs);
  const setMsgs = useBuilderStore((s) => s.setMsgs);
  const input = useBuilderStore((s) => s.input);
  const setInput = useBuilderStore((s) => s.setInput);
  const streaming = useBuilderStore((s) => s.streaming);
  const setStreaming = useBuilderStore((s) => s.setStreaming);
  const streamText = useBuilderStore((s) => s.streamText);
  const setStreamText = useBuilderStore((s) => s.setStreamText);
  const aiActivity = useBuilderStore((s) => s.aiActivity);
  const setAiActivity = useBuilderStore((s) => s.setAiActivity);
  const aiActivities = ["Menganalisa kebutuhan proyek", "Menyusun arsitektur halaman", "Merancang data dan alur pengguna", "Menulis komponen dan service", "Menyiapkan build dan database"]; 
  useEffect(() => {
    if (!streaming) return;
    let index = 0;
    setAiActivity(aiActivities[0]);
    const timer = window.setInterval(() => {
      index = (index + 1) % aiActivities.length;
      setAiActivity(aiActivities[index]);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const mode = useBuilderStore((s) => s.mode);
  const setMode = useBuilderStore((s) => s.setMode);
  const termOpen = useBuilderStore((s) => s.termOpen);
  const setTermOpen = useBuilderStore((s) => s.setTermOpen);
  const termLines = useBuilderStore((s) => s.termLines);
  const setTermLines = useBuilderStore((s) => s.setTermLines);
  const termInput = useBuilderStore((s) => s.termInput);
  const setTermInput = useBuilderStore((s) => s.setTermInput);
  const runtimeRunning = useBuilderStore((s) => s.runtimeRunning);
  const setRuntimeRunning = useBuilderStore((s) => s.setRuntimeRunning);
  const runtimePreview = useBuilderStore((s) => s.runtimePreview);
  const setRuntimePreview = useBuilderStore((s) => s.setRuntimePreview);
  const previewToken = useBuilderStore((s) => s.previewToken);
  const setPreviewToken = useBuilderStore((s) => s.setPreviewToken);
  const pipelinePhase = useBuilderStore((s) => s.pipelinePhase);
  const setPipelinePhase = useBuilderStore((s) => s.setPipelinePhase);
  const pipelineError = useBuilderStore((s) => s.pipelineError);
  const setPipelineError = useBuilderStore((s) => s.setPipelineError);
  const agentRun = useBuilderStore((s) => s.agentRun);
  const setAgentRun = useBuilderStore((s) => s.setAgentRun);
  const agentTools = useBuilderStore((s) => s.agentTools);
  const setAgentTools = useBuilderStore((s) => s.setAgentTools);
  const diagnosticsOpen = useBuilderStore((s) => s.diagnosticsOpen);
  const setDiagnosticsOpen = useBuilderStore((s) => s.setDiagnosticsOpen);
  const workspaceMenuOpen = useBuilderStore((s) => s.workspaceMenuOpen);
  const setWorkspaceMenuOpen = useBuilderStore((s) => s.setWorkspaceMenuOpen);
  const pipelineLabel = pipelinePhase === "sync" ? "Sinkronisasi file" : pipelinePhase === "install-build" ? "Membangun aplikasi" : pipelinePhase === "migration" ? "Menyiapkan database" : pipelinePhase === "database" ? "Memeriksa database" : pipelinePhase === "runtime" ? "Menyalakan preview" : pipelinePhase === "success" ? "Siap digunakan" : pipelinePhase === "failed" ? "Perlu diperbaiki" : "Siap";
  const runtimeFrameRef = useRef<HTMLIFrameElement>(null);
  const device = useBuilderStore((s) => s.device);
  const setDevice = useBuilderStore((s) => s.setDevice);
  const expanded = useBuilderStore((s) => s.expanded);
  const setExpanded = useBuilderStore((s) => s.setExpanded);
  const previewKey = useBuilderStore((s) => s.previewKey);
  const setPreviewKey = useBuilderStore((s) => s.setPreviewKey);
  const tables = useBuilderStore((s) => s.tables);
  const setTables = useBuilderStore((s) => s.setTables);
  const newTable = useBuilderStore((s) => s.newTable);
  const setNewTable = useBuilderStore((s) => s.setNewTable);
  const selectedTable = useBuilderStore((s) => s.selectedTable);
  const setSelectedTable = useBuilderStore((s) => s.setSelectedTable);
  const tableLoading = useBuilderStore((s) => s.tableLoading);
  const setTableLoading = useBuilderStore((s) => s.setTableLoading);
  const policies = useBuilderStore((s) => s.policies);
  const setPolicies = useBuilderStore((s) => s.setPolicies);
  const paletteOpen = useBuilderStore((s) => s.paletteOpen);
  const setPaletteOpen = useBuilderStore((s) => s.setPaletteOpen);
  const paletteQuery = useBuilderStore((s) => s.paletteQuery);
  const setPaletteQuery = useBuilderStore((s) => s.setPaletteQuery);
  const mobileTab = useBuilderStore((s) => s.mobileTab);
  const setMobileTab = useBuilderStore((s) => s.setMobileTab);
  const attachedFile = useBuilderStore((s) => s.attachedFile);
  const setAttachedFile = useBuilderStore((s) => s.setAttachedFile);
  const enhancing = useBuilderStore((s) => s.enhancing);
  const setEnhancing = useBuilderStore((s) => s.setEnhancing);
  const proposal = useBuilderStore((s) => s.proposal);
  const setProposal = useBuilderStore((s) => s.setProposal);
  const proposalSel = useBuilderStore((s) => s.proposalSel);
  const setProposalSel = useBuilderStore((s) => s.setProposalSel);
  const versions = useBuilderStore((s) => s.versions);
  const setVersions = useBuilderStore((s) => s.setVersions);
  const showVersions = useBuilderStore((s) => s.showVersions);
  const setShowVersions = useBuilderStore((s) => s.setShowVersions);
  const checkpointLabel = useBuilderStore((s) => s.checkpointLabel);
  const setCheckpointLabel = useBuilderStore((s) => s.setCheckpointLabel);
  const savingCheckpoint = useBuilderStore((s) => s.savingCheckpoint);
  const setSavingCheckpoint = useBuilderStore((s) => s.setSavingCheckpoint);
  const previewVersion = useBuilderStore((s) => s.previewVersion);
  const setPreviewVersion = useBuilderStore((s) => s.setPreviewVersion);
  const listening = useBuilderStore((s) => s.listening);
  const setListening = useBuilderStore((s) => s.setListening);

  function toggleListening() {
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      alert("Voice input tidak didukung browser ini. Gunakan Chrome atau Edge.");
      return;
    }
    if (listening) {
      setListening(false);
      return;
    }
    try {
      const recog = new SpeechRec();
      recog.lang = "id-ID";
      recog.continuous = false;
      recog.interimResults = false;
      recog.onstart = () => setListening(true);
      recog.onresult = (e: any) => {
        const txt = e.results[0][0].transcript;
        if (txt) setInput((prev) => (prev ? prev + " " + txt : txt));
        setListening(false);
      };
      recog.onerror = () => setListening(false);
      recog.onend = () => setListening(false);
      recog.start();
    } catch {
      setListening(false);
    }
  }
  const selectMode = useBuilderStore((s) => s.selectMode);
  const setSelectMode = useBuilderStore((s) => s.setSelectMode);
  const selectedEl = useBuilderStore((s) => s.selectedEl);
  const setSelectedEl = useBuilderStore((s) => s.setSelectedEl);
  const previewErrors = useBuilderStore((s) => s.previewErrors);
  const setPreviewErrors = useBuilderStore((s) => s.setPreviewErrors);
  const settingsOpen = useBuilderStore((s) => s.settingsOpen);
  const setSettingsOpen = useBuilderStore((s) => s.setSettingsOpen);
  const projSettings = useBuilderStore((s) => s.projSettings);
  const setProjSettings = useBuilderStore((s) => s.setProjSettings);
  const blueprintOpen = useBuilderStore((s) => s.blueprintOpen);
  const setBlueprintOpen = useBuilderStore((s) => s.setBlueprintOpen);
  const blueprint = useBuilderStore((s) => s.blueprint);
  const setBlueprint = useBuilderStore((s) => s.setBlueprint);
  const blueprintSaving = useBuilderStore((s) => s.blueprintSaving);
  const setBlueprintSaving = useBuilderStore((s) => s.setBlueprintSaving);
  // Live build streaming + auto-fix loop + self-test
  const autoFixCount = useBuilderStore((s) => s.autoFixCount);
  const setAutoFixCount = useBuilderStore((s) => s.setAutoFixCount);
  const selfTestStatus = useBuilderStore((s) => s.selfTestStatus);
  const setSelfTestStatus = useBuilderStore((s) => s.setSelfTestStatus);
  const previewErrorsRef = useRef<string[]>([]);
  const autoFixCountRef = useRef(0);
  const livePreviewSwitched = useRef(false);
  const lastLiveUpdate = useRef(0);
  const attachedImageRef = useRef<string | null>(null);
  // Guard agar initialPrompt dari landing hanya dikirim sekali (tidak double saat re-render)
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (initialPrompt && !initialPromptSentRef.current && msgs.length === 0) {
      initialPromptSentRef.current = true;
      // Tunggu sebentar agar project selesai dimuat, lalu kirim otomatis
      const t = setTimeout(() => { send(initialPrompt); }, 800);
      return () => clearTimeout(t);
    }
  }, [initialPrompt]);
  useEffect(() => { previewErrorsRef.current = previewErrors; }, [previewErrors]);
  // Agent runs: polling manual diganti useQuery dengan refetchInterval
  // yang sama seperti sebelumnya (1200ms saat streaming, 5000ms bila tidak).
  const agentRunsQuery = useAgentRuns(pid, streaming);
  const latestRun = agentRunsQuery.data?.runs?.[0];
  const agentRunDetailQuery = useAgentRunDetail(pid, latestRun?.id, streaming);
  useEffect(() => {
    if (latestRun) setAgentRun(latestRun);
  }, [latestRun]);
  useEffect(() => {
    if (agentRunDetailQuery.data) setAgentTools(agentRunDetailQuery.data.tools || []);
  }, [agentRunDetailQuery.data]);
  const updateAgentRunMut = useUpdateAgentRun(pid);
  function loadBlueprint() {
    setBlueprintOpen(true);
  }
  // Blueprint dimuat saat modal dibuka (query enabled oleh blueprintOpen).
  const blueprintQuery = useBlueprint(pid, blueprintOpen);
  const saveBlueprintMut = useSaveBlueprint(pid);
  useEffect(() => {
    if (blueprintOpen && blueprintQuery.data) setBlueprint(blueprintQuery.data.blueprint || "");
  }, [blueprintOpen, blueprintQuery.data]);
  async function saveBlueprint() {
    if (!blueprint.trim()) return;
    setBlueprintSaving(true);
    try {
      await saveBlueprintMut.mutateAsync(blueprint);
      setBlueprintOpen(false);
      setMsgs((m) => [...m, { role: "assistant", content: "✅ Blueprint disetujui. AI akan mengikuti rencana ini pada generate berikutnya." }]);
    } catch (e: any) { alert(e.message); } finally { setBlueprintSaving(false); }
  }
  const isMobile = useIsMobile();
  const msgsRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // Data proyek + riwayat chat dimuat oleh TanStack Query. Sinkronisasi
  // ke store hanya sekali per pid (guard ref) agar refetch/invalidasi
  // sesudah save tidak menimpa edit lokal.
  const qc = useQueryClient();
  const projectQuery = useProject(pid);
  const chatQuery = useChatHistory(pid);
  const projectLoadedRef = useRef<string | null>(null);
  const chatLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    const d = projectQuery.data;
    if (!d || projectLoadedRef.current === pid) return;
    projectLoadedRef.current = pid;
    setProject(d.project);
    setMyRole(d.role || "owner");
    const f = JSON.parse(d.project.files || "{}");
    setFiles(f);
    const keys = Object.keys(f);
    if (keys.length > 0) {
      const entry = keys.find((k) => k.includes("App.")) || keys[0];
      setOpenTabs([entry]);
      setActiveTab(entry);
    }
    // Change 5: auto-send initial prompt from sessionStorage
    const initPrompt = sessionStorage.getItem('wb_initial_prompt');
    if (initPrompt) {
      sessionStorage.removeItem('wb_initial_prompt');
      setTimeout(() => {
        setInput(initPrompt);
        setTimeout(() => {
          const btn = document.getElementById('wb-send-btn') as HTMLButtonElement;
          btn?.click();
        }, 100);
      }, 500);
    }
  }, [pid, projectQuery.data]);
  // Change 1: Load chat history (sekali per pid, hanya bila chat masih kosong).
  useEffect(() => {
    const messages = chatQuery.data?.messages;
    if (!messages?.length || chatLoadedRef.current === pid) return;
    chatLoadedRef.current = pid;
    if (useBuilderStore.getState().msgs.length === 0) {
      setMsgs(messages.map((m: any) => ({ role: m.role, content: m.content })));
    }
  }, [pid, chatQuery.data]);

  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, streamText]);

  // Stream runtime output over SSE; status is checked separately at a low rate.
  useEffect(() => {
    if (!termOpen || !runtimeRunning) return;
    let active = true;
    const controller = new AbortController();
    const consume = async () => {
      try {
        const response = await fetch(`/api/projects/${pid}/runtime/dev/log-stream`, {
          headers: { Authorization: "Bearer " + getToken(), Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const event of events) {
            const line = event.split("\n").find((x) => x.startsWith("data: "));
            if (!line) continue;
            try {
              const logs = JSON.parse(line.slice(6));
              if (typeof logs.output !== "string") continue;
              const next = logs.output.split("\n").filter(Boolean);
              setTermLines((prev) => [...prev.filter((x) => !x.startsWith("__RUNTIME_LOG__")), ...next.map((x: string) => "__RUNTIME_LOG__" + x)].slice(-160));
              const errors = next.filter((x: string) => /error|failed|missing script/i.test(x));
              if (errors.length) setPreviewErrors((prev) => [...new Set([...prev, ...errors])].slice(-8));
            } catch {}
          }
        }
      } catch {}
    };
    consume();
    return () => { active = false; controller.abort(); };
  }, [termOpen, runtimeRunning, pid]);

  // Status runtime di-poll oleh useRuntimeStatus (tiap 3 detik, aktif
  // hanya saat terminal terbuka dan runtime berjalan — sama seperti
  // timer lama yang kini diganti query ini).
  const runtimeStatusQuery = useRuntimeStatus(pid, termOpen && runtimeRunning);
  useEffect(() => {
    const d = runtimeStatusQuery.data;
    if (d) setRuntimeRunning(d.status === "running" || d.status === "starting");
  }, [runtimeStatusQuery.data]);

  // Aksi runtime satu-tembak (sync/start/stop/install/build/verifikasi/
  // pipeline) sebagai mutasi TanStack.
  const runtimeActions = useRuntimeActions(pid);

  // Terima pesan dari preview iframe (error console + click-to-edit)
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "wb-error") {
        setPreviewErrors((prev) => prev.includes(d.msg) ? prev : [...prev.slice(-4), d.msg]);
      } else if (d.type === "wb-select") {
        // Click-to-edit: info elemen masuk ke input chat sebagai konteks + fokus textarea
        const tag = String(d.tag || "?").toUpperCase();
        const txt = String(d.text || "").slice(0, 60);
        const cls = String(d.cls || "").split(" ").filter(Boolean)[0] || "";
        setInput(`[Edit elemen: ${tag}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}] `);
        setSelectMode(false);
        if (isMobile) setMobileTab("chat");
        setTimeout(() => document.getElementById("wb-prompt")?.focus(), 80);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isMobile]);

  // Self-test + auto-fix loop: setelah streaming selesai, tunggu 3 dtk agar
  // console error sempat masuk, lalu auto-fix bila ada error (maks 2x per pesan user)
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      (async () => {
        if (!canEdit) return;
        // Auto-fix hanya untuk mode yang menghasilkan kode
        if (!["build", "debug", "refactor"].includes(mode)) return;
        setSelfTestStatus("testing");
        // Bersihkan error sisa live-streaming; hanya error fresh dari kode final yang dihitung
        setPreviewErrors([]);
        previewErrorsRef.current = [];
        await new Promise((r) => setTimeout(r, 3000));
        setSelfTestStatus(null);
        const errs = (previewErrorsRef.current || []).filter(Boolean).slice(0, 5);
        if (errs.length > 0 && autoFixCountRef.current < 2) {
          autoFixCountRef.current += 1;
          setAutoFixCount(autoFixCountRef.current);
          setSelfTestStatus("fixing");
          setMsgs((m) => [...m, { role: "assistant", content: `🔧 AI memperbaiki error otomatis (${autoFixCountRef.current}/2)...` }]);
          await send(`Perbaiki error berikut pada aplikasi:\n${errs.join("\n")}\n\nPerbaiki kodenya agar error hilang dan aplikasi berjalan normal.`, true);
          setSelfTestStatus(null);
        }
      })();
    }
    wasStreaming.current = streaming;
  }, [streaming, canEdit, mode]);

  // Auto-refresh preview saat file berubah (debounce)
  useEffect(() => {
    if (view !== "preview") return;
    const t = setTimeout(async () => {
      setPreviewKey((k) => k + 1);
      if (runtimePreview) {
        try {
          await runtimeActions.sync();
        } catch {}
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [files, runtimePreview, pid]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setPaletteOpen(true); setPaletteQuery(""); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (activeTab) saveFiles(files); }
      if (e.key === "Escape") setPaletteOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, files]);

  const saveProjectMut = useSaveProject(pid);
  async function saveFiles(nf: Record<string, string>) {
    if (!canEdit) return;
    setFiles(nf);
    await saveProjectMut.mutateAsync(nf);
  }

  const mobileTreeOpen = useBuilderStore((s) => s.mobileTreeOpen);
  const setMobileTreeOpen = useBuilderStore((s) => s.setMobileTreeOpen);

  function openFile(path: string) {
    if (!openTabs.includes(path)) setOpenTabs((t) => [...t, path]);
    setActiveTab(path);
    setView("code");
    if (isMobile) {
      setMobileTab("code");
      setMobileTreeOpen(false);
    }
  }

  function closeTab(path: string) {
    const nt = openTabs.filter((x) => x !== path);
    setOpenTabs(nt);
    if (activeTab === path) setActiveTab(nt[0] || "");
  }

  function onEdit(value: string | undefined) {
    if (!activeTab) return;
    const nf = { ...files, [activeTab]: value || "" };
    setFiles(nf);
    clearTimeout((window as any).__saveT);
    (window as any).__saveT = setTimeout(() => saveFiles(nf), 1500);
  }

  // Tabel & policy dimuat otomatis saat tab Database aktif; mutasi
  // menginvalidasi cache sehingga daftar segar.
  const tablesQuery = useTables(pid, view === "db");
  const policiesQuery = usePolicies(pid, view === "db");
  const createTableMut = useCreateTable(pid);
  const savePolicyMut = useSavePolicy(pid);
  useEffect(() => {
    if (tablesQuery.data) setTables(tablesQuery.data.tables || []);
  }, [tablesQuery.data]);
  useEffect(() => {
    if (policiesQuery.data) setPolicies(policiesQuery.data.policies || []);
  }, [policiesQuery.data]);

  async function loadPolicies() {
    await qc.invalidateQueries({ queryKey: projectKeys.policies(pid) });
  }

  async function savePolicy(table: string, role: string, operation: string, enabled: boolean) {
    await savePolicyMut.mutateAsync({ table, role, operation, enabled });
  }

  async function inspectTable(name: string) {
    setTableLoading(true);
    try {
      const d = await qc.fetchQuery({
        queryKey: projectKeys.tableDetail(pid, name),
        queryFn: () => fetchTableDetail(pid, name),
      });
      setSelectedTable(d);
    } catch (e: any) {
      alert(e.message || "Gagal membaca tabel");
    } finally {
      setTableLoading(false);
    }
  }

  async function createTable() {
    if (!newTable.trim()) return;
    await createTableMut.mutateAsync(newTable.trim());
    setNewTable("");
  }

  async function runTerm(cmd: string) {
    const c = cmd.trim();
    if (!c) return;
    setTermLines((l) => [...l, "$ " + c]);
    const [bin, ...args] = c.split(/\s+/);
    let out = "";
    if (bin === "help") out = "ls, tree, cat <file>, echo, clear, whoami, npm install, npm run build, runtime start, runtime stop, verify, db verify";
    else if (bin === "ls") out = Object.keys(files).join("\n") || "(kosong)";
    else if (bin === "cat") out = (files[args[0]] || "file tidak ada").slice(0, 2000);
    else if (bin === "echo") out = args.join(" ");
    else if (bin === "whoami") out = "builder-sandbox";
    else if (c === "runtime start" || c === "runtime stop") {
      try {
        const action = c.endsWith("start") ? "start" : "stop";
        const d = await (action === "start" ? runtimeActions.start() : runtimeActions.stop());
        setRuntimeRunning(action === "start" && d.status !== "stopped");
        out = JSON.stringify(d);
      } catch (e: any) { out = "Runtime error: " + (e?.message || e); }
    }
    else if (c === "clear") { setTermLines([]); return; }
    else if (c === "npm install" || c === "npm i") {
      setTermLines((l) => [...l, "⏳ Menjalankan npm install di runtime sandbox..."]);
      try {
        const d = await runtimeActions.install();
        out = (d.output || d.error || "Selesai") + `\n[exit code: ${d.exitCode ?? "?"}]`;
      } catch (e: any) { out = "Runtime error: " + (e?.message || e); }
    } else if (c === "npm run build") {
      setTermLines((l) => [...l, "⏳ Menjalankan npm run build di runtime sandbox..."]);
      try {
        const d = await runtimeActions.build();
        out = (d.output || d.error || "Selesai") + `\n[exit code: ${d.exitCode ?? "?"}]`;
        if (d.status === "success") setPreviewErrors([]);
      } catch (e: any) { out = "Runtime error: " + (e?.message || e); }
    } else if (c === "db verify") {
      setTermLines((l) => [...l, "⏳ Menjalankan database connection + CRUD verification..."]);
      try {
        const d = await runtimeActions.dbVerify();
        out = (d.message || d.error || "Selesai") + `\nsteps: ${(d.steps || []).join(" → ")}`;
        if (d.status !== "success" && d.error) setPreviewErrors((prev) => [...prev.slice(-4), d.error]);
      } catch (e: any) { out = "Database runtime error: " + (e?.message || e); }
    } else if (c === "verify" || c === "npm run verify") {
      setTermLines((l) => [...l, "⏳ Install + build verification dimulai..."]);
      try {
        const d = await runtimeActions.verify();
        out = (d.output || d.error || "Selesai") + `\n[phase: ${d.phase || "?"}, exit code: ${d.exitCode ?? "?"}]`;
        if (d.status === "success") setPreviewErrors([]);
        else if (d.error) setPreviewErrors((prev) => [...prev, d.error]);
      } catch (e: any) { out = "Runtime error: " + (e?.message || e); }
    } else out = "command not found: " + bin;
    setTermLines((l) => [...l, out]);
  }

  async function send(overrideText?: string, isAutoFix = false) {
    let text = (typeof overrideText === "string" ? overrideText : input).trim();
    if (attachedFile) {
      text += "\n\n[File: " + attachedFile.filename + "]\n" + attachedFile.full.slice(0, 8000);
      setAttachedFile(null);
    }
    const img = attachedImageRef.current || attachedImage;
    if (img) {
      text += "\n\n[Gambar terlampir — analisa dan buatkan website sesuai gambar]";
      setAttachedImage(null);
      attachedImageRef.current = null;
    }
    if (!text || streaming) return;
    // Reset counter auto-fix untuk pesan baru dari user (bukan dari auto-fix)
    if (!isAutoFix) {
      autoFixCountRef.current = 0;
      setAutoFixCount(0);
    }
    livePreviewSwitched.current = false;
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setStreaming(true);
    setStreamText("");
    try {
      const r = await fetch(`/api/projects/${pid}/chat`, {
        method: "POST",
        headers: { Authorization: "Bearer " + getToken(), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          mode,
          image: img || undefined,
          previewErrors: previewErrors.slice(-8),
          terminalLines: termLines.slice(-80),
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        const statusMsg = r.status === 401
          ? "Sesi login sudah berakhir. Muat ulang halaman lalu login kembali."
          : r.status === 402
            ? (d.message || "Kuota AI habis. Buka Dashboard → Billing untuk upgrade paket.")
            : (d.message || d.error || `Server AI mengembalikan HTTP ${r.status}.`);
        throw new Error(statusMsg);
      }
      if (!r.body) throw new Error("Server tidak mengirim stream AI. Coba muat ulang halaman.");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "", resultStatus = "", resultSummary = "";
      const handleBlock = (block: string) => {
        // SSE bernama: "event: result" + "data: {...}". Sebelumnya hanya baris
        // data yang dibaca sehingga status akhir (completed/failed) dan progres
        // auto-fix dari server tidak pernah muncul di chat.
        let evName = "message";
        let dataLine = "";
        for (const raw of block.split("\n")) {
          const line = raw.trim();
          if (line.startsWith("event:")) evName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
        }
        if (!dataLine || dataLine === "[DONE]") return;
        let chunk: any;
        try { chunk = JSON.parse(dataLine); } catch { return; }
        if (evName === "result" && chunk && typeof chunk === "object") {
          resultStatus = chunk.status || "";
          resultSummary = chunk.summary || "";
          return;
        }
        if (evName === "auto_fix" && chunk && typeof chunk === "object") {
          const attempt = Number(chunk.attempt || 1);
          setMsgs((m) => [...m, { role: "assistant", content: `🔧 Build belum lolos. Memperbaiki otomatis (percobaan ${attempt}/3)…` }]);
          return;
        }
        if (typeof chunk === "string") {
          full += chunk; setStreamText(full);
          // Live build streaming: parse blok FILE parsial & update preview real-time
          const now = Date.now();
          if (now - lastLiveUpdate.current > 600) {
            lastLiveUpdate.current = now;
            const live = extractLiveFiles(full);
            if (Object.keys(live).length > 0) {
              setFiles((prev) => ({ ...prev, ...live }));
              if (!livePreviewSwitched.current) {
                livePreviewSwitched.current = true;
                setView("preview");
                if (isMobile) setMobileTab("preview");
              }
            }
          }
        } else if (chunk && (chunk.__applied__ || chunk.__proposal__ || chunk.applied)) {
          if (chunk.files) {
            const parsed = JSON.parse(chunk.files);
            setFiles(parsed);
            const keys = Object.keys(parsed);
            const entry = keys.find((k) => k.includes("App.")) || keys[0];
            if (entry) {
              setOpenTabs((t) => (t.includes(entry) ? t : [...t, entry]));
              setActiveTab(entry);
            }
          }
          if (!chunk.autoFix) {
            setView("preview");
            setPreviewKey((k) => k + 1);
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) handleBlock(p);
      }
      if (buf.trim()) handleBlock(buf);
      if (full.trim()) {
        setMsgs((m) => [...m, { role: "assistant", content: full }]);
      }
      // Segarkan file dari server (refetch paksa; cache query ikut mutakhir).
      const { data: d } = await projectQuery.refetch();
      if (d) {
        setFiles(JSON.parse(d.project.files || "{}"));
        setProject(d.project);
      }
      // Server sudah menjalankan pipeline + auto-repair sendiri (maks 3x).
      // Klien tidak boleh mengulang perbaikan: itu memicu dua alur edit yang
      // saling menimpa dan biaya AI ganda.
      if (mode !== "ask" && mode !== "plan" && mode !== "review") {
        if (resultStatus === "failed") {
          const detail = lastLinesText(resultSummary, 4);
          setMsgs((m) => [...m, { role: "assistant", content: "⚠️ Belum berhasil.\n" + detail }]);
          setPreviewErrors((prev) => [...prev.slice(-4), detail]);
        } else if (resultStatus === "completed") {
          setMsgs((m) => [...m, { role: "assistant", content: "✅ Kode diterapkan dan diverifikasi: install, build, database, dan Live Runtime selesai." }]);
        } else {
          const pipeline = await autoPrepareAndRunProject(parseGeneratedSQL(full));
          if (pipeline.status !== "success" && pipeline.error) {
            const pipelineDetail = String(pipeline.error);
            setMsgs((m) => [...m, { role: "assistant", content: "⚠️ Belum berhasil.\n" + lastLinesText(pipelineDetail, 4) }]);
            setPreviewErrors((prev) => [...prev.slice(-4), pipelineDetail]);
          }
        }
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", content: "Error: " + e.message }]);
    } finally {
      setStreaming(false);
      setStreamText("");
    }
  }

  async function waitForRuntimeReady(maxAttempts = 15): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      const d = await fetchRuntimeStatus(pid).catch(() => ({}));
      if (d.status === "running" && d.port) return d;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    throw new Error("Live Runtime belum siap setelah 12 detik");
  }

  async function updateLatestAgentRun(phase: string, status = "running", error = "") {
    try {
      const data = await fetchAgentRuns(pid);
      const latest = data.runs?.[0];
      if (!latest || latest.status === "completed" || latest.status === "failed") return;
      await updateAgentRunMut.mutateAsync({ runId: latest.id, phase, status, error });
    } catch {}
  }

  async function autoPrepareAndRunProject(sqlBlocks: string[] = []): Promise<{ status: string; error?: string }> {
    await updateLatestAgentRun("syncing");
    try {
      setTermOpen(true);
      setPipelineError("");
      setPipelinePhase("sync");
      setTermLines((l) => [...l, "🤖 AI pipeline: sinkronisasi file..."]);
      const sync = await runtimeActions.sync();
      if (sync.error) throw new Error(sync.error);
      setTermLines((l) => [...l, "✅ File tersinkron ke runtime"]);

      setPipelinePhase("install-build");
      await updateLatestAgentRun("install_build");
      setTermLines((l) => [...l, "🤖 AI pipeline: npm install + npm run build..."]);
      if (sqlBlocks.length > 0) { setPipelinePhase("migration"); await updateLatestAgentRun("migration"); }
      const verify = await runtimeActions.pipeline(sqlBlocks);
      await updateLatestAgentRun("database_verify");
      if (verify.migrations?.length) setTermLines((l) => [...l, "✅ Migration backend: " + verify.migrations.join(", ")]);
      if (verify.database === "ready") setTermLines((l) => [...l, "✅ Database backend siap"]);
      const verifyOutput = (verify.output || verify.error || "").slice(-12000);
      setTermLines((l) => [...l, verify.status === "success" ? "✅ Install dan build berhasil" : `❌ Build gagal (${verify.phase || "runtime"})`, verifyOutput]);
      if (verify.status !== "success") {
        const error = verify.error || `Build gagal pada phase ${verify.phase || "runtime"}`;
        setPreviewErrors((prev) => [...prev.slice(-4), error]);
        await updateLatestAgentRun(verify.phase || "build", "failed", error);
        return { status: "failed", error };
      }

      setPipelinePhase("database");
      await updateLatestAgentRun("database_verify");
      if (verify.database === "ready") {
        setTermLines((l) => [...l, "✅ Database gate backend berhasil"]);
      }

      setPipelinePhase("runtime");
      await updateLatestAgentRun("runtime");
      setTermLines((l) => [...l, "🤖 AI pipeline: menjalankan Live Runtime..."]);
      const runtime = await runtimeActions.start();
      if (runtime.error) throw new Error(runtime.error);
      const ready = await waitForRuntimeReady();
      setRuntimeRunning(true);
      setRuntimePreview(true);
      setPreviewToken(runtime.previewToken || "");
      // Runtime ready is not enough: run a browser/preview acceptance gate before success.
      await updateLatestAgentRun("acceptance_check");
      let acceptanceData: any;
      try {
        acceptanceData = await fetchSmokeTest(pid);
      } catch (e: any) {
        const error = e.message || "Acceptance check gagal";
        await updateLatestAgentRun("acceptance_check", "failed", error);
        throw new Error(error);
      }
      if (acceptanceData.status === "failed" || acceptanceData.errors?.length) {
        const error = acceptanceData.error || acceptanceData.message || (acceptanceData.errors || []).join("; ") || "Acceptance check gagal";
        await updateLatestAgentRun("acceptance_check", "failed", error);
        throw new Error(error);
      }
      setPipelinePhase("success");
      await updateLatestAgentRun("completed", "completed");
      setPreviewErrors([]);
      setTermLines((l) => [...l, `✅ Live Runtime aktif${ready.port ? ` di port ${ready.port}` : ""}`]);
      return { status: "success" };
    } catch (e: any) {
      const error = e?.message || String(e);
      setPipelinePhase("failed");
      setPipelineError(error);
      setTermLines((l) => [...l, "❌ AI pipeline gagal: " + error]);
      setPreviewErrors((prev) => [...prev.slice(-4), error]);
      await updateLatestAgentRun("failed", "failed", error);
      return { status: "failed", error };
    }
  }

  async function verifyRuntime() {
    setTermLines((l) => [...l, "⏳ Verifikasi project: npm install + npm run build..."]);
    try {
      const d = await runtimeActions.verify();
      const summary = d.status === "success" ? "✅ Build berhasil" : `❌ Build gagal (${d.phase || "runtime"})`;
      setTermLines((l) => [...l, summary, (d.output || d.error || "").slice(-12000)]);
      if (d.status === "success") setPreviewErrors([]);
      else if (d.error) setPreviewErrors((prev) => prev.includes(d.error) ? prev : [...prev.slice(-4), d.error]);
      return d;
    } catch (e: any) {
      const msg = "Runtime error: " + (e?.message || e);
      setTermLines((l) => [...l, msg]);
      setPreviewErrors((prev) => [...prev.slice(-4), msg]);
      return { status: "failed", error: msg };
    }
  }

  const applyProposalMut = useApplyProposal(pid);
  const rejectProposalMut = useRejectProposal(pid);
  const restoreVersionMut = useRestoreVersion(pid);
  const checkpointMut = useCheckpointVersion(pid);
  const versionsQuery = useProjectVersions(pid, showVersions);
  useEffect(() => {
    if (versionsQuery.data) setVersions(versionsQuery.data.versions || []);
  }, [versionsQuery.data]);

  async function applyProposal() {
    const accepted = Object.keys(proposalSel).filter((f) => proposalSel[f]);
    const d = await applyProposalMut.mutateAsync(accepted);
    setProposal(null);
    setFiles(d.files);
    setProject(d.project);
    // Change 3: Auto-switch to preview after applying AI changes
    setView("preview");
    setPreviewKey((k) => k + 1);
  }

  async function rejectProposal() {
    await rejectProposalMut.mutateAsync();
    setProposal(null);
  }

  function loadVersions() {
    setShowVersions(true);
  }

  async function restoreVersion(vid: number) {
    if (!confirm("Kembalikan ke versi ini? Snapshot saat ini akan disimpan dulu sebagai 'Sebelum restore'.")) return;
    const d = await restoreVersionMut.mutateAsync(vid);
    setShowVersions(false);
    setPreviewVersion(null);
    setFiles(d.files);
  }

  async function previewVersionFiles(vid: number, label: string) {
    const d = await qc.fetchQuery({
      queryKey: projectKeys.versionFiles(pid, vid),
      queryFn: () => fetchVersionFiles(pid, vid),
    });
    setPreviewVersion({ id: vid, label, files: d.files || {} });
  }

  async function doSaveCheckpoint() {
    const label = checkpointLabel.trim();
    setSavingCheckpoint(true);
    await checkpointMut.mutateAsync(label || "Checkpoint");
    setSavingCheckpoint(false);
    setCheckpointLabel("");
  }

  async function fixErrorWithAI(err: string, attempt = 1) {
    if (attempt > 3) {
      setMsgs((m) => [...m, { role: "assistant", content: "❌ Auto-fix dihentikan setelah 3 percobaan. Periksa output Terminal untuk error terakhir." }]);
      return;
    }
    setPreviewErrors([]);
    setTermLines((l) => [...l, `🔧 Auto-fix AI percobaan ${attempt}/3: menganalisa error...`]);
    setMsgs((m) => [...m, { role: "user", content: "Perbaiki error ini di preview: " + err }]);
    // langsung kirim sebagai chat debug
    const text = "Perbaiki error ini di preview: " + err;
    setStreaming(true);
    setStreamText("");
    try {
      const r = await fetch(`/api/projects/${pid}/chat`, {
        method: "POST",
        headers: { Authorization: "Bearer " + getToken(), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          mode: "debug",
          previewErrors: [err, ...previewErrors].slice(0, 8),
          terminalLines: termLines.slice(-80),
        }),
      });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          const line = p.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data);
            if (typeof chunk === "string") {
              full += chunk; setStreamText(full);
              // Live build streaming: update preview incremental juga saat auto-fix
              const now = Date.now();
              if (now - lastLiveUpdate.current > 600) {
                lastLiveUpdate.current = now;
                const live = extractLiveFiles(full);
                if (Object.keys(live).length > 0) setFiles((prev) => ({ ...prev, ...live }));
              }
            }
            else if (chunk && (chunk.__applied__ || chunk.__proposal__)) {
              if (chunk.files) {
                const parsed = JSON.parse(chunk.files);
                setFiles(parsed);
                const keys = Object.keys(parsed);
                const entry = keys.find((k) => k.includes("App.")) || keys[0];
                if (entry) {
                  setOpenTabs((t) => (t.includes(entry) ? t : [...t, entry]));
                  setActiveTab(entry);
                }
              }
              setView("preview");
              setPreviewKey((k) => k + 1);
            }
          } catch {}
        }
      }
      setMsgs((m) => [...m, { role: "assistant", content: full }]);
      // Setelah AI menerapkan perbaikan, jalankan pipeline penuh dan ulangi bila masih gagal.
      const verify = await autoPrepareAndRunProject(parseGeneratedSQL(full));
      if (verify.status !== "success") {
        const nextError = verify.error || "Pipeline gagal; periksa fase terakhir di Terminal."
        await fixErrorWithAI(nextError, attempt + 1);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", content: "Error: " + e.message }]);
    } finally {
      setStreaming(false);
      setStreamText("");
    }
  }

  // Pengaturan proyek dimuat saat modal dibuka (query enabled oleh settingsOpen).
  const projectSettingsQuery = useProjectSettings(pid, settingsOpen);
  const saveProjectSettingsMut = useSaveProjectSettings(pid);
  const enhanceMut = useEnhancePrompt();
  const uploadFileMut = useUploadFile();
  useEffect(() => {
    if (settingsOpen && projectSettingsQuery.data) setProjSettings(projectSettingsQuery.data);
  }, [settingsOpen, projectSettingsQuery.data]);

  function loadProjectSettings() {
    setSettingsOpen(true);
  }

  async function saveProjectSettings(s: any) {
    await saveProjectSettingsMut.mutateAsync(s);
    setSettingsOpen(false);
  }

  async function enhance() {
    const text = input.trim();
    if (!text || enhancing) return;
    setEnhancing(true);
    try {
      const d = await enhanceMut.mutateAsync(text);
      if (d.enhanced) setInput(d.enhanced);
    } catch {}
    setEnhancing(false);
  }

  async function uploadFile(f: File) {
    try {
      const d = await uploadFileMut.mutateAsync(f);
      if (d.isImage) {
        setAttachedFile({ filename: d.filename, full: "", });
        setAttachedImage(d.dataUrl);
        attachedImageRef.current = d.dataUrl;
      } else if (d.full) {
        setAttachedFile({ filename: d.filename, full: d.full });
      }
    } catch {}
  }

  const attachedImage = useBuilderStore((s) => s.attachedImage);
  const setAttachedImage = useBuilderStore((s) => s.setAttachedImage);
  const genImgOpen = useBuilderStore((s) => s.genImgOpen);
  const setGenImgOpen = useBuilderStore((s) => s.setGenImgOpen);
  const fileMenuPath = useBuilderStore((s) => s.fileMenuPath);
  const setFileMenuPath = useBuilderStore((s) => s.setFileMenuPath);
  const renamingPath = useBuilderStore((s) => s.renamingPath);
  const setRenamingPath = useBuilderStore((s) => s.setRenamingPath);
  const renameVal = useBuilderStore((s) => s.renameVal);
  const setRenameVal = useBuilderStore((s) => s.setRenameVal);
  const creatingFile = useBuilderStore((s) => s.creatingFile);
  const setCreatingFile = useBuilderStore((s) => s.setCreatingFile);
  const newFilePath = useBuilderStore((s) => s.newFilePath);
  const setNewFilePath = useBuilderStore((s) => s.setNewFilePath);
  const genImgPrompt = useBuilderStore((s) => s.genImgPrompt);
  const setGenImgPrompt = useBuilderStore((s) => s.setGenImgPrompt);
  const genImgLoading = useBuilderStore((s) => s.genImgLoading);
  const setGenImgLoading = useBuilderStore((s) => s.setGenImgLoading);
  const genImgResult = useBuilderStore((s) => s.genImgResult);
  const setGenImgResult = useBuilderStore((s) => s.setGenImgResult);
  const ghOpen = useBuilderStore((s) => s.ghOpen);
  const setGhOpen = useBuilderStore((s) => s.setGhOpen);
  const ghRepo = useBuilderStore((s) => s.ghRepo);
  const setGhRepo = useBuilderStore((s) => s.setGhRepo);
  const ghToken = useBuilderStore((s) => s.ghToken);
  const setGhToken = useBuilderStore((s) => s.setGhToken);
  const ghHasToken = useBuilderStore((s) => s.ghHasToken);
  const setGhHasToken = useBuilderStore((s) => s.setGhHasToken);
  const ghLoading = useBuilderStore((s) => s.ghLoading);
  const setGhLoading = useBuilderStore((s) => s.setGhLoading);

  // GitHub: pengaturan dimuat saat modal dibuka (query enabled oleh ghOpen).
  const gitHubQuery = useGitHubSettings(ghOpen);
  const saveGitHubMut = useSaveGitHubSettings();
  const gitHubPushPullMut = useGitHubPushPull(pid);
  const generateImageMut = useGenerateImage();
  useEffect(() => {
    if (ghOpen && gitHubQuery.data) {
      setGhRepo(gitHubQuery.data.repo || "");
      setGhHasToken(gitHubQuery.data.hasToken);
    }
  }, [ghOpen, gitHubQuery.data]);

  function loadGitHub() {
    setGhOpen(true);
  }

  async function saveGitHub() {
    setGhLoading(true);
    await saveGitHubMut.mutateAsync({ repo: ghRepo, token: ghToken || undefined });
    setGhToken("");
    setGhLoading(false);
  }

  async function githubPushPull(action: string) {
    if (!confirm(action === "push" ? "Push semua file ke GitHub?" : "Pull dari GitHub? File lokal akan diganti.")) return;
    setGhLoading(true);
    const d = await gitHubPushPullMut.mutateAsync(action);
    alert(d.message);
    setGhLoading(false);
    if (action === "pull" && d.files) {
      setFiles(d.files);
    }
  }

  async function generateImage() {
    if (!genImgPrompt.trim() || genImgLoading) return;
    setGenImgLoading(true);
    setGenImgResult(null);
    try {
      const d = await generateImageMut.mutateAsync(genImgPrompt);
      if (d.url) setGenImgResult(d.url);
      else alert(d.message || "Gagal");
    } catch (e: any) {
      alert("Gagal: " + e.message);
    }
    setGenImgLoading(false);
  }

  // Change 2: File tree CRUD (mutasi mengembalikan map file terbaru).
  const createFileMut = useCreateProjectFile(pid);
  const deleteFileMut = useDeleteProjectFile(pid);
  const renameFileMut = useRenameProjectFile(pid);

  async function createFile() {
    const path = newFilePath.trim();
    if (!path) return;
    const files = await createFileMut.mutateAsync(path);
    setCreatingFile(false);
    setNewFilePath("");
    setFiles(files);
    openFile(path);
  }

  async function deleteFile(path: string) {
    if (!confirm(`Hapus file "${path}"?`)) return;
    const files = await deleteFileMut.mutateAsync(path);
    setFileMenuPath(null);
    if (activeTab === path) setActiveTab("");
    setOpenTabs((t) => t.filter((x) => x !== path));
    setFiles(files);
  }

  async function renameFile(from: string, to: string) {
    const toPath = to.trim();
    if (!toPath || toPath === from) { setRenamingPath(null); return; }
    const files = await renameFileMut.mutateAsync({ from, to: toPath });
    setRenamingPath(null);
    setFileMenuPath(null);
    if (activeTab === from) setActiveTab(toPath);
    setOpenTabs((t) => t.map((x) => (x === from ? toPath : x)));
    setFiles(files);
  }

  // Change 4: Quick undo
  async function quickUndo() {
    const d = await qc.fetchQuery({
      queryKey: projectKeys.versions(pid),
      queryFn: () => fetchProjectVersions(pid),
    });
    const versions = d.versions || [];
    if (versions.length === 0) { alert("Belum ada riwayat untuk di-undo"); return; }
    const prev = versions[1] || versions[0];
    if (!confirm(`Undo ke: "${prev.label}" (${new Date(prev.createdAt).toLocaleString("id-ID")})?`)) return;
    const d2 = await restoreVersionMut.mutateAsync(prev.id);
    setFiles(d2.files);
  }
  function renderTree(nodes: FileNode[], depth: number): any {
    return nodes.map((n) => {
      const name = n.path.split("/").pop()!;
      const isDir = !!n.children;
      const exp = expanded[n.path];
      const isRenaming = renamingPath === n.path;
      return (
        <div key={n.path}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 0, borderRadius: 6, background: activeTab === n.path ? "#fff7ed" : "transparent" }}
            onMouseLeave={() => { if (fileMenuPath === n.path) setFileMenuPath(null); }}
          >
            <div
              onClick={() => isDir ? setExpanded((e) => ({ ...e, [n.path]: !e[n.path] })) : openFile(n.path)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", paddingLeft: 8 + depth * 14, cursor: "pointer", fontSize: 13, flex: 1, minWidth: 0 }}
            >
              {isDir ? (exp ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <File size={14} style={{ color: "#9ca3af" }} />}
              {isDir && (exp ? <FolderOpen size={14} style={{ color: ORANGE }} /> : <Folder size={14} style={{ color: ORANGE }} />)}
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") renameFile(n.path, renameVal); if (e.key === "Escape") setRenamingPath(null); }}
                  onBlur={() => renameFile(n.path, renameVal)}
                  style={{ flex: 1, fontSize: 12, border: "1px solid " + ORANGE, borderRadius: 4, padding: "1px 4px", outline: "none", minWidth: 0 }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{name}</span>
              )}
            </div>
            {!isDir && canEdit && (
              <div style={{ position: "relative", flexShrink: 0 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); setFileMenuPath(fileMenuPath === n.path ? null : n.path); }}
                  style={{ border: "none", background: "none", cursor: "pointer", padding: "2px 6px", color: "#9ca3af", fontSize: 14, lineHeight: 1 }}
                  title="Opsi file"
                >⋯</button>
                {fileMenuPath === n.path && (
                  <div style={{ position: "absolute", right: 0, top: "100%", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 130 }}>
                    <button onClick={(e) => { e.stopPropagation(); setRenamingPath(n.path); setRenameVal(n.path); setFileMenuPath(null); }}
                      style={{ display: "block", width: "100%", padding: "8px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 13, textAlign: "left" }}>
                      ✏️ Rename
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); deleteFile(n.path); }}
                      style={{ display: "block", width: "100%", padding: "8px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 13, textAlign: "left", color: "#dc2626" }}>
                      🗑️ Hapus
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {isDir && exp && renderTree(n.children!, depth + 1)}
        </div>
      );
    });
  }

  if (!project) return <p style={{ padding: 24 }}>Memuat...</p>;

  const tree = buildTree(Object.keys(files));
  const deviceWidth = device === "mobile" ? 390 : device === "tablet" ? 768 : "100%";
  const showChat = !isMobile || mobileTab === "chat";
  const showCode = !isMobile || mobileTab !== "chat";
  const showTree = view === "code" && (!isMobile || (mobileTab === "code" && mobileTreeOpen));

  const fileTreePanel = (
    <div style={{ width: isMobile ? 200 : 230, borderRight: "1px solid #e5e7eb", background: "#fafafa", display: "flex", flexDirection: "column", ...(isMobile ? { position: "absolute", left: 0, top: 0, bottom: 0, zIndex: 20, boxShadow: "4px 0 10px rgba(0,0,0,0.1)" } : {}) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280" }}>FILES</span>
        <div style={{ display: "flex", gap: 4 }}>
          {canEdit && (
            <button onClick={() => { setCreatingFile(true); setNewFilePath(""); }} style={{ border: "none", background: "none", cursor: "pointer", color: ORANGE, padding: 2 }} title="File baru">
              <Plus size={14} />
            </button>
          )}
          {isMobile && (
            <button onClick={() => setMobileTreeOpen(false)} style={{ border: "none", background: "none", cursor: "pointer", color: "#6b7280", padding: 2 }}>
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {creatingFile && (
        <div style={{ padding: "4px 8px", display: "flex", gap: 4 }}>
          <input
            autoFocus
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createFile(); if (e.key === "Escape") setCreatingFile(false); }}
            placeholder="src/NewFile.tsx"
            style={{ flex: 1, fontSize: 12, border: "1px solid " + ORANGE, borderRadius: 4, padding: "3px 6px", outline: "none", minWidth: 0 }}
          />
          <button onClick={createFile} style={{ border: "none", background: ORANGE, color: "#fff", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}>✓</button>
          <button onClick={() => setCreatingFile(false)} style={{ border: "none", background: "#e5e7eb", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 12px" }}>{renderTree(tree, 0)}</div>
    </div>
  );

  const codePanel = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: "#fff" }}>
      {view === "code" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", overflowX: "auto", background: "#fafafa", alignItems: "center" }}>
            {isMobile && !mobileTreeOpen && (
              <button onClick={() => setMobileTreeOpen(true)} style={{ padding: "10px 12px", background: "none", border: "none", borderRight: "1px solid #e5e7eb", cursor: "pointer" }}>
                <FolderOpen size={16} style={{ color: ORANGE }} />
              </button>
            )}
            {openTabs.map((t) => (
              <div key={t} onClick={() => setActiveTab(t)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", fontSize: 13, cursor: "pointer", borderRight: "1px solid #e5e7eb", background: activeTab === t ? "#fff" : "transparent", whiteSpace: "nowrap" }}>
                {t.split("/").pop()}
                <X size={13} style={{ color: "#9ca3af" }} onClick={(e) => { e.stopPropagation(); closeTab(t); }} />
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeTab ? (
              <Suspense fallback={<div style={{ padding: 40, color: "#9ca3af", textAlign: "center" }}>Memuat editor…</div>}>
                <Editor height="100%" language="typescript" value={files[activeTab] || ""} onChange={onEdit} theme="vs-light"
                  options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }} />
              </Suspense>
            ) : (
              <div style={{ padding: 40, color: "#9ca3af", textAlign: "center" }}>Pilih file</div>
            )}
          </div>
        </div>
      )}
      {view === "preview" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, rowGap: isMobile ? 8 : 0, flexWrap: isMobile ? "wrap" : "nowrap", padding: 8, borderBottom: "1px solid #e5e7eb", background: "#fafafa", alignItems: "center" }}>
            <div title={pipelineError || pipelineLabel} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", borderRadius: 6, background: pipelinePhase === "failed" ? "#fef2f2" : pipelinePhase === "success" ? "#dcfce7" : pipelinePhase === "idle" ? "#f3f4f6" : "#fff7ed", color: pipelinePhase === "failed" ? "#b91c1c" : pipelinePhase === "success" ? "#166534" : pipelinePhase === "idle" ? "#6b7280" : "#9a3412", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} /> {pipelineLabel}
            </div>
            <button onClick={() => setDevice("desktop")} style={{ padding: 6, border: "none", background: device === "desktop" ? "#e5e7eb" : "transparent", borderRadius: 6, cursor: "pointer" }}><Monitor size={15} /></button>
            <button onClick={() => setDevice("tablet")} style={{ padding: 6, border: "none", background: device === "tablet" ? "#e5e7eb" : "transparent", borderRadius: 6, cursor: "pointer" }}><Tablet size={15} /></button>
            <button onClick={() => setDevice("mobile")} style={{ padding: 6, border: "none", background: device === "mobile" ? "#e5e7eb" : "transparent", borderRadius: 6, cursor: "pointer" }}><Smartphone size={15} /></button>
            <button onClick={() => { send("Percantik desain aplikasi ini: perbaiki spacing, tipografi, warna, tambahkan micro-interactions dan animasi halus, buat terlihat modern dan premium. Jangan ubah struktur/fitur, hanya visual."); }}
              title="Percantik desain otomatis"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <Sparkles size={14} style={{ color: ORANGE }} /> {!isMobile && "Percantik"}
            </button>
            <button onClick={() => { setSelectMode(!selectMode); setPreviewKey((k) => k + 1); }}
              title="Klik elemen untuk edit"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: selectMode ? ORANGE : "#fff", color: selectMode ? "#fff" : "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <MousePointerClick size={14} /> {selectMode ? "Klik elemen..." : "Pilih"}
            </button>
            {diagnosticsOpen && <button onClick={() => setTermOpen(!termOpen)}
              title="Tampilkan Console"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: termOpen ? ORANGE : "#fff", color: termOpen ? "#fff" : "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <TerminalIcon size={14} /> Console
            </button>}
            <button onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
              title="Tools diagnostik dan log"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: diagnosticsOpen ? ORANGE : "#fff", color: diagnosticsOpen ? "#fff" : "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <Settings size={14} /> {!isMobile && "Diagnostics"}
            </button>
            {diagnosticsOpen && <button onClick={async () => { setTermOpen(true); setTermLines((l) => [...l, "⏳ Database verification dimulai..."]); try { const d = await runtimeActions.dbVerify(); setTermLines((l) => [...l, d.status === "success" ? "✅ Database CRUD berhasil" : "❌ Database verification gagal", d.message || d.error || "", `steps: ${(d.steps || []).join(" → ")}`]); if (d.status !== "success" && d.error) setPreviewErrors((p) => [...p.slice(-4), d.error]); } catch (e: any) { setTermLines((l) => [...l, "Database error: " + (e?.message || e)]); } }}
              title="Validasi database"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <Database size={14} /> Verify DB
            </button>}
            <button onClick={async () => {
              try {
                if (runtimeRunning) {
                  await runtimeActions.stop();
                  setRuntimeRunning(false); setRuntimePreview(false);
                } else {
                  const d = await runtimeActions.start();
                  setRuntimeRunning(true); setRuntimePreview(true); setPreviewToken(d.previewToken || ""); setTermOpen(true);
                  setTermLines((l) => [...l, `✅ Runtime dev aktif di port ${d.port}`, "Live preview memakai project runtime asli."]);
                }
              } catch (e: any) { setTermOpen(true); setTermLines((l) => [...l, "❌ Runtime: " + (e?.message || e)]); }
            }} title="Jalankan preview dari runtime Node project"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: runtimeRunning ? "#dcfce7" : "#fff", color: "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              {runtimeRunning ? "Stop Runtime" : "Live Runtime"}
            </button>
            <button onClick={verifyRuntime}
              title="Install dependency dan validasi build project"
              style={{ padding: 6, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", borderRadius: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
              <Check size={14} /> Verify Build
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={() => setPreviewKey((k) => k + 1)} style={{ padding: 6, border: "1px solid #e5e7eb", background: "#fff", borderRadius: 6, cursor: "pointer" }}><RefreshCw size={14} /></button>
          </div>
          {previewErrors.length > 0 && (
            <div style={{ background: "#fef2f2", borderBottom: "1px solid #fecaca", padding: "8px 12px" }}>
              {previewErrors.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#b91c1c", marginBottom: 4 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e}</span>
                  <button onClick={() => fixErrorWithAI(e)} style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                    Perbaiki AI
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{ flex: 1, background: "#f3f4f6", display: "flex", justifyContent: "center", padding: 16, overflow: "hidden" }}>
            <div style={{ width: deviceWidth, maxWidth: "100%", height: "100%", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" }}>
              {runtimePreview ? (
                <iframe ref={runtimeFrameRef} title="Live Runtime Preview" src={`/api/projects/${pid}/runtime/preview/?token=${encodeURIComponent(previewToken)}&v=${previewKey}`} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
              ) : <Suspense fallback={<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>Memuat preview…</div>}><SandpackProvider
                key={previewKey}
                template="react-ts"
                theme="light"
                files={{
                  "/src/App.tsx": `export default function App() { return <div className="p-8 text-center text-gray-500 font-mono">Belum ada kode App.tsx...</div> }`,
                  ...Object.fromEntries(Object.entries(files).map(([k, v]) => ["/" + k, sanitizeSandpackSource(v)])),
                  "/index.tsx": `import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as AppExports from "./src/App";

const App = AppExports.default || AppExports.App || Object.values(AppExports).find(x => typeof x === 'function');

const root = createRoot(document.getElementById("root")!);
if (App) {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} else {
  root.render(
    <div style={{padding: 20, color: 'red', fontFamily: 'monospace'}}>
      <b>Error:</b> Komponen utama tidak ditemukan. Pastikan src/App.tsx memiliki 'export default function App()'.
    </div>
  );
}`,
                  "/public/index.html": `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    window.WB_SELECT_MODE = ${selectMode ? "true" : "false"};
    window.cloudAuth = window.cloudAuth || {};
    window.db = {
      get: function(k){ try{ var v=localStorage.getItem("wb_db_${pid}_"+k); return Promise.resolve(v?JSON.parse(v):null); }catch(e){ return Promise.resolve(null); } },
      set: function(k,v){ try{ localStorage.setItem("wb_db_${pid}_"+k, JSON.stringify(v)); }catch(e){} return Promise.resolve(); },
      del: function(k){ try{ localStorage.removeItem("wb_db_${pid}_"+k); }catch(e){} return Promise.resolve(); },
      list: function(){ var keys=[]; try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k&&k.startsWith("wb_db_${pid}_")) keys.push(k.slice(${"wb_db_${pid}_".length})); } }catch(e){} return Promise.resolve(keys); }
    };
    window.cloudAuth = {
      _tokenKey: "wb_project_session_${pid}",
      _save: function(d) { if (d && d.token) localStorage.setItem(this._tokenKey, d.token); return d; },
      register: async function(name, email, password) { const r = await fetch("/api/app-api/${pid}/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Register gagal"); return this._save(d); },
      login: async function(email, password) { const r = await fetch("/api/app-api/${pid}/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Login gagal"); return this._save(d); },
      me: async function() { const token = localStorage.getItem(this._tokenKey) || ""; const r = await fetch("/api/app-api/${pid}/auth/me", { headers: { "X-Project-Session": token } }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Session tidak valid"); return d; },
      logout: async function() { const token = localStorage.getItem(this._tokenKey) || ""; await fetch("/api/app-api/${pid}/auth/logout", { method: "POST", headers: { "X-Project-Session": token } }); localStorage.removeItem(this._tokenKey); }
    };
    window.cloudDb = {
      _call: async function(act, payload) {
        try {
          const res = await fetch("/api/app-api/${pid}/db/" + act, { method: "POST", headers: { "Content-Type": "application/json", "X-Project-Session": localStorage.getItem("wb_project_session_${pid}") || "" }, body: JSON.stringify(payload) });
          const d = await res.json();
          if (!res.ok) throw new Error(d.error || "DB Error");
          return d.data || d.message;
        } catch (e) {
          console.error("cloudDb error:", e.message);
          throw e;
        }
      },
      select: function(table, where={}) { return this._call("select", { table: table, where: where }); },
      insert: function(table, data) { return this._call("insert", { table: table, data: data }); },
      update: function(table, where, data) { return this._call("update", { table: table, where: where, data: data }); },
      del: function(table, where) { return this._call("delete", { table: table, where: where }); },
      query: function(sql, args=[]) { return this._call("query", { sql: sql, args: args }); }
    };
  </script>
</head>
<body>
  <div id="root"></div>
  <script>
  // WebBuilder bridge: kirim console error & klik elemen (mode pilih) ke parent
  (function(){
    function wbErr(m){ try{ window.parent.postMessage({type:"wb-error",msg:String(m).slice(0,300)},"*"); }catch(e){} }
    window.addEventListener("error",function(e){ if(e.message) wbErr(e.message); });
    window.addEventListener("unhandledrejection",function(e){ var r=e.reason; wbErr("Unhandled rejection: "+(r&&r.message||r)); });
    var _ce=console.error;
    console.error=function(){ try{ wbErr(Array.prototype.map.call(arguments,function(a){ return String(a); }).join(" ")); }catch(e){} return _ce.apply(console,arguments); };
    if(window.WB_SELECT_MODE){
      document.addEventListener("click",function(e){
        e.preventDefault(); e.stopPropagation();
        var t=e.target||{};
        var cls=t.className;
        if(cls&&typeof cls!=="string"){ cls=""; }
        try{ window.parent.postMessage({type:"wb-select",tag:t.tagName||"?",id:t.id||"",cls:String(cls||""),text:(t.innerText||"").trim().slice(0,120)},"*"); }catch(e2){}
      },true);
      var st=document.createElement("style");
      st.textContent="*:hover{outline:2px solid #F6821F !important;outline-offset:2px;cursor:crosshair !important;}";
      document.head.appendChild(st);
    }
  })();
  </script>
</body>
</html>`
                }}
                customSetup={{
                  dependencies: {
                    "lucide-react": "latest",
                    "recharts": "latest",
                    "framer-motion": "latest",
                    "react-router-dom": "latest",
                    "zustand": "latest",
                    "date-fns": "latest",
                    "clsx": "latest",
                    "tailwind-merge": "latest"
                  }
                }}
              >
                <SandpackPreview
                  showNavigator={true}
                  showRefreshButton={false}
                  showOpenInCodeSandbox={false}
                  style={{ height: "100%", flex: 1 }}
                />
              </SandpackProvider></Suspense>}
            </div>
          </div>
        </div>
      )}
      {view === "db" && (
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Database</h3>
          {canEdit && (
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <input value={newTable} onChange={(e) => setNewTable(e.target.value)} placeholder="Nama tabel"
              style={{ flex: 1, minWidth: 0, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 13 }} />
            <button onClick={createTable} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, cursor: "pointer", fontSize: 13, flexShrink: 0 }}>Buat</button>
          </div>
          )}
          {tables.map((t) => (
            <button key={t} onClick={() => inspectTable(t)} style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: selectedTable?.table === t ? "#fff7ed" : "#f9fafb", border: selectedTable?.table === t ? `1px solid ${ORANGE}` : "1px solid #e5e7eb", borderRadius: 8, marginBottom: 8, cursor: "pointer" }}>
              <Database size={15} style={{ color: ORANGE }} />
              <span style={{ fontSize: 13, fontFamily: "monospace" }}>{t}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8" }}>Lihat data</span>
            </button>
          ))}
          <div style={{ marginTop: 18, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}><strong style={{ fontSize: 14 }}>Access policies</strong><button onClick={loadPolicies} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 6, padding: "4px 8px", fontSize: 10, cursor: "pointer" }}>Refresh</button></div>
            <div style={{ color: "#64748b", fontSize: 11, marginBottom: 8 }}>Pilih tabel lalu atur izin per role. Policy tersimpan di database project.</div>
            {selectedTable?.table ? <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}><thead><tr><th style={{ textAlign: "left", padding: 8, background: "#f8fafc" }}>Role</th>{["select","insert","update","delete"].map(op => <th key={op} style={{ padding: 8, background: "#f8fafc" }}>{op}</th>)}</tr></thead><tbody>{["owner","admin","member","viewer"].map(role => <tr key={role}><td style={{ padding: 8, borderTop: "1px solid #f1f5f9", fontWeight: 600 }}>{role}</td>{["select","insert","update","delete"].map(op => { const p=policies.find(x=>x.table===selectedTable.table&&x.role===role&&x.operation===op); const checked=p ? p.enabled : (role==="owner"||role==="admin"||(role==="member"&&(op==="select"||op==="insert"))||(role==="viewer"&&op==="select")); return <td key={op} style={{ textAlign: "center", borderTop: "1px solid #f1f5f9" }}><input type="checkbox" checked={checked} onChange={e=>savePolicy(selectedTable.table,role,op,e.target.checked)} /></td>; })}</tr>)}</tbody></table></div> : <div style={{ fontSize: 11, color: "#94a3b8" }}>Klik tabel untuk mengatur policy.</div>}
          </div>
          {tableLoading && <div style={{ color: "#64748b", fontSize: 12, padding: 8 }}>Membaca schema dan data…</div>}
          {selectedTable && !tableLoading && <div style={{ marginTop: 18, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><strong style={{ fontSize: 14 }}>{selectedTable.table}</strong><span style={{ fontSize: 11, color: "#64748b" }}>{selectedTable.rowCount}{selectedTable.truncated ? "+" : ""} rows</span></div>
            <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}><thead><tr>{(selectedTable.columns || []).map((c: any) => <th key={c.name} style={{ textAlign: "left", padding: "8px 10px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{c.name}<div style={{ fontWeight: 400, color: "#94a3b8" }}>{c.type}</div></th>)}</tr></thead><tbody>{(selectedTable.rows || []).slice(0, 20).map((row: any, i: number) => <tr key={i}>{(selectedTable.columns || []).map((c: any) => <td key={c.name} style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(row[c.name] ?? "—")}</td>)}</tr>)}</tbody></table></div>
          </div>}
        </div>
      )}
      {termOpen && (
        <div style={{ height: 180, borderTop: "1px solid #e5e7eb", background: "#1e1e1e", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", padding: "6px 12px", color: "#9ca3af", fontSize: 12, borderBottom: "1px solid #333" }}>
            <TerminalIcon size={13} /><span style={{ marginLeft: 6 }}>Terminal</span>
            <div style={{ flex: 1 }} />
            <X size={14} style={{ cursor: "pointer" }} onClick={() => setTermOpen(false)} />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontFamily: "monospace", fontSize: 12, color: "#d4d4d4" }}>
            {termLines.map((l, i) => <div key={i} style={{ whiteSpace: "pre-wrap" }}>{l.startsWith("__RUNTIME_LOG__") ? l.slice(15) : l}</div>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); runTerm(termInput); setTermInput(""); }} style={{ display: "flex", padding: "6px 12px", borderTop: "1px solid #333" }}>
            <span style={{ color: ORANGE, fontFamily: "monospace", fontSize: 12, marginRight: 8 }}>$</span>
            <input value={termInput} onChange={(e) => setTermInput(e.target.value)} style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#d4d4d4", fontFamily: "monospace", fontSize: 12 }} />
          </form>
        </div>
      )}
    </div>
  );

  // Tombol aksi input chat — di mobile tampil di baris sendiri (wrap), di desktop sebaris
  const chatActionButtons = (
    <>
      <label title="Upload file/gambar" style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", display: "flex", background: "#fff", flexShrink: 0 }}>
        <Plus size={15} style={{ color: "#6b7280" }} />
        <input type="file" hidden accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.css,.html" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
      </label>
      {!isMobile && <>
      <button onClick={() => setGenImgOpen(true)} title="Generate gambar AI"
        style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", background: "#fff", display: "flex", flexShrink: 0 }}>
        <ImageIcon size={15} style={{ color: "#6b7280" }} />
      </button>
      </>}
      {!isMobile && <button onClick={toggleListening} title={listening ? "Sedang mendengarkan..." : "Bicara prompt (Voice Input)"} 
        style={{ padding: 10, borderRadius: 8, border: listening ? "1px solid #ef4444" : "1px solid #e5e7eb", cursor: "pointer", background: listening ? "#fef2f2" : "#fff", display: "flex", flexShrink: 0 }}>
        {listening ? <MicOff size={15} style={{ color: "#ef4444" }} /> : <Mic size={15} style={{ color: "#6b7280" }} />}
      </button>}
      {isMobile && <button onClick={toggleListening} title={listening ? "Sedang mendengarkan..." : "Bicara prompt"}
        style={{ padding: 10, borderRadius: 8, border: listening ? "1px solid #ef4444" : "1px solid #e5e7eb", cursor: "pointer", background: listening ? "#fef2f2" : "#fff", display: "flex", flexShrink: 0 }}>
        {listening ? <MicOff size={15} style={{ color: "#ef4444" }} /> : <Mic size={15} style={{ color: "#6b7280" }} />}
      </button>}
      {!isMobile && <button onClick={enhance} disabled={enhancing || !input.trim()} title="Enhance prompt"
        style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", background: "#fff", fontSize: 13, flexShrink: 0 }}>
        {enhancing ? "..." : <Sparkles size={15} style={{ color: "#6b7280" }} />}
      </button>}
    </>
  );

  /* Desktop-only extras stay out of the mobile composer. */
  const legacyChatActionButtons = (
    <>
      <label title="Upload file/gambar" style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", display: "flex", background: "#fff", flexShrink: 0 }}>
        <Plus size={15} style={{ color: "#6b7280" }} />
        <input type="file" hidden accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.css,.html" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
      </label>
      <label title="Buatkan aplikasi dari gambar (image-to-app)" style={{ padding: 10, borderRadius: 8, border: "1px solid #fed7aa", cursor: "pointer", display: "flex", background: "#fff7ed", flexShrink: 0 }}>
        <ImageIcon size={15} style={{ color: ORANGE }} />
        <input type="file" hidden accept="image/*" onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          await uploadFile(f);
          send("Buatkan aplikasi web dari desain pada gambar terlampir. Tiru layout, warna, dan struktur sebisa mungkin sebagai aplikasi React yang berfungsi.");
        }} />
      </label>
      <button onClick={() => setGenImgOpen(true)} title="Generate gambar AI"
        style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", background: "#fff", display: "flex", flexShrink: 0 }}>
        <ImageIcon size={15} style={{ color: "#6b7280" }} />
      </button>
      <button onClick={toggleListening} title={listening ? "Sedang mendengarkan..." : "Bicara prompt (Voice Input)"}
        style={{ padding: 10, borderRadius: 8, border: listening ? "1px solid #ef4444" : "1px solid #e5e7eb", cursor: "pointer", background: listening ? "#fef2f2" : "#fff", display: "flex", flexShrink: 0 }}>
        {listening ? <MicOff size={15} style={{ color: "#ef4444" }} /> : <Mic size={15} style={{ color: "#6b7280" }} />}
      </button>
      <button onClick={enhance} disabled={enhancing || !input.trim()} title="Enhance prompt"
        style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb", cursor: "pointer", background: "#fff", fontSize: 13, flexShrink: 0 }}>
        {enhancing ? "..." : <Sparkles size={15} style={{ color: "#6b7280" }} />}
      </button>
    </>
  );

  const chatPanel = (
    <div className="wb-chat-panel" style={{ width: isMobile ? "100%" : 390, height: "100%", minHeight: 0, borderRight: isMobile ? "none" : "1px solid #e5e7eb", display: "flex", flexDirection: "column", background: "#fff", overflow: "hidden", flexShrink: 0 }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: "#fff7ed", border: "1px solid #fed7aa", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Sparkles size={14} style={{ color: ORANGE }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: 14 }}>AI Builder</strong>
          <span style={{ display: "block", fontSize: 10, color: "#64748b" }}>Bangun dan perbaiki aplikasi lewat chat</span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: pipelinePhase === "success" ? "#15803d" : pipelinePhase === "failed" ? "#b91c1c" : "#64748b", background: pipelinePhase === "success" ? "#dcfce7" : pipelinePhase === "failed" ? "#fee2e2" : "#f1f5f9", borderRadius: 12, padding: "4px 8px", whiteSpace: "nowrap" }}>{pipelineLabel}</span>
        <div style={{ flex: 1 }} />
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 8px" }}>
          <option value="build">Build</option>
          <option value="ask">Ask</option>
          <option value="plan">Plan</option>
          <option value="debug">Debug</option>
          <option value="review">Review</option>
          <option value="refactor">Refactor</option>
        </select>
      </div>
      {(pipelinePhase !== "idle" || agentRun) && (
        <div style={{ padding: "9px 12px", borderBottom: "1px solid #f1f5f9", background: agentRun?.status === "failed" || pipelinePhase === "failed" ? "#fff7f7" : "#fffdf9" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: pipelinePhase === "failed" ? "#b91c1c" : pipelinePhase === "success" ? "#166534" : ORANGE, textTransform: "uppercase", letterSpacing: ".04em" }}>Progress aplikasi</span>
            <span style={{ fontSize: 10, color: "#64748b" }}>{pipelinePhase === "success" ? "Selesai" : pipelinePhase === "failed" ? "Terhenti" : "Sedang berjalan"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
            {[["sync", "File"], ["install-build", "Aplikasi"], ["database", "Data"], ["runtime", "Siap"]].map(([phase, label]) => {
              const order = ["sync", "install-build", "migration", "database", "runtime", "success"];
              const current = order.indexOf(pipelinePhase);
              const target = phase === "database" ? order.indexOf("database") : order.indexOf(phase);
              const done = pipelinePhase === "success" || (current >= 0 && target >= 0 && current > target);
              const active = pipelinePhase === phase || (phase === "database" && pipelinePhase === "migration");
              return <div key={phase} style={{ minWidth: 0 }}>
                <div style={{ height: 4, borderRadius: 4, background: done ? "#22c55e" : active ? ORANGE : "#e2e8f0" }} />
                <div style={{ marginTop: 4, fontSize: 9, color: done ? "#15803d" : active ? "#c2410c" : "#94a3b8", fontWeight: active || done ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{done ? "✓ " : active ? "● " : "○ "}{label}</div>
              </div>;
            })}
          </div>
          {pipelinePhase === "failed" && pipelineError && <div style={{ marginTop: 7, fontSize: 10, color: "#b91c1c", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={pipelineError}>{pipelineError}</div>}
          {agentRun && <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 10, color: agentRun.status === "completed" ? "#15803d" : agentRun.status === "failed" ? "#b91c1c" : ORANGE, fontWeight: 700 }}>{agentRun.status === "completed" ? "✓ Agent selesai" : agentRun.status === "failed" ? "Agent gagal" : `● Agent: ${agentRun.phase || "berjalan"}`}</span>
            <button onClick={() => setDiagnosticsOpen((v) => !v)} style={{ marginLeft: "auto", border: "1px solid #e2e8f0", background: "#fff", borderRadius: 6, padding: "3px 7px", fontSize: 10, cursor: "pointer" }}>{diagnosticsOpen ? "Tutup aktivitas" : "Lihat aktivitas"}</button>
          </div>}
          {diagnosticsOpen && agentTools.length > 0 && <div style={{ marginTop: 7, maxHeight: 100, overflowY: "auto", borderTop: "1px solid #f1f5f9", paddingTop: 5 }}>{agentTools.map((tool) => <div key={tool.id} style={{ display: "flex", gap: 6, fontSize: 10, lineHeight: 1.5, color: tool.status === "failed" ? "#b91c1c" : "#475569" }}><span>{tool.status === "success" ? "✓" : tool.status === "failed" ? "!" : "●"}</span><span>{tool.tool}</span><span style={{ color: "#94a3b8" }}>{tool.phase}</span></div>)}</div>}
        </div>
      )}
      <div ref={msgsRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        {msgs.length === 0 && (
          <div style={{ margin: "auto 0", padding: "20px 8px", textAlign: "center" }}>
            <div style={{ width: 48, height: 48, margin: "0 auto 12px", borderRadius: 14, background: "#fff7ed", border: "1px solid #fed7aa", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Sparkles size={24} style={{ color: ORANGE }} />
            </div>
            <strong style={{ display: "block", fontSize: 16, color: "#0f172a", marginBottom: 6 }}>Apa yang ingin kamu bangun?</strong>
            <p style={{ margin: "0 auto", maxWidth: 280, color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>Jelaskan ide, pengguna, dan fitur utama. AI akan menyusun rencana, menulis kode, menjalankan build, dan menyiapkan preview.</p>
            <div style={{ marginTop: 14, textAlign: "left" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>Mulai dengan contoh:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {[
                  "Buatkan aplikasi kasir (POS) dengan login, produk, transaksi, dan laporan",
                  "Buatkan toko online dengan keranjang belanja dan checkout",
                  "Buatkan dashboard admin dengan data pengguna dan statistik",
                  "Buatkan aplikasi booking jadwal dengan kalender",
                ].map((text) => (
                  <button key={text} onClick={() => send(text)} style={{ border: "1px solid #F6821F", background: "#fff7ed", borderRadius: 999, padding: "7px 12px", textAlign: "left", color: "#9a3412", fontSize: 11, cursor: "pointer" }}>{text}</button>
                ))}
              </div>
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          const badges = m.role === "assistant" ? parseFileBadges(m.content) : [];
          return (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? ORANGE : "#ffffff", color: m.role === "user" ? "#fff" : "#1e293b", border: m.role === "assistant" ? "1px solid #e2e8f0" : "none", borderRadius: 14, padding: 14, maxWidth: "94%", fontSize: 13, wordBreak: "break-word", lineHeight: "1.5", boxShadow: m.role === "assistant" ? "0 2px 12px rgba(0,0,0,0.03)" : "none" }}>
              {m.role === "user" ? (
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #f1f5f9" }}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, background: "#fff7ed", border: "1px solid #fed7aa", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Sparkles size={14} style={{ color: ORANGE }} />
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>AI Web Builder</span>
                  </div>

                  {badges.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#166534", background: "#dcfce7", borderRadius: 12, padding: "4px 8px" }}>✓ Perubahan diterapkan</span>
                      {pipelinePhase === "success" && <span style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", background: "#dbeafe", borderRadius: 12, padding: "4px 8px" }}>Preview siap</span>}
                      <span style={{ fontSize: 10, color: "#64748b", padding: "4px 2px" }}>{badges.length} file diperbarui</span>
                    </div>
                  )}

                  {isBuildFailureMessage(m.content) ? renderBuildFailureCard(m.content, () => fixErrorWithAI(m.content)) : renderMarkdown(m.content)}

                  {badges.length > 0 && (
                    <div style={{ marginTop: 12, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                        <Folder size={13} style={{ color: ORANGE }} />
                        {badges.length} Berkas Dibuat & Diperbarui:
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {badges.map((f) => (
                          <button key={f} onClick={() => openFile(f)} style={{ border: "1px solid #e2e8f0", background: "#fff", color: "#0f172a", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 5, fontWeight: 600, maxWidth: "100%" }}>
                            <File size={12} style={{ color: ORANGE, flexShrink: 0 }} /> 
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {streaming && (
          <div style={{ alignSelf: "flex-start", width: "95%", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14, boxShadow: "0 4px 16px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: "#fff7ed", border: "1px solid #fed7aa", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Sparkles size={16} style={{ color: ORANGE }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{aiActivity}</span>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: ORANGE }} />
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{pipelinePhase === "idle" ? "Membaca instruksi dan menyiapkan rencana" : pipelinePhase === "sync" ? "Menyinkronkan file project ke runtime" : pipelinePhase === "install-build" ? "Menjalankan npm install dan npm run build" : pipelinePhase === "migration" ? "Menerapkan schema database project" : pipelinePhase === "database" ? "Memeriksa koneksi dan kesiapan database" : pipelinePhase === "runtime" ? "Menunggu Vite Live Runtime siap" : pipelinePhase === "success" ? "Project siap dilihat di Preview" : "Menganalisa error untuk auto-fix"}</div>
              </div>
            </div>

            {parseFileBadges(streamText).length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                {parseFileBadges(streamText).map((file, idx, arr) => {
                  const isCurrent = idx === arr.length - 1 && !streamText.includes("<<<END>>>");
                  return (
                    <div key={file} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontFamily: "monospace", color: isCurrent ? ORANGE : "#334155", background: isCurrent ? "#fff7ed" : "#f8fafc", padding: "6px 10px", borderRadius: 8, border: isCurrent ? "1px solid #fed7aa" : "1px solid #f1f5f9", maxWidth: "100%" }}>
                      <span style={{ fontSize: 11, flexShrink: 0 }}>{isCurrent ? "⚙️" : "✓"}</span>
                      <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file}</span>
                      <span style={{ fontSize: 10, color: isCurrent ? "#c2410c" : "#16a34a", fontWeight: 700, flexShrink: 0 }}>
                        {isCurrent ? "Menulis..." : "Selesai"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {renderMarkdown(streamText)}
          </div>
        )}
        {selfTestStatus === "testing" && (
          <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 16, padding: "6px 12px", fontWeight: 600 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: ORANGE }} />
            AI mengetes hasil...
          </div>
        )}
      </div>
      <div style={{ padding: isMobile ? "7px 8px calc(7px + env(safe-area-inset-bottom))" : 10, borderTop: "1px solid #e5e7eb", background: "#fff", position: "relative", flexShrink: 0 }}>
        {/* Slash Command Menu Popup */}
        {input.startsWith("/") && (
          <div style={{ position: "absolute", bottom: "100%", left: 10, right: 10, marginBottom: 6, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", maxHeight: 200, overflowY: "auto", zIndex: 50, padding: 4 }}>
            <div style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#9ca3af", borderBottom: "1px solid #f3f4f6" }}>COMMAND CEPAT</div>
            {slashCommands
              .filter((c) => c.cmd.toLowerCase().startsWith(input.toLowerCase().trim()))
              .map((c) => (
                <div
                  key={c.cmd}
                  onClick={() => { send(c.prompt); }}
                  style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#fff7ed")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontWeight: 700, color: ORANGE, fontFamily: "monospace" }}>{c.cmd}</span>
                  <span style={{ color: "#6b7280", fontSize: 11 }}>{c.desc}</span>
                </div>
              ))}
          </div>
        )}
        {/* Smart Follow-up Suggestion Chips */}
        {msgs.length === 0 && !streaming && canEdit && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, scrollbarWidth: "none" }}>
            {smartSuggestions.slice(0, isMobile ? 2 : smartSuggestions.length).map((chip, idx) => (
              <button
                key={idx}
                onClick={() => send(chip.prompt)}
                title={chip.prompt}
                style={{
                  border: "1px solid #fed7aa",
                  background: "#fff7ed",
                  color: "#c2410c",
                  borderRadius: 16,
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  flexShrink: 0,
                }}
              >
                <span>{chip.icon}</span> {chip.label}
              </button>
            ))}
          </div>
        )}
        {attachedFile && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "6px 10px", marginBottom: 8 }}>
            <File size={13} style={{ color: ORANGE }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachedFile.filename}</span>
            <X size={13} style={{ cursor: "pointer" }} onClick={() => setAttachedFile(null)} />
          </div>
        )}
        <div style={{ border: "1px solid #dbe3ee", borderRadius: 14, padding: isMobile ? 6 : 8, background: "#fff", boxShadow: "0 4px 18px rgba(15,23,42,0.06)" }}>
          <textarea
            id="wb-prompt"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={listening ? "Mendengarkan..." : canEdit ? "Apa yang ingin kamu ubah?" : "Mode lihat saja"}
            disabled={streaming || !canEdit}
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              border: listening ? "2px solid #ef4444" : "1px solid #d1d5db",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "inherit",
              resize: "none",
              maxHeight: 120,
              outline: "none",
              boxSizing: "border-box",
              lineHeight: "1.4",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            {!isMobile && chatActionButtons}
            {isMobile && <div style={{ display: "flex", gap: 4 }}>{chatActionButtons}</div>}
            {!isMobile && <span style={{ flex: 1, fontSize: 10, color: "#94a3b8" }}>Enter untuk mengirim · Shift+Enter untuk baris baru</span>}
            {isMobile && <span style={{ flex: 1 }} />}
            <button id="wb-send-btn" onClick={() => send()} disabled={streaming || !input.trim() || !canEdit}
            style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, cursor: "pointer", display: "flex", flexShrink: 0 }}>
            <Send size={15} />
          </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="wb-shell" style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#f8fafc", fontFamily: "system-ui", overflowX: "clip", maxWidth: "100vw" }}>
      <style>{`
        .wb-shell { color: #0f172a; }
        .wb-shell button { transition: background .15s ease, border-color .15s ease, transform .15s ease; }
        .wb-shell button:hover:not(:disabled) { border-color: #cbd5e1 !important; }
        .wb-shell button:active:not(:disabled) { transform: translateY(1px); }
        .wb-chat-panel { box-shadow: 8px 0 28px rgba(15,23,42,.04); }
        .wb-shell textarea:focus { border-color: #f6821f !important; box-shadow: 0 0 0 3px rgba(246,130,31,.12); }
        .wb-shell ::-webkit-scrollbar { width: 7px; height: 7px; }
        .wb-shell ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
        .wb-shell ::-webkit-scrollbar-track { background: transparent; }
        @media (max-width: 767px) {
          .wb-shell { background: #fff; }
          .wb-chat-panel { box-shadow: none; }
          .wb-shell textarea { min-height: 58px; font-size: 15px !important; }
        }
      `}</style>
      <div style={{ position: "sticky", top: 0, zIndex: 40, background: "#fff", display: "flex", alignItems: "center", gap: 8, rowGap: isMobile ? 8 : 0, flexWrap: isMobile ? "wrap" : "nowrap", padding: "10px 12px", borderBottom: "1px solid #e5e7eb", overflowX: "clip" }}>
        <button onClick={onBack} style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", flexShrink: 0 }}>
          <ArrowLeft size={16} />
        </button>
        <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{project.name}</strong>
        {!isMobile && <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "2px 8px", borderRadius: 12, flexShrink: 0 }}>{project.framework}</span>}
        {myRole !== "owner" && (
          <span style={{ fontSize: 10, fontWeight: 700, color: ORANGE, background: "#fff7ed", padding: "3px 8px", borderRadius: 12, flexShrink: 0, textTransform: "uppercase" }}>{myRole}</span>
        )}
        <div style={{ flex: 1, minWidth: 4 }} />
        {canEdit && (
          <button onClick={() => {
            setMobileTab("chat");
            if (!input.trim()) {
              window.setTimeout(() => document.getElementById("wb-prompt")?.focus(), 0);
            } else if (!streaming) {
              void send();
            }
          }} title="Kirim instruksi dan jalankan pipeline aplikasi"
            style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 11px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
            <Sparkles size={15} /> {!isMobile && (input.trim() ? "Buat / Perbaiki" : "Mulai Buat")}
          </button>
        )}
        {!isMobile && <button onClick={() => setShowComments(!showComments)} title="Komentar"
          style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", flexShrink: 0, position: "relative" }}>
          <MessageSquare size={16} style={{ color: "#6b7280" }} />
          {comments.filter((c) => !c.resolved).length > 0 && (
            <span style={{ position: "absolute", top: -4, right: -4, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 10, padding: "1px 5px" }}>
              {comments.filter((c) => !c.resolved).length}
            </span>
          )}
        </button>}
        {myRole === "owner" && (
          <button onClick={doPublish} title="Publish" style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>
            <Rocket size={16} />
            {!isMobile && (publishing ? "Publishing..." : "Publish")}
          </button>
        )}
        <button onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)} title="Tools proyek" style={{ background: workspaceMenuOpen ? "#fff7ed" : "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#374151", flexShrink: 0 }}>
          <Settings size={16} /> {!isMobile && "Lainnya"}
        </button>
        {workspaceMenuOpen && canEdit && (
        <>
        <button onClick={loadVersions} title="Riwayat versi / Undo" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", flexShrink: 0 }}>
          <History size={16} />
          {!isMobile && "Riwayat"}
        </button>
        <button onClick={loadBlueprint} title="Blueprint / Rencana AI" style={{ background: "#fff7ed", border: "1px solid #fed7aa", color: "#c2410c", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
          <Sparkles size={15} /> {!isMobile && "Blueprint"}
        </button>
        <button onClick={loadProjectSettings} title="Pengaturan proyek" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", flexShrink: 0 }}>
          <Settings size={16} style={{ color: "#6b7280" }} />
        </button>
        <button
          onClick={async () => {
            try {
              await downloadProjectExport(pid, project.slug || "project");
            } catch (e: any) { alert("Gagal download ZIP: " + e.message); }
          }}
          title="Export Project ZIP (Download Source Code)"
          style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", flexShrink: 0 }}
        >
          <Download size={16} style={{ color: "#6b7280" }} />
        </button>
        <button onClick={loadGitHub} title="GitHub Sync" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex", flexShrink: 0 }}>
          <Github size={16} style={{ color: "#6b7280" }} />
        </button>
        </>
        )}
        {!isMobile && (
          <div style={{ display: "flex", border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            <button onClick={() => setView("code")} style={{ padding: "8px 14px", border: "none", cursor: "pointer", background: view === "code" ? ORANGE : "#fff", color: view === "code" ? "#fff" : "#374151", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Code2 size={14} /> Kode
            </button>
            <button onClick={() => { setView("preview"); setPreviewKey((k) => k + 1); }} style={{ padding: "8px 14px", border: "none", cursor: "pointer", background: view === "preview" ? ORANGE : "#fff", color: view === "preview" ? "#fff" : "#374151", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Play size={14} /> Preview
            </button>
            <button onClick={() => setView("db")} style={{ padding: "8px 14px", border: "none", cursor: "pointer", background: view === "db" ? ORANGE : "#fff", color: view === "db" ? "#fff" : "#374151", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Database size={14} /> Database
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0, height: 0, position: "relative", paddingBottom: isMobile ? 60 : 0 }}>
        {showChat && chatPanel}
        {showCode && showTree && fileTreePanel}
        {showCode && codePanel}
      </div>

      {isMobile && (
        <div ref={navRef} style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, display: "flex", borderTop: "1px solid #e5e7eb", background: "#fff", paddingBottom: "env(safe-area-inset-bottom)", boxSizing: "border-box", maxWidth: "100vw" }}>
          {[["chat", "Chat", MessageSquare], ["code", "Build", Code2], ["preview", "Preview", Play], ["db", "Data", Database]].map(([id, label, Icon]: any) => (
            <button key={id} onClick={() => { setMobileTab(id); if (id === "preview") { setView("preview"); setPreviewKey((k) => k + 1); } else if (id === "db") { setView("db"); } else if (id === "code") setView("code"); }}
              style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0", border: "none", background: "none", cursor: "pointer", color: mobileTab === id ? ORANGE : "#6b7280", fontSize: 11, fontWeight: mobileTab === id ? 700 : 400 }}>
              <Icon size={18} />{label}
            </button>
          ))}
        </div>
      )}

      {!isMobile && (
        <div style={{ display: "flex", alignItems: "center", padding: "6px 12px", borderTop: "1px solid #e5e7eb", background: "#fafafa" }}>
          <button onClick={() => setTermOpen(!termOpen)} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: termOpen ? "#e5e7eb" : "transparent" }}>
            <TerminalIcon size={13} /> Terminal
          </button>
          <span style={{ fontSize: 12, color: "#9ca3af", marginLeft: 8 }}>{Object.keys(files).length} file</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>Ctrl+K · Ctrl+S</span>
        </div>
      )}

      {paletteOpen && (
        <div onClick={() => setPaletteOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 500, maxWidth: "90vw", background: "#fff", borderRadius: 12, height: "fit-content", maxHeight: 400, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <input value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} placeholder="Cari file..." autoFocus
              style={{ border: "none", outline: "none", padding: "14px 16px", fontSize: 14, borderBottom: "1px solid #e5e7eb" }} />
            <div style={{ overflowY: "auto", padding: 8 }}>
              {Object.keys(files).filter((f) => f.toLowerCase().includes(paletteQuery.toLowerCase())).slice(0, 20).map((f) => (
                <div key={f} onClick={() => { openFile(f); setPaletteOpen(false); }}
                  style={{ padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "monospace" }}>
                  {f}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showVersions && (
        <div onClick={() => { setShowVersions(false); setPreviewVersion(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 60, alignItems: "flex-start" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: previewVersion ? 860 : 460, maxWidth: "96vw", background: "#fff", borderRadius: 14, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
            {/* Header */}
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <History size={16} />
                Riwayat Versi
                <span style={{ fontSize: 12, fontWeight: 400, color: "#6b7280" }}>({versions.length} tersimpan)</span>
              </div>
              <button onClick={() => { setShowVersions(false); setPreviewVersion(null); }} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
            </div>

            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
              {/* List versi */}
              <div style={{ width: previewVersion ? 300 : "100%", borderRight: previewVersion ? "1px solid #e5e7eb" : "none", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Simpan checkpoint */}
                <div style={{ padding: "10px 12px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: 6 }}>
                  <input
                    value={checkpointLabel}
                    onChange={(e) => setCheckpointLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && doSaveCheckpoint()}
                    placeholder="Nama checkpoint…"
                    style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 7, padding: "6px 10px", fontSize: 12, outline: "none" }}
                  />
                  <button
                    onClick={doSaveCheckpoint}
                    disabled={savingCheckpoint}
                    style={{ border: "none", background: ORANGE, color: "#fff", borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}
                  >
                    {savingCheckpoint ? "…" : "📌 Simpan"}
                  </button>
                </div>

                {/* Daftar versi */}
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {versions.length === 0 && <div style={{ padding: 16, color: "#9ca3af", fontSize: 13 }}>Belum ada riwayat.</div>}
                  {versions.map((v: any) => {
                    const isCheckpoint = v.label?.startsWith("📌");
                    const isAI = v.label?.includes("AI");
                    const isRestore = v.label?.includes("restore");
                    const badgeColor = isCheckpoint ? "#7c3aed" : isAI ? "#0ea5e9" : isRestore ? "#f59e0b" : "#6b7280";
                    const isPreviewing = previewVersion?.id === v.id;
                    return (
                      <div key={v.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderRadius: 8, margin: "2px 6px", background: isPreviewing ? "#fef9f0" : "transparent", border: isPreviewing ? `1px solid ${ORANGE}` : "1px solid transparent" }}>
                        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => previewVersionFiles(v.id, v.label)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: badgeColor, background: badgeColor + "18", borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
                              {isCheckpoint ? "checkpoint" : isAI ? "ai" : isRestore ? "restore" : "auto"}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label || "Versi"}</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                            {new Date(v.createdAt).toLocaleString("id-ID")} · {v.fileCount} file
                          </div>
                        </div>
                        <button onClick={() => restoreVersion(v.id)} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600, marginLeft: 8, whiteSpace: "nowrap" }}>
                          Pulihkan
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Preview panel */}
              {previewVersion && (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", fontSize: 12, fontWeight: 600, color: "#374151", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>Perbandingan dengan versi sekarang: {previewVersion.label}</span>
                    <button onClick={() => setPreviewVersion(null)} style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af" }}><X size={14} /></button>
                  </div>
                  <div style={{ overflowY: "auto", flex: 1, padding: 10 }}>
                    {Array.from(new Set([...Object.keys(previewVersion.files), ...Object.keys(files)])).sort().map((fname) => {
                      const inSnapshot = Object.prototype.hasOwnProperty.call(previewVersion.files, fname);
                      const inCurrent = Object.prototype.hasOwnProperty.call(files, fname);
                      const snapshotContent = inSnapshot ? previewVersion.files[fname] : "";
                      const currentContent = inCurrent ? files[fname] : "";
                      const changed = snapshotContent !== currentContent;
                      const status = !inSnapshot ? "baru sekarang" : !inCurrent ? "dihapus sekarang" : changed ? "diubah" : "sama";
                      const color = !inSnapshot ? "#16a34a" : !inCurrent ? "#dc2626" : changed ? "#b45309" : "#9ca3af";
                      return (
                        <div key={fname} style={{ marginBottom: 10, borderRadius: 8, border: "1px solid " + (changed ? "#fcd34d" : "#e5e7eb"), overflow: "hidden" }}>
                          <div style={{ padding: "5px 10px", background: changed ? "#fffbeb" : "#f9fafb", fontSize: 11, fontWeight: 700, fontFamily: "monospace", display: "flex", justifyContent: "space-between" }}>
                            <span>{fname}</span><span style={{ color }}>{status}</span>
                          </div>
                          {changed && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "#d1d5db" }}>
                            <div style={{ minWidth: 0, background: "#111827" }}>
                              <div style={{ padding: "4px 8px", color: "#fca5a5", fontSize: 10, fontWeight: 700 }}>VERSI DIPILIH</div>
                              <pre style={{ margin: 0, padding: "7px 8px", fontSize: 10, overflow: "auto", color: "#e5e7eb", maxHeight: 180, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{inSnapshot ? snapshotContent.slice(0, 4000) : "(file belum ada pada versi ini)"}{snapshotContent.length > 4000 ? "\n… dipotong" : ""}</pre>
                            </div>
                            <div style={{ minWidth: 0, background: "#111827" }}>
                              <div style={{ padding: "4px 8px", color: "#86efac", fontSize: 10, fontWeight: 700 }}>SEKARANG</div>
                              <pre style={{ margin: 0, padding: "7px 8px", fontSize: 10, overflow: "auto", color: "#e5e7eb", maxHeight: 180, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{inCurrent ? currentContent.slice(0, 4000) : "(file sudah dihapus)"}{currentContent.length > 4000 ? "\n… dipotong" : ""}</pre>
                            </div>
                          </div>}
                        </div>
                      );
                    })}
                  </div> 
                  <div style={{ padding: 10, borderTop: "1px solid #e5e7eb" }}>
                    <button onClick={() => restoreVersion(previewVersion.id)} style={{ width: "100%", border: "none", background: ORANGE, color: "#fff", borderRadius: 8, padding: "9px 0", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                      Pulihkan ke versi ini
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {proposal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 60 }}>
          <div style={{ width: 520, maxWidth: "92vw", background: "#fff", borderRadius: 12, height: "fit-content", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 700 }}>
              AI mengusulkan {proposal.length} perubahan file
              <div style={{ fontWeight: 400, fontSize: 12, color: "#6b7280", marginTop: 4 }}>Centang file yang ingin diterapkan, lalu Terima.</div>
            </div>
            <div style={{ overflowY: "auto", padding: 8, flex: 1 }}>
              {proposal.map((f) => (
                <label key={f} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "monospace" }}>
                  <input type="checkbox" checked={!!proposalSel[f]} onChange={(e) => setProposalSel((s) => ({ ...s, [f]: e.target.checked }))} />
                  <File size={14} style={{ color: proposalSel[f] ? ORANGE : "#9ca3af" }} />
                  <span style={{ flex: 1 }}>{f}</span>
                  <span style={{ fontSize: 11, color: files[f] ? "#b45309" : "#15803d", fontFamily: "system-ui" }}>{files[f] ? "diubah" : "baru"}</span>
                </label>
              ))}
            </div>
            <div style={{ padding: 12, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={rejectProposal} style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <XCircle size={14} /> Tolak Semua
              </button>
              <button onClick={applyProposal} style={{ border: "none", background: ORANGE, color: "#fff", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                <Check size={14} /> Terima Pilihan
              </button>
            </div>
          </div>
        </div>
      )}
      {selectedEl && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 80 }}>
          <div style={{ width: 440, maxWidth: "92vw", background: "#fff", borderRadius: 14, height: "fit-content", overflow: "hidden", boxShadow: "0 8px 30px rgba(0,0,0,0.2)" }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <MousePointerClick size={16} style={{ color: ORANGE }} />
                <span>Edit Elemen: <code style={{ color: ORANGE, fontFamily: "monospace", fontSize: 13 }}>&lt;{selectedEl.tag}&gt;</code></span>
              </div>
              <button onClick={() => setSelectedEl(null)} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                {selectedEl.id && `#${selectedEl.id}`} {selectedEl.cls && `.${selectedEl.cls.split(" ")[0]}`}
              </div>
              <div style={{ fontSize: 13, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 12, maxHeight: 70, overflow: "hidden" }}>
                {selectedEl.text ? `"${selectedEl.text}"` : "(elemen tanpa teks)"}
              </div>

              {/* Quick Action Chips */}
              <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", marginBottom: 6 }}>AKSI CEPAT:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                {[
                  { label: "✏️ Ubah Teks", prompt: "Ubah teks elemen ini menjadi yang lebih menarik" },
                  { label: "🎨 Ubah Warna", prompt: "Ubah warna latar belakang dan teks elemen ini agar lebih kontras" },
                  { label: "🗑️ Hapus", prompt: "Hapus elemen ini dari halaman" },
                  { label: "✨ Animasi Hover", prompt: "Tambahkan efek animasi transition/hover yang mulus pada elemen ini" },
                ].map((act, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      const desc = `Pada elemen <${selectedEl.tag}> dengan teks "${selectedEl.text}"${selectedEl.id ? ` id="${selectedEl.id}"` : ""}: ${act.prompt}`;
                      setSelectedEl(null);
                      send(desc);
                    }}
                    style={{ border: "1px solid #e5e7eb", background: "#f8fafc", borderRadius: 16, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600, color: "#334155" }}
                  >
                    {act.label}
                  </button>
                ))}
              </div>

              <input id="wb-el-edit" placeholder="Atau ketik instruksi khusus..."
                style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box", marginBottom: 12 }}
                onKeyDown={(e) => { if (e.key === "Enter") (document.getElementById("wb-el-apply") as HTMLButtonElement)?.click(); }} />
              <button id="wb-el-apply" onClick={() => {
                const v = (document.getElementById("wb-el-edit") as HTMLInputElement)?.value || "";
                if (!v.trim()) return;
                const desc = `Pada elemen <${selectedEl.tag}> dengan teks "${selectedEl.text}"${selectedEl.id ? ` id="${selectedEl.id}"` : ""}: ${v}`;
                setSelectedEl(null);
                send(desc);
              }} style={{ width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
                Kirim Instruksi ke AI
              </button>
            </div>
          </div>
        </div>
      )}

      {ghOpen && (
        <div onClick={() => setGhOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 80 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "92vw", background: "#fff", borderRadius: 12, height: "fit-content", overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              GitHub Sync
              <button onClick={() => setGhOpen(false)} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <div style={{ padding: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6, display: "block" }}>Repository (owner/nama)</label>
              <input value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="aldi1963/my-app"
                style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box", marginBottom: 12 }} />
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6, display: "block" }}>
                Personal Access Token {ghHasToken && <span style={{ color: "#15803d", fontWeight: 400 }}>(tersimpan)</span>}
              </label>
              <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghHasToken ? "Kosongkan jika tidak ganti" : "ghp_..."}
                style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box", marginBottom: 12 }} />
              <button onClick={saveGitHub} disabled={ghLoading}
                style={{ width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, fontWeight: 700, cursor: "pointer", fontSize: 13, marginBottom: 12 }}>
                Simpan
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => githubPushPull("push")} disabled={ghLoading || !ghRepo}
                  style={{ flex: 1, border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  Push ke GitHub
                </button>
                <button onClick={() => githubPushPull("pull")} disabled={ghLoading || !ghRepo}
                  style={{ flex: 1, border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, padding: 10, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  Pull dari GitHub
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {genImgOpen && (
        <div onClick={() => setGenImgOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100, display: "flex", justifyContent: "center", paddingTop: 80 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "92vw", background: "#fff", borderRadius: 12, height: "fit-content", overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              Generate Gambar AI
              <button onClick={() => setGenImgOpen(false)} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <div style={{ padding: 16 }}>
              <input value={genImgPrompt} onChange={(e) => setGenImgPrompt(e.target.value)}
                placeholder="Contoh: logo toko kopi minimalis, orange"
                style={{ width: "100%", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13, boxSizing: "border-box", marginBottom: 12 }}
                onKeyDown={(e) => e.key === "Enter" && generateImage()} />
              {genImgResult && (
                <div style={{ marginBottom: 12 }}>
                  <img src={genImgResult} alt="hasil" style={{ width: "100%", borderRadius: 8, border: "1px solid #e5e7eb" }} />
                  <a href={genImgResult} download="ai-image.png" style={{ fontSize: 12, color: ORANGE, fontWeight: 600 }}>Unduh gambar</a>
                </div>
              )}
              <button onClick={generateImage} disabled={genImgLoading || !genImgPrompt.trim()}
                style={{ width: "100%", background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: 10, fontWeight: 700, cursor: "pointer", fontSize: 13, opacity: genImgLoading ? 0.6 : 1 }}>
                {genImgLoading ? "Membuat..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {blueprintOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 110, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ width: 680, maxWidth: "100%", maxHeight: "90vh", overflow: "auto", background: "#fff", borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,.2)" }}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 10 }}>
              <Sparkles size={18} style={{ color: ORANGE }} /><strong style={{ fontSize: 16, flex: 1 }}>Blueprint / Rencana Implementasi</strong>
              <button onClick={() => setBlueprintOpen(false)} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={18} /></button>
            </div>
            <div style={{ padding: 18 }}>
              <p style={{ margin: "0 0 10px", color: "#64748b", fontSize: 12 }}>Jelaskan target pengguna, role, halaman, fitur, database, alur utama, dan acceptance criteria. Blueprint ini akan menjadi kontrak kerja AI.</p>
              <textarea value={blueprint} onChange={(e) => setBlueprint(e.target.value)} placeholder={'Contoh:\nTarget: pemilik toko dan kasir\nRole: owner, manager, cashier\nHalaman: dashboard, products, inventory, checkout, reports\nDatabase: products, sales, sale_items, users\nAcceptance: checkout mengurangi stok dan menghitung kembalian'} style={{ width: "100%", minHeight: 300, resize: "vertical", border: "1px solid #cbd5e1", borderRadius: 10, padding: 12, fontSize: 13, lineHeight: 1.5, boxSizing: "border-box", outline: "none" }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button onClick={() => setBlueprintOpen(false)} style={{ padding: "9px 14px", border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, cursor: "pointer" }}>Batal</button>
                <button onClick={saveBlueprint} disabled={blueprintSaving || !blueprint.trim()} style={{ padding: "9px 16px", border: "none", background: ORANGE, color: "#fff", borderRadius: 8, cursor: "pointer", fontWeight: 700, opacity: blueprintSaving || !blueprint.trim() ? .55 : 1 }}>{blueprintSaving ? "Menyimpan..." : "Simpan & Setujui Blueprint"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && projSettings && (
        <ProjectSettingsModal settings={projSettings} pid={pid} myRole={myRole} onClose={() => setSettingsOpen(false)} onSave={saveProjectSettings} />
      )}
      {showComments && (
        <div style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: 320, maxWidth: "85vw", background: "#fff", borderLeft: "1px solid #e5e7eb", zIndex: 80, display: "flex", flexDirection: "column", boxShadow: "-4px 0 16px rgba(0,0,0,0.08)" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 14, flex: 1 }}>Komentar {activeTab ? <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 12 }}>· {activeTab}</span> : ""}</strong>
            <button onClick={() => setShowComments(false)} style={{ border: "none", background: "none", cursor: "pointer" }}><X size={16} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {comments.filter((c) => !activeTab || c.filePath === activeTab).map((c) => (
              <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 8, opacity: c.resolved ? 0.55 : 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <strong style={{ fontSize: 12 }}>{c.userName}</strong>
                  <span style={{ fontSize: 10, color: "#9ca3af" }}>{c.filePath}{c.line ? ":" + c.line : ""}</span>
                  <div style={{ flex: 1 }} />
                  {canEdit && (
                    <button onClick={() => toggleResolveComment(c.id)} title={c.resolved ? "Buka lagi" : "Tandai selesai"}
                      style={{ border: "none", background: "none", cursor: "pointer" }}>
                      <Check size={14} style={{ color: c.resolved ? ORANGE : "#9ca3af" }} />
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{c.body}</div>
              </div>
            ))}
            {comments.filter((c) => !activeTab || c.filePath === activeTab).length === 0 && (
              <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", marginTop: 20 }}>Belum ada komentar untuk file ini.</p>
            )}
          </div>
          {canEdit && activeTab && (
            <div style={{ padding: 12, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8 }}>
              <input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendComment()}
                placeholder="Tulis komentar..." style={{ flex: 1, minWidth: 0, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", fontSize: 13 }} />
              <button onClick={sendComment} style={{ background: ORANGE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>
                <Send size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

