/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
  enableQuaggaFallback: true,
  ocr: { enabled: true },

  // OCR versnellen: kleiner gebied scannen
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
const nextPlayerBtn = document.getElementById("nextPlayerBtn");

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

let LOCKED = false;  // vergrendel speler
let toggleWifi = false; // LAN ↔ Wi-Fi wissel

// Eén rij per speler
const playerIndex = new Map();
let scanData = [];

// Elk item maar 1×
const seenLanMacs = new Set();
const seenWifiMacs = new Set();
const seenSerials = new Set();

/****************************************************
 * STORAGE
 ****************************************************/
function saveData() {
  try { localStorage.setItem("ricoh_scan_data_v8", JSON.stringify(scanData)); }
  catch {}
}

function loadData() {
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
 * BUTTON LOGICA
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

nextPlayerBtn.addEventListener("click", () => {
  LOCKED = false;
  lockBtn.textContent = "Vergrendel speler";
  playerNameEl.value = "";
  showToast("Nieuwe speler gestart");
});

/****************************************************
 * HUD / UI Helpers
 ****************************************************/
function beep(freq=880, dur=140, vol=0.15) {
  try {
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value=freq; g.gain.value=vol;
    o.connect(g); g.connect(ac.destination);
    o.start();
    setTimeout(() => { o.stop(); ac.close(); }, dur);
  } catch {}
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 900);
}

function updateScanCount() {
  scanCountEl.textContent = scanData.length;
}

// LAN / WiFi / Serial indicator
function indicateScanType(type) {
  statusLight.style.background = {
    lan:   "#00c853",
    wifi:  "#2962ff",
    serial:"#ffab00"
  }[type] || "#CE0000";

  setTimeout(() => {
    statusLight.style.background = "";
  }, 1200);
}

/****************************************************
 * OVERLAY RENDER
 ****************************************************/
function drawOverlay() {
  const w = overlay.width = video.clientWidth;
  const h = overlay.height = video.clientHeight;
  ctx.clearRect(0,0,w,h);

  const elapsed = Date.now() - lastScanAt;

  if (!lastBox || elapsed > 1200) {
    ctx.strokeStyle="rgba(229,57,53,0.9)";
    ctx.lineWidth=3;
    const pad=20;
    ctx.strokeRect(pad,pad,w-2*pad,h-2*pad);
    return;
  }

  ctx.strokeStyle="rgba(25,169,116,0.95)";
  ctx.lineWidth=4;

  if (lastBox.type==="rect") {
    const {x,y,width,height}=lastBox.rect;
    ctx.strokeRect(x,y,width,height);
  }
}

/****************************************************
 * MAC DETECTIE
 ****************************************************/
function toColonMac(hex12) {
  return hex12.match(/.{1,2}/g).join(":").toUpperCase();
}

function normalizeMacFlexible(raw) {
  if (!raw) return null;
  raw = String(raw);

  let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/);
  if (c) return toColonMac(c[0].replace(/\./g,""));

  let h = raw.match(/\b[0-9A-Fa-f]{12}\b/);
  if (h) return toColonMac(h[0]);

  let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
  if (d) return d[0].replace(/-/g,":").toUpperCase();

  return null;
}

/****************************************************
 * BARCODE PARSER
 ****************************************************/
function extractFromBarcode(raw) {
  const out = { mac:null, wifiMac:null, serial:"" };

  const mac = normalizeMacFlexible(raw);
  if (mac) out.mac = mac;

  let wfm = raw.match(/WFM\s*[:=\s]*([0-9A-Fa-f]{12})/i);
  if (wfm) out.wifiMac = toColonMac(wfm[1]);

  let sn = raw.match(/(?:S\/?N|Serial|Serienummer)[\s:=]*([A-Za-z0-9\-]+)/i);
  if (sn) out.serial = sn[1];

  return out;
}

