/****************************************************
 * CONFIG
 ****************************************************/
const CONFIG = {
    enableQuaggaFallback: true,

    cloud: {
        oneDrive: {
            enabled: true,
            clientId: "VUL_JOUW_AAD_CLIENTID_HIER_IN",
            scopes: ["Files.ReadWrite"]
        },
        gDrive: {
            enabled: true,
            apiKey: "VUL_JOUW_GOOGLE_API_KEY_HIER_IN",
            clientId: "VUL_JOUW_GOOGLE_OAUTH_CLIENTID_HIER_IN.apps.googleusercontent.com"
        }
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

// Duplicate detection: MAC+Serial
const dedupSet = new Set();

// In-memory + persistent localStorage store
let scanData = [];

/****************************************************
 * STORAGE
 ****************************************************/
function saveData() {
    try {
        localStorage.setItem("ricoh_scan_data_v2", JSON.stringify(scanData));
    } catch { }
}

function loadData() {
    try {
        const stored = localStorage.getItem("ricoh_scan_data_v2");
        if (stored) {
            scanData = JSON.parse(stored);
            scanData.forEach(r => {
                appendRow(r.time, r.player, r.mac, r.serial);
                dedupSet.add(`${r.mac}#${r.serial}`);
            });
            updateScanCount();
        }
    } catch { }
}

/****************************************************
 * UTILS
 ****************************************************/
function beep(freq = 880, dur = 140, vol = 0.15) {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.frequency.value = freq;
        gain.gain.value = vol;
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ac.close(); }, dur);
    } catch { }
}

function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 900);
}

function updateScanCount() {
    scanCountEl.textContent = scanData.length;
}

/****************************************************
 * DRAW OVERLAY
 ****************************************************/
function drawOverlay() {
    const w = overlay.width = video.clientWidth;
    const h = overlay.height = video.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const elapsed = Date.now() - lastScanAt;
    if (!lastBox || elapsed > 1200) {
        ctx.strokeStyle = "rgba(229,57,53,0.9)";
        ctx.lineWidth = 3;
        const pad = 20;
        ctx.strokeRect(pad, pad, w - 2 * pad, h - 2 * pad);

        ctx.beginPath();
        ctx.moveTo(w / 2 - 30, h / 2);
        ctx.lineTo(w / 2 + 30, h / 2);
        ctx.moveTo(w / 2, h / 2 - 30);
        ctx.lineTo(w / 2, h / 2 + 30);
        ctx.stroke();
        return;
    }

    ctx.strokeStyle = "rgba(25,169,116,0.95)";
    ctx.lineWidth = 4;

    if (lastBox.type === "rect") {
        const { x, y, width, height } = lastBox.rect;
        ctx.strokeRect(x, y, width, height);
    } else if (lastBox.type === "poly") {
        ctx.beginPath();
        const pts = lastBox.points;
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.stroke();
    }

    ctx.fillStyle = "rgba(25,169,116,0.95)";
    ctx.font = "bold 18px Arial";
    ctx.fillText("Gescand", 16, 30);
}

/****************************************************
 * MAC & SERIAL TEKST EXTRACTIE (volledig automatisch)
 ****************************************************/
function toColonMac(hex12) {
    return hex12.match(/.{1,2}/g).join(":").toUpperCase();
}

function normalizeMacFlexible(raw) {
    if (!raw) return null;

    raw = String(raw);

    // Cisco AAAA.BBBB.CCCC
    let c = raw.match(/[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}/);
    if (c) return toColonMac(c[0].replace(/\./g, ""));

    // 12 hex
    let h = raw.match(/\b[0-9A-Fa-f]{12}\b/);
    if (h) return toColonMac(h[0]);

    // 6x2 met : of -
    let d = raw.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
    if (d) return d[0].replace(/-/g, ":").toUpperCase();

    return null;
}

