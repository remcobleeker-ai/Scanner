const CACHE_VERSION = "ricoh-scanner-v9";

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./scanner.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);

  if (
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cdnjs.com")
  ) return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;

      return fetch(req).then(resp =>
        caches.open(CACHE_VERSION).then(c => {
          try { c.put(req, resp.clone()); } catch {}
          return resp;
        })
      ).catch(() => caches.match("./index.html"));
    })
  );
});
