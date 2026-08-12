// 永続化バックエンドの唯一の差し替え口。
//
// 現在の実装:
//   - sharedBackend.enabled=true かつ mode="api" のとき、MySQL の共有ストアが正。
//     localStorage は同期読み取り用のキャッシュとして使う。
//   - それ以外（mode="local"）は localStorage だけで完結する。
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
import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "./config";

const cache = new Map<string, unknown>();
let preloaded = false;
// 複数モジュールが同時に preload() を呼ぶため、実行中は同じ Promise を返す。
// これが無いと共有ストアの取得がページ表示ごとに何度も走る。
let preloading: Promise<void> | null = null;

function config(): TripConfig {
  return normalizeTripConfig(
    mergeConfig(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      readGlobalTripConfig() as Record<string, unknown>,
    ) as unknown as TripConfig,
  );
}

// ---- 共有ストア API（MySQL）--------------------------------------------
// Apps Script と同じ役割の、自前バックエンド版。
// 読みは preload でまとめて取り、書きは write-through で非同期に投げる
// （getJSON を同期のまま保つため。この設計は冒頭のコメント参照）。

function apiConfig(): { base: string; token: string } | null {
  const shared = config().sharedBackend;
  if (!shared?.enabled || shared.mode !== "api") return null;
  const base = (shared.apiBaseUrl || "").replace(/\/+$/, "");
  if (!base) return null;
  return { base, token: shared.apiToken || "" };
}

function apiHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** 共有ストア API を使う構成かどうか（プラン種の抑止判定にも使う）。 */
export function sharedApiEnabled(): boolean {
  return apiConfig() !== null;
}

/** キーごとのサーバー側バージョン。楽観ロックの再送判断に使う。 */
const versions = new Map<string, number>();

/** 直近サーバーへ送った（またはサーバーから受け取った）内容。無駄な PUT を避ける。 */
const lastSynced = new Map<string, string>();

/** preload 前に書き込もうとしたキー。読み込み後に現在値で送り直す。 */
const deferredKeys = new Set<string>();

function apiPersist(key: string, value: unknown): void {
  const api = apiConfig();
  if (!api) return;
  // サーバーを読み終える前に書くと、まだ手元に無いデータを空で上書きしてしまう。
  // 起動時のマイグレーション（ensureSeed / migrateExistingToPublic）が
  // preload 完了前に走るため、実際に共有中の計画一覧が消える事故が起きた。
  // 読み込み後に現在値で送り直す。
  if (!preloaded) {
    deferredKeys.add(key);
    return;
  }
  const serialized = JSON.stringify(value);
  // 中身が変わっていないなら送らない。
  // 起動時のハイドレートで同じ値が何十件も書き直されるため、これが無いと
  // ページを開くたびに大量の PUT が飛んでレート制限に当たる。
  if (lastSynced.get(key) === serialized) return;
  lastSynced.set(key, serialized);
  const url = `${api.base}/api/store/${encodeURIComponent(key)}`;
  const body = JSON.stringify({ value, version: versions.get(key) });
  void fetch(url, { method: "PUT", headers: apiHeaders(api.token), body })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as { version?: number };
        if (typeof data.version === "number") versions.set(key, data.version);
        emitSyncEvent({ ok: true, source: "api", key });
        return;
      }
      if (res.status === 409) {
        // 別端末が先に書いた。手元の版を進めて次回に備える。
        // 費用のように配列を持つキーは、呼び出し側（ExpenseStore.merge など）が
        // id で和集合マージしてから書き直すことで取りこぼしを防ぐ。
        const data = (await res.json()) as { version?: number };
        if (typeof data.version === "number") versions.set(key, data.version);
        lastSynced.delete(key); // 次回は必ず送り直す
        emitSyncEvent({ ok: false, source: "api", key, conflict: true });
        return;
      }
      lastSynced.delete(key); // 失敗したので次回また送る
      emitSyncEvent({ ok: false, source: "api", key, error: `HTTP ${res.status}` });
    })
    .catch((error: unknown) => {
      lastSynced.delete(key);
      emitSyncEvent({ ok: false, source: "api", key, error: String(error) });
    });
}

function apiDelete(key: string): void {
  const api = apiConfig();
  if (!api) return;
  void fetch(`${api.base}/api/store/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: apiHeaders(api.token),
  })
    .then(() => {
      versions.delete(key);
      lastSynced.delete(key);
      emitSyncEvent({ ok: true, source: "api", key });
    })
    .catch((error: unknown) => emitSyncEvent({ ok: false, source: "api", key, error: String(error) }));
}

/** 共有ストアを丸ごと取得してキャッシュと localStorage を満たす。 */
async function apiLoadAll(): Promise<void> {
  const api = apiConfig();
  if (!api) return;
  const res = await fetch(`${api.base}/api/store`, { headers: apiHeaders(api.token) });
  if (!res.ok) throw new Error(`共有ストアの取得に失敗しました (HTTP ${res.status})`);
  const data = (await res.json()) as {
    store?: Record<string, unknown>;
    versions?: Record<string, number>;
  };
  for (const [key, value] of Object.entries(data.store || {})) {
    cache.set(key, value);
    lastSynced.set(key, JSON.stringify(value));
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
  for (const [key, version] of Object.entries(data.versions || {})) versions.set(key, version);
}

function emitSyncEvent(detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent("trip-backend-sync", { detail }));
  } catch {
    /* ignore */
  }
}

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
  // 共有ストア API が正なら、ファイルへは書かない（二重の真実を作らない）。
  if (sharedApiEnabled()) return;
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
  if (sharedApiEnabled()) return;
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
  if (preloading) return preloading;
  preloading = runPreload().finally(() => {
    preloading = null;
  });
  return preloading;
}

async function runPreload(): Promise<void> {
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
  // 開発サーバー限定: data/store のファイルを流し込む（/api/store で書き戻る）。
  // 本番ビルドには注入されない（vite.config.ts の apply:"serve"）。
  // 共有ストア API を使う構成では、そちらが正なので当てない。
  const ds = sharedApiEnabled() ? null : devStore();
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
  // 共有ストア API（MySQL）。サーバーが正なので、種やローカルより後に当てて上書きする。
  if (apiConfig()) {
    try {
      await apiLoadAll();
      emitSyncEvent({ ok: true, source: "api" });
    } catch (error) {
      // 落ちても localStorage の内容で動き続ける（オフライン時と同じ扱い）
      emitSyncEvent({
        ok: false,
        source: "api",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  preloaded = true;
  // preload 前に保留した書き込みを、読み込み後の値で送り直す。
  // 大半はサーバーの値と一致して dedupe で消えるが、
  // 本当に手元だけの変更があればここで反映される。
  const deferred = [...deferredKeys];
  deferredKeys.clear();
  for (const key of deferred) {
    if (cache.has(key)) apiPersist(key, cache.get(key));
  }
}

/** 認証後などに共有ストアを明示的に再取得する。 */
export async function reload(): Promise<void> {
  preloaded = false;
  preloading = null;
  await preload();
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
  apiPersist(key, value);
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
  apiDelete(key);
}
