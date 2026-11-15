package handler

import "strings"

// ── Visual editor klik-elemen: bridge preview ──
//
// Bridge yang sama dipakai di dua preview (logika ini WAJIB dijaga
// selaras dengan skrip bridge di web/src/pages/Builder.tsx untuk
// preview Sandpack):
//   - meneruskan console error ke parent sebagai "wb-error" (dipakai
//     loop self-test/auto-fix yang sudah ada),
//   - dalam mode pilih, klik elemen mengirim "wb-select" ke parent
//     dengan tag/id/class/teks/src/gaya terhitung,
//   - mode pilih dihidupkan/dimatikan dari parent lewat postMessage
//     {type:"wb-set-select", enabled} — proxy preview tidak tahu mode
//     pilih, jadi bridge mulai dalam keadaan mati.
//
// Disuntikkan server-side oleh runtimeDevPreview ke setiap respons
// HTML preview Live Runtime (lihat runtime.go). TIDAK ditulis ke file
// proyek: preview tetap menampilkan kode asli pengguna, dan build
// production tidak mengandung bridge ini.

const previewBridgeScript = `(function(){
  function wbErr(m){ try{ window.parent.postMessage({type:"wb-error",msg:String(m).slice(0,300)},"*"); }catch(e){} }
  window.addEventListener("error",function(e){ if(e.message) wbErr(e.message); });
  window.addEventListener("unhandledrejection",function(e){ var r=e.reason; wbErr("Unhandled rejection: "+(r&&r.message||r)); });
  var _ce=console.error;
  console.error=function(){ try{ wbErr(Array.prototype.map.call(arguments,function(a){ return String(a); }).join(" ")); }catch(e){} return _ce.apply(console,arguments); };
  var selectOn=false;
  function setSelect(on){
    selectOn=!!on;
    var st=document.getElementById("wb-select-style");
    if(selectOn && !st){
      st=document.createElement("style");
      st.id="wb-select-style";
      st.textContent="*:hover{outline:2px solid #F6821F !important;outline-offset:2px;cursor:crosshair !important;}";
      document.head.appendChild(st);
    } else if(!selectOn && st){ st.remove(); }
  }
  window.addEventListener("message",function(e){
    var d=e.data||{};
    if(d && d.type==="wb-set-select"){ setSelect(d.enabled); }
  });
  document.addEventListener("click",function(e){
    if(!selectOn) return;
    e.preventDefault(); e.stopPropagation();
    var t=e.target||{};
    var cls=t.className;
    if(cls&&typeof cls!=="string"){ cls=""; }
    var cs=null; try{ cs=window.getComputedStyle(t); }catch(e2){}
    var src="";
    try{ src=(t.getAttribute && t.getAttribute("src")) || t.src || ""; }catch(e3){}
    try{ window.parent.postMessage({type:"wb-select",tag:t.tagName||"?",id:t.id||"",cls:String(cls||""),text:(t.innerText||"").trim().slice(0,120),src:src,alt:t.alt||"",color:cs?cs.color:"",fontSize:cs?cs.fontSize:"",backgroundColor:cs?cs.backgroundColor:""},"*"); }catch(e4){}
  },true);
  if(window.WB_SELECT_MODE){ setSelect(true); }
})();`

const previewBridgeMarker = "wb-visual-editor-bridge"

// shouldInjectPreviewBridge: hanya respons HTML yang diberi bridge.
func shouldInjectPreviewBridge(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/html")
}

// injectPreviewBridge menyisipkan skrip bridge sebelum </body> terakhir
// (atau di akhir dokumen bila tidak ada </body>). Idempotent: bila
// penanda bridge sudah ada, HTML dikembalikan apa adanya.
func injectPreviewBridge(html string) string {
	if strings.Contains(html, previewBridgeMarker) {
		return html
	}
	script := "<script>\n/* " + previewBridgeMarker + " */\n" + previewBridgeScript + "\n</script>"
	if idx := strings.LastIndex(strings.ToLower(html), "</body>"); idx >= 0 {
		return html[:idx] + script + "\n" + html[idx:]
	}
	return html + "\n" + script
}
