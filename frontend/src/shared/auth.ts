// 共有パスワード認証セッション（localStorage）。

import type { AuthConfig } from "./config";
import { errorMessage } from "./dom";

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface AuthSession {
  ok?: boolean;
  expiresAt?: number;
}

export function readAuthSession(storageKey: string): AuthSession {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}") as AuthSession;
  } catch {
    return {};
  }
}

/** 有効なセッションがあるか。 */
export function hasAuthSession(auth: AuthConfig): boolean {
  if (!auth.enabled) return true;
  const session = readAuthSession(auth.storageKey);
  return Boolean(
    session &&
    session.expiresAt &&
    Date.now() < session.expiresAt,
  );
}

export function saveAuthSession(auth: AuthConfig): void {
  const days = Number(auth.rememberDays || 1);
  try {
    localStorage.setItem(
      auth.storageKey,
      JSON.stringify({
        ok: true,
        expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
      }),
    );
  } catch {
    // プライベートモード等では記憶できないだけで、このセッションの認証は通す。
  }
}

export interface PasswordGateOptions {
  auth: AuthConfig;
  classPrefix: string;
  title: string;
  submitLabel?: string;
  showDescription?: boolean;
}

/** ローカルハッシュ認証のパスワードゲートを表示する。 */
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
        if (!options.auth.passwordHash) throw new Error("passwordHash が未設定です。");
        if (await sha256Hex(password) !== options.auth.passwordHash) {
          throw new Error("パスワードが違います。");
        }
        saveAuthSession(options.auth);
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
