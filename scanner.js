const video = document.getElementById("camera");
const startBtn = document.getElementById("startScan");
const downloadBtn = document.getElementById("download");
const tableBody = document.querySelector("#results tbody");

let detector;

if ("BarcodeDetector" in window) {
    detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "code_39"] });
} else {
    alert("BarcodeDetector wordt niet ondersteund in deze browser. Gebruik Chrome op Android.");
}

startBtn.onclick = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
    });

    video.srcObject = stream;
    await video.play();

    requestAnimationFrame(scanLoop);
};

async function scanLoop() {
    try {
        const barcodes = await detector.detect(video);
        for (const barcode of barcodes) {
            const data = barcode.rawValue;
            const parts = data.split(";");

            const mac = parts[0] || "";
            const serial = parts[1] || "";
            const timestamp = new Date().toLocaleString();

            addRow(timestamp, mac, serial);
        }
    } catch (err) {
        console.warn("Scan fout:", err);
    }

    requestAnimationFrame(scanLoop);
}

function addRow(time, mac, serial) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
        <td>${time}</td>
        <td>${mac}</td>
        <td>${serial}</td>
    `;
    tableBody.appendChild(tr);
}

downloadBtn.onclick = () => {
    const rows = [...tableBody.querySelectorAll("tr")].map(tr =>
        [...tr.children].map(td => td.innerText).join(",")
    );

    const csv = "Tijd,MAC-adres,Serienummer\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "scanresultaten.csv";
    a.click();
};
