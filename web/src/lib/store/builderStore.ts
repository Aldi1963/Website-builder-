// Project-scoped Zustand store untuk Builder (roadmap item 2).
//
// Sebelumnya seluruh state di bawah ini hidup sebagai ~70 useState di
// pages/Builder.tsx. Store ini memegang data + setter-nya saja; logika
// (kirim chat, pipeline, terminal, dsb.) tetap di komponen. Setter
// menerima nilai langsung atau updater function, sama seperti
// Dispatch<SetStateAction<T>> milik React, sehingga call site lama
// tidak berubah bentuk.
//
// Project-scoped: `initProject(pid)` mereset seluruh state setiap kali
// Builder dibuka untuk proyek lain, sehingga state proyek lama tidak
// bocor ke proyek baru.
import { create } from "zustand";

export type PipelinePhase = "idle" | "sync" | "install-build" | "migration" | "database" | "runtime" | "success" | "failed";
export type BuilderView = "code" | "preview" | "db";

// Hasil verifikasi browser (event SSE "result", lihat agentpipeline.go):
// kartu screenshot + ringkasan yang dirender di chat oleh VerificationCard.
// screenshotUrl = URL RELATIF endpoint penyajian screenshot
// (mis. /api/projects/:id/runtime/screenshots/verification/:runId/...).
// screenshotPath absolut server TIDAK PERNAH disimpan di state klien dan
// tidak pernah dipakai sebagai src gambar.
export interface ChatVerification {
  attempted: boolean;
  passed: boolean;
  rounds: number;
  consoleErrors: string[];
  failedRequests: string[];
  screenshotUrl?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  verification?: ChatVerification;
  // Provider+model per prompt yang dipakai untuk pesan ini (kontrak
  // backend: kolom provider/model ChatMessage). Ditampilkan sebagai
  // keterangan kecil di bawah pesan user supaya riwayat konsisten.
  provider?: string;
  model?: string;
}

interface BuilderFields {
  projectId: string | null;
  project: any;
  myRole: string;
  publishing: boolean;
  pubUrl: string;
  comments: any[];
  showComments: boolean;
  newComment: string;
  files: Record<string, string>;
  openTabs: string[];
  activeTab: string;
  view: "code" | "preview" | "db";
  msgs: ChatMessage[];
  input: string;
  streaming: boolean;
  streamText: string;
  aiActivity: string;
  mode: string;
  termOpen: boolean;
  termLines: string[];
  termInput: string;
  runtimeRunning: boolean;
  runtimePreview: boolean;
  previewToken: string;
  pipelinePhase: PipelinePhase;
  pipelineError: string;
  agentRun: any;
  agentTools: any[];
  diagnosticsOpen: boolean;
  workspaceMenuOpen: boolean;
  device: string;
  expanded: Record<string, boolean>;
  previewKey: number;
  tables: string[];
  newTable: string;
  selectedTable: any;
  tableLoading: boolean;
  policies: any[];
  paletteOpen: boolean;
  paletteQuery: string;
  mobileTab: string;
  attachedFile: { filename: string; full: string } | null;
  enhancing: boolean;
  proposal: string[] | null;
  proposalSel: Record<string, boolean>;
  versions: any[];
  showVersions: boolean;
  checkpointLabel: string;
  savingCheckpoint: boolean;
  previewVersion: { id: number; label: string; files: Record<string, string> } | null;
  listening: boolean;
  selectMode: boolean;
  selectedEl: any;
  previewErrors: string[];
  settingsOpen: boolean;
  projSettings: any;
  blueprintOpen: boolean;
  blueprint: string;
  blueprintSaving: boolean;
  autoFixCount: number;
  selfTestStatus: null | "testing" | "fixing";
  // Gate discovery/klarifikasi server (features.go): pesan pertama proyek
  // baru selalu dijawab event SSE "discovery", permintaan vague dijawab
  // "clarification". Tanpa state ini event tersebut terabaikan dan build
  // tidak pernah jalan (run macet waiting_for_confirmation).
  clarification: any | null;
  discovery: any | null;
  mobileTreeOpen: boolean;
  attachedImage: string | null;
  fileMenuPath: string | null;
  renamingPath: string | null;
  renameVal: string;
  creatingFile: boolean;
  newFilePath: string;
  genImgOpen: boolean;
  genImgPrompt: string;
  genImgLoading: boolean;
  genImgResult: string | null;
  ghOpen: boolean;
  ghRepo: string;
  ghToken: string;
  ghHasToken: boolean;
  ghLoading: boolean;
  // Pemilih provider/model per prompt (trek 1/4): daftar provider aktif
  // dari GET /api/ai-providers + pilihan composer saat ini. Pilihan
  // terakhir per proyek juga disimpan di localStorage (lihat
  // lib/aiProviders.ts) supaya proyek yang dibuka ulang memakai
  // provider/model yang sama.
  aiProviders: import("../aiProviders").AIProviderOption[];
  selectedProviderId: number;
  selectedModel: string;
}

