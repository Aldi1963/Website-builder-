import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Box, ChevronRight, Code2, Database, Eye, Folder, Gauge, LayoutGrid, LogOut, Menu, MessageSquare, Plus, Rocket, Send, Settings, Sparkles, X, Mic, Paperclip, Square, MoreHorizontal, PanelRight, Download, Camera, LoaderCircle, History, RotateCcw, Globe, ExternalLink } from "lucide-react";
import { api, getToken, setToken } from "./lib/api";

type Page = "landing" | "auth" | "home" | "builder";
type Project = { id:number; name:string; slug:string; framework?:string; updatedAt?:string; blueprint?:string; memory?:string };
function AnalysisPanel({project,discovery,onBuild}:{project:Project;discovery:any;onBuild:()=>void}){
 const raw=(project as any).blueprint||""; let saved:any=null; try{saved=raw?JSON.parse(raw):null}catch{saved=null}
 const plan=discovery||saved||{}; const stack=plan.stack||{}; const list=(v:any)=>Array.isArray(v)?v:[];
 return <div className="r-analysis-panel"><div className="r-analysis-head"><div><small>ANALYSIS WORKSPACE</small><h2>Rencana project</h2><p>AI menganalisis kebutuhan sebelum kode dan database dibuat.</p></div><button onClick={onBuild}>Approve & Build <Rocket size={14}/></button></div><div className="r-analysis-grid"><article><small>INTENT & SCOPE</small><b>{plan.intent||"Product analysis"}</b><p>{plan.summary||"Blueprint akan muncul setelah AI menerima prompt project."}</p><span className="r-analysis-badge">{plan.complexity||plan.architectureProfile||"Belum ditentukan"}</span></article><article><small>ARCHITECTURE</small><b>{plan.frameworkProfile||project.framework||"Auto-select"}</b><p>{plan.folderStrategy||"AI memilih struktur berdasarkan domain, role, data, dan skala."}</p><span className="r-analysis-badge">{plan.architectureProfile||"Adaptive"}</span></article><article><small>DATABASE & ROLES</small><b>{list(plan.entities).length||0} entities · {list(plan.roles).length||0} roles</b><div className="r-analysis-chips">{list(plan.entities).slice(0,8).map((x:string)=><span key={x}>{x}</span>)}{list(plan.roles).slice(0,5).map((x:string)=><span key={x}>role:{x}</span>)}</div></article><article><small>STACK</small><b>Teknologi yang dipilih AI</b><div className="r-analysis-stack">{Object.values(stack).flatMap((v:any)=>list(v)).slice(0,12).map((x:any)=><span key={String(x)}>{String(x)}</span>)}</div></article><article><small>UI REFERENCE</small><b>{plan.references?.length||0} reference dianalisis</b><p>Website dipakai sebagai inspirasi UI/UX, GitHub sebagai constraint teknis. Source tidak disalin mentah.</p></article><article><small>ACCEPTANCE GATES</small><b>{list(plan.qualityGates||plan.acceptance).length||0} quality checks</b><ul>{list(plan.qualityGates||plan.acceptance).slice(0,5).map((x:any)=><li key={String(x)}>{typeof x==="string"?x:(x.name||x.label||JSON.stringify(x))}</li>)}</ul></article></div></div>
}
const lime="#c8f169", ink="#142118", green="#173d2a", paper="#f5f7f1", muted="#718078", line="#dbe3d8";
const btn={border:0,borderRadius:6,cursor:"pointer",fontWeight:700} as const;
const phaseLabels:Record<string,string>={analyzing:"Memahami permintaan",planning:"Menyusun rencana",generating:"Menulis kode",applying:"Menerapkan perubahan",syncing:"Menyinkronkan project",install_build:"Memeriksa build",migration:"Menyiapkan database",database_verify:"Memverifikasi data",runtime:"Menyalakan preview",acceptance_check:"Menguji aplikasi",completed:"Selesai",failed:"Butuh perhatian"};
const toolLabels:Record<string,string>={analyze_project:"Memeriksa project",ai_stream:"Membuat perubahan",apply_files:"Menerapkan perubahan",apply_file:"Membuat atau mengubah file",sync_project:"Menyinkronkan project",npm_install:"Menyiapkan dependency",run_build:"Memeriksa build",apply_migration:"Memperbarui database",verify_database:"Memverifikasi database",start_runtime:"Menyalakan preview",browser_test:"Menguji hasil"};
const statusLabels:Record<string,string>={queued:"Menunggu",running:"Sedang berjalan",completed:"Berhasil",success:"Berhasil",failed:"Gagal",error:"Gagal"};
function toolTitle(name:string){return toolLabels[name]||name.replace(/_/g," ")}
function statusTitle(value:string){return statusLabels[value]||value||"Menunggu"}
function cleanAgentText(value:string){
 let text=value.replace(/<<<FILE:[\s\S]*?(?:<<<END>>>|$)/g,"").replace(/<<<SQL>>>[\s\S]*?(?:<<<END>>>|$)/g,"").replace(/<<<BLUEPRINT>>>[\s\S]*?(?:<<<END>>>|$)/g,"").replace(/```(?:bash|sh|shell|console|terminal|markdown|md)?\s*/gi,"").replace(/```/g,"");
 const lines=text.split("\n").map(v=>v.trim()).filter(Boolean);
 const technical=/^(\$|>\s*(find|grep|rg|npm|pnpm|yarn|git|go|curl|cd\s)|(?:find|grep|rg)\s+|(?:npm|pnpm|yarn|git|go|curl)\s+(run|exec|install|build|test|status|diff)|search returned|hasil pencarian|command|perintah|exit code|stdout|stderr|```)/i;
 const kept=lines.filter(line=>{
   if(technical.test(line)||/^[-_]{3,}$/.test(line)) return false;
   if(/^(runtime error|failed to fetch|exit status|exit code|stderr|stdout|hasil pencarian)/i.test(line)) return false;
   return true;
 });
 let result=kept.join("\n").replace(/\n{3,}/g,"\n\n").trim();
 if(/failed to fetch|runtime error/i.test(value) && /crud|database|cloudDb/i.test(value)) result="Data sudah diproses, tetapi Preview belum bisa terhubung ke database. Saya akan memperbaiki koneksi Preview tanpa mengubah data yang sudah tersimpan.";
 if(/placeholder\.tsx|quality stage|kontrak.*build|project belum memenuhi/i.test(value)){
   const match=value.match(/(?:src\/[^\s`]+\.(?:tsx|ts|jsx|js))/i);
   result=match?`Preview belum siap karena masih ada file lama yang belum dipakai: ${match[0]}. Saya akan menggantinya atau menghapusnya, lalu menjalankan build ulang.`:"Preview belum siap karena masih ada bagian project yang belum lengkap. Saya akan memperbaikinya lalu menjalankan build ulang.";
 }
 return result||"Perubahan sedang diproses. Detail teknis tersedia di aktivitas project.";
}
// Helper: render activity card ala Emergent (timeline di chat)
function activityCard(tool:any,selected:boolean,onToggle:()=>void,ctx?:{files:Record<string,string>;paths:string[];fileTab:string|null;setFileTab:(p:string)=>void}){
 const tname=tool.tool||"";
 const status=tool.status||"running";
 const done=status==="completed"||status==="success";
 const running=status==="running"||status==="queued";
 // Ekstrak path file dari input/output untuk tool file
 let filePath="";
 try{
   const src=(tool.input||"")+" "+(tool.output||"");
   const m=src.match(/(?:\/[\w\-\.\/]+\.(?:tsx|ts|jsx|js|css|py|html|json))/);
   if(m)filePath=m[0];
 }catch{}
 // Tipe 1: delegasi ke agen pengujian
 if(tname==="browser_test"||tool.phase==="acceptance_check"){
   return <button className="r-act-card" onClick={onToggle}>
     <span className={done?"r-act-check done":running?"r-act-check running":"r-act-check"}>{done?"✓":running?<span className="r-mini-spinner"/>:"○"}</span>
     <div><b>Didelegasikan ke Agen Pengujian</b><small>{done?"Pengujian selesai":running?"Sedang menguji...":statusTitle(status)}</small>
     {selected&&<div className="r-act-detail" onClick={e=>e.stopPropagation()}><pre>{tool.output||tool.input||"Tidak ada detail"}</pre></div>}</div>
     <ChevronRight size={16} className="r-act-arrow"/>
   </button>;
 }
 // Tipe 2: edit file (path pink/ungu ala Emergent) — expand tampilkan file viewer dengan tab
 if(tname==="apply_file"||tname==="apply_files"||filePath){
   return <button className="r-act-card" onClick={onToggle}>
     <span className="r-act-fileicon"><Code2 size={15}/></span>
     <div><span className="r-act-edit-label">Diedit </span><code className="r-act-path">{filePath||toolTitle(tname)}</code>
     {selected&&<div className="r-act-detail" onClick={e=>e.stopPropagation()}>{ctx&&ctx.paths.length>0?<FileViewer paths={ctx.paths} files={ctx.files} active={ctx.fileTab} onSelect={ctx.setFileTab}/>:<pre>{tool.output||tool.input||"Tidak ada detail"}</pre>}</div>}</div>
     <ChevronRight size={16} className="r-act-arrow"/>
   </button>;
 }
 // Tipe 3: generik
 return <button className="r-act-card" onClick={onToggle}>
   <span className={done?"r-act-check done":running?"r-act-check running":"r-act-check"}>{done?"✓":running?<span className="r-mini-spinner"/>:"○"}</span>
   <div><b>{toolTitle(tname)}</b><small>{tool.phase?phaseLabels[tool.phase]||tool.phase:"Aktivitas agent"} · {statusTitle(status)}</small>
   {selected&&<div className="r-act-detail" onClick={e=>e.stopPropagation()}><pre>{tool.input||"Tidak ada input"}</pre>{tool.output&&<pre>{tool.output}</pre>}</div>}</div>
   <ChevronRight size={16} className="r-act-arrow"/>
 </button>;
}
// Syntax highlight ringan per baris (aman untuk dangerouslySetInnerHTML)
function highlightJS(src:string){
 const esc=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
 const re=/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|typeof|class|extends|interface|type|enum|async|await|try|catch|finally|throw|default|as|of|in|this|true|false|null|undefined|void|useState|useEffect|useRef)\b|\b(\d+(?:\.\d+)?)\b/g;
 let out="",last=0,m:RegExpExecArray|null;
 while((m=re.exec(src))){
   out+=esc(src.slice(last,m.index));
   const tok=m[0];
   if(m[1])out+='<span class="tk-c">'+esc(tok)+"</span>";
   else if(m[2])out+='<span class="tk-s">'+esc(tok)+"</span>";
   else if(m[3])out+='<span class="tk-k">'+esc(tok)+"</span>";
   else if(m[4])out+='<span class="tk-n">'+esc(tok)+"</span>";
   else out+=esc(tok);
   last=m.index+tok.length;
 }
 return out+esc(src.slice(last));
}
// Tampilan kode dengan nomor baris
function CodeView({code}:{code:string}){
 const lines=code.split("\n");
 return <div className="r-codeview">
   <div className="r-code-gutter">{lines.map((_,i)=><span key={i}>{i+1}</span>)}</div>
   <pre className="r-code-pre">{lines.map((l,i)=><code key={i} dangerouslySetInnerHTML={{__html:highlightJS(l)||" "}}/> )}</pre>
 </div>;
}
type FileTreeNode={name:string;path:string;dir:boolean;children:FileTreeNode[]};
function buildFileTree(paths:string[]):FileTreeNode[]{
 const root:FileTreeNode={name:"",path:"",dir:true,children:[]};
 for(const path of paths){let cur=root;const parts=path.split("/").filter(Boolean);let full="";parts.forEach((name,i)=>{full=full?full+"/"+name:name;let child=cur.children.find(x=>x.name===name);if(!child){child={name,path:full,dir:i<parts.length-1,children:[]};cur.children.push(child)}cur=child});}
 const sort=(n:FileTreeNode)=>{n.children.sort((a,b)=>Number(b.dir)-Number(a.dir)||a.name.localeCompare(b.name));n.children.forEach(sort)};sort(root);return root.children;
}
function FileTree({paths,onSelect,active}:{paths:string[];onSelect:(p:string)=>void;active:string|null}){
 const render=(nodes:FileTreeNode[],depth=0):any=>nodes.map(n=><div key={n.path}><button className={`r-tree-item ${active===n.path?"active":""}`} style={{paddingLeft:10+depth*16}} onClick={()=>!n.dir&&onSelect(n.path)}>{n.dir?<Folder size={14}/>:<Code2 size={14}/>}<span>{n.name}</span>{n.dir&&<small>{n.children.length}</small>}</button>{n.dir&&render(n.children,depth+1)}</div>);
 return <div className="r-file-tree">{render(buildFileTree(paths))}</div>;
}
// File viewer dengan tab untuk file yang diedit sesi ini
function FileViewer({paths,files,active,onSelect}:{paths:string[];files:Record<string,string>;active:string|null;onSelect:(p:string)=>void}){
 if(paths.length===0)return <pre>Tidak ada file yang terdeteksi.</pre>;
 const shown=active&&paths.includes(active)?active:paths[0];
 const code=shown?(files[shown]??""):"";
 return <div className="r-fileviewer">
   <div className="r-filetabs">{paths.map(p=><button key={p} className={p===shown?"active":""} onClick={()=>onSelect(p)}>{p.split("/").pop()}</button>)}</div>
   {shown&&<div className="r-filepath">{shown}</div>}
   {code?<CodeView code={code}/>:<pre>Memuat isi file...</pre>}
 </div>;
}

