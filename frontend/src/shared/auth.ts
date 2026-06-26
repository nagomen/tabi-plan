// 共有パスワード認証セッション（localStorage）。
// Apps Script モードのページが共有する。storageKey とポリシーは auth 設定から取る。

import type { AuthConfig } from "./config";

export interface AuthSession {
  ok?: boolean;
  token?: string;
  expiresAt?: number;
}

export function readAuthSession(storageKey: string): AuthSession {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}") as AuthSession;
  } catch {
    return {};
  }
}

/**
 * 有効なセッションがあるか。
 * appsScript モードではトークン必須、それ以外（local 認証）はトークン無しでも可。
 */
export function hasAuthSession(auth: AuthConfig): boolean {
  if (!auth.enabled) return true;
  const session = readAuthSession(auth.storageKey);
  return Boolean(
    session &&
    session.expiresAt &&
    Date.now() < session.expiresAt &&
    (auth.mode !== "appsScript" || session.token),
  );
}

export function getAuthToken(storageKey: string): string {
  const session = readAuthSession(storageKey);
  return session && session.expiresAt && Date.now() < session.expiresAt ? session.token || "" : "";
}

export function saveAuthSession(
  auth: AuthConfig,
  token: string | undefined,
  expiresAt: number | undefined,
): void {
  const days = Number(auth.rememberDays || 1);
  localStorage.setItem(
    auth.storageKey,
    JSON.stringify({
      ok: true,
      token: token || "",
      expiresAt: expiresAt || Date.now() + days * 24 * 60 * 60 * 1000,
    }),
  );
}

export function clearAuthSession(storageKey: string): void {
  localStorage.removeItem(storageKey);
}
