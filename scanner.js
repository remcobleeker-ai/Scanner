/**********************
 * Config
 *********************/
const CONFIG = {
  enableQuaggaFallback: true,
  macRegex: /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/,

  cloud: {
    oneDrive: { enabled: false, clientId: "VUL_HIER_JE_AAD_APP_CLIENT_ID_IN", scopes: ["Files.ReadWrite"] },
    gDrive:   { enabled: false }
  }
};

/**********************
 * Elementen
 *********************/
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

/**********************
 * State
 *********************/
let stream, track, detector, useBarcodeDetector = false;
const scannedSet = new Set();
let lastBox = null;
let lastScanAt = 0;
let torchOn = false;

// Persistent data store
let scanData = [];

/**********************
 * Persistence (localStorage)
 *********************/
function saveData() {
  try {
    localStorage.setItem("ricoh_scan_data", JSON.stringify(scanData));
  } catch (e) {}
}

function loadData() {
  try {
    const stored = localStorage.getItem("ricoh_scan_data");
    if (stored) {
      scanData = JSON.parse(stored);
      scanData.forEach(row => {
        scannedSet.add(row.raw);
        appendRowToTable(row.time, row.player, row.mac, row.serial);
      });
      updateScanCount();
    }
  } catch (e) {}
}

/**********************
 * Utils
 *********************/
function beep(f=880, t=120, vol=0.15){
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    g.gain.value = vol; o.frequency.value = f; o.type = "sine";
    o.start(); setTimeout(()=>{o.stop(); ac.close();}, t);
  } catch {}
}

function showToast(msg="Gescand"){
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(()=>toast.classList.remove("show"), 800);
}

function normalizeMac(mac){ return mac.trim().replace(/-/g, ":").toUpperCase(); }
function validMac(mac){ return CONFIG.macRegex.test(mac); }

function updateScanCount() {
  if (scanCountEl) {
    scanCountEl.textContent = scanData.length;
  }
}