const initialState: BuilderFields = {
  projectId: null,
  project: null,
  myRole: "owner",
  publishing: false,
  pubUrl: "",
  comments: [],
  showComments: false,
  newComment: "",
  files: {},
  openTabs: [],
  activeTab: "",
  view: "preview",
  msgs: [],
  input: "",
  streaming: false,
  streamText: "",
  aiActivity: "Menganalisa kebutuhan proyek",
  mode: "build",
  termOpen: false,
  termLines: ["WebBuilder Terminal — ketik 'help'"],
  termInput: "",
  runtimeRunning: false,
  runtimePreview: false,
  previewToken: "",
  pipelinePhase: "idle",
  pipelineError: "",
  agentRun: null,
  agentTools: [],
  diagnosticsOpen: false,
  workspaceMenuOpen: false,
  device: "desktop",
  expanded: { src: true },
  previewKey: 0,
  tables: [],
  newTable: "",
  selectedTable: null,
  tableLoading: false,
  policies: [],
  paletteOpen: false,
  paletteQuery: "",
  mobileTab: "chat",
  attachedFile: null,
  enhancing: false,
  proposal: null,
  proposalSel: {},
  versions: [],
  showVersions: false,
  checkpointLabel: "",
  savingCheckpoint: false,
  previewVersion: null,
  listening: false,
  selectMode: false,
  selectedEl: null,
  previewErrors: [],
  settingsOpen: false,
  projSettings: null,
  blueprintOpen: false,
  blueprint: "",
  blueprintSaving: false,
  autoFixCount: 0,
  selfTestStatus: null,
  clarification: null,
  discovery: null,
  mobileTreeOpen: true,
  attachedImage: null,
  fileMenuPath: null,
  renamingPath: null,
  renameVal: "",
  creatingFile: false,
  newFilePath: "",
  genImgOpen: false,
  genImgPrompt: "",
  genImgLoading: false,
  genImgResult: null,
  ghOpen: false,
  ghRepo: "",
  ghToken: "",
  ghHasToken: false,
  ghLoading: false,
  aiProviders: [],
  selectedProviderId: 0,
  selectedModel: "",
};

type Fields = BuilderFields;
type Setter<K extends keyof Fields> = (value: Fields[K] | ((prev: Fields[K]) => Fields[K])) => void;

