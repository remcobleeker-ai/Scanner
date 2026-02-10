const CACHE_VERSION = "ricoh-scanner-v5";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./scanner.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// Install
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

// Activate (clean old)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Laat auth/APIs direct naar netwerk
  if (
    url.hostname.includes("graph.microsoft.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname.includes("alcdn.msauth.net") ||
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("unpkg.com")
  ) {
    return; // niet intercepten
  }

  // Cache-first voor eigen assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        return caches.open(CACHE_VERSION).then((cache) => {
          try { cache.put(req, resp.clone()); } catch {}
          return resp;
        });
      }).catch(() => caches.match("./index.html"));
    })
  );
});
