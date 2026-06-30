// 永続化バックエンドの唯一の差し替え口（seam）。
//
// 現在の実装: ブラウザの localStorage。
// 将来: この1ファイルの中身を HTTP API / DB クライアントに差し替えれば、
//       全ドメインデータ（プラン・費用・プロフィール・送金リンク）が
//       そのままバックエンドへ移行できる。各ストア・各ページのコードは変更不要。
//
// ルール:
//   - ドメインデータの読み書きは、各ストアが必ずこの backend 経由で行う
//     （localStorage を直接触らない）。
//   - 端末固有の UI 設定（地図の高さ・開閉状態など）や認証トークンは
//     「DB 化すべきデータ」ではないため対象外。各ページが従来どおり扱ってよい。
//
// 設計（同期読み取り + 非同期プリロード）:
//   - 読み取り getJSON は同期。内部のメモリキャッシュを参照する。
//   - 起動時に preload() でキャッシュを満たす（localStorage は同期なので即時）。
//   - キャッシュ未満のキーは localStorage を直読みするフォールバックがあり、
//     preload を呼ばなくても現状どおり動く（前方互換の保険）。
//
// API / DB バックエンドへ差し替えるときにやること（このファイルだけ）:
//   1. preload() を「サーバーから全件取得してキャッシュに入れる」に変更。
//   2. setJSON/removeJSON を「サーバーへ反映する」に変更（楽観更新でキャッシュも更新）。
//   3. getJSON の localStorage フォールバックを削除し、各ページ起動で
//      `await Backend.preload()` を必ず待つようにする。

const cache = new Map<string, unknown>();
let preloaded = false;

// 開発時のファイル保存（data/store/<key>.json）。
// Vite の dev プラグインが window.__DEV_STORE__ を注入し、/api/store で読み書きする。
// プランは別経路（data/plans/*.json）が担当するため、ここでは除外する。
function devStore(): Record<string, unknown> | null {
  const value = (window as unknown as { __DEV_STORE__?: unknown }).__DEV_STORE__;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isPlanKey(key: string): boolean {
  // "trip-dashboard-plans"（一覧）と "trip-dashboard-plan-<slug>"（データ）
  return key.startsWith("trip-dashboard-plan");
}

function devPersist(key: string, value: unknown): void {
  if (!devStore() || isPlanKey(key)) return; // 本番 or プランは対象外
  try {
    void fetch("/api/store/" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }).catch(() => {
      /* dev only, best-effort */
    });
  } catch {
    /* ignore */
  }
}

function devDelete(key: string): void {
  if (!devStore() || isPlanKey(key)) return;
  try {
    void fetch("/api/store/" + encodeURIComponent(key), { method: "DELETE" }).catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}

/**
 * バックエンドの全データをメモリキャッシュへ読み込む。
 * localStorage 実装では同期的に完了する。API 実装ではここでサーバー取得する。
 * 開発時は data/store のファイル（__DEV_STORE__）を真実として localStorage に上書きする。
 */
export async function preload(): Promise<void> {
  if (preloaded) return;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (raw == null) continue;
      try {
        cache.set(key, JSON.parse(raw));
      } catch {
        /* JSON でない値（プレーン文字列など）はキャッシュ対象外 */
      }
    }
  } catch {
    /* localStorage が使えない環境 */
  }
  // 開発時: data/store のファイルが真実。別ブラウザでも同じ内容になる。
  const ds = devStore();
  if (ds) {
    for (const [key, value] of Object.entries(ds)) {
      cache.set(key, value);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    }
  }
  preloaded = true;
}

/** 同期読み取り。キャッシュ→localStorage の順で解決し、無ければ fallback。 */
export function getJSON<T>(key: string, fallback: T): T {
  if (cache.has(key)) {
    const value = cache.get(key);
    return value === null || value === undefined ? fallback : (value as T);
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw) as T | null;
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 書き込み（write-through）。キャッシュを更新し、バックエンドへ反映する。 */
export function setJSON(key: string, value: unknown): boolean {
  cache.set(key, value);
  let ok = true;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    ok = false; // 容量超過など
  }
  devPersist(key, value); // 開発時は data/store/<key>.json にも保存
  return ok;
}

/** 削除。 */
export function removeJSON(key: string): void {
  cache.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  devDelete(key);
}