interface BuilderStore extends Fields {
  /** Reset seluruh state untuk proyek `pid` (dipanggil saat pid berubah). */
  initProject: (pid: string) => void;
  setProject: Setter<"project">;
  setMyRole: Setter<"myRole">;
  setPublishing: Setter<"publishing">;
  setPubUrl: Setter<"pubUrl">;
  setComments: Setter<"comments">;
  setShowComments: Setter<"showComments">;
  setNewComment: Setter<"newComment">;
  setFiles: Setter<"files">;
  setOpenTabs: Setter<"openTabs">;
  setActiveTab: Setter<"activeTab">;
  setView: Setter<"view">;
  setMsgs: Setter<"msgs">;
  setInput: Setter<"input">;
  setStreaming: Setter<"streaming">;
  setStreamText: Setter<"streamText">;
  setAiActivity: Setter<"aiActivity">;
  setMode: Setter<"mode">;
  setTermOpen: Setter<"termOpen">;
  setTermLines: Setter<"termLines">;
  setTermInput: Setter<"termInput">;
  setRuntimeRunning: Setter<"runtimeRunning">;
  setRuntimePreview: Setter<"runtimePreview">;
  setPreviewToken: Setter<"previewToken">;
  setPipelinePhase: Setter<"pipelinePhase">;
  setPipelineError: Setter<"pipelineError">;
  setAgentRun: Setter<"agentRun">;
  setAgentTools: Setter<"agentTools">;
  setDiagnosticsOpen: Setter<"diagnosticsOpen">;
  setWorkspaceMenuOpen: Setter<"workspaceMenuOpen">;
  setDevice: Setter<"device">;
  setExpanded: Setter<"expanded">;
  setPreviewKey: Setter<"previewKey">;
  setTables: Setter<"tables">;
  setNewTable: Setter<"newTable">;
  setSelectedTable: Setter<"selectedTable">;
  setTableLoading: Setter<"tableLoading">;
  setPolicies: Setter<"policies">;
  setPaletteOpen: Setter<"paletteOpen">;
  setPaletteQuery: Setter<"paletteQuery">;
  setMobileTab: Setter<"mobileTab">;
  setAttachedFile: Setter<"attachedFile">;
  setEnhancing: Setter<"enhancing">;
  setProposal: Setter<"proposal">;
  setProposalSel: Setter<"proposalSel">;
  setVersions: Setter<"versions">;
  setShowVersions: Setter<"showVersions">;
  setCheckpointLabel: Setter<"checkpointLabel">;
  setSavingCheckpoint: Setter<"savingCheckpoint">;
  setPreviewVersion: Setter<"previewVersion">;
  setListening: Setter<"listening">;
  setSelectMode: Setter<"selectMode">;
  setSelectedEl: Setter<"selectedEl">;
  setPreviewErrors: Setter<"previewErrors">;
  setSettingsOpen: Setter<"settingsOpen">;
  setProjSettings: Setter<"projSettings">;
  setBlueprintOpen: Setter<"blueprintOpen">;
  setBlueprint: Setter<"blueprint">;
  setBlueprintSaving: Setter<"blueprintSaving">;
  setAutoFixCount: Setter<"autoFixCount">;
  setSelfTestStatus: Setter<"selfTestStatus">;
  setClarification: Setter<"clarification">;
  setDiscovery: Setter<"discovery">;
  setMobileTreeOpen: Setter<"mobileTreeOpen">;
  setAttachedImage: Setter<"attachedImage">;
  setFileMenuPath: Setter<"fileMenuPath">;
  setRenamingPath: Setter<"renamingPath">;
  setRenameVal: Setter<"renameVal">;
  setCreatingFile: Setter<"creatingFile">;
  setNewFilePath: Setter<"newFilePath">;
  setGenImgOpen: Setter<"genImgOpen">;
  setGenImgPrompt: Setter<"genImgPrompt">;
  setGenImgLoading: Setter<"genImgLoading">;
  setGenImgResult: Setter<"genImgResult">;
  setGhOpen: Setter<"ghOpen">;
  setGhRepo: Setter<"ghRepo">;
  setGhToken: Setter<"ghToken">;
  setGhHasToken: Setter<"ghHasToken">;
  setGhLoading: Setter<"ghLoading">;
  setAiProviders: Setter<"aiProviders">;
  setSelectedProviderId: Setter<"selectedProviderId">;
  setSelectedModel: Setter<"selectedModel">;
}

