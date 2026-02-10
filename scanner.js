/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
  enableQuaggaFallback: true,
  ocr: { enabled: true },

  // OCR versnellen door minder pixels te verwerken
  ocrCrop: {
    w: 0.70,  // 70% breedte
    h: 0.50,  // 50% hoogte
    x: 0.15,  // 15% van links
    y: 0.25   // 25% van boven
  }
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
const lockBtn = document.getElementById("lockBtn");
const toggleBtn = document.getElementById("toggleBtn");
const nextPlayerBtn = document.createElement("button");
nextPlayerBtn.textContent = "Volgende speler";
nextPlayerBtn.className = "cloud";
document.querySelector(".toolbar").appendChild(nextPlayerBtn);

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

let LOCKED = false;
let toggleWifi = false;

// één rij per speler
const playerIndex = new Map();
let scanData = [];

// unieke sets
const seenLanMacs = new Set();
const seenWifiMacs = new Set();
const seenSerials = new Set();

/****************************************************
 * STORAGE
 ****************************************************/
function saveData(){ try{ localStorage.setItem("ricoh_scan_data_v8", JSON.stringify(scanData)); }catch{} }
function loadData(){
  try {
    const stored = localStorage.getItem("ricoh_scan_data_v8");
    if (stored) {
      scanData = JSON.parse(stored);
      scanData.forEach((r, idx) => {
        appendRow(r.time, r.player, r.mac, r.wifiMac, r.serial);
        playerIndex.set(r.player, idx);
        if (r.mac) seenLanMacs.add(r.mac);
        if (r.wifiMac) seenWifiMacs.add(r.wifiMac);
        if (r.serial) seenSerials.add(r.serial);
      });
      updateScanCount();
    }
  } catch {}
}

/****************************************************
 * UI BUTTONS
 ****************************************************/
lockBtn.addEventListener("click", () => {
  LOCKED = !LOCKED;
  lockBtn.textContent = LOCKED ? "Ontgrendel speler" : "Vergrendel speler";
  showToast(LOCKED ? "Speler vergrendeld" : "Speler ontgrendeld");
});

toggleBtn.addEventListener("click", () => {
  toggleWifi = !toggleWifi;
  toggleBtn.textContent = toggleWifi ? "Wi‑Fi → LAN" : "LAN → Wi‑Fi";
  showToast("Toggle actief");
});

// Nieuwe: volgende speler knop
nextPlayerBtn.addEventListener("click", () => {
  LOCKED = false;
  lockBtn.textContent = "Vergrendel speler";
  playerNameEl.value = "";
  showToast("Nieuwe speler");
});

/****************************************************
 * HELPER: beep, toast
 ****************************************************/
function beep(freq=880, dur=140, vol=0.15){
  try{
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value=freq; g.gain.value=vol;
    o.connect(g); g.connect(ac.destination);
    o.start(); setTimeout(()=>{o.stop(); ac.close();}, dur);
  }catch{}
}

function showToast(msg){
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(()=>toast.classList.remove("show"), 900);
}

function updateScanCount(){ scanCountEl.textContent = scanData.length; }

/****************************************************
 * OVERLAY TEKENEN
 ****************************************************/
function drawOverlay(){
  const w = overlay.width = video.clientWidth;
  const h = overlay.height = video.clientHeight;
  ctx.clearRect(0,0,w,h);

  const elapsed = Date.now() - lastScanAt;
  if(!lastBox || elapsed > 1200){
    ctx.strokeStyle="rgba(229,57,53,0.9)";
    ctx.lineWidth=3;
    const pad=20;
    ctx.strokeRect(pad,pad,w-2*pad,h-2*pad);
    return;
  }

  ctx.strokeStyle="rgba(25,169,116,0.95)";
  ctx.lineWidth=4;
  if(lastBox.type==="rect"){
    const {x,y,width,height}=lastBox.rect;
    ctx.strokeRect(x,y,width,height);
  }
}

/****************************************************
 * MAC parsing
 ****************************************************/
function toColonMac(hex12){ return hex12.match(/.{1,2}/g).join(":").toUpperCase(); }

function normalizeMacFlexible(raw){
  if(!raw) return null;
  raw = String(raw);

  let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/);
  if(c) return toColonMac(c[0].replace(/\./g,""));

  let h = raw.match(/\b[0-9A-Fa-f]{12}\b/);
  if(h) return toColonMac(h[0]);

  let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
  if(d) return d[0].replace(/-/g,":").toUpperCase();

  return null;
}

/****************************************************
 * BARCODE parsing
 ****************************************************/