// Render teks asisten sederhana: **tebal**, `kode`, daftar bullet/nomor, heading.
// Sebelumnya bubble menampilkan markdown mentah (tanda ** dan backtick terlihat).
function renderInline(text:string,prefix:string){
 const parts=String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
 return parts.map((part,i)=>{
   if(part.startsWith("**")&&part.endsWith("**"))return <strong key={prefix+i}>{part.slice(2,-2)}</strong>;
   if(part.startsWith("`")&&part.endsWith("`"))return <code className="r-inline-code" key={prefix+i}>{part.slice(1,-1)}</code>;
   return <span key={prefix+i}>{part}</span>;
 });
}
function RichText({text}:{text:string}){
 const lines=String(text||"").split("\n");
 const out:any[]=[];let list:string[]=[];
 const flush=()=>{if(list.length){const items=[...list];list=[];out.push(<ul className="r-md-list" key={"ul"+out.length}>{items.map((li,i)=><li key={i}>{renderInline(li,"li"+i)}</li>)}</ul>);}};
 for(const raw of lines){
   const line=raw.trim();
   if(!line){flush();continue;}
   const bullet=line.match(/^[-*•]\s+(.*)$/);
   const numbered=line.match(/^\d+[.)]\s+(.*)$/);
   if(bullet||numbered){list.push((bullet||numbered)![1]);continue;}
   flush();
   if(/^#{1,4}\s+/.test(line)){out.push(<b className="r-md-heading" key={"h"+out.length}>{renderInline(line.replace(/^#{1,4}\s+/,""),"h")}</b>);continue;}
   out.push(<p key={"p"+out.length}>{renderInline(line,"p")}</p>);
 }
 flush();
 return <div className="r-rich">{out}</div>;
}

