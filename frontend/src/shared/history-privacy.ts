// 旅行履歴の公開設定（user_id → 公開する/しない）。
// 人のアイコンから開ける「旅行履歴」ページを、本人以外に見せてよいかの設定。
// 送金リンク（payment-links）と同様、計画ではなく端末（backend 経由）に名前キーで保存する。
// 既定は「公開」。マイページで本人が自分の名前についてオフにできる。
//
// 注意: これはプロトタイプ（名前ベースの本人判定）なので、あくまで表示上の設定。
// 将来アカウント連携が入ったら、ユーザーIDに紐づくサーバー側の設定へ差し替える。

import * as Backend from "./backend";
import * as db from "./db";

const KEY = "trip-dashboard-history-privacy";

// 保存するのは「既定（公開）から外れた分」だけ。name → 公開フラグ。
type PrivacyMap = Record<string, boolean>;

function readAll(): PrivacyMap {
  if (db.isEnabled() && db.isLoaded()) {
    return Object.fromEntries(
      db.userSettings()
        .map((row) => [row.user_id, Boolean(row.history_public)]),
    );
  }
  const parsed = Backend.getJSON<PrivacyMap>(KEY, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

function writeAll(map: PrivacyMap): void {
  Backend.setJSON(KEY, map);
}

/** その名前の旅行履歴を他人に公開してよいか。未設定は既定で公開（true）。 */
export function isHistoryPublic(userIdOrLegacyName: string): boolean {
  const key = String(userIdOrLegacyName || "").trim();
  if (!key) return true;
  if (db.isEnabled() && db.isLoaded() && !db.userById(key)) {
    const matches = db.users().filter((user) => user.display_name.trim() === key);
    if (matches.length !== 1) return false;
    return isHistoryPublic(matches[0].id);
  }
  const map = readAll();
  return key in map ? Boolean(map[key]) : true;
}

/** 公開する/しないを設定する。 */
export function setHistoryPublic(userIdOrLegacyName: string, isPublic: boolean): void {
  const key = String(userIdOrLegacyName || "").trim();
  if (!key) return;
  if (db.isEnabled() && db.isLoaded()) {
    if (db.userById(key)) db.setHistoryPublic(key, isPublic);
    return;
  }
  const map = readAll();
  map[key] = Boolean(isPublic);
  writeAll(map);
}