function extractFromBarcode(raw){
  const out = { mac:null, wifiMac:null, serial:"" };

  const mac = normalizeMacFlexible(raw);
  if(mac) out.mac = mac;

  let wfm = raw.match(/WFM\s*[:=\s]*([0-9A-Fa-f]{12})/i);
  if(wfm) out.wifiMac = toColonMac(wfm[1]);

  let sn = raw.match(/(?:S\/?N|Serial|Serienummer)[\s:=]*([A-Za-z0-9\-]+)/i);
  if(sn) out.serial = sn[1];
  return out;
}

/****************************************************
 * OCR parsing (sneller door cropping)
 ****************************************************/
function extractFromText(text){
  const out = { mac:null, wifiMac:null, serial:"" };
  if(!text) return out;

  let wfm = text.match(/WFM[\s:=]*([0-9A-Fa-f]{12})/i);
  if(wfm) out.wifiMac = toColonMac(wfm[1]);

  let macA = text.match(/MAC[\s:=]*([0-9A-Fa-f:\-]{12,17})/i);
  if(macA) out.mac = normalizeMacFlexible(macA[1]);

  if(!out.mac){
    const gen = normalizeMacFlexible(text);
    if(gen && gen !== out.wifiMac) out.mac = gen;
  }

  let sn = text.match(/S\/?N[\s:=]*([A-Za-z0-9\-]+)/i);
  if(sn) out.serial = sn[1];

  return out;
}

async function ocrScanVideoFrame(){
  if(!CONFIG.ocr.enabled || !window.Tesseract) return "";
  if(!video.videoWidth) return "";

  const crop = CONFIG.ocrCrop;

  const W = video.videoWidth;
  const H = video.videoHeight;

  const x = Math.floor(W*crop.x);
  const y = Math.floor(H*crop.y);
  const w = Math.floor(W*crop.w);
  const h = Math.floor(H*crop.h);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const c = canvas.getContext("2d");
  c.drawImage(video, x, y, w, h, 0, 0, w, h);

  try{
    const { data:{ text } } = await Tesseract.recognize(canvas, "eng");
    return text || "";
  }catch{
    return "";
  }
}

/****************************************************
 * TABEL
 ****************************************************/
function appendRow(time, player, mac, wifiMac, serial){
  const tr=document.createElement("tr");
  tr.innerHTML = `
    <td>${time}</td>
    <td>${player}</td>
    <td>${mac||""}</td>
    <td>${wifiMac||""}</td>
    <td>${serial||""}</td>
  `;
  tableBody.appendChild(tr);
}

function updateRow(idx){
  const rows = tableBody.querySelectorAll("tr");
  const r = scanData[idx];
  const tr = rows[idx];
  tr.children[0].textContent = r.time;
  tr.children[1].textContent = r.player;
  tr.children[2].textContent = r.mac||"";
  tr.children[3].textContent = r.wifiMac||"";
  tr.children[4].textContent = r.serial||"";
}

/****************************************************
 * PROCESS SCAN
 ****************************************************/
async function processScan(raw){
  const cleaned = String(raw).trim();
  const playerInput = playerNameEl.value.trim();

  let player;
  if(LOCKED){
    if(playerIndex.size === 0){
      showToast("Geen speler vergrendeld");
      return;
    }
    player = [...playerIndex.keys()][playerIndex.size-1];
  } else {
    if(!playerInput){
      showToast("Vul eerst spelernaam in");
      beep(240,140,0.2);
      return;
    }
    player = playerInput;
  }

  const timestamp = new Date().toLocaleString();
  let bc = extractFromBarcode(cleaned);

  if(!bc.mac || !bc.wifiMac || !bc.serial){
    const text = await ocrScanVideoFrame();
    const tx = extractFromText(text);
    bc.mac = bc.mac || tx.mac;
    bc.wifiMac = bc.wifiMac || tx.wifiMac;
    bc.serial = bc.serial || tx.serial;
  }

  if(toggleWifi){
    let tmp = bc.mac;
    bc.mac = bc.wifiMac;
    bc.wifiMac = tmp;
  }

  if(bc.mac && seenLanMacs.has(bc.mac)){
    showToast("LAN-MAC al gescand");
    return;
  }
  if(bc.wifiMac && seenWifiMacs.has(bc.wifiMac)){
    showToast("WiFi-MAC al gescand");
    return;
  }
  if(bc.serial && seenSerials.has(bc.serial)){
    showToast("Serial al gescand");
    return;
  }

  let idx;
  if(playerIndex.has(player)){
    idx = playerIndex.get(player);
  } else {
    idx = scanData.length;
    playerIndex.set(player, idx);
    scanData.push({
      time: timestamp, player,
      mac:"", wifiMac:"", serial:""
    });
    appendRow(timestamp,player,"","","");
  }

  const row = scanData[idx];
  let updated=false;

  if(bc.mac && !row.mac){
    row.mac = bc.mac;
    seenLanMacs.add(bc.mac);
    updated=true;
  }
  if(bc.wifiMac && !row.wifiMac){
    row.wifiMac = bc.wi

Please resend this message in the next turn.