function drawOverlay(){
  const w = overlay.width = video.clientWidth;
  const h = overlay.height = video.clientHeight;
  ctx.clearRect(0,0,w,h);

  const elapsed = Date.now() - lastScanAt;
  if (!lastBox || elapsed > 1200){
    ctx.strokeStyle = "rgba(229,57,53,0.9)";
    ctx.lineWidth = 3;
    const pad = 20;
    ctx.strokeRect(pad,pad,w-2*pad,h-2*pad);
    ctx.beginPath();
    ctx.moveTo(w/2-30,h/2); ctx.lineTo(w/2+30,h/2);
    ctx.moveTo(w/2,h/2-30); ctx.lineTo(w/2,h/2+30);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = "rgba(25,169,116,0.95)";
  ctx.lineWidth = 4;
  if (lastBox.type === "rect"){
    const {x,y,width,height} = lastBox.rect;
    ctx.strokeRect(x,y,width,height);
  } else if (lastBox.type === "poly"){
    const pts = lastBox.points;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(25,169,116,0.95)";
  ctx.font = "bold 18px Arial";
  ctx.fillText("Gescand", 16, 30);
}

function appendRowToTable(time, player, mac, serial) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${time}</td><td>${player}</td><td>${mac}</td><td>${serial}</td>`;
  tableBody.appendChild(tr);
}

function parseAndAppend(raw){
  const parts = String(raw).split(";");
  let mac = normalizeMac(parts[0] || "");
  const serial = (parts[1] || "").trim();
  const player = playerNameEl.value.trim();
  const timestamp = new Date().toLocaleString();

  if (!validMac(mac)){
    statusLight.className = "status red";
    showToast("Ongeldig MAC");
    beep(240, 160, 0.2);
    return;
  }

  // anti-duplicaat
  if (scannedSet.has(raw)) return;
  scannedSet.add(raw);

  // Add to data store
  scanData.push({ raw, time: timestamp, player, mac, serial });
  saveData();

  appendRowToTable(timestamp, player, mac, serial);
  updateScanCount();
  statusLight.className = "status green";
  showToast("Gescand");
  beep(880, 120, 0.18);
  lastScanAt = Date.now();
}

/**********************
 * Scannen
 *********************/
async function startScan(){
  startBtn.disabled = true;
  statusLight.className = "status red";

  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  await video.play();
  track = stream.getVideoTracks()[0];

  if ("BarcodeDetector" in window){
    detector = new BarcodeDetector({
      formats: ["qr_code","code_128","code_39","ean_13","ean_8","upc_a","itf","pdf417","data_matrix"]
    });
    useBarcodeDetector = true;
  } else {
    useBarcodeDetector = false;
  }

  (function loop(){ drawOverlay(); requestAnimationFrame(loop); })();

  if (useBarcodeDetector) scanWithDetector();
  else if (CONFIG.enableQuaggaFallback) startQuagga();
}

async function scanWithDetector(){
  try{
    const barcodes = await detector.detect(video);
    if (barcodes && barcodes.length){
      for (const bc of barcodes){
        if (bc.boundingBox){
          const r = bc.boundingBox;
          lastBox = { type:"rect", rect:{x:r.x, y:r.y, width:r.width, height:r.height} };
        }
        const raw = bc.rawValue.trim();
        // Let parseAndAppend handle duplicate checking and data storage
        parseAndAppend(raw);
      }
    }
  }catch(e){}
  requestAnimationFrame(scanWithDetector);
}

function startQuagga(){
  Quagga.init({
    inputStream:{ type:"LiveStream", target: video, constraints:{ facingMode:"environment" } },
    decoder:{ readers:["code_128_reader","code_39_reader","ean_reader","ean_8_reader","upc_reader","upc_e_reader","i2of5_reader"] },
    locate:true
  }, err => {
    if (err){ console.error(err); startBtn.disabled=false; return; }
    Quagga.start();
  });

  Quagga.onDetected(data => {
    const raw = data.codeResult.code.trim();
    // Let parseAndAppend handle duplicate checking and data storage
    parseAndAppend(raw);
    if (data.box && Array.isArray(data.box)){
      const pts = data.box.map(p=>[p[0],p[1]]);
      lastBox = { type:"poly", points: pts };
      lastScanAt = Date.now();
    }
  });
}

/**********************
 * Reset & CSV
 *********************/
function resetAll(){
  scannedSet.clear();
  scanData = [];
  lastBox = null;
  tableBody.innerHTML = "";
  statusLight.className = "status red";
  toast.classList.remove("show");
  saveData();
  updateScanCount();
}

function buildCSV(){
  const header = "Tijd,Speler,MAC-adres,Serienummer";
  const rows = scanData.map(r =>
    [r.time, r.player, r.mac, r.serial].map(v => `"${(v||"").replace(/"/g,'""')}"`).join(",")
  );
  return header + "\n" + rows.join("\n");
}

