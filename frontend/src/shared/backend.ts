// 永続化バックエンドの唯一の差し替え口。
//
// 現在の実装:
//   - MySQL API 運用時のドメインデータは shared/db.ts が関係別 API を担当する。
//   - このモジュールは localStorage と開発用ファイルストアだけを担当する。
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
import { resolvedTripConfig } from "./config";

const cache = new Map<string, unknown>();
let preloaded = false;
// 複数モジュールが同時に preload() を呼ぶため、実行中は同じ Promise を返す。
// これが無いと共有ストアの取得がページ表示ごとに何度も走る。
let preloading: Promise<void> | null = null;

/** 関係別 API を使う構成かどうか（ローカル永続化の抑止判定に使う）。 */
export function sharedApiEnabled(): boolean {
  const shared = resolvedTripConfig().sharedBackend;
  return Boolean(shared?.enabled && shared.mode === "api");
}

// 開発時のファイル保存（data/store/<key>.json）。
// Vite の dev プラグインが window.__DEV_STORE__ を注入し、/api/store で読み書きする。
function devStore(): Record<string, unknown> | null {
  const value = (window as unknown as { __DEV_STORE__?: unknown }).__DEV_STORE__;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function devPersist(key: string, value: unknown): void {
  // 共有ストア API が正なら、ファイルへは書かない（二重の真実を作らない）。
  if (sharedApiEnabled()) return;
  if (!devStore()) return;
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
  preloaded = true;
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
  return ok;
}
