/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
  enableQuaggaFallback: true,

  cloud: {
    oneDrive: {
      enabled: true,
      clientId: "85cac966-79c1-e43c-00ab-8251cf2ebcf1", // <-- VEREIST
      scopes: ["Files.ReadWrite"]
    },
    gDrive: {
      enabled: true,
      apiKey: "VUL_JOUW_GOOGLE_API_KEY_HIER_IN", // <-- VEREIST
      clientId: "VUL_JOUW_GOOGLE_OAUTH_CLIENT_ID_HIER_IN.apps.googleusercontent.com" // <-- VEREIST
    }
  },

  // OCR via CDN (tesseract.js v5) — online direct bruikbaar
  ocr: { enabled: true }
};

/****************************************************
 * ELEMENTS
 ****************************************************/
const video = document.getElementById("camera");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const toast = document.getElementById("toast");
const statusLight = document.getElementById("statusLight");
const tableBody = document.querySelector("#results tbody");
const scanCountEl = document.getElementById("scanCount");

const startBtn = document.getElementById("startScan");
const resetBtn = document.getElementById("resetBtn");
const flashToggleBtn = document.getElementById("flashToggle");
const downloadBtn = document.getElementById("downloadBtn");
const downloadExcelBtn = document.getElementById("downloadExcelBtn");
const uploadODBtn = document.getElementById("uploadOneDrive");
const uploadGDBtn = document.getElementById("uploadGDrive");
const playerNameEl = document.getElementById("playerName");

/****************************************************
 * STATE
 ****************************************************/
let stream, track, detector, useBarcodeDetector = false;
let lastBox = null;
let lastScanAt = 0;
let torchOn = false;
const dedupSet = new Set(); // MAC#Serial
let scanData = [];

/****************************************************
 * PERSISTENTIE
 ****************************************************/
function saveData(){ try{ localStorage.setItem("ricoh_scan_data_v4", JSON.stringify(scanData)); }catch{} }
function loadData(){
  try {
    const stored = localStorage.getItem("ricoh_scan_data_v4");
    if (stored) {
      scanData = JSON.parse(stored);
      scanData.forEach(r => { appendRow(r.time,r.player,r.mac,r.serial); dedupSet.add(`${r.mac}#${r.serial}`); });
      updateScanCount();
    }
  } catch {}
}

/****************************************************
 * UTILS
 ****************************************************/
function beep(freq=880, dur=140, vol=0.15){
  try{
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value=freq; g.gain.value=vol; o.connect(g); g.connect(ac.destination);
    o.start(); setTimeout(()=>{o.stop(); ac.close();}, dur);
  }catch{}
}
function showToast(msg){ toast.textContent = msg; toast.classList.add("show"); setTimeout(()=>toast.classList.remove("show"), 900); }
function updateScanCount(){ scanCountEl.textContent = scanData.length; }

/****************************************************
 * OVERLAY
 ****************************************************/
function drawOverlay(){
  const w = overlay.width = video.clientWidth;
  const h = overlay.height = video.clientHeight;
  ctx.clearRect(0,0,w,h);

  const elapsed = Date.now()-lastScanAt;
  if(!lastBox || elapsed>1200){
    ctx.strokeStyle="rgba(229,57,53,0.9)"; ctx.lineWidth=3; const pad=20;
    ctx.strokeRect(pad,pad,w-2*pad,h-2*pad);
    ctx.beginPath(); ctx.moveTo(w/2-30,h/2); ctx.lineTo(w/2+30,h/2);
    ctx.moveTo(w/2,h/2-30); ctx.lineTo(w/2,h/2+30); ctx.stroke();
    return;
  }
  ctx.strokeStyle="rgba(25,169,116,0.95)"; ctx.lineWidth=4;
  if(lastBox.type==="rect"){ const {x,y,width,height}=lastBox.rect; ctx.strokeRect(x,y,width,height); }
  else if(lastBox.type==="poly"){ const pts=lastBox.points; ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]); for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]); ctx.closePath(); ctx.stroke(); }
  ctx.fillStyle="rgba(25,169,116,0.95)"; ctx.font="bold 18px Arial"; ctx.fillText("Gescand",16,30);
}

