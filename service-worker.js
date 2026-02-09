self.addEventListener("install", event => {
  event.waitUntil(
    caches.open("ricoh-cache-v1").then(cache => {
      return cache.addAll([
        "./",
        "./index.html",
        "./styles.css",
        "./scanner.js",
        "./quagga.min.js",
        "./icon-192.png",
        "./icon-512.png"
      ]);
    })
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});