// Riwayat versi + perbandingan + rollback untuk UI yang benar-benar dipakai.
// Sebelumnya fitur ini hanya ada di Builder.tsx yang tidak ikut di-build.
function VersionHistory({projectId,currentFiles,onClose,onRestored}:{projectId:number;currentFiles:Record<string,string>;onClose:()=>void;onRestored:(files:Record<string,string>)=>void}){
 const auth={Authorization:"Bearer "+getToken()};
 const [versions,setVersions]=useState<any[]>([]);
 const [label,setLabel]=useState("");
 const [saving,setSaving]=useState(false);
 const [busyId,setBusyId]=useState<number|null>(null);
 const [snap,setSnap]=useState<{id:number;label:string;files:Record<string,string>}|null>(null);
 const [msg,setMsg]=useState("");
 const load=async()=>{try{const r=await fetch(`/api/projects/${projectId}/versions`,{headers:auth});const d=await r.json();setVersions(d.versions||[])}catch{setMsg("Gagal memuat riwayat.")}};
 useEffect(()=>{load()},[projectId]);
 const checkpoint=async()=>{setSaving(true);try{const r=await fetch(`/api/projects/${projectId}/versions/checkpoint`,{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({label:label.trim()||"Checkpoint"})});if(!r.ok)throw new Error("HTTP "+r.status);setLabel("");await load();setMsg("Checkpoint disimpan.")}catch(e:any){setMsg("Gagal menyimpan: "+String(e?.message||e))}finally{setSaving(false)}};
 const preview=async(id:number,text:string)=>{setBusyId(id);try{const r=await fetch(`/api/projects/${projectId}/versions/${id}/files`,{headers:auth});const d=await r.json();if(!r.ok)throw new Error(d.message||"HTTP "+r.status);setSnap({id,label:text,files:d.files||{}})}catch(e:any){setMsg("Gagal membuka versi: "+String(e?.message||e))}finally{setBusyId(null)}};
 const restore=async(id:number)=>{if(!window.confirm("Pulihkan versi ini? Kondisi sekarang disimpan dulu sebagai snapshot."))return;setBusyId(id);try{const r=await fetch(`/api/projects/${projectId}/versions/${id}/restore`,{method:"POST",headers:auth});const d=await r.json();if(!r.ok)throw new Error(d.message||"HTTP "+r.status);const f=d.files?JSON.parse(d.files):null;if(f)onRestored(f);setSnap(null);await load();setMsg("Versi dipulihkan. Jalankan build ulang untuk menerapkan ke preview.")}catch(e:any){setMsg("Gagal memulihkan: "+String(e?.message||e))}finally{setBusyId(null)}};
 const names=snap?Array.from(new Set([...Object.keys(snap.files),...Object.keys(currentFiles)])).sort():[];
 const changedCount=names.filter(n=>snap&&(snap.files[n]||"")!==(currentFiles[n]||"")).length;
 return <div className="r-modal-backdrop" onClick={onClose}><div className="r-modal" onClick={e=>e.stopPropagation()}>
   <header><b><History size={15}/> Riwayat versi</b><button onClick={onClose} aria-label="Tutup"><X size={16}/></button></header>
   <div className="r-modal-body">
     <aside className="r-version-list">
       <div className="r-checkpoint"><input value={label} onChange={e=>setLabel(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")checkpoint()}} placeholder="Nama checkpoint..."/><button onClick={checkpoint} disabled={saving}>{saving?"...":"Simpan"}</button></div>
       {msg&&<p className="r-modal-msg">{msg}</p>}
       {versions.length===0&&<p className="r-modal-msg">Belum ada riwayat.</p>}
       {versions.map(v=><div className={"r-version-item"+(snap?.id===v.id?" active":"")} key={v.id}>
         <button onClick={()=>preview(v.id,v.label)}><b>{v.label||"Versi"}</b><small>{new Date(v.createdAt).toLocaleString("id-ID")} · {v.fileCount} file</small></button>
         <button className="r-version-restore" onClick={()=>restore(v.id)} disabled={busyId===v.id} title="Pulihkan versi ini"><RotateCcw size={13}/></button>
       </div>)}
     </aside>
     <section className="r-diff">
       {!snap?<div className="r-diff-empty"><History size={26}/><p>Pilih versi untuk membandingkan dengan kondisi sekarang.</p></div>:
        <><div className="r-diff-head"><b>{snap.label}</b><small>{changedCount} file berbeda dari kondisi sekarang</small></div>
        <div className="r-diff-body">{names.map(n=>{const a=snap.files[n];const b=currentFiles[n];const same=(a||"")===(b||"");const status=a===undefined?"baru sekarang":b===undefined?"dihapus sekarang":same?"sama":"diubah";return <div className={"r-diff-file"+(same?" same":"")} key={n}>
          <div className="r-diff-file-head"><code>{n}</code><span data-status={status}>{status}</span></div>
          {!same&&<div className="r-diff-cols"><div><small>VERSI DIPILIH</small><pre>{a===undefined?"(belum ada di versi ini)":a.slice(0,4000)}</pre></div><div><small>SEKARANG</small><pre>{b===undefined?"(sudah dihapus)":b.slice(0,4000)}</pre></div></div>}
        </div>})}</div>
        <div className="r-diff-actions"><button className="r-dark" onClick={()=>restore(snap.id)} disabled={busyId===snap.id}>{busyId===snap.id?"Memulihkan...":"Pulihkan ke versi ini"}</button></div></>}
     </section>
   </div>
 </div></div>;
}
function buildResultCard(tools:any[],onView:(v:"preview"|"code"|"data")=>void){const files=tools.filter(t=>["apply_file","apply_files"].includes(t.tool)).length;const db=tools.some(t=>["verify_database","apply_migration"].includes(t.tool));return <div className="r-result-card"><div className="r-result-head"><span className="r-result-check">✓</span><div><b>Project berhasil diperbarui</b><small>Build selesai dan hasil siap diperiksa</small></div></div><div className="r-result-stats"><span>✓ {files||0} aktivitas file</span><span>✓ Build berhasil</span>{db&&<span>✓ Database siap</span>}<span>✓ Preview siap</span></div><div className="r-result-actions"><button onClick={()=>onView("preview")}><Eye size={14}/> Buka Preview</button><button onClick={()=>onView("code")}><Code2 size={14}/> Lihat Code</button><button onClick={()=>onView("data")}><Database size={14}/> Database</button></div></div>}
function agentCopy(value:string,active=false){const text=cleanAgentText(value);const lines=text.split("\n").map(x=>x.trim()).filter(Boolean);const summary=lines.find(x=>!x.startsWith("#"))||"Perubahan sudah diterapkan ke project.";return <div className="r-agent-answer"><div className="r-answer-summary"><span className={active?"r-answer-check pending":"r-answer-check"}>{active?"●":"✓"}</span><div><b>{active?"Sedang menyiapkan perubahan":"Perubahan sudah diterapkan"}</b><p>{active?"Agent sedang mengerjakan permintaan ini.":summary}</p></div></div><details className="r-answer-details"><summary>Lihat detail teknis</summary><pre className="r-technical-text">{text}</pre></details></div>}
const followUps=["Tambahkan mode gelap","Buat responsive mobile","Tambahkan data contoh"];
const agentSteps=[
 {id:"analyzing",label:"Memahami permintaan",detail:"Membaca konteks project dan tujuanmu."},
 {id:"planning",label:"Membuat logic",detail:"Menyusun struktur fitur dan alur data."},
 {id:"generating",label:"Membuat file",detail:"Menulis komponen dan konfigurasi yang dibutuhkan."},
 {id:"applying",label:"Mengedit file",detail:"Menerapkan perubahan ke project."},
 {id:"install_build",label:"Memeriksa aplikasi",detail:"Menjalankan install dan build."},
 {id:"database_verify",label:"Memeriksa database",detail:"Memastikan schema dan CRUD tetap aman."},
 {id:"runtime",label:"Menyiapkan preview",detail:"Menyalakan runtime project."},
 {id:"acceptance_check",label:"Menguji hasil",detail:"Memastikan aplikasi bisa digunakan."}
];
const phaseOrder=agentSteps.map(s=>s.id);


function QuizWizard({clarification,quizIdx,setQuizIdx,quizAnswers,setQuizAnswers,onDone,onAuto,onClose}:any){
 const qs=clarification.questions||[];
 const q=qs[quizIdx]||{question:"",options:[]};
 const isLast=quizIdx>=qs.length-1;
 const isText=q.type==="text";
 const sel=quizAnswers[quizIdx];
 const canNext=isText||!!sel;
 const choose=(label:string)=>{const a=[...quizAnswers];a[quizIdx]=label;setQuizAnswers(a);};
 return <div className="r-quiz-card">
  <div className="r-quiz-head"><span className="r-quiz-icon">?</span><div><b>Beberapa pertanyaan sebelum membangun</b><small>Jawab seperlunya agar hasil lebih tepat</small></div><button className="r-quiz-close" onClick={onClose} aria-label="Tutup">×</button></div>
  <div className="r-quiz-progress" aria-label={`Pertanyaan ${quizIdx+1} dari ${qs.length}`}>{qs.map((_:any,i:number)=><span key={i} className={i===quizIdx?"active":i<quizIdx?"done":""}/>)}</div>
  <div className="r-quiz-body"><h3>{q.question}</h3>
   {isText
    ?<textarea className="r-quiz-text" placeholder="Ketik jawabanmu..." value={sel||""} onChange={e=>choose(e.target.value)} rows={3}/>
    :<div className="r-quiz-options">{(q.options||[]).map((o:any,oi:number)=>{
     const label=typeof o==="string"?o:(o.label||"");
     const rec=typeof o!=="string"&&!!o.recommended;
     return <button key={oi} className={"r-quiz-opt"+(sel===label?" selected":"")} onClick={()=>choose(label)}><span className="r-quiz-radio"/>{label}{rec&&<em>(recommended)</em>}</button>;
    })}</div>}
  </div>
  <div className="r-quiz-foot"><button className="r-quiz-skip" onClick={onAuto}>Lewati semua</button><span className="r-quiz-count">{quizIdx+1} dari {qs.length}</span>
   <div><button className="r-quiz-auto" onClick={onAuto}>Pilih otomatis</button>
   <button className="r-quiz-next" disabled={!canNext} onClick={()=>{if(isLast){onDone(quizAnswers)}else{setQuizIdx(quizIdx+1)}} }>{isLast?"Mulai membangun":"Berikutnya"}</button></div>
  </div>
 </div>;
}

export default function Rebuild(){
 const routeProjectId=Number((window.location.pathname.match(/^\/project\/(\d+)/)||[])[1]||0);
 const savedProjectId=routeProjectId||Number(localStorage.getItem("wb-current-project")||0);
 const [page,setPage]=useState<Page>(getToken()?"home":"landing"); const [project,setProject]=useState<Project|null>(null);
 const [pendingPrompt,setPendingPrompt]=useState<string|null>(null);
 const [restoring,setRestoring]=useState(!!getToken()&&savedProjectId>0);
 useEffect(()=>{
   if(!getToken()||!savedProjectId)return;
   api.projects().then(d=>{
     const found=(d.projects||[]).find((p:Project)=>p.id===savedProjectId);
     if(found){setProject(found);setPage("builder");window.history.replaceState({},"",`/project/${found.id}`);}
     else localStorage.removeItem("wb-current-project");
   }).catch(()=>localStorage.removeItem("wb-current-project")).finally(()=>setRestoring(false));
 },[]);
 function handleLandingStart(p?:string){ if(p?.trim()) setPendingPrompt(p.trim()); setPage("auth"); }
 async function handleAuthDone(){
   setPage("home");
   if(pendingPrompt){
     const prompt=pendingPrompt;
     try{
       const words=prompt.split(/\s+/).slice(0,6).join(" ");
       const name=(words||"Proyek baru").slice(0,40);
       const d=await api.createProject(name,"react");
       if(d?.project){ setProject(d.project); localStorage.setItem("wb-current-project",String(d.project.id)); window.history.pushState({},"",`/project/${d.project.id}`); setPage("builder"); }
       else setPendingPrompt(null);
     }catch{ setPendingPrompt(null); }
   }
 }
 if(restoring) return <div className="r-loading-screen"><LoaderCircle className="r-spin" size={24}/><span>Memulihkan project terakhir…</span></div>;
 if(page==="landing") return <Landing onStart={handleLandingStart}/>;
 if(page==="auth") return <Auth onDone={handleAuthDone} onBack={()=>{setPage("landing");setPendingPrompt(null)}}/>;
 if(page==="builder"&&project) return <Builder project={project} initialPrompt={pendingPrompt||undefined} onBack={()=>{localStorage.removeItem("wb-current-project");window.history.pushState({},"","/");setProject(null);setPendingPrompt(null);setPage("home")}}/>;
 return <Home onOpen={(p,prompt)=>{setProject(p);localStorage.setItem("wb-current-project",String(p.id));window.history.pushState({},"",`/project/${p.id}`);if(prompt)setPendingPrompt(prompt);setPage("builder")}} onLogout={()=>{setToken("");localStorage.removeItem("wb-current-project");setPage("landing")}}/>;
}

function Mark(){return <a className="r-mark" href="#" onClick={e=>e.preventDefault()}>web<span>builder</span><i>.</i></a>}
function Landing({onStart}:{onStart:(prompt?:string)=>void}){const [menu,setMenu]=useState(false);const [prompt,setPrompt]=useState("");function submit(){const t=prompt.trim();if(t) onStart(t);}return <main className="r-landing"><nav><Mark/><div className="r-navlinks"><a href="#how">Cara kerja</a><a href="#stack">Platform</a><a href="#pricing">Harga</a></div><button className="r-dark" onClick={()=>onStart()}>Mulai gratis <ArrowUp size={15}/></button><button className="r-menu" onClick={()=>setMenu(!menu)} aria-label={menu?"Tutup navigasi":"Buka navigasi"}><Menu/></button></nav>{menu&&<div className="r-mobile-menu-panel"><a href="#how" onClick={()=>setMenu(false)}>Cara kerja</a><a href="#stack" onClick={()=>setMenu(false)}>Platform</a><a href="#pricing" onClick={()=>setMenu(false)}>Harga</a><button onClick={()=>onStart()}>Mulai gratis <ArrowUp size={15}/></button></div>}<section className="r-hero"><div className="r-eyebrow"><span/> AI PRODUCT WORKSPACE</div><h1>Build ideas<br/><em>into products.</em></h1><p>Workspace AI untuk mengubah ide menjadi aplikasi nyata—dengan database, runtime, dan verifikasi yang bisa dipercaya.</p><div className="r-actions"><button className="r-lime" onClick={()=>onStart()}>Mulai membangun <ArrowUp size={16}/></button><a href="#how">Lihat cara kerja <ChevronRight size={15}/></a></div><div className="r-terminal"><div><b><span className="r-dot"/> agent.run</b><small>ready</small></div><div className="r-terminal-prompt"><strong>prompt</strong><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();submit()}}} placeholder="Buat dashboard inventory untuk tim retail dengan role admin dan kasir..." rows={2} style={{background:"transparent",border:"none",outline:"none",resize:"none",width:"100%",font:"inherit",color:"inherit"}}/><button onClick={submit} aria-label="Kirim ide" style={{background:lime,border:"none",borderRadius:6,padding:"6px 10px",cursor:"pointer",display:"flex",alignItems:"center"}}><ArrowUp size={15} color={ink}/></button></div><div className="r-terminal-status"><span>✓ project context</span><span>✓ database plan</span><span>● ready to build</span></div></div></section><section id="how" className="r-section"><div className="r-section-title"><small>01 / WORKFLOW</small><h2>Less setup.<br/><em>More shipping.</em></h2></div><div className="r-process"><article><b>01</b><Sparkles/><h3>Describe</h3><p>Ceritakan tujuan, user, dan fitur utama dengan bahasa biasa.</p></article><article><b>02</b><Code2/><h3>Build</h3><p>Agent membuat file, database, auth, dan runtime terisolasi.</p></article><article><b>03</b><Gauge/><h3>Prove</h3><p>Build, test, preview, dan perbaikan berjalan sebelum siap.</p></article></div></section><section id="stack" className="r-dark-section"><small>02 / PLATFORM</small><h2>Satu tempat untuk<br/><em>produk yang serius.</em></h2><div className="r-stack"><span><Database/> PostgreSQL</span><span><Eye/> Live preview</span><span><Rocket/> Deployment</span><span><LayoutGrid/> Team workspace</span></div></section><section id="pricing" className="r-end"><span>START SMALL. BUILD REAL.</span><h2>Punya ide?<br/><em>Mulai sekarang.</em></h2><button className="r-dark" onClick={() => onStart()}>Masuk ke workspace <ArrowUp size={15}/></button></section><footer><Mark/><span>AI software builder · 2026</span></footer></main>}

