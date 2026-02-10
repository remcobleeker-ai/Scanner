/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
  enableQuaggaFallback: true,

  cloud: {
    oneDrive: {
      enabled: true,
      clientId: "VUL_JOUW_AAD_CLIENT_ID_HIER_IN", // <- vereist
      scopes: ["Files.ReadWrite"]
    },
    gDrive: {
      enabled: true,
      apiKey: "VUL_JOUW_GOOGLE_API_KEY_HIER_IN", // <- vereist
      clientId: "VUL_JOUW_GOOGLE_OAUTH_CLIENT_ID_HIER_IN.apps.googleusercontent.com" // <- vereist
    }
  },

  ocr: {
    enabled: true,
    // Lokale paden voor offline OCR
    workerPath: "./libs/tesseract/tesseract.min.js",
    corePath: "./libs/tesseract/tesseract-core.wasm.js",
    langPath: "./libs/tesseract/lang-data",
    lang: "eng"
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

const dedupSet = new Set();     // MAC#Serial
let scanData = [];              // {raw,time,player,mac,serial}

let ocrWorker = null;           // Tesseract worker (gedeeld)

/****************************************************
 * PERSISTENTIE
 ****************************************************/
function saveData() {
  try {
    localStorage.setItem("ricoh_scan_data_v3", JSON.stringify(scanData));
  } catch {}
}
function loadData() {
  try {
    const stored = localStorage.getItem("ricoh_scan_data_v3");
    if (stored) {
      scanData = JSON.parse(stored);
      scanData.forEach(r => {
        appendRow(r.time, r.player, r.mac, r.serial);
        dedupSet.add(`${r.mac}#${r.serial}`);
      });
      updateScanCount();
    }
  } catch {}
}

/****************************************************
 * UTILS
 ****************************************************/
function beep(freq=880, dur=140, vol=0.15) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain); gain.connect(ac.destination);
    osc.start(); setTimeout(()=>{osc.stop(); ac.close();}, dur);
  } catch {}
}
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(()=>toast.classList.remove("show"), 900);
}
function updateScanCount() {
  scanCountEl.textContent = scanData.length;
}

/****************************************************
 * OVERLAY TEKENEN
 ****************************************************/
function drawOverlay() {
  const w = overlay.width = video.clientWidth;
  const h = overlay.height = video.clientHeight;
  ctx.clearRect(0,0,w,h);

  const elapsed = Date.now() - lastScanAt;
  if (!lastBox || elapsed > 1200) {
    ctx.strokeStyle = "rgba(229,57,53,0.9)";
    ctx.lineWidth = 3;
    const pad = 20;
    ctx.strokeRect(pad, pad, w-2*pad, h-2*pad);
    ctx.beginPath();
    ctx.moveTo(w/2-30, h/2); ctx.lineTo(w/2+30, h/2);
    ctx.moveTo(w/2, h/2-30); ctx.lineTo(w/2, h/2+30);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = "rgba(25,169,116,0.95)";
  ctx.lineWidth = 4;

  if (lastBox.type === "rect") {
    const {x,y,width,height} = lastBox.rect;
    ctx.strokeRect(x, y, width, height);
  } else if (lastBox.type === "poly") {
    const pts = lastBox.points;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.stroke();
  }

  ctx.fillStyle = "rgba(25,169,116,0.95)";
  ctx.font = "bold 18px Arial";
  ctx.fillText("Gescand", 16, 30);
}

/****************************************************
 * MAC & SERIAL EXTRACTIE – helpers
 ****************************************************/
function toColonMac(hex12) {
  return hex12.match(/.{1,2}/g).join(":").toUpperCase();
}
function normalizeMacFlexible(raw) {
  if (!raw) return null;
  raw = String(raw);

  // Cisco AAAA.BBBB.CCCC
  let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/);
  if (c) return toColonMac(c[0].replace(/\./g,""));

  // 12 hex
  let h = raw.match(/\b[0-9A-Fa-f]{12}\b/);
  if (h) return toColonMac(h[0]);

  // 6x2 met : of -
  let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
  if (d) return d[0].replace(/-/g,":").toUpperCase();

  return null;
}
function extractMac(raw) {
  raw = String(raw);
  const candidates = [raw, raw.replace(/mac\s*[:=]/i, ""), raw.replace(/WFM\s*[:=]/i, "")];
  for (const c of candidates) {
    const mac = normalizeMacFlexible(c);
    if (mac) return mac;
  }
  return null;
}
function extractSerial(raw, mac) {
  raw = String(raw);

  // JSON?
  try {
    const parsed = JSON.parse(raw);
    for (const k of ["serial","serienummer","sn","s/n"]) {
      if (parsed[k]) return String(parsed[k]).trim();
    }
  } catch {}

  // Labels met SN / Serial (géén WFM)
  let lbl = raw.match(/(?:S\/?N|Serial|Serienummer)\s*[:=#]?\s*([A-Za-z0-9\-]+)/i);
  if (lbl) return lbl[1].trim();

  // Meerdere tokens (mac;serial of mac,serial)
  const parts = raw.split(/[;,\|]/).map(s=>s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const other = parts.find(p => !normalizeMacFlexible(p));
    if (other) return other;
  }

  // Fallback: langste non-MAC token (8–20)
  const tokens = raw.replace(/[^\w\-]/g," ").split(/\s+/).filter(Boolean);
  const nonMac = tokens.filter(t => !normalizeMacFlexible(t) && /^[A-Za-z0-9\-]{8,20}$/.test(t));
  if (nonMac.length > 0) return nonMac.sort((a,b)=>b.length-a.length)[0];

  return "";
}

// OCR-specifiek (tekst op label)
function extractMacFromText(text) {
  if (!text) return null;

  // WFM is MAC (jouw opmerking)
  let wfm = text.match(/WFM\s*[:\s]*([0-9A-Fa-f]{12})/i);
  if (wfm) return toColonMac(wfm[1]);

  // MAC: AA:BB:CC:...
  let macA = text.match(/MAC\s*[:\s]*([0-9A-Fa-f:\-]{12,17})/i);
  if (macA) return normalizeMacFlexible(macA[1]);

  // Generiek
  let gen = normalizeMacFlexible(text);
  if (gen) return gen;

  return null;
}
function extractSerialFromText(text) {
  if (!text) return "";

  // S/N: XXXXX
  let sn = text.match(/S\/?N\s*[:\s]*([A-Za-z0-9\-]+)/i);
  if (sn) return sn[1];

  // Serial|Serienummer: XXXXX
  let lbl = text.match(/(?:Serial|Serienummer)\s*[:\s]*([A-Za-z0-9\-]+)/i);
  if (lbl) return lbl[1];

  // Fallback: langste alfanumerieke (8–20), behalve WFM en MAC
  const tokens = text.replace(/[^\w\-]/g, " ").split(/\s+/).filter(Boolean);
  const cands = tokens.filter(t => {
    if (/^WFM$/i.test(t)) return false;
    if (normalizeMacFlexible(t)) return false;
    return /^[A-Za-z0-9\-]{8,20}$/.test(t);
  });
  if (cands.length) return cands.sort((a,b)=>b.length-a.length)[0];

  return "";
}

/****************************************************
 * TABEL
 ****************************************************/
function appendRow(time, player, mac, serial) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${time}</td>
    <td>${player}</td>
