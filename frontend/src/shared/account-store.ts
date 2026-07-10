// メール+パスワードのアカウント（サインアップ/ログイン）。
//
// 保存は backend（差し替え口）経由なので、dev では data/store/trip-dashboard-accounts.json、
// 本番では localStorage に入る。将来 backend.ts を API/DB 実装へ差し替えれば、そのまま移行できる。
//
// セキュリティについての重要な注意:
//   - これは「サーバーが無い段階」のプロトタイプ認証であり、本物の認証ではない。
//     アカウント一覧（ハッシュ含む）はクライアントから読めてしまう。
//   - それでもパスワードは平文では保存しない。PBKDF2(SHA-256, 10万回, ランダムソルト)で
//     ハッシュ化して保存し、照合は派生ハッシュの定数時間比較で行う。
//   - 将来 backend を本物のサーバー実装に差し替えたら、署名・検証はサーバー側で行うこと。
//     セッションは httpOnly Cookie / サーバー発行トークンへ移す。

import * as Backend from "./backend";
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

function newId(): string {
  return "usr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- セッション（端末固有） ---------------------------------------------

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return s && s.userId ? { userId: s.userId, email: s.email || "", name: s.name || "" } : null;
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
  const mail = normalizeEmail(email);
  if (!isValidEmail(mail)) throw new Error("メールアドレスの形式が正しくありません");
  if (isWeakPassword(password)) throw new Error("パスワードは8文字以上にしてください");
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
  const mail = normalizeEmail(email);
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

function startSession(record: AccountRecord): void {
  writeSession({ userId: record.id, email: record.email, name: record.name });
  // 既存の「本人」判定（メンバー表示など）と連動させる
  setUserName(record.name);
}

export function logOut(): void {
  writeSession(null);
  // セッションだけ消すと、旧来の名前ベース判定が前ユーザーのまま残る。
  setUserName("");
}

/** 現在ログイン中のアカウント（公開情報）。未ログインなら null。 */
export function currentAccount(): Account | null {
  const session = readSession();
  if (!session) return null;
  const record = readAccounts().find((a) => a.id === session.userId);
  if (record) return toPublic(record);
  // アカウント一覧側が見つからない場合でもセッション情報で最低限返す
  return { id: session.userId, email: session.email, name: session.name, createdAt: "" };
}

export function isLoggedIn(): boolean {
  return readSession() != null;
}

/** ログイン中アカウントの表示名を更新する（プロフィール編集用）。 */
export function updateName(name: string): Account | null {
  const session = readSession();
  if (!session) return null;
  const accounts = readAccounts();
  const i = accounts.findIndex((a) => a.id === session.userId);
  if (i < 0) return null;
  accounts[i] = { ...accounts[i], name: (name || "").trim() || accounts[i].name };
  writeAccounts(accounts);
  writeSession({ ...session, name: accounts[i].name });
  setUserName(accounts[i].name);
  return toPublic(accounts[i]);
}