function Auth({onDone,onBack}:{onDone:()=>void;onBack:()=>void}){const [mode,setMode]=useState<"login"|"register">("login");const [name,setName]=useState("");const [email,setEmail]=useState("");const [pw,setPw]=useState("");const [error,setError]=useState("");async function submit(e:any){e.preventDefault();setError("");try{const d=mode==="login"?await api.login(email,pw):await api.register(name,email,pw);setToken(d.token);onDone()}catch(x:any){setError(x.message)}}return <main className="r-auth"><aside><Mark/><div><small>YOUR NEXT<br/>PRODUCT STARTS HERE</small><h1>Build with<br/><em>intent.</em></h1><p>Ideate, build, verify, ship.</p></div><span>WebBuilder / 2026</span></aside><section><button className="r-back" onClick={onBack}><ArrowLeft size={15}/> Back</button><form onSubmit={submit}><small>WORKSPACE ACCESS</small><h2>{mode==="login"?"Welcome back.":"Create your workspace."}</h2><p>{mode==="login"?"Lanjutkan project yang sedang kamu bangun.":"Satu akun untuk semua project kamu."}</p>{mode==="register"&&<input placeholder="Nama lengkap" value={name} onChange={e=>setName(e.target.value)} required/>}<input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required/><input type="password" placeholder="Password" value={pw} onChange={e=>setPw(e.target.value)} required/>{error&&<div className="r-error">{error}</div>}<button className="r-submit">{mode==="login"?"Masuk":"Buat akun"}<ArrowUp size={16}/></button><button type="button" className="r-switch" onClick={()=>setMode(mode==="login"?"register":"login")}>{mode==="login"?"Belum punya akun? Daftar":"Sudah punya akun? Masuk"}</button></form></section></main>}


function Onboarding({onDone,onSkip}:{onDone:(idea?:string)=>void;onSkip:()=>void}){
 const [step,setStep]=useState(0);
 const [idea,setIdea]=useState("");
 const steps=[
  {t:"Deskripsikan idemu",d:"Ceritakan aplikasi yang ingin kamu buat dengan bahasa sehari-hari. Semakin detail, semakin bagus hasilnya."},
  {t:"AI membangun",d:"AI akan menyusun arsitektur, menulis kode, membuat database, dan menyiapkan semuanya secara otomatis."},
  {t:"Preview & publish",d:"Lihat hasilnya secara langsung, minta perbaikan lewat chat, lalu publish dengan satu klik saat sudah puas."}
 ];
 const s=steps[step];
 return <div className="r-onboard-overlay" onClick={onSkip}>
  <div className="r-onboard-modal" onClick={e=>e.stopPropagation()}>
   <div className="r-onboard-dots">{steps.map((_,i)=><span key={i} className={i===step?"active":i<step?"done":""}/>)}</div>
   <small>LANGKAH {step+1} DARI 3</small>
   <h2>{s.t}</h2>
   <p>{s.d}</p>
   {step===0&&<textarea value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Contoh: Buatkan aplikasi kasir untuk toko kelontong dengan login kasir, daftar produk, transaksi, dan laporan harian..." rows={4}/>}
   {step===1&&<div className="r-onboard-illu"><Sparkles size={32}/><div><span className="r-mini-spinner"/> Menyiapkan AI builder...</div></div>}
   {step===2&&<div className="r-onboard-illu"><Rocket size={32}/><span>Siap diluncurkan ke internet</span></div>}
   <div className="r-onboard-actions">
    <button className="r-onboard-skip" onClick={onSkip}>Lewati</button>
    {step<2
      ?<button className="r-onboard-next" onClick={()=>setStep(step+1)}>Lanjut <ChevronRight size={15}/></button>
      :<button className="r-onboard-next primary" onClick={()=>onDone(idea)}>Mulai Membangun <ArrowUp size={15}/></button>}
   </div>
  </div>
 </div>;
}

function Home({onOpen,onLogout}:{onOpen:(p:Project,initialPrompt?:string)=>void;onLogout:()=>void}){
 const [projects,setProjects]=useState<Project[]>([]);
 const [name,setName]=useState("");
 const [prompt,setPrompt]=useState("");
 const [buildType,setBuildType]=useState("Web app");
 const [agent,setAgent]=useState("Auto");
 const [agentOpen,setAgentOpen]=useState(false);
 const [advancedOpen,setAdvancedOpen]=useState(false);
 const [accountOpen,setAccountOpen]=useState(false);
 const [loading,setLoading]=useState(true); const [loadError,setLoadError]=useState("");
 const [menu,setMenu]=useState(false);
 const [showOnboarding,setShowOnboarding]=useState(false);
 const loadProjects=()=>{setLoading(true);setLoadError("");api.projects().then(d=>{const ps=d.projects||[];setProjects(ps);if(ps.length===0&&!localStorage.getItem("wb-onboarded"))setShowOnboarding(true)}).catch((e:any)=>{setLoadError(e?.message||"Workspace belum bisa dimuat")}).finally(()=>setLoading(false))};
 useEffect(()=>{loadProjects()},[]);
 async function create(){
   const idea=prompt.trim()||name.trim();
   if(!idea)return;
   const words=idea.split(/\s+/).slice(0,6).join(" ");
   const pname=(name.trim()||words||"Proyek baru").slice(0,40);
   const d=await api.createProject(pname,"auto");
   if(d?.project)onOpen(d.project,`${buildType}: ${idea}`);
   setPrompt("");
   setName("");
 }
 async function createWithIdea(idea:string){
   const words=idea.split(/\s+/).slice(0,6).join(" ");
   const pname=(words||"Proyek baru").slice(0,40);
   try{
     const d=await api.createProject(pname,"react");
     if(d?.project)onOpen(d.project,idea);
   }catch{}
 }
 function finishOnboarding(idea?:string){
   localStorage.setItem("wb-onboarded","1");
   setShowOnboarding(false);
   if(idea?.trim())createWithIdea(idea.trim());
 }
 return (<main className="r-home r-prompt-home r-emergent-home">{showOnboarding&&<Onboarding onDone={finishOnboarding} onSkip={()=>finishOnboarding()}/>}<aside className={`r-sidebar ${menu?"open":""}`}><Mark/><div className="r-side-group"><small>WORKSPACE</small><button className="active"><Plus/> New task</button><button><Rocket/> Published apps</button><button><Sparkles/> Showcase</button></div><div className="r-side-bottom"><button onClick={()=>setAccountOpen(!accountOpen)}><div className="r-account-avatar">A</div> Aldi Irawan <ChevronRight size={14}/></button><button onClick={onLogout}><LogOut/> Sign out</button></div></aside><section className="r-home-main"><header><button className="r-mobile-menu" onClick={()=>setMenu(!menu)} aria-label={menu?"Tutup menu":"Buka menu"}><Menu/></button><div><small>WORKSPACE / NEW TASK</small><h1>Apa yang akan kamu bangun hari ini?</h1></div><button className="r-home-credit" onClick={()=>setAccountOpen(!accountOpen)}>✦ Kredit</button><div className="r-avatar">A</div></header><div className="r-promo-strip">🎉 Promo perayaan berlangsung! <b>Nikmati 50% kredit ekstra.</b></div><div className="r-prompt-stage"><div className="r-build-types">{["Web app","Mobile app","Desktop app","Creative"].map(t=><button key={t} className={buildType===t?"active":""} onClick={()=>setBuildType(t)}>{t}</button>)}</div><h2>Mulai dengan sebuah ide</h2><p>Jelaskan apa yang ingin kamu buat. AI akan bertanya dulu jika ada bagian yang belum jelas.</p><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();create()}}} placeholder="Build me sebuah sistem CRM dengan..." rows={4}/><div className="r-composer-bar"><button>＋ Lampiran</button><button onClick={()=>setAgentOpen(true)}>✦ {agent}</button><button onClick={()=>setAdvancedOpen(true)}>⚙ Pengaturan</button><button className="r-voice-button">◉</button><button className="r-send-prompt" onClick={create} disabled={!prompt.trim()&&!name.trim()}><Send size={16}/></button></div><div className="r-prompt-bottom"><small>{buildType} · AI discovery aktif</small><button onClick={create} disabled={!prompt.trim()&&!name.trim()}><Sparkles size={15}/> Mulai membangun</button></div><div className="r-prompt-examples"><button onClick={()=>setPrompt("Buat CRM untuk tim sales dengan pipeline, kontak, dan laporan")}>CRM sales</button><button onClick={()=>setPrompt("Buat aplikasi kasir dengan produk, transaksi, dan laporan")}>Aplikasi kasir</button><button onClick={()=>setPrompt("Buat dashboard analytics dengan role admin dan member")}>Dashboard analytics</button></div></div><div className="r-create-hint"><Folder size={14}/><span>Referensi GitHub atau website dikirim langsung di Chat AI.</span></div>{agentOpen&&<div className="r-control-modal"><div className="r-control-panel"><button className="r-panel-close" onClick={()=>setAgentOpen(false)}>×</button><small>SELECT AGENT</small><h2>Pilih agent</h2>{["Auto","E-1 · Stable & thorough","E-3 · Autonomous & powerful","Mobile · Agent aplikasi mobile"].map(a=><button className={agent===a?"selected":""} onClick={()=>{setAgent(a);setAgentOpen(false)}}><b>{a.split(" · ")[0]}</b><span>{a.includes("·")?a.split(" · ")[1]:"Agent adaptif WebBuilder"}</span></button>)}</div></div>}{advancedOpen&&<div className="r-control-modal"><div className="r-control-panel"><button className="r-panel-close" onClick={()=>setAdvancedOpen(false)}>×</button><small>ADVANCED CONTROLS</small><h2>Pengaturan lanjutan</h2><label><span>Plan mode</span><input type="checkbox"/></label><label><span>Fast mode</span><input type="checkbox"/></label><button className="r-advanced-row">Model <b>Auto</b></button><button className="r-advanced-row">MCP Tools <b>New</b></button><button className="r-advanced-row">Connect to GitHub <b>›</b></button><button className="r-advanced-row">Full Stack Template <b>Auto</b></button></div></div>}{accountOpen&&<div className="r-control-modal"><div className="r-control-panel r-account-panel"><button className="r-panel-close" onClick={()=>setAccountOpen(false)}>×</button><small>ACCOUNT</small><h2>Aldi Irawan</h2><p>Workspace WebBuilder</p><div className="r-credit-large">✦ Unlimited credits</div><button className="r-advanced-row">Manage plan <b>›</b></button><button className="r-advanced-row">Account settings <b>›</b></button><button className="r-advanced-row">Documentation <b>›</b></button></div></div>}<div className="r-list-head"><h2>Your projects</h2><span>{projects.length} total</span></div>{loading?<div className="r-empty r-loading-workspace"><LoaderCircle className="r-spin" size={24}/><h3>Memuat workspace</h3><p>Menyiapkan project kamu...</p></div>:loadError?<div className="r-empty r-load-error"><Box size={28}/><h3>Workspace belum tersedia</h3><p>{loadError}</p><button onClick={loadProjects}>Coba lagi</button></div>:projects.length===0?<div className="r-empty"><Box size={30}/><h3>Workspace masih kosong</h3><p>Buat project pertama dan biarkan AI mulai bekerja.</p></div>:<div className="r-projects">{projects.map(p=><button key={p.id} onClick={()=>onOpen(p)}><div className="r-project-icon"><Code2 size={17}/></div><div><b>{p.name}</b><span>{p.framework||"react"} · /{p.slug}</span></div><ChevronRight size={17}/></button>)}</div>}</section></main>)
}