function extractMac(raw) {
    raw = String(raw);
    const candidates = [raw, raw.replace(/mac\s*[:=]/i, "")];

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
        for (const k of ["serial", "serienummer", "sn", "s/n"]) {
            if (parsed[k]) return String(parsed[k]).trim();
        }
    } catch { }

    // Labels
    let lab = raw.match(/(?:S\/?N|Serial|Serienummer)\s*[:=#]?\s*([A-Za-z0-9\-]+)/i);
    if (lab) return lab[1].trim();

    // 2 tokens
    const parts = raw.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const other = parts.find(p => normalizeMacFlexible(p) === null);
        if (other) return other;
    }

    // fallback: kies langste non-MAC token
    const tokens = raw.replace(/[^\w-]/g, " ").split(/\s+/).filter(Boolean);
    const nonMac = tokens.filter(t => !normalizeMacFlexible(t));
    if (nonMac.length > 0) return nonMac.sort((a, b) => b.length - a.length)[0];

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
        <td>${mac}</td>
        <td>${serial}</td>
    `;
    tableBody.appendChild(tr);
}

/****************************************************
 * PARSE EN TOEVOEGEN
 ****************************************************/
function processScan(raw) {
    const cleaned = String(raw).trim();
    const mac = extractMac(cleaned);
    const serial = extractSerial(cleaned, mac);
    const player = playerNameEl?.value?.trim() || "";
    const timestamp = new Date().toLocaleString();

    if (!mac) {
        statusLight.className = "status red";
        showToast("MAC niet gevonden");
        beep(240, 140, 0.2);
        return;
    }

    const key = `${mac}#${serial}`;
    if (dedupSet.has(key)) return;

    dedupSet.add(key);
    scanData.push({ raw: cleaned, time: timestamp, player, mac, serial });
    saveData();

    appendRow(timestamp, player, mac, serial);
    updateScanCount();

    statusLight.className = "status green";
    showToast("Gescand");
    beep(880, 140, 0.18);
    lastScanAt = Date.now();
}

/****************************************************
 * SCAN STARTEN
 ****************************************************/
async function startScan() {
    startBtn.disabled = true;
    statusLight.className = "status red";

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
                    "qr_code", "code_128", "code_39",
                    "ean_13", "ean_8", "upc_a",
                    "itf", "pdf417", "data_matrix"
                ]
            });
            useBarcodeDetector = true;
        } catch {
            useBarcodeDetector = false;
        }
    }

    (function loop() { drawOverlay(); requestAnimationFrame(loop); })();

    if (useBarcodeDetector) scanLoopDetector();
    else scanFallbackQuagga();
}

