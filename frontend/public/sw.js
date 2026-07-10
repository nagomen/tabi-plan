// Vite がバンドルする JS/CSS（assets/*.HASH.js）はハッシュ名なので precache せず、
// fetch ハンドラの cache-first で初回取得時にキャッシュする。
// ここでは安定名の HTML と public 配下の静的ファイルだけを precache する。
const CACHE_NAME = "travel-dashboard-v13";
const APP_SHELL = [
  "./",
  "./index.html",
  "./trip-config.js",
  "./plans.html",
  "./plan-editor.html",
  "./expense-entry.html",
  "./expense-entry.webmanifest",
  "./itinerary-editor.html",
  "./site.webmanifest",
  "./icon-32.webp",
  "./icon-192.webp",
  "./icon-512.webp"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