/****************************************************
 * OCR PARSER (DEELS GEKNIPT BIJ DEEL A)
 ****************************************************/
/****************************************************
 * OCR PARSER (vervolg Deel A)
 ****************************************************/
function extractFromText(text) {
  const out = { mac:null, wifiMac:null, serial:"" };
  if (!text) return out;

  let wfm = text.match(/WFM[\s:=]*([0-9A-Fa-f]{12})/i);
  if (wfm) out.wifiMac = toColonMac(wfm[1]);

  let macA = text.match(/MAC[\s:=]*([0-9A-Fa-f:\-]{12,17})/i);
  if (macA) out.mac = normalizeMacFlexible(macA[1]);

  if (!out.mac) {
    const gen = normalizeMacFlexible(text);
    if (gen && gen !== out.wifiMac) out.mac = gen;
  }

  let sn = text.match(/S\/?N[\s:=]*([A-Za-z0-9\-]+)/i);
  if (sn) out.serial = sn[1];
  else {
    let lbl = text.match(/(?:Serial|Serienummer)[\s:=]*([A-Za-z0-9\-]+)/i);
    if (lbl) out.serial = lbl[1];
  }

  return out;
}

/****************************************************
 * Snelle OCR (cropped)
 ****************************************************/
async function ocrScanVideoFrame() {
  if (!CONFIG.ocr.enabled || !window.Tesseract) return "";
  if (!video.videoWidth) return "";

  const crop = CONFIG.ocrCrop;
  const W = video.videoWidth;
  const H = video.videoHeight;

  const x = Math.floor(W * crop.x);
  const y = Math.floor(H * crop.y);
  const w = Math.floor(W * crop.w);
  const h = Math.floor(H * crop.h);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const c = canvas.getContext("2d");
  c.drawImage(video, x, y, w, h, 0, 0, w, h);

  try {
    const { data:{ text } } = await Tesseract.recognize(canvas, "eng");
    return text || "";
  } catch {
    return "";
  }
}

/****************************************************
 * Tabelfuncties
 ****************************************************/
