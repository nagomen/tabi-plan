// 共有パスワード認証セッション（localStorage）。
// Apps Script モードのページが共有する。storageKey とポリシーは auth 設定から取る。

import type { AuthConfig } from "./config";
import { authenticateAppsScript, sha256Hex } from "./apps-script";
import { errorMessage } from "./dom";

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

export interface PasswordGateOptions {
  auth: AuthConfig;
  appsScriptUrl: string;
  classPrefix: string;
  title: string;
  submitLabel?: string;
  showDescription?: boolean;
}

/** Apps Script / ローカルハッシュ認証で共通のパスワードゲートを表示する。 */
export function requestPasswordGate(options: PasswordGateOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!options.auth.enabled || hasAuthSession(options.auth)) {
      resolve(true);
      return;
    }

    const prefix = options.classPrefix;
    const gate = document.createElement("div");
    gate.className = prefix;
    gate.innerHTML = `
      <form class="${prefix}-box">
        <h2>${options.title}</h2>
        <div class="${prefix}-body">
          ${options.showDescription === false ? "" : "<p>共有されたパスワードを入力してください。</p>"}
          <label>
            パスワード
            <input type="password" autocomplete="current-password" autofocus aria-label="パスワード" placeholder="パスワードを入力">
          </label>
          <button type="submit">${options.submitLabel || "開く"}</button>
          <div class="${prefix}-error" aria-live="polite"></div>
        </div>
      </form>`;
    document.body.appendChild(gate);

    const form = gate.querySelector<HTMLFormElement>("form");
    const input = gate.querySelector<HTMLInputElement>("input");
    const error = gate.querySelector<HTMLElement>(`.${prefix}-error`);
    if (!form || !input || !error) {
      gate.remove();
      resolve(false);
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = input.value || "";
      try {
        if (options.auth.mode === "appsScript") {
          const response = await authenticateAppsScript(options.appsScriptUrl, password);
          saveAuthSession(options.auth, response.token, response.expiresAt);
        } else {
          if (!options.auth.passwordHash) throw new Error("passwordHash が未設定です。");
          if (await sha256Hex(password) !== options.auth.passwordHash) {
            throw new Error("パスワードが違います。");
          }
          saveAuthSession(options.auth, undefined, undefined);
        }
        gate.remove();
        resolve(true);
      } catch (authError) {
        input.value = "";
        input.focus();
        error.textContent = errorMessage(authError) || "認証に失敗しました。";
      }
    });
  });
}