function Builder({project,onBack,initialPrompt}:{project:Project;onBack:()=>void;initialPrompt?:string}) {
 useEffect(()=>{localStorage.setItem("wb-current-project",String(project.id));},[project.id]);
 const [input,setInput]=useState("");
 const [messages,setMessages]=useState<any[]>([]);
 const [busy,setBusy]=useState(false);
 const [phase,setPhase]=useState("");
 const [open,setOpen]=useState(true);
 const [tools,setTools]=useState<any[]>([]);
 const [runStatus,setRunStatus]=useState("");
 const [discovery,setDiscovery]=useState<any>(null);
 const [clarification,setClarification]=useState<any>(null);
 const [quizIdx,setQuizIdx]=useState(0);
 const [quizAnswers,setQuizAnswers]=useState<string[]>([]);
 const [lastIntent,setLastIntent]=useState("");
 // P2.2: indikator self-test & auto-fix
 const autoFixCountRef=useRef(0);
 const [autoFixing,setAutoFixing]=useState(false);
 const [deploying,setDeploying]=useState(false);
 const [projectGate,setProjectGate]=useState<any>({publishState:(project as any).publishState||"draft",buildStatus:(project as any).buildStatus||"unknown"});
 const [historyOpen,setHistoryOpen]=useState(false); // status quality gate project
 useEffect(()=>{fetch(`/api/projects/${project.id}`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>{const p=d.project||d;setProjectGate({publishState:p.publishState||"draft",buildStatus:p.buildStatus||"unknown",buildError:p.buildError||""});if(p.blueprint){try{setAnalysisPlan(typeof p.blueprint==="string"?JSON.parse(p.blueprint):p.blueprint)}catch{setAnalysisPlan({summary:p.blueprint})}}}).catch(()=>{})},[project.id,runStatus]);
 const gateLabel=projectGate.publishState==="published"?"Published":projectGate.publishState==="stale"?"Stale":projectGate.buildStatus==="success"?"Preview ready":projectGate.buildStatus==="failed"?"Needs fix":"Draft"; const gateClass=projectGate.publishState==="published"?"published":projectGate.publishState==="stale"||projectGate.buildStatus==="failed"?"warning":"";
 const [showAllGood,setShowAllGood]=useState(false);
 const [giveUp,setGiveUp]=useState(false);
 const [selectedTool,setSelectedTool]=useState<string|null>(null);
 const recoveryPrompt=()=>{const latest=tools.slice().reverse().find((t:any)=>t.status==="failed"||t.status==="error")||tools[tools.length-1];const detail=String((projectGate as any).buildError||latest?.output||latest?.error||"").replace(/\s+/g," ").trim().slice(0,1800);const phaseText=phaseLabels[phase]||phase||"verifikasi terakhir";return `Perbaiki akar masalah pada fase ${phaseText}. Error terbaru: ${detail||"hasil verifikasi belum memenuhi kontrak project"}. Baca file yang terkait dan dependency-nya, ubah hanya penyebabnya, lalu jalankan ulang verifikasi otomatis. Jangan hanya menjelaskan dan jangan mengulang perbaikan yang sudah berhasil.`};
 // Antrian pesan saat agent sibuk + file viewer + stop
 const [queue,setQueue]=useState<string[]>([]);
 const [runId,setRunId]=useState<string|null>(null);
 const skipRunPollRef=useRef(false);
 const [fileTab,setFileTab]=useState<string|null>(null);
 const userStoppedRef=useRef(false);
 // Guard kirim ganda: Enter + submit form bisa memicu send() dua kali untuk teks
 // yang sama, menghasilkan pesan user dobel di UI dan jawaban yang terasa aneh.
 const lastSendRef=useRef<{text:string;ts:number}>({text:"",ts:0});
 const wasBusyRef=useRef(false);
 const [menu,setMenu]=useState(false);
 const [view,setView]=useState<"chat"|"analyze"|"preview"|"code"|"data">("chat"); const [analysisPlan,setAnalysisPlan]=useState<any>(null);
 const [files,setFiles]=useState<Record<string,string>>({});
 const [tables,setTables]=useState<any[]>([]); const [selectedTable,setSelectedTable]=useState<any>(null); const [tableLoading,setTableLoading]=useState(false);
 const [tableQuery,setTableQuery]=useState(""); const [tableRefresh,setTableRefresh]=useState(0); const [dataTab,setDataTab]=useState<"overview"|"rows"|"schema">("overview"); const [rowMessage,setRowMessage]=useState(""); const [rowBusy,setRowBusy]=useState(false); const [rowDraft,setRowDraft]=useState<Record<string,string>>({}); const [editingRow,setEditingRow]=useState<any>(null); const [editDraft,setEditDraft]=useState<Record<string,string>>({});
  const editRow=async()=>{if(!selectedTable?.name||!editingRow)return;setRowBusy(true);try{const data:any={};editableColumns.forEach(c=>{const value=editDraft[c.name];if(value!==undefined){const type=String(c.type||"").toLowerCase();data[c.name]=type.includes("int")?Number(value):type.includes("bool")?value==="true":value}});const r=await fetch(`/api/projects/${project.id}/tables/${encodeURIComponent(selectedTable.name)}/rows/${editingRow.id}`,{method:"PATCH",headers:{Authorization:"Bearer "+getToken(),"Content-Type":"application/json"},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw new Error(d.message||"Gagal mengubah row");setEditingRow(null);setRowMessage(`Row #${editingRow.id} diubah`);setTableRefresh(v=>v+1)}catch(e:any){setRowMessage(e.message)}finally{setRowBusy(false)}};
  const editableColumns=useMemo(()=>((selectedTable?.columns||[]) as any[]).filter(c=>c.name!=="id"&&!String(c.name).endsWith("_at")),[selectedTable?.columns]);
  const addRow=async()=>{if(!selectedTable?.name)return;setRowMessage("");const data:any={};editableColumns.forEach(c=>{const value=rowDraft[c.name];if(value!==undefined&&value!==""){const type=String(c.type||"").toLowerCase();data[c.name]=type.includes("int")?Number(value):type.includes("bool")?value==="true":value}});if(!Object.keys(data).length){setRowMessage("Isi minimal satu kolom");return}setRowBusy(true);try{const r=await fetch(`/api/projects/${project.id}/tables/${encodeURIComponent(selectedTable.name)}/rows`,{method:"POST",headers:{Authorization:"Bearer "+getToken(),"Content-Type":"application/json"},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw new Error(d.message||"Gagal menambah row");setRowDraft({});setRowMessage(`Row #${d.id} ditambahkan`);setTableRefresh(v=>v+1)}catch(e:any){setRowMessage(e.message)}finally{setRowBusy(false)}};
  const deleteRow=async(id:any)=>{if(!selectedTable?.name||!window.confirm(`Hapus row #${id}?`))return;setRowBusy(true);try{const r=await fetch(`/api/projects/${project.id}/tables/${encodeURIComponent(selectedTable.name)}/rows/${encodeURIComponent(String(id))}`,{method:"DELETE",headers:{Authorization:"Bearer "+getToken()}});const d=await r.json();if(!r.ok)throw new Error(d.message||"Gagal menghapus row");setRowMessage(`Row #${id} dihapus`);setTableRefresh(v=>v+1)}catch(e:any){setRowMessage(e.message)}finally{setRowBusy(false)}}; const [previewRole,setPreviewRole]=useState("admin"); const [previewDevice,setPreviewDevice]=useState<"desktop"|"tablet"|"mobile">("desktop"); const [codeQuery,setCodeQuery]=useState(""); const [diffOnly,setDiffOnly]=useState(false);
 const filteredTables=useMemo(()=>tables.filter((t:any)=>String(typeof t==="string"?t:(t.name||t.tableName||t)).toLowerCase().includes(tableQuery.toLowerCase())),[tables,tableQuery]);
 const changedFileNames=useMemo(()=>tools.filter(t=>["apply_file","apply_files"].includes(t.tool)).flatMap(t=>{const s=String(t.input||"")+" "+String(t.output||"");return Object.keys(files).filter(p=>s.includes(p))}),[tools,files]);
 const codePaths=useMemo(()=>Object.keys(files).filter(p=>!codeQuery||p.toLowerCase().includes(codeQuery.toLowerCase())||String(files[p]).toLowerCase().includes(codeQuery.toLowerCase())).filter(p=>!diffOnly||changedFileNames.includes(p)),[files,codeQuery,diffOnly,changedFileNames]);
 const runRoleTest=(role:string)=>{setPreviewRole(role);setView("preview");setPreviewKey(k=>k+1);setMessages(m=>m.concat({role:"assistant",content:`Menjalankan preview sebagai role **${role}**. Periksa menu dan aksi yang terlihat, lalu gunakan chat jika ada akses yang salah.`}))};
 const [previewUrl,setPreviewUrl]=useState("");
 const [previewLoading,setPreviewLoading]=useState(false);
 const [previewReady,setPreviewReady]=useState(false);
 const [previewKey,setPreviewKey]=useState(0);
 const [previewStopping,setPreviewStopping]=useState(false);
 const [captureUrl,setCaptureUrl]=useState(""); const [captureBusy,setCaptureBusy]=useState(false);
 const [chatScreenshot,setChatScreenshot]=useState("");
 const screenshotRunRef=useRef<string>("");
 const [previewState,setPreviewState]=useState<"starting"|"ready"|"error"|"stopped">("stopped");
 // Kredit/kuota user
 const [quota,setQuota]=useState<any>(null);
 // Notifikasi floating "Preview siap"
 const [showPreviewPill,setShowPreviewPill]=useState(false);
 // Daftar path file yang diedit/dibuat sesi ini (untuk file viewer)
 const editedPaths=useMemo(()=>{const s=new Set<string>();tools.forEach(t=>{const src=((t as any).input||"")+" "+((t as any).output||"");const re=/(?:\/[\w\-\.\/]+\.(?:tsx|ts|jsx|js|css|py|html|json))/g;let m:RegExpExecArray|null;while((m=re.exec(src)))s.add(m[0])});return [...s]},[tools]);
 useEffect(()=>{fetch(`/api/projects/${project.id}/files`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>{const f=d.files||d.project?.files||{};setFiles(typeof f==="string"?JSON.parse(f):f)}).catch(()=>{});fetch(`/api/projects/${project.id}/tables` ,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>setTables(d.tables||[])).catch(()=>{});fetch(`/api/projects/${project.id}/chat`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>setMessages(d.messages||[])).catch(()=>{});
 // Ambil kuota kredit user
 fetch(`/api/usage`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>setQuota(d)).catch(()=>{});},[project.id]);
 useEffect(()=>{if(view!=="data")return;fetch(`/api/projects/${project.id}/tables`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>setTables(d.tables||[])).catch(()=>{});},[view,project.id,tableRefresh]);
 useEffect(()=>{if(view!=="data"||!selectedTable)return;let cancelled=false;setTableLoading(true);fetch(`/api/projects/${project.id}/tables/${encodeURIComponent(selectedTable?.name||"")}`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>{if(!cancelled)setSelectedTable((v:any)=>typeof v==="string"?{name:v,...d}:({...v,...d}))}).catch(()=>{}).finally(()=>{if(!cancelled)setTableLoading(false)});return()=>{cancelled=true}},[view,project.id,selectedTable?.name,tableRefresh]);
 useEffect(()=>{if(view!=="preview")return;let cancelled=false;setPreviewLoading(true);setPreviewReady(false);const h={Authorization:"Bearer "+getToken(),"Content-Type":"application/json"};(async()=>{try{await fetch(`/api/projects/${project.id}/runtime/dev/sync`,{method:"POST",headers:h});const r=await fetch(`/api/projects/${project.id}/runtime/dev/start`,{method:"POST",headers:h});const d=await r.json();if(!cancelled&&d.previewPath){const u=`${d.previewPath}?token=${encodeURIComponent(d.previewToken||"")}`;setPreviewUrl(u);setPreviewState("starting");let ready=false;for(let i=0;i<15&&!cancelled;i++){await new Promise(r=>setTimeout(r,1000));try{const sr=await fetch(`/api/projects/${project.id}/runtime/dev/status`,{headers:{Authorization:"Bearer "+getToken()}});const sd=await sr.json();if(sd.status==="ready"||sd.ready||sd.running){ready=true;break}}catch{}}if(!cancelled){setPreviewReady(ready);setPreviewState(ready?"ready":"error")}}}catch{if(!cancelled)setPreviewState("error")}finally{if(!cancelled)setPreviewLoading(false)}})();return()=>{cancelled=true}},[view,project.id,previewKey]);
 useEffect(()=>{const poll=()=>{if(skipRunPollRef.current)return;fetch(`/api/projects/${project.id}/agent/runs`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>{const run=d.runs?.[0];setPhase(run?.phase||"");setRunStatus(run?.status||"");setBusy(run?.status==="running"||run?.status==="queued");if(run?.id){setRunId(String(run.id));fetch(`/api/projects/${project.id}/agent/runs/${run.id}`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>setTools(d.tools||[])).catch(()=>{})}}).catch(()=>{})};poll();const id=window.setInterval(poll,1200);return()=>window.clearInterval(id)},[project.id]);
 // Setelah run selesai, ambil screenshot runtime nyata dan kirim sebagai artifact chat sekali per run.
 useEffect(()=>{if(runStatus!=="completed"||busy||!runId||screenshotRunRef.current===String(runId))return;screenshotRunRef.current=String(runId);let cancelled=false;(async()=>{try{const r=await fetch(`/api/projects/${project.id}/runtime/screenshot`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}});const d=await r.json();if(!cancelled&&r.ok&&d.path){setChatScreenshot(d.path);setMessages(m=>m.concat({role:"assistant",content:"Preview terbaru sudah siap.",artifact:{type:"screenshot",url:d.path}}))}}catch{} })();return()=>{cancelled=true}},[runStatus,busy,runId,project.id]);
 // P2.2: auto-fix otomatis saat run gagal (maks 3x), indikator status self-test
 useEffect(()=>{
   if(userStoppedRef.current)return;
   if(runStatus==="failed"&&!busy&&!autoFixing){
     if(autoFixCountRef.current<1){
       const n=autoFixCountRef.current+1;
       autoFixCountRef.current=n;
       setAutoFixing(true);
       setGiveUp(false);
       const remainingCredits=(quota?.tokensLimit||0)-(quota?.tokensUsed||0); if(quota&&remainingCredits<=0){setAutoFixing(false);setGiveUp(true);return} const t=window.setTimeout(()=>{send(recoveryPrompt(),true);},1600);
       return ()=>window.clearTimeout(t);
     }else{
       setAutoFixing(false);
       setGiveUp(true);
     }
   }
   if((runStatus==="completed"||runStatus==="success")&&!busy){
     if(autoFixing){
       setAutoFixing(false);
       if(autoFixCountRef.current>0){
         setShowAllGood(true);
         const t=window.setTimeout(()=>setShowAllGood(false),3000);
         return ()=>window.clearTimeout(t);
       }
     }
   }
 },[runStatus,busy]);
 // Antrian pesan: kirim otomatis pesan pertama saat agent selesai (bukan auto-fix, bukan stop manual)
 useEffect(()=>{
   if(!busy&&queue.length>0&&!autoFixing&&!userStoppedRef.current&&(runStatus==="completed"||runStatus==="success")){
     const [first,...rest]=queue;
     setQueue(rest);
     const t=window.setTimeout(()=>send(first),700);
     return ()=>window.clearTimeout(t);
   }
 },[busy,queue,runStatus,autoFixing]);
 // Refresh daftar file saat agent selesai bekerja (agar file viewer selalu fresh)
 useEffect(()=>{
   if(wasBusyRef.current&&!busy){
     fetch(`/api/projects/${project.id}/files`,{headers:{Authorization:"Bearer "+getToken()}}).then(r=>r.json()).then(d=>{const f=d.files||d.project?.files||{};setFiles(typeof f==="string"?JSON.parse(f):f)}).catch(()=>{});
   }
   wasBusyRef.current=busy;
 },[busy,project.id]);
 // Deploy: publish artifact build ke URL live. Sebelumnya tombol ini tidak
 // punya handler sama sekali (UI mati) padahal terlihat bisa diklik.
 const deploy=async()=>{
   if(deploying)return;
   setDeploying(true);
   try{
     const r=await fetch(`/api/projects/${project.id}/publish`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}});
     const d=await r.json().catch(()=>({}));
     if(!r.ok)throw new Error(d.message||d.error||`HTTP ${r.status}`);
     const url=window.location.origin+"/pub/"+(d.slug||project.slug);
     setMessages(m=>m.concat({role:"assistant",content:`**Situs live siap**\n\n${url}\n\nBuka dan uji alurnya di browser.`}));
     window.open(url,"_blank","noopener");
   }catch(e:any){
     setMessages(m=>m.concat({role:"assistant",content:"Deploy gagal: "+String(e?.message||e)}));
   }finally{setDeploying(false)}
 };
 const isConversational=(text:string)=>{const m=text.toLowerCase().trim();return /^(halo|hai|hi|hello|pagi|siang|sore|malam|terima kasih|makasih)[!.? ]*$/.test(m)};
 const stopRun=async()=>{userStoppedRef.current=true;try{if(runId)await fetch(`/api/projects/${project.id}/agent/runs/${runId}/cancel`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}})}catch{}try{await fetch(`/api/projects/${project.id}/runtime/dev/stop`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}})}catch{}setBusy(false);setRunStatus("stopped");setPhase("failed");setAutoFixing(false);setMessages(m=>m.concat({role:"assistant",content:"Proses dihentikan. Perubahan terakhir yang sudah tersimpan tetap aman."}))};
 const confirmDiscovery=()=>{setAnalysisPlan(discovery);setDiscovery(null);send("Gunakan rencana dan asumsi default tersebut. Mulai implementasi sekarang.",false,true)}; const approveBuild=()=>{if(discovery){setAnalysisPlan(discovery);setDiscovery(null)};setView("chat");send("Blueprint disetujui. Mulai implementasi dan verifikasi end-to-end sekarang.",false,true)}; const openAnalysis=()=>{setView("analyze");if(discovery)setAnalysisPlan(discovery)};
 const quizSubmit=(answers:string[])=>{const qs=clarification?.questions||[];const qa=qs.map((q:any,i:number)=>'- '+q.question+': '+(answers[i]||'(dilewati)'));setClarification(null);setQuizIdx(0);setQuizAnswers([]);send('Jawaban klarifikasi saya:'+qa.join('|')+'. Lanjutkan membangun sesuai jawaban di atas dengan penilaian terbaikmu.',false,true);};
 const quizAuto=()=>{setClarification(null);setQuizIdx(0);setQuizAnswers([]);send('Tidak perlu klarifikasi, lanjutkan dengan penilaian terbaikmu.',false,true);};
 const chooseClarification=(answer:string)=>{setClarification(null);send(`${answer}. Lanjutkan perubahan yang paling tepat dan verifikasi hasilnya.`,false,true)};
 const retryRun=()=>{if(busy)return;const remainingCredits=(quota?.tokensLimit||0)-(quota?.tokensUsed||0);if(quota&&remainingCredits<=0){setGiveUp(true);return}setRunStatus("");setPhase("");setGiveUp(false);setAutoFixing(false);setInput("");window.setTimeout(()=>send(recoveryPrompt(),false,true),80);};
 const send=async(overrideText?:string,isAutoFix=false,confirmed=false)=>{const text=(typeof overrideText==="string"?overrideText:input).trim();if(!text)return;
 const nowTs=Date.now();if(!isAutoFix&&lastSendRef.current.text===text&&nowTs-lastSendRef.current.ts<2500){return}lastSendRef.current={text,ts:nowTs};
 const conversational=isConversational(text);if(busy&&!isAutoFix){setQueue(q=>[...q,text]);setInput("");return}if(busy)return;userStoppedRef.current=false;if(conversational){skipRunPollRef.current=true;window.setTimeout(()=>{skipRunPollRef.current=false},2500)}if(!isAutoFix){autoFixCountRef.current=0;setGiveUp(false);setShowAllGood(false);}setInput("");setMessages(m=>m.concat({role:"user",content:text}));setBusy(!conversational);setRunStatus(conversational?"completed":"queued");try{const r=await fetch(`/api/projects/${project.id}/chat`,{method:"POST",headers:{Authorization:"Bearer "+getToken(),"Content-Type":"application/json"},body:JSON.stringify({message:text,mode:conversational?"greeting":"",context:{activeView:view,selectedFile:fileTab,previewState,previewErrors:[],queuedMessages:queue.length},confirm:confirmed||!!isAutoFix||!!discovery})});if(!r.ok)throw new Error("Permintaan ditolak server");const reader=r.body?.getReader();if(reader){const decoder=new TextDecoder();let partial="",streamed="";while(true){const part=await reader.read();if(part.done)break;partial+=decoder.decode(part.value,{stream:true});const events=partial.split("\n\n");partial=events.pop()||"";for(const event of events){const lines=event.split("\n");const eventName=(lines.find(v=>v.startsWith("event: "))||"event: message").slice(7);const line=lines.find(v=>v.startsWith("data: "));if(!line)continue;const raw=line.slice(6);if(raw==="[DONE]"){if(streamed){const cleaned=cleanAgentText(streamed);setMessages(m=>{const last=m[m.length-1];return last?.role==="assistant"?m.slice(0,-1).concat({...last,content:cleaned}):m})}continue;}let value:any;try{value=JSON.parse(raw)}catch{value=raw}if(eventName==="intent"){setLastIntent(value?.intent||"");continue}else if(eventName==="clarification"){setClarification(value);setQuizIdx(0);setQuizAnswers([]);setBusy(false);setRunStatus("waiting_for_confirmation");setPhase("clarification");setMessages(m=>m.concat({role:"assistant",content:value.summary||"Aku butuh sedikit arahan sebelum mengubah project."}));continue}else if(eventName==="discovery"){setDiscovery(value);setAnalysisPlan(value);setView("analyze");setBusy(false);setRunStatus("waiting_for_confirmation");setPhase("discovery");setMessages(m=>m.concat({role:"assistant",content:value.summary||"Saya sudah menyusun rencana implementasi. Buka Analyze untuk meninjau blueprint."}));continue}else if(eventName==="message"){const chunk=typeof value==="string"?value:(value.text||"");if(!chunk)continue;streamed+=chunk;const shown=streamed.trim()||"Sedang menyiapkan perubahan...";setMessages(m=>{const last=m[m.length-1];if(last?.role==="assistant")return m.slice(0,-1).concat({...last,content:shown});return m.concat({role:"assistant",content:shown})})}else if(eventName==="changes"&&value?.changed){/* changes are refreshed from backend after the run */}else if(eventName==="result"&&value?.summary){setMessages(m=>{const last=m[m.length-1];if(last?.role==="assistant")return m.slice(0,-1).concat({...last,content:value.summary});return m.concat({role:"assistant",content:value.summary})})}else if(eventName==="error"||raw.startsWith("[ERROR]"))throw new Error(typeof value==="string"?value:(value.message||"AI error"))}}}}catch(e:any){setBusy(false);setRunStatus("failed");setMessages(m=>m.concat({role:"assistant",content:"Permintaan belum dapat diproses: "+String(e?.message||"kesalahan tidak diketahui")}))}};
 // Auto-kirim initialPrompt dari landing (sekali saja, guard ref)
 const initialSentRef=useRef(false);
 useEffect(()=>{ if(initialPrompt&&!initialSentRef.current&&messages.length===0){ initialSentRef.current=true; const t=setTimeout(()=>send(initialPrompt),800); return ()=>clearTimeout(t); } },[initialPrompt]);
 // Notifikasi floating "Preview siap" — muncul saat run selesai & view bukan preview
 useEffect(()=>{
   if((runStatus==="completed"||runStatus==="success")&&!busy&&view!=="preview"){
     setShowPreviewPill(true);
     const t=setTimeout(()=>setShowPreviewPill(false),5000);
     return ()=>clearTimeout(t);
   }else{
     setShowPreviewPill(false);
   }
 },[runStatus,busy,view]);
 return <main className="r-builder"><header className="r-builder-top"><button onClick={onBack} aria-label="Kembali"><ArrowLeft size={16}/></button><Mark/><b>{project.name}</b><div/><span className={`r-status ${busy?"busy":""} ${gateClass}`}><i/>{busy?(phaseLabels[phase]||"Agent sedang bekerja..."):gateLabel}<small>{!busy&&gateLabel==="Draft"?"Belum build":!busy&&gateLabel==="Stale"?"Perlu publish ulang":""}</small></span><button className="r-deploy-button" onClick={deploy} disabled={deploying} title="Publish build ke URL live">{deploying?<LoaderCircle size={15}/>:<Rocket size={15}/>} {deploying?"Deploy...":"Deploy"}</button><button className="r-more-button" onClick={()=>setMenu(!menu)} aria-label="Buka menu project" aria-expanded={menu}><MoreHorizontal size={18}/></button>{menu&&<div className="r-project-menu"><div className="r-project-menu-grab"/><b>Project tools</b><button onClick={()=>{setView("chat");setMenu(false)}}><MessageSquare size={15}/> Chat</button><button onClick={()=>{openAnalysis();setMenu(false)}}><PanelRight size={15}/> Analyze</button><button onClick={()=>{setView("preview");setMenu(false)}}><Eye size={15}/> Preview</button><button onClick={()=>{setView("preview");setMenu(false);runRoleTest("admin")}}><Gauge size={15}/> Test role</button><button onClick={()=>{setView("code");setMenu(false)}}><Code2 size={15}/> Code <small>{Object.keys(files).length} files</small></button><button onClick={()=>{setView("data");setMenu(false)}}><Database size={15}/> Database <small>{tables.length} tables</small></button><button onClick={()=>{setHistoryOpen(true);setMenu(false)}}><History size={15}/> Riwayat versi</button></div>}</header>{historyOpen&&<VersionHistory projectId={project.id} currentFiles={files} onClose={()=>setHistoryOpen(false)} onRestored={(f:any)=>setFiles(f)}/>}<div className={`r-builder-body view-${view}`}><section className="r-chat"><div className={busy?"r-run-banner running":"r-run-banner"}><span className="r-run-dot"/><div><b>{busy?(phaseLabels[phase]||"Sedang membangun..."):(runStatus==="failed"?"Build gagal":runStatus==="completed"?"Build selesai":"Siap menerima instruksi")}</b><small>{busy?"Perubahan sedang diproses":"Kamu bisa mengirim instruksi baru"}</small></div></div><div className="r-messages">{messages.length===0&&!busy&&<div className="r-empty-prompts"><b>Mulai dengan contoh:</b><div className="r-prompt-chips">{["Buatkan aplikasi kasir (POS) dengan login, produk, transaksi, dan laporan","Buatkan toko online dengan keranjang belanja dan checkout","Buatkan dashboard admin dengan data pengguna dan statistik","Buatkan aplikasi booking jadwal dengan kalender"].map(t=><button key={t} onClick={()=>send(t)}>{t}</button>)}</div></div>}{messages.map((m,i)=><div className={m.role==="user"?"r-msg user":"r-msg"} key={i}><small>{m.role==="user"?"YOU":"AGENT"}</small>{m.role==="assistant"?<><div className="r-natural-answer"><RichText text={cleanAgentText(m.content)}/></div>{m.artifact?.type==="screenshot"&&<div className="r-chat-artifact"><img src={m.artifact.url} alt="Preview terbaru project"/><a href={m.artifact.url} target="_blank" rel="noreferrer">Buka preview terbaru</a></div>}</>:<p>{m.content}</p>}</div>)}{tools.length>0&&<section className={`r-activity-panel ${busy?"is-running":""}`}><div className="r-activity-head"><div><b>{busy?"Building the app":"Aktivitas build"}</b><small>{busy?"Perintah dan verifikasi berjalan di server":`${tools.filter((t:any)=>t.status==="completed"||t.status==="success").length} aktivitas selesai`}</small></div><span className="r-activity-state">{busy?<><i className="r-mini-spinner"/> Thinking…</>:runStatus==="failed"?"Needs attention":"Completed"}</span></div><div className="r-activity-list">{tools.map((tool:any,i:number)=>activityCard(tool,selectedTool===String(i),()=>setSelectedTool(selectedTool===String(i)?null:String(i)),{files,paths:editedPaths,fileTab,setFileTab}))}</div></section>}{busy&&tools.length>0&&<div className="r-live-work"><span className="r-mini-spinner"/><span>{toolTitle(tools[tools.length-1]?.tool||"ai_stream")}</span>{tools[tools.length-1]?.input&&<small>{cleanAgentText(String(tools[tools.length-1].input)).slice(0,120)}</small>}</div>}{/* P2.2: indikator self-test */}
{busy&&phase==="acceptance_check"&&<div className="r-selftest-banner"><span className="r-mini-spinner"/><div><b>AI mengetes hasil...</b><small>Memeriksa aplikasi sebelum diserahkan</small></div></div>}
{/* P2.2: indikator auto-fix berjalan */}
{autoFixing&&<div className="r-autofix-banner"><span className="r-mini-spinner"/><div><b>AI mencoba sekali lagi otomatis ({autoFixCountRef.current}/1)...</b><small>Mencoba perbaiki tanpa perlu campur tanganmu</small></div></div>}
{/* P2.2: sukses setelah auto-fix */}
{showAllGood&&!busy&&<div className="r-allgood-banner"><b>Semua beres!</b><small>Error berhasil diperbaiki otomatis</small></div>}
{/* P2.2: menyerah setelah 2x, minta intervensi manual */}
{giveUp&&!busy&&runStatus==="failed"&&<div className="r-giveup-banner"><b>Masih ada error</b><small>Coba jelaskan masalahnya secara manual agar AI bisa bantu lebih tepat.</small></div>}
{clarification&&!busy&&(clarification.questions&&clarification.questions.length?<QuizWizard clarification={clarification} quizIdx={quizIdx} setQuizIdx={setQuizIdx} quizAnswers={quizAnswers} setQuizAnswers={setQuizAnswers} onDone={quizSubmit} onAuto={quizAuto} onClose={()=>setClarification(null)}/>:<div className="r-discovery-card"><div><b>Perjelas fokus perubahan</b><p>{clarification.question}</p></div><div className="r-discovery-actions">{(clarification.options||[]).map((o:string)=><button key={o} onClick={()=>chooseClarification(o)}>{o}</button>)}</div></div>)}{discovery&&!busy&&<div className="r-discovery-card"><div><b>Rencana sebelum membangun</b><p>{discovery.summary}</p>{discovery.architectureProfile&&<div className="r-blueprint-meta"><b>Arsitektur: {discovery.architectureProfile}</b><span>Folder: {discovery.folderStrategy}</span></div>}</div>{discovery.modules?.length>0&&<div className="r-blueprint-section"><b>Modul</b><div className="r-blueprint-chips">{discovery.modules.map((x:string)=><span key={x}>{x}</span>)}</div></div>}{discovery.entities?.length>0&&<div className="r-blueprint-section"><b>Entity database</b><div className="r-blueprint-chips">{discovery.entities.map((x:string)=><span key={x}>{x}</span>)}</div></div>}<ul>{(discovery.assumptions||[]).map((a:string)=><li key={a}>{a}</li>)}</ul><ol>{(discovery.steps||[]).map((s:string)=><li key={s}>{s}</li>)}</ol><div className="r-discovery-actions"><button onClick={confirmDiscovery}>Mulai dengan asumsi ini</button><button onClick={()=>{setInput("Ubah rencana: ");document.querySelector("textarea")?.focus()}}>Ubah rencana</button></div></div>}{runStatus==="failed"&&!busy&&!giveUp&&<div className="r-failure-card"><b>Proses belum selesai{phase?` (${phaseLabels[phase]||phase})`:""}</b><span>Agent berhenti sebelum semua pemeriksaan selesai. Perubahan yang sudah tersimpan tetap aman.</span><div className="r-failure-diagnostic">{projectGate.buildError&&<pre>{projectGate.buildError}</pre>}</div><div><button onClick={retryRun}>Coba lagi</button><button onClick={()=>{setView("code");setOpen(true)}}>Lihat kode & aktivitas</button></div></div>}{runStatus==="completed"&&tools.length>0&&buildResultCard(tools,setView)}{(busy||tools.length>0)&&<div className={`r-agent-timeline ${busy?"active":"complete"}`}><button className="r-agent-now" onClick={()=>setOpen(!open)}><span className={busy?"r-spinner":"r-result-check"}>{busy?"":"✓"}</span><b>{busy?(phaseLabels[phase]||"Agent sedang bekerja..."):"Aktivitas selesai"}</b><span>{open?"Sembunyikan":"Lihat aktivitas"}</span></button>{open&&<div className="r-agent-steps">{agentSteps.map((s,i)=><div className={s.id===phase?"r-agent-step active":"r-agent-step"} key={s.id}><span>{s.id===phase?"●":i+1}</span><b>{s.label}</b></div>)}</div>}{tools.length>0&&<div className="r-agent-activities">{tools.slice(-8).map((tool,i)=>{const key=tool.id||String(i);return <div key={key}>{activityCard(tool,selectedTool===key,()=>setSelectedTool(selectedTool===key?null:key),{files,paths:editedPaths,fileTab,setFileTab})}</div>})}</div>}</div>}</div>{/* Credit bar di atas composer */}
{!busy&&messages.length>0&&runStatus!=="failed"&&<div className="r-followups">{(lastIntent==="greeting"?["Mulai project baru","Perbaiki error","Lihat Preview"]:runStatus==="completed"?["Buat responsive mobile","Tambahkan mode gelap","Tambahkan data contoh"]:lastIntent==="debug"?["Perbaiki otomatis","Lihat detail error","Jalankan ulang test"]:followUps).map(s=><button key={s} onClick={()=>send(s)}>{s}</button>)}</div>}{quota&&<div className="r-credit-bar">
  {(quota.tokensLimit-(quota.tokensUsed||0))<=0
    ?<><span className="r-credit-empty">✦ Kredit habis</span><button className="r-credit-upgrade" onClick={()=>window.location.href="/#pricing"}>⊕ Tingkatkan</button></>
    :<><span className="r-credit-info">✦ Kredit tersisa: {((quota.tokensLimit||0)-(quota.tokensUsed||0)).toLocaleString("id-ID")}</span><small>{quota.plan||"free"}</small></>}
</div>}<div className={`r-composer ${busy?"is-busy":""}`}>{busy&&<div className="r-agent-running-pill"><span className="r-green-dot"/><b>Agen berjalan...</b></div>}{queue.length>0&&<div className="r-queue-chip"><span>{queue.length} pesan dalam antrian</span><button onClick={()=>setQueue([])}>Batalkan</button></div>}{busy?<div className="r-composer-row"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder="Antri pesan Anda..." aria-label="Antri pesan"/><button className="r-stop-btn" onClick={stopRun} aria-label="Hentikan proses" title="Hentikan"><Square size={15}/></button></div>:<><div className="r-composer-state"><span className="r-composer-dot"/><span>{runStatus==="failed"?"Butuh perhatian":"Siap menerima instruksi"}</span>{runStatus==="failed"&&<button className="r-retry-inline" onClick={retryRun}>Coba lagi</button>}</div><div className="r-composer-row"><textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={quota&&(quota.tokensLimit-(quota.tokensUsed||0))<=0?"Kredit habis — tingkatkan paket untuk lanjut":"Apa yang ingin kamu bangun?"}/><button className="r-send-button" onClick={() => send()} disabled={!input.trim()||(quota&&(quota.tokensLimit-(quota.tokensUsed||0))<=0)} aria-label="Kirim pesan" title={quota&&(quota.tokensLimit-(quota.tokensUsed||0))<=0?"Kredit habis":"Kirim pesan"}><Send size={17}/></button></div></>}</div></section><section className="r-workspace">{view==="analyze"&&<AnalysisPanel project={project} discovery={analysisPlan||discovery} onBuild={approveBuild}/>} {view==="preview"&&<div className="r-preview-panel"><div className="r-role-toolbar"><b>Preview & test role</b><div>{["admin","kasir","user"].map(role=><button key={role} className={previewRole===role?"active":""} onClick={()=>runRoleTest(role)}>{role}</button>)}</div><small>Role aktif: {previewRole}</small><div className="r-device-toggle"><button className={previewDevice==="desktop"?"active":""} onClick={()=>setPreviewDevice("desktop")}>Desktop</button><button className={previewDevice==="tablet"?"active":""} onClick={()=>setPreviewDevice("tablet")}>Tablet</button><button className={previewDevice==="mobile"?"active":""} onClick={()=>setPreviewDevice("mobile")}>Mobile</button></div><span className="r-env-badge">ENV aktif: .env.local · runtime preview</span></div><div className="r-preview-toolbar"><button className="r-capture-button" disabled={captureBusy||!previewReady} onClick={async()=>{setCaptureBusy(true);try{const r=await fetch(`/api/projects/${project.id}/runtime/screenshot`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}});const d=await r.json();if(r.ok&&d.path)setCaptureUrl(d.path)}finally{setCaptureBusy(false)}}}><Camera size={16}/> {captureBusy?"Membuat screenshot...":"Ambil screenshot nyata"} <ChevronRight size={16}/></button>{captureUrl&&<a className="r-capture-download" href={captureUrl} target="_blank" rel="noreferrer" download="preview.png"><Download size={14}/> Download PNG</a>}<div className="r-preview-actions"><button onClick={()=>setPreviewKey(k=>k+1)} aria-label="Refresh preview"><LoaderCircle size={14}/> Refresh</button><button onClick={()=>{const el=document.querySelector(".r-shot iframe") as HTMLIFrameElement|null;el?.requestFullscreen?.()}} disabled={!previewUrl}><Eye size={14}/> Fullscreen</button><button className="danger" onClick={async()=>{setPreviewStopping(true);try{await fetch(`/api/projects/${project.id}/runtime/dev/stop`,{method:"POST",headers:{Authorization:"Bearer "+getToken()}});setPreviewUrl("");setPreviewReady(false);setPreviewState("stopped")}finally{setPreviewStopping(false)}}} disabled={!previewUrl||previewStopping}><Square size={13}/> {previewStopping?"Stopping…":"Stop"}</button></div></div><div className="r-screenshot-card"><h3>Cuplikan layar</h3>{previewLoading?<div className="r-preview-loading"><LoaderCircle className="r-spin" size={24}/><span>Menyiapkan link website sementara...</span></div>:previewUrl?<div className="r-live-link-card"><div className="r-live-link-icon"><Globe size={22}/></div><div className="r-live-link-copy"><b>Website sementara siap</b><small>Buka hasil project langsung di tab baru</small><code>{window.location.origin}{previewUrl}</code></div><a className="r-live-link-button" href={previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={15}/> Buka website</a></div>:<div className="r-preview-empty"><Eye size={28}/><h3>Website sementara belum siap</h3><p>Jalankan build project untuk mendapatkan link preview.</p></div>}<div className={`r-preview-ready ${previewState}`}><Eye size={15}/><b>{previewState==="error"?"Preview belum merespons":previewReady?"Website sementara siap":"Menunggu preview"}</b></div></div></div>}{view==="code"&&<div className="r-inspector r-code-inspector"><h3><Code2 size={17}/> Project files <small>{codePaths.length}/{Object.keys(files).length} files</small></h3><div className="r-inspector-tools"><input value={codeQuery} onChange={e=>setCodeQuery(e.target.value)} placeholder="Cari file atau isi kode..."/><button className={diffOnly?"active":""} onClick={()=>setDiffOnly(!diffOnly)}>Perubahan agent</button></div>{Object.keys(files).length===0?<p>Belum ada file project.</p>:<div className="r-code-layout"><FileTree paths={codePaths} active={fileTab} onSelect={setFileTab}/><div className="r-code-selected">{fileTab&&files[fileTab]!==undefined?<><div className="r-filepath">{fileTab}</div><CodeView code={files[fileTab]}/></>:<p>Pilih file dari struktur project.</p>}</div></div>}</div>}{view==="data"&&<div className="r-inspector r-database-inspector"><div className="r-database-head"><div><h3><Database size={17}/> Database</h3><p>PostgreSQL project workspace · {tables.length} tabel</p></div><button onClick={()=>setTableRefresh(v=>v+1)}>↻ Refresh</button></div><div className="r-database-tabs"><button className={dataTab==="overview"?"active":""} onClick={()=>setDataTab("overview")}>Overview</button><button className={dataTab==="rows"?"active":""} onClick={()=>setDataTab("rows")} disabled={!selectedTable}>Rows</button><button className={dataTab==="schema"?"active":""} onClick={()=>setDataTab("schema")} disabled={!selectedTable}>Schema</button></div>{tables.length===0?<p>Belum ada tabel database.</p>:<div className="r-data-layout"><div className="r-table-list"><div className="r-table-tools"><input value={tableQuery} onChange={e=>setTableQuery(e.target.value)} placeholder="Cari tabel..."/><button onClick={()=>setTableRefresh(v=>v+1)} title="Refresh tabel">↻</button></div>{filteredTables.map((t:any)=>{const name=typeof t==="string"?t:(t.name||t.tableName);return <button key={name} className={selectedTable?.name===name?"active":""} onClick={()=>setSelectedTable({name})}>{name}<ChevronRight size={14}/></button>})}</div>{selectedTable?<div className="r-table-detail"><div className="r-table-title"><b>{selectedTable.name}</b><span>{tableLoading?"Memuat...":`${selectedTable.rowCount||0} row`}</span></div>{rowMessage&&<div className="r-row-message">{rowMessage}</div>}<div className="r-row-create">{editableColumns.length?editableColumns.map(c=><label key={c.name}><span>{c.name}<small>{c.type}</small></span><input value={rowDraft[c.name]||""} onChange={e=>setRowDraft(v=>({...v,[c.name]:e.target.value}))} placeholder={c.nullable?"Opsional":"Wajib"} type={String(c.type||"").toLowerCase().includes("int")?"number":"text"}/></label>):<small>Tidak ada kolom input yang bisa diisi.</small>}<button onClick={addRow} disabled={rowBusy}>+ Tambah row</button></div><div className="r-columns">{(selectedTable.columns||[]).map((c:any)=><span key={c.name}><b>{c.name}</b><small>{c.type}{c.nullable?" · nullable":""}</small></span>)}</div>{(selectedTable.rows||[]).length?<div className="r-rows">{selectedTable.rows.slice(0,20).map((row:any,i:number)=><div className="r-row-card" key={i}><pre>{JSON.stringify(row,null,2)}</pre><div><button onClick={()=>{setEditingRow(row);setEditDraft(Object.fromEntries(editableColumns.map(c=>[c.name,row[c.name]===null?"":String(row[c.name]??"")])))}}>Edit</button><button className="danger" onClick={()=>deleteRow(row.id)}>Hapus</button></div></div>)}</div>:<p>Belum ada data pada tabel ini.</p>}{editingRow&&<div className="r-row-edit"><b>Edit row #{editingRow.id}</b>{editableColumns.map(c=><label key={c.name}><span>{c.name}</span><input value={editDraft[c.name]||""} onChange={e=>setEditDraft(v=>({...v,[c.name]:e.target.value}))}/></label>)}<div><button onClick={editRow} disabled={rowBusy}>Simpan</button><button onClick={()=>setEditingRow(null)}>Batal</button></div></div>}</div>:<p className="r-data-placeholder">Pilih tabel untuk melihat schema dan data.</p>}</div>}</div>}{view==="chat"&&<div className="r-preview-empty"><MessageSquare size={28}/><h3>Chat with your agent</h3><p>Pilih Preview, Code, atau Database dari menu project.</p></div>}</section></div>{/* Hapus bottom nav — navigasi via menu project di header */}
{showPreviewPill&&<button className="r-preview-pill" onClick={()=>{setView("preview");setShowPreviewPill(false)}}><Eye size={16}/> Pratinjau Anda sudah siap</button>}</main>;
}

