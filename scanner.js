const video = document.getElementById("camera");
const startBtn = document.getElementById("startScan");
const downloadBtn = document.getElementById("downloadBtn");
const tableBody = document.querySelector("#results tbody");

// set met reeds gescande codes (voorkomt duplicaten)
const scannedSet = new Set();

let useBarcodeDetector = false;
let detector;

if ("BarcodeDetector" in window) {
  detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "code_39"] });
  useBarcodeDetector = true;
}

startBtn.onclick = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" }
  });

  video.srcObject = stream;
  await video.play();

  if (useBarcodeDetector) scanBarcodeDetector();
  else startQuagga();
};

async function scanBarcodeDetector() {
  try {
    const barcodes = await detector.detect(video);

    barcodes.forEach(bc => {
      const raw = bc.rawValue.trim();

      // check op duplicaat
      if (scannedSet.has(raw)) return;

      scannedSet.add(raw);
      parseResult(raw);
    });

  } catch (e) {}

  requestAnimationFrame(scanBarcodeDetector);
}

// verwerkt MAC + Serial
function parseResult(data) {
  const parts = data.split(";");
  const mac = parts[0] || "";
  const serial = parts[1] || "";
  const timestamp = new Date().toLocaleString();

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${timestamp}</td>
    <td>${mac}</td>
    <td>${serial}</td>
  `;
  tableBody.appendChild(tr);
}

downloadBtn.onclick = () => {
  const rows = [...tableBody.querySelectorAll("tr")].map(tr =>
    [...tr.children].map(td => td.innerText).join(",")
  );
  const csv = "Tijd,MAC,Serienummer\n" + rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "scanresultaten.csv";
  a.click();
};

// fallback voor 1D barcodes (Quagga)
function startQuagga() {
  Quagga.init({
    inputStream: {
      type: "LiveStream",
      target: video
    },
    decoder: { readers: ["code_128_reader", "code_39_reader"] }
  }, err => {
    if (err) return;
    Quagga.start();
  });

  Quagga.onDetected(data => {
    const raw = data.codeResult.code.trim();

    // check op duplicaat
    if (scannedSet.has(raw)) return;

    scannedSet.add(raw);
    parseResult(raw);
  });
}
