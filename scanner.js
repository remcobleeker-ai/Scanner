/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
  enableQuaggaFallback: true,
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
const sendOutlookBtn = document.getElementById("sendOutlookBtn");
const playerNameEl = document.getElementById("playerName");

/****************************************************
 * STATE
 ****************************************************/
let stream, track, detector, useBarcodeDetector = false;
let lastBox = null;
let lastScanAt = 0;
let torchOn = false;

// Eén rij per speler
const playerIndex = new Map(); // player -> rowIndex in scanData
let scanData = [];             // { time, player, mac, wifiMac, serial }

// Sterke de-dup: elk item mag 1x
const seenLanMacs = new Set();
const seenWifiMacs = new Set();
const seenSerials = new Set();

/****************************************************
 * PERSISTENTIE
 ****************************************************/
function saveData(){ try{ localStorage.setItem("ricoh_scan_data_v5", JSON.stringify(scanData)); }catch{} }
function loadData(){
  try {
    const stored = localStorage.getItem("ricoh_scan_data_v5");
    if (stored) {
      scanData = JSON.parse(stored);
      scanData.forEach((r, idx) => {
        appendRow(r.time, r.player, r.mac, r.wifiMac, r.serial);
        if (r.player && !playerIndex.has(r.player)) playerIndex.set(r.player, idx);
        if (r.mac) seenLanMacs.add(r.mac);
        if (r.wifiMac) seenWifiMacs.add(r.wifiMac);
        if (r.serial) seenSerials.add(r.serial);
      });
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
 * PARSING HELPERS
 ****************************************************/
function toColonMac(hex12){ return hex12.match(/.{1,2}/g).join(":").toUpperCase(); }
function normalizeMacFlexible(raw){
  if(!raw) return null; raw=String(raw);
  let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/); if(c) return toColonMac(c[0].replace(/\./g,""));
  let h = raw.match(/\b[0-9A-Fa-f]{12}\b/); if(h) return toColonMac(h[0]);
  let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/); if(d) return d[0].replace(/-/g,":").toUpperCase();
  return null;
}

// Barcode (ruwe string) -> mogelijk LAN-MAC en/of Serial
function extractFromBarcode(raw){
  const out = { mac: null, wifiMac: null, serial: "" };
  const mac = normalizeMacFlexible(raw);
  if (mac) out.mac = mac;

  // SN labels
  let lbl = String(raw).match(/(?:S\/?N|Serial|Serienummer)\s*[:=#]?\s*([A-Za-z0-9\-]+)/i);
  if (lbl) out.serial = lbl[1].trim();

  // Als barcode al een 'WFM' bevat, interpreteer dat als Wi-Fi-MAC
  let wfm = String(raw).match(/WFM\s*[:=\s]*([0-9A-Fa-f]{12})/i);
  if (wfm) {
    out.wifiMac = toColonMac(wfm[1]);
    // en zorg dat we hem niet ook als LAN-MAC zetten
    if (out.mac && out.mac === out.wifiMac) out.mac = null;
  }
  return out;
}

// OCR (tekst) -> mogelijk Wi-Fi-MAC (WFM), LAN-MAC en/of Serial
function extractFromText(text){
  const out = { mac: null, wifiMac: null, serial: "" };
  if (!text) return out;

  // Wi-Fi-MAC via WFM
  let wfm = text.match(/WFM\s*[:\s]*([0-9A-Fa-f]{12})/i);
  if (wfm) out.wifiMac = toColonMac(wfm[1]);

  // MAC: AA:BB:...
  let macA = text.match(/MAC\s*[:\s]*([0-9A-Fa-f:\-]{12,17})/i);
  if (macA) out.mac = normalizeMacFlexible(macA[1]);

  // Generieke MAC als niets anders gevonden (maar alleen als we nog geen Wi-Fi-MAC hadden)
  if (!out.mac) {
    const gen = normalizeMacFlexible(text);
    if (gen && gen !== out.wifiMac) out.mac = gen;
  }

  // Serienummer labels
  let sn = text.match(/S\/?N\s*[:\s]*([A-Za-z0-9\-]+)/i);
  if (sn) out.serial = sn[1].trim();
  else {
    let lbl = text.match(/(?:Serial|Serienummer)\s*[:\s]*([A-Za-z0-9\-]+)/i);
    if (lbl) out.serial = lbl[1].trim();
    else {
      // fallback: langste alfanumerieke (8–20), geen MAC
      const tokens = text.replace(/[^\w\-]/g," ").split(/\s+/).filter(Boolean);
      const cands = tokens.filter(t => !/^WFM$/i.test(t) && !normalizeMacFlexible(t) && /^[A-Za-z0-9\-]{8,20}$/.test(t));
      if (cands.length) out.serial = cands.sort((a,b)=>b.length-a.length)[0];
    }
  }

  // Als LAN-MAC gelijk is aan Wi-Fi-MAC, geef Wi-Fi voorrang en verwijder LAN
  if (out.mac && out.wifiMac && out.mac === out.wifiMac) out.mac = null;

  return out;
}

/****************************************************
 * TABEL
 ****************************************************/
function appendRow(time, player, mac, wifiMac, serial){
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${time}</td>
    <td>${player || ""}</td>
    <td>${mac || ""}</td>
    <td>${wifiMac || ""}</td>
    <td>${serial || ""}</td>
  `;
  tableBody.appendChild(tr);
}
function updateRow(idx){
  // herschrijf rij in DOM
  const rows = tableBody.querySelectorAll("tr");
  const r = scanData[idx];
  let tr = rows[idx];
  if (!tr) {
    appendRow(r.time, r.player, r.mac, r.wifiMac, r.serial);
    return;
    }
  tr.children[0].textContent = r.time;
  tr.children[1].textContent = r.player || "";
  tr.children[2].textContent = r.mac || "";
  tr.children[3].textContent = r.wifiMac || "";
  tr.children[4].textContent = r.serial || "";
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
    const { data:{ text } } = await Tesseract.recognize(canvas, "eng");
    return text || "";
  }catch{ return ""; }
}

/****************************************************
 * PROCESS SCAN
 ****************************************************/
async function processScan(raw){
  const cleaned = String(raw).trim();
  const player = playerNameEl?.value?.trim() || "";
  const timestamp = new Date().toLocaleString();

  // 1) Haal uit barcode
  let bc = extractFromBarcode(cleaned);

  // 2) OCR als iets ontbreekt
  if (!bc.mac || !bc.serial || !bc.wifiMac) {
    const text = await ocrScanVideoFrame();
    const tx = extractFromText(text);
    // combineer, met WFM als wifiMac
    bc.wifiMac = bc.wifiMac || tx.wifiMac;
    bc.mac     = bc.mac     || tx.mac;
    bc.serial  = bc.serial  || tx.serial;
  }

  // 3) De-dup per item: LAN-MAC, Wi-Fi-MAC, Serial mogen maar 1x voorkomen
  if (bc.mac && seenLanMacs.has(bc.mac)) {
    showToast("LAN‑MAC al gescand"); beep(240,140,0.2); return;
  }
  if (bc.wifiMac && seenWifiMacs.has(bc.wifiMac)) {
    showToast("Wi‑Fi‑MAC al gescand"); beep(240,140,0.2); return;
  }
  if (bc.serial && seenSerials.has(bc.serial)) {
    showToast("Serienummer al gescand"); beep(240,140,0.2); return;
  }

  // 4) Bepaal rij (één per speler). Geen speler? Maak losse rij op basis van tijdstempel als key.
  const key = player || `NO_PLAYER_${new Date().getTime()}`;
  let idx;
  if (player && playerIndex.has(player)) {
    idx = playerIndex.get(player);
  } else {
    idx = scanData.length;
    playerIndex.set(player, idx);
    scanData.push({ time: timestamp, player, mac: "", wifiMac: "", serial: "" });
    appendRow(timestamp, player, "", "", "");
  }

  // 5) Vul alleen nog lege velden — nooit overschrijven (alles 1x scannen)
  const row = scanData[idx];

  let updated = false;
  if (bc.mac && !row.mac)        { row.mac = bc.mac; seenLanMacs.add(bc.mac); updated = true; }
  if (bc.wifiMac && !row.wifiMac){ row.wifiMac = bc.wifiMac; seenWifiMacs.add(bc.wifiMac); updated = true; }
  if (bc.serial && !row.serial)  { row.serial = bc.serial; seenSerials.add(bc.serial); updated = true; }

  // Als we net een nieuwe rij hebben gemaakt, staat time al goed; anders alleen bij echte wijziging timestamp updaten.
  if (updated && idx < scanData.length) {
    row.time = timestamp;
  }

  saveData();
  updateRow(idx);
  updateScanCount();

  statusLight.className="status green"; showToast(updated ? "Gescand" : "Geen nieuwe info"); beep(updated?880:480, 140, updated?0.18:0.12);
  lastScanAt = Date.now();
}

/****************************************************
 * SCANNEN
 ****************************************************/
let track=null;
async function startScan(){
  startBtn.disabled = true;
  statusLight.className="status red";
  const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }});
  video.srcObject = media; await video.play();
  track = media.getVideoTracks()[0];

  if ("BarcodeDetector" in window) {
    try {
      detector = new BarcodeDetector({
        formats: ["qr_code","code_128","code_39","ean_13","ean_8","upc_a","itf","pdf417","data_matrix"]
      });
      useBarcodeDetector = true;
    } catch { useBarcodeDetector = false; }
  }

  (function loop(){ drawOverlay(); requestAnimationFrame(loop); })();
  if (useBarcodeDetector) scanLoopDetector();
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
  if (typeof Quagga==="undefined") { console.warn("Quagga niet geladen"); return; }
  Quagga.init({
    inputStream:{ type:"LiveStream", target: video, constraints:{ facingMode:"environment" } },
    decoder:{ readers:["code_128_reader","code_39_reader","ean_reader","ean_8_reader","upc_reader","i2of5_reader"] },
    locate:true
  }, err => {
    if (err) { console.error(err); startBtn.disabled=false; return; }
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
 * EXPORT
 ****************************************************/
function buildCSV(){
  const header = "Tijd,Speler,LAN-MAC,Wi-Fi-MAC,Serienummer";
  const rows = scanData.map(r =>
    [r.time, r.player, r.mac || "", r.wifiMac || "", r.serial || ""]
      .map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
  );
  return header + "\n" + rows.join("\n");
}
function downloadCSV(){
  if(scanData.length===0){ showToast("Geen data"); return; }
  const blob = new Blob(["\uFEFF"+buildCSV()], {type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="scanresultaten.csv"; a.click();
}
function downloadExcel(){
  if(scanData.length===0){ showToast("Geen data"); return; }
  if(typeof XLSX==="undefined"){ alert("Excel library ontbreekt"); return; }
  const wsData=[["Tijd","Speler","LAN-MAC","Wi-Fi-MAC","Serienummer"], ...scanData.map(r=>[r.time,r.player,r.mac||"",r.wifiMac||"",r.serial||""])];
  const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"]=[{wch:22},{wch:20},{wch:20},{wch:20},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws, "Scanresultaten");
  XLSX.writeFile(wb, "scanresultaten.xlsx");
}

/****************************************************
 * VERZEND MET OUTLOOK
 * - Android/Chrome: Web Share API met CSV-bijlage => Outlook share
 * - Fallback: mailto: met CSV in de body (bijlage niet mogelijk via mailto)
 ****************************************************/
async function sendWithOutlook(){
  if (scanData.length === 0) { showToast("Geen data"); return; }

  const csvText = buildCSV();
  const csvBlob = new Blob(["\uFEFF"+csvText], { type: "text/csv" });
  const file = new File([csvBlob], "scanresultaten.csv", { type: "text/csv" });

  const subject = "Scanresultaten";
  const bodyIntro = "Bijgevoegd de scanresultaten.\n\n";
  const bodyFallback = bodyIntro + csvText;

  // 1) Web Share API met bestanden (Android/Chrome/Edge)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try{
      await navigator.share({
        title: subject,
        text: "Scanresultaten als CSV.",
        files: [file]
      });
      showToast("Verzonden");
      return;
    }catch(e){
      // doorgaan naar mailto-fallback
    }
  }

  // 2) mailto fallback (geen bijlage mogelijk, maar wel inhoud in body)
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyFallback)}`;
  window.location.href = mailto;
}

/****************************************************
 * RESET & EVENTS
 ****************************************************/
function resetAll(){
  playerIndex.clear();
  scanData = [];
  seenLanMacs.clear();
  seenWifiMacs.clear();
  seenSerials.clear();

  lastBox = null;
  tableBody.innerHTML="";
  statusLight.className="status red"; toast.classList.remove("show");
  saveData(); updateScanCount();
}

startBtn.addEventListener("click", startScan);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadCSV);
downloadExcelBtn.addEventListener("click", downloadExcel);
flashToggleBtn.addEventListener("click", toggleTorch);
sendOutlookBtn.addEventListener("click", sendWithOutlook);
window.addEventListener("resize", drawOverlay);

// Init
loadData();