function downloadCSV(){
  if (scanData.length === 0) { showToast("Geen data"); return; }
  const csv = buildCSV();
  const blob = new Blob(["\uFEFF" + csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "scanresultaten.csv";
  a.click();
}

/**********************
 * Excel Export (XLSX)
 *********************/
function downloadExcel(){
  if (scanData.length === 0) { showToast("Geen data"); return; }
  if (typeof XLSX === "undefined") { alert("Excel bibliotheek wordt geladen, probeer opnieuw."); return; }

  const wsData = [
    ["Tijd", "Speler", "MAC-adres", "Serienummer"],
    ...scanData.map(r => [r.time, r.player, r.mac, r.serial])
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-size columns
  ws["!cols"] = [
    { wch: 22 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Scanresultaten");
  XLSX.writeFile(wb, "scanresultaten.xlsx");
}

/**********************
 * Zaklamp (torch)
 *********************/
async function toggleTorch(){
  if (!track || typeof track.getCapabilities !== "function"){
    alert("Zaklamp niet ondersteund op dit apparaat.");
    return;
  }
  const caps = track.getCapabilities();
  if (!caps.torch){ alert("Zaklamp niet beschikbaar voor deze camera."); return; }
  torchOn = !torchOn;
  try{
    await track.applyConstraints({ advanced:[{ torch: torchOn }] });
    flashToggleBtn.textContent = `Zaklamp: ${torchOn ? "aan" : "uit"}`;
  }catch(e){ alert("Kon zaklamp niet schakelen."); }
}

/**********************
 * Cloud Sync (OneDrive/SharePoint)
 *********************/
async function getCSVBlob(){ return new Blob(["\uFEFF" + buildCSV()], {type:"text/csv;charset=utf-8"}); }

async function uploadToOneDrive(){
  if (!CONFIG.cloud.oneDrive.enabled){ alert("OneDrive sync is uitgeschakeld in scanner.js"); return; }
  const msalConfig = {
    auth:{ clientId: CONFIG.cloud.oneDrive.clientId, authority: "https://login.microsoftonline.com/common", redirectUri: location.origin + location.pathname },
    cache:{ cacheLocation:"localStorage" }
  };
  const msalInstance = new msal.PublicClientApplication(msalConfig);
  const account = (await msalInstance.getAllAccounts())[0] || (await msalInstance.loginPopup({scopes:CONFIG.cloud.oneDrive.scopes})).account;
  const tokenResp = await msalInstance.acquireTokenSilent({scopes:CONFIG.cloud.oneDrive.scopes, account})
                   .catch(()=>msalInstance.acquireTokenPopup({scopes:CONFIG.cloud.oneDrive.scopes}));

  const blob = await getCSVBlob();
  const fileName = `scanresultaten-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`;
  const putUrl = "https://graph.microsoft.com/v1.0/me/drive/root:/RicohScanner/" + encodeURIComponent(fileName) + ":/content";
  const res = await fetch(putUrl, { method:"PUT", headers:{ "Authorization":"Bearer " + tokenResp.accessToken }, body: blob });
  if (!res.ok){ alert("Upload naar OneDrive mislukt"); return; }
  alert("Upload naar OneDrive/SharePoint voltooid.");
}

/**********************
 * Cloud Sync (Google Drive)
 *********************/
async function uploadToGDrive(){
  if (!CONFIG.cloud.gDrive.enabled){ alert("Google Drive sync is uitgeschakeld in scanner.js"); return; }

  await new Promise(resolve => gapi.load('client', resolve));
  await gapi.client.init({
    apiKey: "JE_GOOGLE_API_KEY",
    clientId: "JE_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
    discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    scope: "https://www.googleapis.com/auth/drive.file"
  });
  if (!gapi.auth.getToken()) await gapi.auth2.getAuthInstance().signIn();

  const blob = await getCSVBlob();
  const fileName = `scanresultaten-${Date.now()}.csv`;
  const metadata = { name: fileName, mimeType: "text/csv" };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], {type:'application/json'}));
  form.append('file', blob);

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Authorization": "Bearer " + gapi.auth.getToken().access_token },
    body: form
  });
  if (!res.ok){ alert("Upload naar Google Drive mislukt"); return; }
  alert("Upload naar Google Drive voltooid.");
}

/**********************
 * Events
 *********************/
startBtn.addEventListener("click", startScan);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadCSV);
if (downloadExcelBtn) downloadExcelBtn.addEventListener("click", downloadExcel);
flashToggleBtn.addEventListener("click", toggleTorch);
uploadODBtn.addEventListener("click", uploadToOneDrive);
uploadGDBtn.addEventListener("click", uploadToGDrive);
window.addEventListener("resize", drawOverlay);

// Load persisted data on startup
loadData();