export const useBuilderStore = create<BuilderStore>()((set) => {
  const s = <K extends keyof Fields>(key: K): Setter<K> =>
    (value: any) =>
      set((st) => ({ [key]: typeof value === "function" ? value(st[key]) : value }) as Partial<Fields>);
  return {
    ...initialState,
    initProject: (pid) => set({ ...initialState, projectId: pid }),
    setProject: s("project"),
    setMyRole: s("myRole"),
    setPublishing: s("publishing"),
    setPubUrl: s("pubUrl"),
    setComments: s("comments"),
    setShowComments: s("showComments"),
    setNewComment: s("newComment"),
    setFiles: s("files"),
    setOpenTabs: s("openTabs"),
    setActiveTab: s("activeTab"),
    setView: s("view"),
    setMsgs: s("msgs"),
    setInput: s("input"),
    setStreaming: s("streaming"),
    setStreamText: s("streamText"),
    setAiActivity: s("aiActivity"),
    setMode: s("mode"),
    setTermOpen: s("termOpen"),
    setTermLines: s("termLines"),
    setTermInput: s("termInput"),
    setRuntimeRunning: s("runtimeRunning"),
    setRuntimePreview: s("runtimePreview"),
    setPreviewToken: s("previewToken"),
    setPipelinePhase: s("pipelinePhase"),
    setPipelineError: s("pipelineError"),
    setAgentRun: s("agentRun"),
    setAgentTools: s("agentTools"),
    setDiagnosticsOpen: s("diagnosticsOpen"),
    setWorkspaceMenuOpen: s("workspaceMenuOpen"),
    setDevice: s("device"),
    setExpanded: s("expanded"),
    setPreviewKey: s("previewKey"),
    setTables: s("tables"),
    setNewTable: s("newTable"),
    setSelectedTable: s("selectedTable"),
    setTableLoading: s("tableLoading"),
    setPolicies: s("policies"),
    setPaletteOpen: s("paletteOpen"),
    setPaletteQuery: s("paletteQuery"),
    setMobileTab: s("mobileTab"),
    setAttachedFile: s("attachedFile"),
    setEnhancing: s("enhancing"),
    setProposal: s("proposal"),
    setProposalSel: s("proposalSel"),
    setVersions: s("versions"),
    setShowVersions: s("showVersions"),
    setCheckpointLabel: s("checkpointLabel"),
    setSavingCheckpoint: s("savingCheckpoint"),
    setPreviewVersion: s("previewVersion"),
    setListening: s("listening"),
    setSelectMode: s("selectMode"),
    setSelectedEl: s("selectedEl"),
    setPreviewErrors: s("previewErrors"),
    setSettingsOpen: s("settingsOpen"),
    setProjSettings: s("projSettings"),
    setBlueprintOpen: s("blueprintOpen"),
    setBlueprint: s("blueprint"),
    setBlueprintSaving: s("blueprintSaving"),
    setAutoFixCount: s("autoFixCount"),
    setSelfTestStatus: s("selfTestStatus"),
    setClarification: s("clarification"),
    setDiscovery: s("discovery"),
    setMobileTreeOpen: s("mobileTreeOpen"),
    setAttachedImage: s("attachedImage"),
    setFileMenuPath: s("fileMenuPath"),
    setRenamingPath: s("renamingPath"),
    setRenameVal: s("renameVal"),
    setCreatingFile: s("creatingFile"),
    setNewFilePath: s("newFilePath"),
    setGenImgOpen: s("genImgOpen"),
    setGenImgPrompt: s("genImgPrompt"),
    setGenImgLoading: s("genImgLoading"),
    setGenImgResult: s("genImgResult"),
    setGhOpen: s("ghOpen"),
    setGhRepo: s("ghRepo"),
    setGhToken: s("ghToken"),
    setGhHasToken: s("ghHasToken"),
    setGhLoading: s("ghLoading"),
    setAiProviders: s("aiProviders"),
    setSelectedProviderId: s("selectedProviderId"),
    setSelectedModel: s("selectedModel"),
  };
});