async function scanLoopDetector() {
    try {
        const found = await detector.detect(video);
        if (found && found.length > 0) {
            for (const bc of found) {
                if (bc.boundingBox) {
                    const r = bc.boundingBox;
                    lastBox = { type: "rect", rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
                }
                processScan(bc.rawValue);
            }
        }
    } catch { }
    requestAnimationFrame(scanLoopDetector);
}

/****************************************************
 * QUAGGA FALLBACK
 ****************************************************/
function scanFallbackQuagga() {
    if (!CONFIG.enableQuaggaFallback) return;

    Quagga.init({
        inputStream: {
            type: "LiveStream",
            target: video,
            constraints: { facingMode: "environment" }
        },
        decoder: {
            readers: [
                "code_128_reader",
                "code_39_reader",
                "ean_reader",
                "ean_8_reader",
                "upc_reader",
                "i2of5_reader"
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
        if (res && res.codeResult && res.codeResult.code) {
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
 * TORCH
 ****************************************************/
async function toggleTorch() {
    if (!track?.getCapabilities) {
        alert("Zaklamp niet beschikbaar");
        return;
    }

    const caps = track.getCapabilities();
    if (!caps.torch) {
        alert("Zaklamp niet beschikbaar");
        return;
    }

    torchOn = !torchOn;

    try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        flashToggleBtn.textContent = `Zaklamp: ${torchOn ? "aan" : "uit"}`;
    } catch {
        alert("Kon zaklamp niet schakelen");
    }
}

/****************************************************
 * CSV EXPORT
 ****************************************************/
function buildCSV() {
    const header = "Tijd,Speler,MAC-adres,Serienummer";
    const rows = scanData.map(r =>
        [r.time, r.player, r.mac, r.serial]
            .map(v => `"${String(v).replace(/"/g, '""')}"`)
            .join(",")
    );
    return header + "\n" + rows.join("\n");
}

function downloadCSV() {
    if (scanData.length === 0) {
        showToast("Geen data");
        return;
    }
    const csv = buildCSV();
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "scanresultaten.csv";
    a.click();
}

/****************************************************
 * EXCEL EXPORT
 ****************************************************/
async function downloadExcel() {
    if (scanData.length === 0) {
        showToast("Geen data");
        return;
    }

    const sheet = [
        ["Tijd", "Speler", "MAC", "Serienummer"],
        ...scanData.map(r => [r.time, r.player, r.mac, r.serial])
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheet);

    ws["!cols"] = [
        { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 20 }
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Scanresultaten");
    XLSX.writeFile(wb, "scanresultaten.xlsx");
}

/****************************************************
 * CLOUD SYNC
 ****************************************************/
async function getCSVBlob() {
    return new Blob(["\uFEFF" + buildCSV()], {
        type: "text/csv;charset=utf-8"
    });
}

/********** O N E D R I V E *********************************************/
async function uploadToOneDrive() {
    if (!CONFIG.cloud.oneDrive.enabled) {
        alert("OneDrive staat UIT in config.");
        return;
    }

    const msalConfig = {
        auth: {
            clientId: CONFIG.cloud.oneDrive.clientId,
            authority: "https://login.microsoftonline.com/common",
            redirectUri: location.href
        },
        cache: { cacheLocation: "localStorage" }
    };

    const msalApp = new msal.PublicClientApplication(msalConfig);

    let account =
        msalApp.getAllAccounts()[0] ||
        (await msalApp.loginPopup({ scopes: CONFIG.cloud.oneDrive.scopes })).account;

    const token = await msalApp.acquireTokenSilent({
        scopes: CONFIG.cloud.oneDrive.scopes,
        account
    }).catch(() =>
        msalApp.acquireTokenPopup({
            scopes: CONFIG.cloud.oneDrive.scopes
        })
    );

    const blob = await getCSVBlob();
    const name = `scan-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.csv`;

    const url = `https://graph.microsoft.com/v1.0/me/drive/root:/RicohScanner/${name}:/content`;
    const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token.accessToken },
        body: blob
    });

    if (!res.ok) {
        alert("Upload mislukt");
        return;
    }

    alert("Upload naar OneDrive voltooid");
}

/********** G O O G L E  D R I V E ***************************************/
async function uploadToGDrive() {
    if (!CONFIG.cloud.gDrive.enabled) {
        alert("Google Drive staat UIT in config.");
        return;
    }

    await new Promise(resolve => gapi.load("client:auth2", resolve));

    await gapi.client.init({
        apiKey: CONFIG.cloud.gDrive.apiKey,
        clientId: CONFIG.cloud.gDrive.clientId,
        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
        scope: "https://www.googleapis.com/auth/drive.file"
    });

    if (!gapi.auth.getToken()) {
        await gapi.auth2.getAuthInstance().signIn();
    }

    const blob = await getCSVBlob();
    const fileName = `scan-${Date.now()}.csv`;

    const form = new FormData();
    form.append("metadata", new Blob(
        [JSON.stringify({ name: fileName, mimeType: "text/csv" })],
        { type: "application/json" }
    ));
    form.append("file", blob);

    const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
        {
            method: "POST",
            headers: { Authorization: "Bearer " + gapi.auth.getToken().access_token },
            body: form
        }
    );

    if (!res.ok) {
        alert("Google Drive upload mislukt");
        return;
    }

    alert("Upload naar Google Drive voltooid");
}

/****************************************************
 * RESET
 ****************************************************/
function resetAll() {
    dedupSet.clear();
    scanData = [];
    lastBox = null;

    tableBody.innerHTML = "";
    statusLight.className = "status red";
    toast.classList.remove("show");

    saveData();
    updateScanCount();
}

/****************************************************
 * EVENTS
 ****************************************************/
startBtn.addEventListener("click", startScan);
resetBtn.addEventListener("click", resetAll);
downloadBtn.addEventListener("click", downloadCSV);
downloadExcelBtn.addEventListener("click", downloadExcel);
flashToggleBtn.addEventListener("click", toggleTorch);
uploadODBtn.addEventListener("click", uploadToOneDrive);
uploadGDBtn.addEventListener("click", uploadToGDrive);

window.addEventListener("resize", drawOverlay);

// Load persistent data
loadData();