/****************************************************
 * MAC & SERIAL EXTRACTIE
 ****************************************************/
function toColonMac(hex12){ return hex12.match(/.{1,2}/g).join(":").toUpperCase(); }
function normalizeMacFlexible(raw){
  if(!raw) return null; raw=String(raw);
  let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/); if(c) return toColonMac(c[0].replace(/\./g,""));
  let h = raw.match(/\b[0-9A-Fa-f]{12}\b/); if(h) return toColonMac(h[0]);
  let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/); if(d) return d[0].replace(/-/g,":").toUpperCase();
  return null;
}
function extractMac(raw){
  raw=String(raw);
  const candidates=[raw, raw.replace(/mac\s*[:=]/i,""), raw.replace(/WFM\s*[:=]/i,"")];
  for(const c of candidates){ const mac=normalizeMacFlexible(c); if(mac) return mac; }
  return null;
}
function extractSerial(raw, mac){
  raw=String(raw);
  try { const obj=JSON.parse(raw); for(const k of ["serial","serienummer","sn","s/n"]) if(obj[k]) return String(obj[k]).trim(); } catch {}
  let lbl = raw.match(/(?:S\/?N|Serial|Serienummer)\s*[:=#]?\s*([A-Za-z0-9\-]+)/i); if(lbl) return lbl[1].trim();
  const parts = raw.split(/[;,\|]/).map(s=>s.trim()).filter(Boolean);
  if(parts.length>=2){ const other=parts.find(p=>!normalizeMacFlexible(p)); if(other) return other; }
  const tokens = raw.replace(/[^\w\-]/g," ").split(/\s+/).filter(Boolean);
  const nonMac = tokens.filter(t=>!normalizeMacFlexible(t)&&/^[A-Za-z0-9\-]{8,20}$/.test(t));
  if(nonMac.length) return nonMac.sort((a,b)=>b.length-a.length)[0];
  return "";
}

// OCR uit tekst
function extractMacFromText(text){
  if(!text) return null;
  let wfm = text.match(/WFM\s*[:\s]*([0-9A-Fa-f]{12})/i); if(wfm) return toColonMac(wfm[1]);
  let macA = text.match(/MAC\s*[:\s]*([0-9A-Fa-f:\-]{12,17})/i); if(macA) return normalizeMacFlexible(macA[1]);
  let gen = normalizeMacFlexible(text); if(gen) return gen;
  return null;
}
function extractSerialFromText(text){
  if(!text) return "";
  let sn = text.match(/S\/?N\s*[:\s]*([A-Za-z0-9\-]+)/i); if(sn) return sn[1];
  let lbl = text.match(/(?:Serial|Serienummer)\s*[:\s]*([A-Za-z0-9\-]+)/i); if(lbl) return lbl[1];
  const tokens = text.replace(/[^\w\-]/g," ").split(/\s+/).filter(Boolean);
  const cands = tokens.filter(t => !/^WFM$/i.test(t) && !normalizeMacFlexible(t) && /^[A-Za-z0-9\-]{8,20}$/.test(t));
  if(cands.length) return cands.sort((a,b)=>b.length-a.length)[0];
  return "";
}

/****************************************************
 * TABEL
 ****************************************************/
function appendRow(time, player, mac, serial){
  const tr=document.createElement("tr");
  tr.innerHTML = `<td>${time}</td><td>${player}</td><td>${mac}</td><td>${serial}</td>`;
  tableBody.appendChild(tr);
}

/****************************************************
 * OCR
 ****************************************************/
async function ocrScanVideoFrame(){
  if(!CONFIG.ocr.enabled || !window.Tesseract) return "";
  if(!video.videoWidth || !video.videoHeight) return "";

  const canvas=document.createElement("canvas");
  canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  const c=canvas.getContext("2d"); c.drawImage(video,0,0);

  try{
    const { data:{ text } } = await Tesseract.recognize(canvas, "eng"); // CDN: laadt automatisch de eng traineddata
    return text || "";
  }catch(e){
    console.error("OCR failed", e);
    return "";
  }
}

/****************************************************
 * PROCESS SCAN (barcode + OCR)
 ****************************************************/
async function processScan(raw){
  const cleaned=String(raw).trim();
  const player = playerNameEl?.value?.trim() || "";
  const timestamp = new Date().toLocaleString();

  // 1) Barcode
  let mac = extractMac(cleaned);
  let serial = extractSerial(cleaned, mac);

  // 2) OCR indien nodig
  if(!mac || !serial){
    const text = await ocrScanVideoFrame();
    if(text){
      if(!mac){ const m=extractMacFromText(text); if(m) mac=m; }
      if(!serial){ const s=extractSerialFromText(text); if(s) serial=s; }
    }
  }

  if(!mac){
    statusLight.className="status red"; showToast("Geen MAC gevonden"); beep(240,140,0.2);
    return;
  }

  const key = `${mac}#${serial}`;
  if(dedupSet.has(key)) return;
  dedupSet.add(key);

  scanData.push({ raw: cleaned, time: timestamp, player, mac, serial });
  saveData();
  appendRow(timestamp, player, mac, serial);
  updateScanCount();

  statusLight.className="status green"; showToast("Gescand"); beep(880,140,0.18);
  lastScanAt = Date.now();
}

/****************************************************
 * SCANNEN
 ****************************************************/
async function startScan(){
  startBtn.disabled = true;
  statusLight.className="status red";

  // Camera stream (HTTPS vereist)
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream; await video.play();
  const tracks = stream.getVideoTracks(); track = tracks && tracks[0];

  // BarcodeDetector check
  if("BarcodeDetector" in window){
    try {
      detector = new BarcodeDetector({
        formats: ["qr_code","code_128","code_39","ean_13","ean_8","upc_a","itf","pdf417","data_matrix"]
      });
      useBarcodeDetector = true;
    } catch { useBarcodeDetector = false; }
  }

  (function loop(){ drawOverlay(); requestAnimationFrame(loop); })();

  if(useBarcodeDetector) scanLoopDetector();
  else startQuagga();
}

async function scanLoopDetector(){
  try{
    const found = await detector.detect(video);
    if(found && found.length){
      for(const bc of found){
        if(bc.boundingBox){ const r=bc.boundingBox; lastBox={ type:"rect", rect:{x:r.x,y:r.y,width:r.width,height:r.height} }; }
        processScan(bc.rawValue);
      }
    }
  }catch{}
  requestAnimationFrame(scanLoopDetector);
}

function startQuagga(){
  if(typeof Quagga==="undefined"){ console.warn("Quagga niet geladen"); return; }
  Quagga.init({
    inputStream:{ type:"LiveStream", target: video, constraints:{ facingMode:"environment" } },
    decoder:{ readers:["code_128_reader","code_39_reader","ean_reader","ean_8_reader","upc_reader","i2of5_reader"] },
    locate:true
  }, err => {
    if(err){ console.error(err); startBtn.disabled=false; return; }
    Quagga.start();
  });

  Quagga.onDetected(res => {
    if(res?.codeResult?.code){
      processScan(res.codeResult.code);
      if(res.box && Array.isArray(res.box)){
        lastBox = { type:"poly", points: res.box.map(p=>[p[0],p[1]]) };
        lastScanAt = Date.now();
      }
    }
  });
}

/****************************************************
 * TORCH
 ****************************************************/
async function toggleTorch(){
  if(!track?.getCapabilities){ alert("Zaklamp niet beschikbaar"); return; }
  const caps = track.getCapabilities();
  if(!caps.torch){ alert("Zaklamp niet beschikbaar"); return; }
  try{
    torchOn = !torchOn;
    await track.applyConstraints({ advanced:[{ torch: torchOn }] });
    flashToggleBtn.textContent = `Zaklamp: ${torchOn ? "aan" : "uit"}`;
  }catch{ alert("Kon zaklamp niet schakelen"); }
}

/****************************************************
 * EXPORT: CSV & EXCEL
 ****************************************************/
function buildCSV(){
  const header="Tijd,Speler,MAC-adres,Serienummer";
  const rows = scanData.map(r => [r.time,r.player,r.mac,r.serial].map(v=>`"${String(v).replace(/\"/g,'\"\"')}"`).join(","));
  return header+"\n"+rows.join("\n");
}
function downloadCSV(){
  if(scanData.length===0){ showToast("Geen data"); return; }
  const blob = new Blob(["\uFEFF"+buildCSV()], {type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="scanresultaten.csv"; a.click();
}
function downloadExcel(){
  if(scanData.length===0){ showToast("Geen data"); return; }
  if(typeof XLSX==="undefined"){ alert("Excel library ontbreekt"); return; }
  const wsData=[["Tijd","Speler","MAC-adres","Serienummer"], ...scanData.map(r=>[r.time,r.player,r.mac,r.serial])];
  const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"]=[{wch:22},{wch:20},{wch:20},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws, "Scanresultaten");
  XLSX.writeFile(wb, "scanresultaten.xlsx");
}

/****************************************************
 * CLOUD: OneDrive & Google Drive
 ****************************************************/
async function getCSVBlob(){ return new Blob(["\uFEFF"+buildCSV()], {type:"text/csv;charset=utf-8"}); }

/* OneDrive */
async function uploadToOneDrive(){
  if(!CONFIG.cloud.oneDrive.enabled){ alert("OneDrive staat uit"); return; }
  if(typeof msal==="undefined"){ alert("MSAL ontbreekt"); return; }

  const msalConfig={
    auth:{ clientId: CONFIG.cloud.oneDrive.clientId, authority:"https://login.microsoftonline.com/common", redirectUri: location.href },
    cache:{ cacheLocation:"localStorage" }
  };
  const app = new msal.PublicClientApplication(msalConfig);
  let account = app.getAllAccounts()[0];
  if(!account){ const login = await app.loginPopup({ scopes: CONFIG.cloud.oneDrive.scopes }); account = login.account; }

  const token = await app.acquireTokenSilent({ scopes: CONFIG.cloud.oneDrive.scopes, account })
    .catch(()=> app.acquireTokenPopup({ scopes: CONFIG.cloud.oneDrive.scopes }));

  const blob = await getCSVBlob();
  const name = `scan-${new Date().toISOString().replace(/[:T]/g,"-").slice(0,19)}.csv`;
  const url = `https://graph.microsoft.com/v1.0/me/drive/root:/RicohScanner/${name}:/content`;

  const res = await fetch(url, { method:"PUT", headers:{ Authorization:"Bearer "+token.accessToken }, body: blob });
  if(!res.ok){ alert("Upload naar OneDrive mislukt"); return; }
  alert("Upload naar OneDrive voltooid");
}

/* Google Drive */
async function uploadToGDrive(){
  if(!CONFIG.cloud.gDrive.enabled){ alert("Google Drive staat uit"); return; }
  if(typeof gapi==="undefined"){ alert("Google API ontbreekt"); return; }

  await new Promise(resolve => gapi.load("client:auth2", resolve));
  await gapi.client.init({
    apiKey: CONFIG.cloud.gDrive.apiKey,
    clientId: CONFIG.cloud.gDrive.clientId,
    discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    scope: "https://www.googleapis.com/auth/drive.file"
  });
  if(!gapi.auth.getToken()) await gapi.auth2.getAuthInstance().signIn();

  const blob = await getCSVBlob();
  const fileName = `scan-${Date.now()}.csv`;

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name:fileName, mimeType:"text/csv" })], {type:"application/json"}));
  form.append("file", blob);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method:"POST",
    headers:{ Authorization: "Bearer " + gapi.auth.getToken().access_token },
    body: form
  });
  if(!res.ok){ alert("Google Drive upload mislukt"); return; }
  alert("Upload naar Google Drive voltooid");
}

/****************************************************
 * RESET & EVENTS
 ****************************************************/
function resetAll(){
  dedupSet.clear(); scanData=[]; lastBox=null; tableBody.innerHTML="";
  statusLight.className="status red"; toast.classList.remove("show");
  saveData(); updateScanCount();
}

startBtn.addEventListener("click", startScan);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadCSV);
downloadExcelBtn.addEventListener("click", downloadExcel);
flashToggleBtn.addEventListener("click", toggleTorch);
uploadODBtn.addEventListener("click", uploadToOneDrive);
uploadGDBtn.addEventListener("click", uploadToGDrive);
window.addEventListener("resize", drawOverlay);

// Init
loadData();
