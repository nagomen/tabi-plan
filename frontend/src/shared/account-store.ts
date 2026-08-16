// メール+パスワードのアカウント（サインアップ/ログイン）。
//
// 保存は backend（差し替え口）経由なので、dev では data/store/trip-dashboard-accounts.json、
// 本番では localStorage に入る。将来 backend.ts を API/DB 実装へ差し替えれば、そのまま移行できる。
//
// API 有効時はサーバー発行セッションでログインする。
// ローカル保存モードでは従来どおり PBKDF2 ハッシュを使うが、共有用途では API を使う前提。

import * as Backend from "./backend";
import * as db from "./db";
import { setCurrentUser, clearCurrentUser } from "./identity";
import { setUserName } from "./user-store";

const ACCOUNTS_KEY = "trip-dashboard-accounts"; // 共有（dev: data/store のファイル）
const SESSION_KEY = "trip-dashboard-session"; // 端末固有（localStorage に直接）
const PBKDF2_ITERATIONS = 100_000;

/** 保存用アカウント（ハッシュ等のシークレットを含む）。 */
interface AccountRecord {
  id: string;
  email: string;
  name: string;
  salt: string; // base64
  hash: string; // base64 (PBKDF2 派生)
  createdAt: string;
}

/** 画面に渡してよい公開アカウント情報（シークレットなし）。 */
export interface Account {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

interface Session {
  userId: string;
  email: string;
  name: string;
  token?: string;
}

// ---- base64 ⇔ bytes -----------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---- PBKDF2 -------------------------------------------------------------

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}

async function deriveHash(password: string, saltB64: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64ToBytes(saltB64) as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

/** タイミング攻撃を避ける定数時間比較。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- アカウント永続化 ---------------------------------------------------

function readAccounts(): AccountRecord[] {
  const arr = Backend.getJSON<AccountRecord[]>(ACCOUNTS_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

function writeAccounts(accounts: AccountRecord[]): void {
  Backend.setJSON(ACCOUNTS_KEY, accounts);
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function toPublic(record: AccountRecord): Account {
  return { id: record.id, email: record.email, name: record.name, createdAt: record.createdAt };
}

function credentialToAccount(credential: {
  id?: string;
  user_id?: string;
  display_name: string;
  email: string;
}): Account {
  return {
    id: credential.id || credential.user_id || "",
    email: credential.email,
    name: credential.display_name,
    createdAt: "",
  };
}

function newId(): string {
  return "usr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- セッション（端末固有） ---------------------------------------------

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return s && s.userId ? { userId: s.userId, email: s.email || "", name: s.name || "", token: s.token || "" } : null;
  } catch {
    return null;
  }
}

function writeSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ---- バリデーション -----------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(normalizeEmail(email));
}

/** サインアップ時の弱いパスワード判定（8文字以上）。 */
export function isWeakPassword(password: string): boolean {
  return String(password || "").length < 8;
}

// ---- 公開 API -----------------------------------------------------------

/** メールアドレスで登録する。既存・不正値は Error を投げる。成功でログイン状態にする。 */
export async function signUp(email: string, password: string, name: string): Promise<Account> {
  await Backend.preload();
  if (db.isEnabled() && !db.isLoaded()) await db.load();
  const mail = normalizeEmail(email);
  if (!isValidEmail(mail)) throw new Error("メールアドレスの形式が正しくありません");
  if (isWeakPassword(password)) throw new Error("パスワードは8文字以上にしてください");
  if (db.isEnabled()) {
    const result = await db.authSignUp({
      email: mail,
      password,
      display_name: (name || "").trim() || mail.split("@")[0],
    });
    const account = credentialToAccount(result.user);
    startSession(account, result.session);
    return account;
  }
  const accounts = readAccounts();
  if (accounts.some((a) => normalizeEmail(a.email) === mail)) {
    throw new Error("このメールアドレスは既に登録されています");
  }
  const salt = randomSalt();
  const hash = await deriveHash(password, salt);
  const record: AccountRecord = {
    id: newId(),
    email: mail,
    name: (name || "").trim() || mail.split("@")[0],
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  accounts.push(record);
  writeAccounts(accounts);
  startSession(record);
  return toPublic(record);
}

/** ログイン。資格情報が誤っていれば Error を投げる。 */
export async function logIn(email: string, password: string): Promise<Account> {
  await Backend.preload();
  if (db.isEnabled() && !db.isLoaded()) await db.load();
  const mail = normalizeEmail(email);
  if (db.isEnabled()) {
    const result = await db.authLogIn({ email: mail, password });
    const account = credentialToAccount(result.user);
    startSession(account, result.session);
    return account;
  }
  const record = readAccounts().find((a) => normalizeEmail(a.email) === mail);
  // 存在しなくてもダミーで派生を回し、応答時間でユーザー有無を漏らさない
  const salt = record ? record.salt : randomSalt();
  const candidate = await deriveHash(password, salt);
  if (!record || !constantTimeEqual(candidate, record.hash)) {
    throw new Error("メールアドレスまたはパスワードが違います");
  }
  startSession(record);
  return toPublic(record);
}

function startSession(record: AccountRecord | Account, token = ""): void {
  writeSession({ userId: record.id, email: record.email, name: record.name, token });
  setCurrentUser(record.id);
  // 既存の「本人」判定（メンバー表示など）と連動させる
  setUserName(record.name);
}

export function logOut(): void {
  if (db.isEnabled() && readSession()?.token) void db.authLogOut().catch(() => undefined);
  writeSession(null);
  clearCurrentUser();
  // セッションだけ消すと、旧来の名前ベース判定が前ユーザーのまま残る。
  setUserName("");
  clearDeviceProfiles();
}

/**
 * 計画ごとの「本人設定」（trip-dashboard-profile-<slug>）を全部消す。
 * 残したままだと、同じ端末で別アカウントにログインした人が
 * 前のユーザーの本人設定を引き継いでしまう（支払者の初期値・自分の立替表示）。
 */
function clearDeviceProfiles(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("trip-dashboard-profile-") || key.startsWith("trip-db-bootstrap:"))) {
        keys.push(key);
      }
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* localStorage が使えない環境 */
  }
}