function appendRow(time, player, mac, wifiMac, serial) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${time}</td>
    <td>${player}</td>
    <td>${mac || ""}</td>
    <td>${wifiMac || ""}</td>
    <td>${serial || ""}</td>
  `;
  tableBody.appendChild(tr);
}

function updateRow(idx) {
  const rows = tableBody.querySelectorAll("tr");
  const r = scanData[idx];
  const tr = rows[idx];

  tr.children[0].textContent = r.time;
  tr.children[1].textContent = r.player;
  tr.children[2].textContent = r.mac || "";
  tr.children[3].textContent = r.wifiMac || "";
  tr.children[4].textContent = r.serial || "";
}

/****************************************************
 * PROCESS SCAN
 ****************************************************/
async function processScan(raw) {
  const cleaned = String(raw).trim();
  const playerInput = playerNameEl.value.trim();

  let player;
  if (LOCKED) {
    if (playerIndex.size === 0) {
      showToast("Geen speler vergrendeld");
      beep(240, 140, 0.2);
      return;
    }
    player = [...playerIndex.keys()][playerIndex.size - 1];
  } else {
    if (!playerInput) {
      showToast("Vul eerst spelernaam in");
      beep(240, 140, 0.2);
      return;
    }
    player = playerInput;
  }

  const timestamp = new Date().toLocaleString();

  // 1. Barcode parsing
  let bc = extractFromBarcode(cleaned);

  // 2. OCR indien nodig
  if (!bc.mac || !bc.wifiMac || !bc.serial) {
    const text = await ocrScanVideoFrame();
    const tx = extractFromText(text);

    bc.mac     = bc.mac     || tx.mac;
    bc.wifiMac = bc.wifiMac || tx.wifiMac;
    bc.serial  = bc.serial  || tx.serial;
  }

  // 3. Wifi ↔ LAN toggle
  if (toggleWifi) {
    const tmp = bc.mac;
    bc.mac = bc.wifiMac;
    bc.wifiMac = tmp;
  }

  // 4. DEDUP
  if (bc.mac && seenLanMacs.has(bc.mac)) {
    showToast("LAN‑MAC al gescand");
    beep(240,140,0.2);
    return;
  }

  if (bc.wifiMac && seenWifiMacs.has(bc.wifiMac)) {
    showToast("Wi‑Fi‑MAC al gescand");
    beep(240,140,0.2);
    return;
  }

  if (bc.serial && seenSerials.has(bc.serial)) {
    showToast("Serienummer al gescand");
    beep(240,140,0.2);
    return;
  }

  // 5. De juiste spelerregel bepalen
  let idx;
  if (playerIndex.has(player)) {
    idx = playerIndex.get(player);
  } else {
    idx = scanData.length;
    playerIndex.set(player, idx);
    scanData.push({
      time: timestamp,
      player,
      mac: "",
      wifiMac: "",
      serial: ""
    });
    appendRow(timestamp, player, "", "", "");
  }

  let row = scanData[idx];
  let updated = false;

  // Velden aanvullen (nooit overschrijven)
  if (bc.mac && !row.mac) {
    row.mac = bc.mac;
    seenLanMacs.add(bc.mac);
    updated = true;
    indicateScanType("lan");
  }

  if (bc.wifiMac && !row.wifiMac) {
    row.wifiMac = bc.wifiMac;
    seenWifiMacs.add(bc.wifiMac);
    updated = true;
    indicateScanType("wifi");
  }

  if (bc.serial && !row.serial) {
    row.serial = bc.serial;
    seenSerials.add(bc.serial);
    updated = true;
    indicateScanType("serial");
  }

  if (updated) {
    row.time = timestamp;
    lastScanAt = Date.now();
    beep(880, 140, 0.18);
    showToast("Gescand");
  } else {
    showToast("Geen nieuwe data");
    beep(480, 140, 0.12);
  }

  updateRow(idx);
  saveData();
  updateScanCount();
}

/****************************************************
 * SCANNING SETUP
 ****************************************************/
async function startScan() {
  startBtn.disabled = true;

  // Camera
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
  });

  video.srcObject = stream;
  await video.play();
  track = stream.getVideoTracks()[0];

  // BarcodeDetector?
  if ("BarcodeDetector" in window) {
    try {
      detector = new BarcodeDetector({
        formats: [
          "qr_code","code_128","code_39","ean_13","ean_8",
          "upc_a","itf","pdf417","data_matrix"
        ]
      });
      useBarcodeDetector = true;
    } catch {
      useBarcodeDetector = false;
    }
  }

  (function loop(){
    drawOverlay();
    requestAnimationFrame(loop);
  })();

  if (useBarcodeDetector) scanLoopDetector();
  else startQuagga();
}

async function scanLoopDetector() {
  try {
    const found = await detector.detect(video);
    if (found && found.length) {
      for (const bc of found) {
        if (bc.boundingBox) {
          const r = bc.boundingBox;
          lastBox = {
            type: "rect",
            rect: { x:r.x, y:r.y, width:r.width, height:r.height }
          };
        }
        processScan(bc.rawValue);
      }
    }
  } catch {}

  requestAnimationFrame(scanLoopDetector);
}

function startQuagga() {
  if (typeof Quagga === "undefined") {
    console.warn("Quagga niet geladen!");
    return;
  }

  Quagga.init({
    inputStream: {
      type: "LiveStream",
      target: video,
      constraints: { facingMode: "environment" }
    },
    decoder: {
      readers: [
        "code_128_reader","code_39_reader","ean_reader",
        "ean_8_reader","upc_reader","i2of5_reader"
      ]
    },
    locate: true
  }, err => {
    if (err) {
      console.error(err);
      startBtn.disabled = false;
      return;
    }
    Quagga.start();
  });

  Quagga.onDetected(res => {
    if (res?.codeResult?.code) {
      processScan(res.codeResult.code);

      if (res.box && Array.isArray(res.box)) {
        lastBox = {
          type: "poly",
          points: res.box.map(p => [p[0], p[1]])
        };
        lastScanAt = Date.now();
      }
    }
  });
}

/****************************************************
 * ZAKLAMP
 ****************************************************/
async function toggleTorch() {
  if (!track?.getCapabilities) {
    alert("Zaklamp niet beschikbaar");
    return;
  }
  const caps = track.getCapabilities();
  if (!caps.torch) {
    alert("Torch niet beschikbaar");
    return;
  }

  torchOn = !torchOn;
  try {
    await track.applyConstraints({ advanced:[{ torch:torchOn }] });
    flashToggleBtn.textContent = torchOn ? "Zaklamp: aan" : "Zaklamp: uit";
  } catch {
    alert("Kon zaklamp niet schakelen");
  }
}

/****************************************************
 * CSV & EXCEL EXPORT
 ****************************************************/
function buildCSV() {
  const header =
    "Tijd,Speler,LAN-MAC,Wi-Fi-MAC,Serienummer";
  const rows = scanData.map(r =>
    [r.time, r.player, r.mac || "", r.wifiMac || "", r.serial || ""]
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(",")
  );
  return header + "\n" + rows.join("\n");
}

function downloadCSV() {
  if (scanData.length===0) {
    showToast("Geen data");
    return;
  }
  const blob = new Blob(["\uFEFF"+buildCSV()], {type:"text/csv"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="scanresultaten.csv";
  a.click();
}

function downloadExcel() {
  if (scanData.length===0) {
    showToast("Geen data");
    return;
  }
  const wsData = [
    ["Tijd","Speler","LAN-MAC","Wi-Fi-MAC","Serienummer"],
    ...scanData.map(r => [
      r.time, r.player, r.mac || "", r.wifiMac || "", r.serial || ""
    ])
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [
    {wch:22},{wch:20},{wch:20},{wch:20},{wch:20}
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Scanresultaten");
  XLSX.writeFile(wb, "scanresultaten.xlsx");
}

/****************************************************
 * OUTLOOK DELEN
 ****************************************************/
async function sendWithOutlook() {
  if (scanData.length === 0) {
    showToast("Geen data");
    return;
  }

  const csvText = buildCSV();
  const blob = new Blob(["\uFEFF"+csvText], { type:"text/csv" });
  const file = new File([blob], "scanresultaten.csv", {type:"text/csv"});

  // Share sheet op Android
  if (navigator.canShare && navigator.canShare({ files:[file] })) {
    try {
      await navigator.share({
        title: "Scanresultaten",
        text: "Bijgevoegd CSV-bestand.",
        files: [file]
      });
      showToast("Verzonden");
      return;
    } catch(e) { console.warn("Share mislukte:", e); }
  }

  // fallback
  const mailto = `mailto:?subject=Scanresultaten&body=${encodeURIComponent(csvText)}`;
  window.location.href = mailto;
}

/****************************************************
 * RESET
 ****************************************************/
function resetAll() {
  playerIndex.clear();
  scanData = [];
  seenLanMacs.clear();
  seenWifiMacs.clear();
  seenSerials.clear();
  lastBox = null;

  tableBody.innerHTML = "";
  statusLight.className = "status red";
  toast.classList.remove("show");

  saveData();
  updateScanCount();
}

/****************************************************
 * EVENT LISTENERS
 ****************************************************/
startBtn.addEventListener("click", startScan);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadCSV);
downloadExcelBtn.addEventListener("click", downloadExcel);
flashToggleBtn.addEventListener("click", toggleTorch);
sendOutlookBtn.addEventListener("click", sendWithOutlook);

window.addEventListener("resize", drawOverlay);

// Laden van opgeslagen data
loadData();
