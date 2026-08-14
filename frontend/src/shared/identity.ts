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

export function currentUser(): db.UserRow | undefined {
  return db.userById(currentUserId());
}

/** 表示名。未設定なら空文字。 */
export function currentDisplayName(): string {
  return currentUser()?.display_name || "";
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
 * 表示名から利用者を確定する。users に居なければ作る
 * （招待前でも実体を持たせる方針。名前を入れるだけで参加できる）。
 */
export async function identifyByName(displayName: string): Promise<db.UserRow | null> {
  const name = String(displayName || "").trim();
  if (!name) return null;
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

/** 表示名を変更する（users の1列を更新するだけ）。 */
export function renameCurrentUser(displayName: string): void {
  const id = currentUserId();
  const name = String(displayName || "").trim();
  if (!id || !name) return;
  db.renameUser(id, name);
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
