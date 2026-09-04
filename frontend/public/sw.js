// Vite がバンドルする JS/CSS（assets/*.HASH.js）は内容ハッシュ付きなのでcache-first。
// 固定名のHTML・設定・画像は必ずネットワークで再検証し、成功時だけキャッシュを更新する。
const CACHE_NAME = "travel-dashboard-v19";
const APP_SHELL = [
  "./",
  "./index.html",
  "./trip-config.js",
  "./plans.html",
  "./plan-editor.html",
  "./mypage.html",
  "./person.html",
  "./login.html",
  "./asset-manifest.json",
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
      .then(async (cache) => {
        let generatedAssets = [];
        try {
          const response = await fetch(new Request("./asset-manifest.json", { cache: "reload" }));
          if (response.ok) {
            await cache.put("./asset-manifest.json", response.clone());
            const manifest = await response.json();
            if (Array.isArray(manifest.assets)) generatedAssets = manifest.assets.filter((path) => typeof path === "string");
          }
        } catch { /* HTMLだけでもオフライン起動できる範囲を保存する */ }
        return Promise.allSettled(
          [...new Set([...APP_SHELL, ...generatedAssets])]
            .map((path) => cache.add(new Request(path, { cache: "reload" })))
        );
      })
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
  // 認証済みAPI応答を共有キャッシュへ入れない。同じ端末の別アカウントへ
  // bootstrap等が漏れるのを防ぐ（ローカルの同一Origin構成も含む）。
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;
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
      // 別画面のURLへダッシュボードHTMLを返さない。同じpathnameのキャッシュだけを使う。
      const url = new URL(request.url);
      const page = await caches.match(new Request(url.origin + url.pathname));
      if (page) return page;
    }
    return new Response("", { status: 504, statusText: "offline" });
  }
}
