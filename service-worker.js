const CACHE_VERSION = "ricoh-scanner-v3";
const CACHE_ASSETS = [
    "./",
    "./index.html",
    "./styles.css",
    "./scanner.js",
    "./manifest.json",

    // Icons
    "./icon-192.png",
    "./icon-512.png",

    // Local library copies
    "./libs/quagga.min.js",
    "./libs/xlsx.full.min.js",
    "./libs/msal-browser.min.js",
    "./libs/google-api.js"
];

// Install: cache all essential assets
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => {
            return cache.addAll(CACHE_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys
                    .filter(k => k !== CACHE_VERSION)
                    .map(k => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// Fetch handler
self.addEventListener("fetch", event => {
    const req = event.request;
    const url = new URL(req.url);

    // Runtime caching for CDN / external libs
    if (
        url.hostname.includes("cdn") ||
        url.hostname.includes("googleapis") ||
        url.hostname.includes("gstatic")
    ) {
        event.respondWith(
            caches.open(CACHE_VERSION).then(async cache => {
                const cached = await cache.match(req);
                if (cached) return cached;

                try {
                    const fresh = await fetch(req);
                    cache.put(req, fresh.clone());
                    return fresh;
                } catch {
                    return cached || Response.error();
                }
            })
        );
        return;
    }

    // Cache First for own assets
    event.respondWith(
        caches.match(req).then(cacheRes => {
            return (
                cacheRes ||
                fetch(req).catch(() => caches.match("./index.html"))
            );
        })
    );
});
