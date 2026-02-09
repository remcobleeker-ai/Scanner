self.addEventListener("install", event => {
    event.waitUntil(
        caches.open("ricoh-scanner-cache").then(cache => {
            return cache.addAll([
                "./index.html",
                "./scanner.js",
                "./styles.css",
                "./icon-192.png",
                "./icon-512.png"
            ]);
        })
    );
});

self.addEventListener("fetch", event => {
    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        })
    );
});
