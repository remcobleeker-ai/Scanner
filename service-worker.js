// Production-grade PWA Service Worker
const CACHE_VERSION = "ricoh-scanner-v4";

// Alles wat we offline willen hebben
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./scanner.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",

  // Lokale libraries
  "./libs/quagga.min.js",
  "./libs/xlsx.full.min.js",
  "./libs/msal-browser.min.js",
  "./libs/google-api.js",

  // Tesseract (OCR)
  "./libs/tesseract/tesseract.min.js",
  "./libs/tesseract/tesseract-core.wasm.js",
  "./libs/tesseract/tesseract-core.wasm",

  // Taaldata (LET OP: zet dit bestand zelf neer)
  "./libs/tesseract/lang-data/eng.traineddata"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Laat Graph/GDrive requests altijd door naar netwerk
  if (
    url.hostname.includes("graph.microsoft.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com")
  ) {
    return; // no intercept
  }

  // Cache-first voor onze assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Runtime cache van externe scripts (indien gebruikt)
        return caches.open(CACHE_VERSION).then((cache) => {
          try { cache.put(req, resp.clone()); } catch (e) {}
          return resp;
        });
      }).catch(() => caches.match("./index.html"));
    })
  );
});
