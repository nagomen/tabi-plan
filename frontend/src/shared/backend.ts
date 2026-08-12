// 永続化バックエンドの唯一の差し替え口。
//
// 現在の実装:
//   - 既定はブラウザの localStorage。
//   - sharedBackend.enabled=true かつ mode="appsScript" のときだけ、
//     localStorage を即時キャッシュとして残しながら Apps Script の共有ストアへ同期する。
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
import { callAppsScript, postAppsScript } from "./apps-script";

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

function remoteEnabled(): boolean {
  const cfg = config();
  return Boolean(cfg.sharedBackend?.enabled && cfg.sharedBackend.mode === "appsScript" && cfg.appsScriptUrl);
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

function authToken(): string {
  const cfg = config();
  try {
    const raw = localStorage.getItem(cfg.auth.storageKey);
    const session = raw ? (JSON.parse(raw) as { token?: string; expiresAt?: number }) : null;
    if (session?.expiresAt && Date.now() > session.expiresAt) return "";
    return session?.token || "";
  } catch {
    return "";
  }
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

function remotePersist(key: string, value: unknown): void {
  if (!remoteEnabled()) return;
  const cfg = config();
  try {
    void postAppsScript(
      cfg.appsScriptUrl,
      {
        action: "storeSet",
        token: authToken(),
        key,
        value: JSON.stringify(value),
      },
      {
        source: "trip-shared-store",
        idPrefix: "store",
        timeoutMs: 30000,
        timeoutMessage: "共有ストアへの保存がタイムアウトしました",
        failMessage: "共有ストアへの保存に失敗しました",
      },
    ).then(
      () => emitSyncEvent({ ok: true, source: "appsScript", key }),
      (error) => emitSyncEvent({
        ok: false,
        source: "appsScript",
        key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } catch {
    /* ignore */
  }
}

function remoteDelete(key: string): void {
  if (!remoteEnabled()) return;
  const cfg = config();
  try {
    void postAppsScript(
      cfg.appsScriptUrl,
      {
        action: "storeRemove",
        token: authToken(),
        key,
      },
      {
        source: "trip-shared-store",
        idPrefix: "store",
        timeoutMs: 30000,
        timeoutMessage: "共有ストアからの削除がタイムアウトしました",
        failMessage: "共有ストアからの削除に失敗しました",
      },
    ).then(
      () => emitSyncEvent({ ok: true, source: "appsScript", key }),
      (error) => emitSyncEvent({
        ok: false,
        source: "appsScript",
        key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  } catch {
    /* ignore */
  }
}

/** 端末固有で、配ってはいけないキー（配ると全員が同じ名前になる）。 */
const DEVICE_LOCAL_KEYS = new Set(["trip-dashboard-user"]);

/** id を持つ行の配列を、既存を優先しつつ id で和集合にする。 */
function unionById(seed: unknown, mine: unknown): unknown {
  if (!Array.isArray(seed)) return mine ?? seed;
  if (!Array.isArray(mine)) return seed;
  const has = new Set(
    mine.map((row) => (row && typeof row === "object" ? (row as { id?: string }).id : undefined)).filter(Boolean),
  );
  const added = seed.filter((row) => {
    const id = row && typeof row === "object" ? (row as { id?: string }).id : undefined;
    return id && !has.has(id);
  });
  return added.length ? [...mine, ...added] : mine;
}

/**
 * 本番での「種」の当て方。
 *   - 端末固有キーは配らない
 *   - 訪問者がまだ持っていないキーはそのまま入れる
 *   - アカウントは id で和集合（配ったアカウントで必ずログインでき、
 *     その端末で作ったアカウントも消えない）
 *   - それ以外で既にデータがあるなら、訪問者のものを優先して触らない
 */
function mergeSeed(key: string, seed: unknown, mine: unknown): unknown {
  if (DEVICE_LOCAL_KEYS.has(key)) return mine ?? undefined;
  if (mine === undefined || mine === null) return seed;
  if (key === "trip-dashboard-accounts") return unionById(seed, mine);
  return mine;
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
  // data/store のファイルを流し込む。
  // dev: ファイルが真実（/api/store で書き戻るので上書きしてよい）。
  // 本番: git で配る「種」。書き戻せないので、訪問者が既に持っているデータは壊さない。
  // 共有ストア API が正のときは、git の種を当てない。
  // 当ててしまうと、ページを開くたびに古いコミット内容で共有データを上書きする。
  const ds = sharedApiEnabled() ? null : devStore();
  if (ds) {
    for (const [key, value] of Object.entries(ds)) {
      const next = import.meta.env.DEV ? value : mergeSeed(key, value, cache.get(key));
      if (next === undefined) continue; // 配らないキー（端末固有で手元にも無い）
      cache.set(key, next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    }
  }
  if (remoteEnabled()) {
    const cfg = config();
    try {
      const response = await callAppsScript(cfg.appsScriptUrl, {
        action: "storeDump",
        token: authToken(),
      });
      const store = response.store;
      if (store && typeof store === "object" && !Array.isArray(store)) {
        for (const [key, value] of Object.entries(store as Record<string, unknown>)) {
          cache.set(key, value);
          try {
            localStorage.setItem(key, JSON.stringify(value));
          } catch {
            /* ignore */
          }
        }
        emitSyncEvent({ ok: true, source: "appsScript" });
      }
    } catch (error) {
      emitSyncEvent({
        ok: false,
        source: "appsScript",
        error: error instanceof Error ? error.message : String(error),
      });
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
  remotePersist(key, value);
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
  remoteDelete(key);
  apiDelete(key);
}
