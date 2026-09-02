// Service Worker 登録。
// 本番ビルドでのみ登録する。dev（Vite）では登録せず、過去に登録された SW を解除する。
// （古い SW が dev サーバを横取りして古いコード/キャッシュを配信し続けるのを防ぐ）

export function registerServiceWorker(swUrl = "sw.js"): void {
  if (!("serviceWorker" in navigator)) return;

  if (import.meta.env.DEV) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => registrations.forEach((registration) => void registration.unregister()))
      .catch(() => {
        /* ignore */
      });
    return;
  }

  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register(swUrl, { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch(() => {
      /* オフライン時は既存Service Workerをそのまま使う */
    });
}
