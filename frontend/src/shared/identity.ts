// 「この端末を使っているのは誰か」を user_id で1本化する。
//
// 旧構造は3系統に分かれていた:
//   trip-dashboard-session（アカウント） / trip-dashboard-user（端末の表示名） /
//   trip-dashboard-profile-<slug>（計画ごとの本人設定）
// 実データではアカウントと表示名の9割が噛み合っておらず、権限判定が
// subjectType "account" | "name" の二重構造になっていた。
//
// ここでは端末に user_id だけを保存する。表示名は users テーブルから引く
// （名前は「表示のための値」に降格）。
//
// 端末固有の状態なので localStorage を直接使う（DB へ入れるものではない）。

import * as db from "./db";

const KEY = "trip-dashboard-identity";

interface Stored {
  userId: string;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return parsed && parsed.userId ? { userId: parsed.userId } : null;
  } catch {
    return null;
  }
}

/**
 * ログイン中の利用者 id。account-store は identity を読むので、循環を避けて
 * 保存先を直接見る（キーは account-store の SESSION_KEY と同じ）。
 */
function loggedInUserId(): string {
  try {
    const raw = localStorage.getItem("trip-dashboard-session");
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { userId?: string };
    return parsed.userId || "";
  } catch {
    return "";
  }
}

function write(userId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ userId }));
  } catch {
    /* ignore */
  }
}

/** いまの利用者の user_id。未設定なら空文字。 */
export function currentUserId(): string {
  const stored = read();
  if (!stored) return "";
  // users から消えた id を握り続けないよう、実在を確認する
  return db.userById(stored.userId) ? stored.userId : "";
}

export function isIdentified(): boolean {
  return currentUserId() !== "";
}

/** この端末の利用者を確定する。 */
export function setCurrentUser(userId: string): void {
  write(userId);
}

export function clearCurrentUser(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 表示名から利用者を確定する。API利用時は既存ユーザーだけを解決し、
 * 未登録参加者は旅行の招待画面でplaceholderを選んでアカウントへ紐付ける。
 */
export async function identifyByName(displayName: string): Promise<db.UserRow | null> {
  const name = String(displayName || "").trim();
  if (!name) return null;
  // ログイン済みなら、名前の入力で別人になれてしまわないようにする。
  // 名前は一意ではないので、同名の他人の id を掴めてしまい、「自分の立替」や
  // 支払者の初期値が他人のものになる（サーバーの権限はセッション基準なので
  // 情報は漏れないが、表示と既定値が狂う）。
  const account = loggedInUserId();
  if (account) {
    write(account);
    return db.userById(account) || null;
  }
  const existing = db.findUserByName(name);
  if (existing) {
    write(existing.id);
    return existing;
  }
  let user: db.UserRow;
  try {
    user = await db.ensureUser(name);
  } catch {
    return null;
  }
  write(user.id);
  return user;
}

// ---- 旧データからの引き継ぎ ---------------------------------------------

/**
 * 旧キー（session / user）から user_id を一度だけ引き継ぐ。
 * アカウント id は users.id と同じ値で移行しているのでそのまま使える。
 */
export function adoptLegacyIdentity(): void {
  if (read()) return;
  try {
    const session = localStorage.getItem("trip-dashboard-session");
    if (session) {
      const parsed = JSON.parse(session) as { userId?: string };
      if (parsed.userId && db.userById(parsed.userId)) {
        write(parsed.userId);
        return;
      }
    }
    const legacyUser = localStorage.getItem("trip-dashboard-user");
    if (legacyUser) {
      const parsed = JSON.parse(legacyUser) as { name?: string };
      const found = parsed.name ? db.findUserByName(parsed.name) : undefined;
      if (found) write(found.id);
    }
  } catch {
    /* ignore */
  }
}
