// Apps Script Web App との通信（JSONP 取得 / iframe POST）と認証判定。
// 各画面が個別に持っていた実装をここへ集約する。url は呼び出し側が渡す。

import type { TripData } from "./types";
import { errorMessage } from "./dom";

export type AppsScriptParams = Record<string, string | number | undefined>;

/** すべての action のレスポンスを包含する緩い型 */
export interface AppsScriptResponse {
  ok?: boolean;
  error?: string;
  token?: string;
  expiresAt?: number;
  data?: TripData;
  url?: string;
  status?: string;
  cached?: boolean;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  shared?: boolean;
  fileId?: string;
  name?: string;
  now?: number;
  [key: string]: unknown;
}

/** JSONP で GET する（action=data/auth/... など） */
export function callAppsScript(url: string, params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("appsScriptUrl が未設定です"));
      return;
    }
    const callback = "__tripJsonp_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const queryParams: Record<string, string> = { callback, cachebust: String(Date.now()) };
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) queryParams[key] = String(value);
    });
    const query = new URLSearchParams(queryParams);
    const globalScope = window as unknown as Record<string, unknown>;
    globalScope[callback] = (response: AppsScriptResponse | undefined): void => {
      delete globalScope[callback];
      script.remove();
      if (!response || response.ok === false) {
        reject(new Error(response && response.error ? response.error : "Apps Script API error"));
        return;
      }
      resolve(response);
    };
    script.onerror = (): void => {
      delete globalScope[callback];
      script.remove();
      reject(new Error("Apps Script APIを読み込めませんでした"));
    };
    script.async = true;
    script.src = url + (url.includes("?") ? "&" : "?") + query.toString();
    document.head.appendChild(script);
  });
}

export interface PostOptions {
  /** 期待する postMessage の source 値 */
  source: string;
  /** uploadId / iframe 名のプレフィックス */
  idPrefix?: string;
  timeoutMs?: number;
  timeoutMessage?: string;
  failMessage?: string;
}

/** 非表示 iframe へ form POST し、postMessage で結果を受け取る（大きな本文・レシート等） */
export function postAppsScript(
  url: string,
  params: AppsScriptParams,
  options: PostOptions,
): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error("appsScriptUrl が未設定です"));
      return;
    }
    const idPrefix = options.idPrefix || "post";
    const timeoutMs = options.timeoutMs ?? 60000;
    const timeoutMessage = options.timeoutMessage || "通信がタイムアウトしました";
    const failMessage = options.failMessage || "通信に失敗しました";
    const uploadId = `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const iframeName = `${idPrefix}Frame_${uploadId.replace(/[^A-Za-z0-9_]/g, "_")}`;
    const iframe = document.createElement("iframe");
    const form = document.createElement("form");
    const cleanup = (): void => {
      window.removeEventListener("message", onMessage);
      form.remove();
      iframe.remove();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      const data = (event.data || {}) as {
        source?: string;
        uploadId?: string;
        response?: AppsScriptResponse;
      };
      if (data.source !== options.source || data.uploadId !== uploadId) return;
      clearTimeout(timer);
      cleanup();
      const response = data.response || {};
      if (response.ok === false) {
        reject(new Error(response.error || failMessage));
        return;
      }
      resolve(response);
    };

    iframe.name = iframeName;
    iframe.hidden = true;
    form.hidden = true;
    form.method = "POST";
    form.action = url;
    form.target = iframeName;

    const allParams: AppsScriptParams = { ...params, uploadId };
    Object.entries(allParams).forEach(([key, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value == null ? "" : String(value);
      form.appendChild(input);
    });

    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const AUTH_ERROR_RE = /auth|token|password|Authentication|Invalid token|Token expired|認証|権限|Password/i;

export function isAuthError(error: unknown): boolean {
  return AUTH_ERROR_RE.test(errorMessage(error));
}