/** 現在ログイン中のアカウント（公開情報）。未ログインなら null。 */
export function currentAccount(): Account | null {
  const session = readSession();
  if (!session) return null;
  const record = readAccounts().find((a) => a.id === session.userId);
  if (record) return toPublic(record);
  const user = db.userById(session.userId);
  if (user) return { id: user.id, email: session.email, name: user.display_name, createdAt: "" };
  // アカウント一覧側が見つからない場合でもセッション情報で最低限返す
  return { id: session.userId, email: session.email, name: session.name, createdAt: "" };
}

export function isLoggedIn(): boolean {
  return readSession() != null;
}

/** メールアドレス完全一致でアカウントを探す（友達申請の宛先探索用）。 */
export function findAccountByEmail(email: string): Account | null {
  const mail = normalizeEmail(email);
  if (!mail) return null;
  const record = readAccounts().find((a) => normalizeEmail(a.email) === mail);
  if (record) return toPublic(record);
  const credential = db.credentials().find((row) => normalizeEmail(row.email) === mail);
  const user = credential ? db.userById(credential.user_id) : undefined;
  return user && credential ? { id: user.id, email: credential.email, name: user.display_name, createdAt: "" } : null;
}

/** id 指定でアカウントを探す（友達一覧の表示情報解決用）。 */
export function findAccountById(id: string): Account | null {
  if (!id) return null;
  const record = readAccounts().find((a) => a.id === id);
  if (record) return toPublic(record);
  const user = db.userById(id);
  const credential = db.credentials().find((row) => row.user_id === id);
  return user ? { id: user.id, email: credential?.email || "", name: user.display_name, createdAt: "" } : null;
}

function accountsFromSnapshot(query: string, opts: { excludeSelf?: boolean } = {}): Account[] {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const selfId = opts.excludeSelf ? currentAccount()?.id : undefined;
  const local = readAccounts()
    .filter((a) => a.id !== selfId)
    .filter((a) => a.name.toLowerCase().includes(q) || normalizeEmail(a.email).includes(q))
    .map(toPublic);
  const remote = db.users()
    .filter((user) => user.id !== selfId)
    .map((user) => {
      const credential = db.credentials().find((row) => row.user_id === user.id);
      return { id: user.id, email: credential?.email || "", name: user.display_name, createdAt: "" };
    })
    .filter((account) => account.name.toLowerCase().includes(q) || normalizeEmail(account.email).includes(q));
  return Array.from(new Map([...local, ...remote].map((account) => [account.id, account])).values()).slice(0, 20);
}

/** 名前/メールの部分一致でアカウントを検索する（既に読み込まれた情報のみ）。 */
export function searchAccounts(query: string, opts: { excludeSelf?: boolean } = {}): Account[] {
  return accountsFromSnapshot(query, opts);
}

/** サーバー側の公開範囲に沿ってユーザー検索し、候補をスナップショットへ反映して返す。 */
export async function searchAccountsRemote(query: string, opts: { excludeSelf?: boolean } = {}): Promise<Account[]> {
  const q = String(query || "").trim();
  if (!q) return [];
  if (db.isEnabled()) {
    try {
      await db.searchUsers(q);
    } catch {
      /* 検索 API が使えない場合は手元のスナップショットだけで返す */
    }
  }
  return accountsFromSnapshot(q, opts);
}

/** ログイン中アカウントの表示名を更新する（プロフィール編集用）。 */
export function updateName(name: string): Account | null {
  const session = readSession();
  if (!session) return null;
  const accounts = readAccounts();
  const i = accounts.findIndex((a) => a.id === session.userId);
  if (i < 0) {
    const nextName = (name || "").trim() || session.name;
    writeSession({ ...session, name: nextName });
    setUserName(nextName);
    if (db.isEnabled()) void db.renameUser(session.userId, nextName);
    return { id: session.userId, email: session.email, name: nextName, createdAt: "" };
  }
  accounts[i] = { ...accounts[i], name: (name || "").trim() || accounts[i].name };
  writeAccounts(accounts);
  writeSession({ ...session, name: accounts[i].name });
  setUserName(accounts[i].name);
  if (db.isEnabled()) void db.renameUser(session.userId, accounts[i].name);
  return toPublic(accounts[i]);
}
