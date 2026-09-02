// Vite がバンドルする JS/CSS（assets/*.HASH.js）は内容ハッシュ付きなのでcache-first。
// 固定名のHTML・設定・画像は必ずネットワークで再検証し、成功時だけキャッシュを更新する。
const CACHE_NAME = "travel-dashboard-v18";
const APP_SHELL = [
  "./",
  "./index.html",
  "./trip-config.js",
  "./plans.html",
  "./plan-editor.html",
  "./site.webmanifest",
  "./icon-32.webp",
  "./icon-192.webp",
  "./icon-512.webp"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll は1件でも失敗すると install ごと失敗し、オフライン対応が
      // 永久に効かなくなる。1件ずつ入れて、失敗した分だけ諦める。
      .then((cache) => Promise.allSettled(
        APP_SHELL.map((path) => cache.add(new Request(path, { cache: "reload" })))
      ))
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
    event.respondWith(networkFirst(request, true));
    return;
  }

  if (url.origin !== location.origin) return;

  const hashedAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname);
  event.respondWith(hashedAsset ? cacheFirst(request) : networkFirst(request, false));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  } catch {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

async function networkFirst(request, navigation) {
  try {
    // GitHub Pagesの10分キャッシュも条件付き再検証し、固定名の差し替えを取りこぼさない。
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigation) {
      const shell = await caches.match("./index.html");
      if (shell) return shell;
    }
    return new Response("", { status: 504, statusText: "offline" });
  }
}
