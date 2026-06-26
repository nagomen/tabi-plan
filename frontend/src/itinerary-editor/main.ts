// 行程編集ページ。docs/itinerary-editor.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// JSONP（callAppsScript）で Apps Script と通信し、認証ゲート・行程の読み込み・
// 絞り込み・各行の表示上書き保存（itineraryUpdate）を行う。

import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "../shared/config";
import type { ItineraryItem, ItineraryEdit, TripData } from "../shared/types";

// ---- 補助型 -------------------------------------------------------------

/** Apps Script JSONP のレスポンス共通形 */
interface AppsScriptResponse {
  ok?: boolean;
  error?: string;
  token?: string;
  expiresAt?: number;
  data?: TripData;
  [key: string]: unknown;
}

/** callAppsScript に渡すパラメータ */
type AppsScriptParams = Record<string, string | number | undefined>;

/** ローカルストレージに保存する認証セッション */
interface AuthSession {
  ok?: boolean;
  token?: string;
  expiresAt?: number;
}

interface AppState {
  data: TripData | null;
  rows: ItineraryItem[];
  filter: string;
  day: string;
}

// ---- 設定 ---------------------------------------------------------------

function applyDocumentTripTitle(title: string | undefined): void {
  const tripTitle = title || "旅行";
  document.title = `行程編集 | ${tripTitle}`;
}

const CONFIG: TripConfig = normalizeTripConfig(
  mergeConfig(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    readGlobalTripConfig() as Record<string, unknown>,
  ) as unknown as TripConfig,
);
applyDocumentTripTitle(CONFIG.tripTitle);

// ---- DOM ヘルパー -------------------------------------------------------

const rootElement = document.getElementById("editor");
if (!rootElement) {
  throw new Error("editor 要素が見つかりません");
}
const root: HTMLElement = rootElement;

/** root 配下から要素を取得し、無ければ throw する型付き qs */
function qs<E extends Element = Element>(selector: string): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

/** root 配下の要素を配列で返す */
function qsa<E extends Element = Element>(selector: string): E[] {
  return Array.from(root.querySelectorAll<E>(selector));
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

const state: AppState = { data: null, rows: [], filter: "", day: "" };

// ---- Apps Script 通信 ---------------------------------------------------

function callAppsScript(params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    const callback = "__tripEditorCallback_" + Math.random().toString(36).slice(2);
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
    script.src =
      CONFIG.appsScriptUrl +
      (CONFIG.appsScriptUrl.includes("?") ? "&" : "?") +
      query.toString();
    document.head.appendChild(script);
  });
}

// ---- 認証 ---------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readAuthSession(): AuthSession {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.auth.storageKey) || "{}") as AuthSession;
  } catch (_) {
    return {};
  }
}

function hasAuthSession(): boolean {
  if (!CONFIG.auth.enabled) return true;
  try {
    const session = readAuthSession();
    return Boolean(session && session.expiresAt && Date.now() < session.expiresAt && session.token);
  } catch (_) {
    return false;
  }
}

function getAuthToken(): string {
  try {
    const session = readAuthSession();
    return session && session.expiresAt && Date.now() < session.expiresAt
      ? session.token || ""
      : "";
  } catch (_) {
    return "";
  }
}

function saveAuthSession(token: string | undefined, expiresAt: number | undefined): void {
  const days = Number(CONFIG.auth.rememberDays || 1);
  localStorage.setItem(
    CONFIG.auth.storageKey,
    JSON.stringify({
      ok: true,
      token: token || "",
      expiresAt: expiresAt || Date.now() + days * 24 * 60 * 60 * 1000,
    }),
  );
}

function clearAuthSession(): void {
  localStorage.removeItem(CONFIG.auth.storageKey);
}

function requestPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!CONFIG.auth.enabled || hasAuthSession()) {
      resolve(true);
      return;
    }

    const gate = document.createElement("div");
    gate.className = "ed-auth";
    gate.innerHTML = `
          <form class="ed-auth-box">
            <h2>行程編集を開く</h2>
            <div class="ed-auth-body">
              <input type="password" autocomplete="current-password" autofocus aria-label="パスワード">
              <button type="submit">開く</button>
              <div class="ed-auth-error" aria-live="polite"></div>
            </div>
          </form>`;
    document.body.appendChild(gate);

    const form = gate.querySelector("form");
    const input = gate.querySelector("input");
    const error = gate.querySelector<HTMLElement>(".ed-auth-error");
    if (!form || !input || !error) {
      gate.remove();
      resolve(true);
      return;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const passwordHash = await sha256Hex(input.value || "");
        const response = await callAppsScript({ action: "auth", passwordHash });
        saveAuthSession(response.token, response.expiresAt);
        gate.remove();
        resolve(true);
      } catch (apiError) {
        input.value = "";
        input.focus();
        error.textContent = errorMessage(apiError) || "認証に失敗しました。";
      }
    });
  });
}

function isAuthError(error: unknown): boolean {
  const message = errorMessage(error);
  return /auth|token|password|Authentication|Invalid token|Token expired|認証|権限|Password/i.test(
    message,
  );
}

// ---- データ読み込み -----------------------------------------------------

async function loadData(didRetryAuth: boolean): Promise<void> {
  try {
    qs<HTMLElement>("[data-status]").textContent = "読み込み中";
    const response = await callAppsScript({
      action: "data",
      token: getAuthToken(),
      includeHidden: "true",
    });
    const data = response.data;
    if (!data) throw new Error("データを取得できませんでした");
    state.data = data;
    state.rows = data.itinerary || [];
    qs<HTMLElement>("[data-trip-title]").textContent =
      (data.trip && data.trip.title) || CONFIG.tripTitle || "旅行";
    qs<HTMLElement>("[data-status]").textContent = `行程 ${state.rows.length}件`;
    renderDayFilter();
    renderList();
  } catch (error) {
    if (!didRetryAuth && isAuthError(error)) {
      clearAuthSession();
      await requestPassword();
      return loadData(true);
    }
    qs<HTMLElement>("[data-list]").innerHTML = `<div class="ed-error">${escapeHtml(
      errorMessage(error) || "読み込みに失敗しました。",
    )}</div>`;
    qs<HTMLElement>("[data-status]").textContent = "読み込み失敗";
  }
}

// ---- 絞り込み -----------------------------------------------------------

function renderDayFilter(): void {
  const select = qs<HTMLSelectElement>("[data-day-filter]");
  const days = Array.from(
    new Map(state.rows.map((row) => [row.date, row] as const)).values(),
  );
  select.innerHTML =
    `<option value="">すべての日</option>` +
    days
      .map(
        (row) =>
          `<option value="${escapeHtml(row.date)}">${escapeHtml(row.date)} ${escapeHtml(
            row.day || "",
          )} ${escapeHtml(row.area || "")}</option>`,
      )
      .join("");
  select.value = state.day;
}

function rowText(row: ItineraryItem): string {
  const edit: ItineraryEdit = row.edit || {};
  return [
    row.date,
    row.day,
    row.area,
    row.title,
    row.place,
    row.note,
    edit.rawMemo,
    edit.origin,
    edit.destination,
    edit.transport,
    edit.purpose,
  ]
    .join(" ")
    .toLowerCase();
}

function filteredRows(): ItineraryItem[] {
  const filter = state.filter.trim().toLowerCase();
  return state.rows.filter((row) => {
    if (state.day && row.date !== state.day) return false;
    if (filter && !rowText(row).includes(filter)) return false;
    return true;
  });
}

// ---- 描画 ---------------------------------------------------------------

function sourceLine(row: ItineraryItem): string {
  const edit: ItineraryEdit = row.edit || {};
  const route =
    edit.origin && edit.destination
      ? `${edit.origin} -> ${edit.destination}`
      : row.place || row.area || "";
  return [route, edit.transport, edit.duration, edit.status, edit.certainty]
    .filter(Boolean)
    .join(" / ");
}

function renderList(): void {
  const rows = filteredRows();
  const list = qs<HTMLElement>("[data-list]");
  if (!rows.length) {
    list.innerHTML = `<div class="ed-empty">該当する行程はありません。</div>`;
    return;
  }
  list.innerHTML = rows.map(renderRow).join("");
  qsa<HTMLFormElement>("[data-row-form]").forEach((form) => {
    form.addEventListener("input", () => {
      form.dataset.dirty = "true";
      const msg = form.querySelector<HTMLElement>("[data-row-msg]");
      if (msg) {
        msg.textContent = "未保存";
        msg.className = "ed-row-msg";
      }
    });
    form.addEventListener("change", () => {
      form.dataset.dirty = "true";
    });
    form.addEventListener("submit", saveRow);
  });
}

function renderRow(row: ItineraryItem): string {
  const edit: ItineraryEdit = row.edit || {};
  const visible = edit.visible !== false;
  return `
        <form class="ed-row ${visible ? "" : "is-hidden"}" data-row-form data-row-number="${escapeHtml(
          row.rowNumber || "",
        )}">
          <div class="ed-row-head">
            <div class="ed-date">${escapeHtml(row.date || "")}<br>${escapeHtml(row.day || "")}</div>
            <div class="ed-title">
              <b>${escapeHtml(row.title || "")}</b>
              <span>${escapeHtml(sourceLine(row))}</span>
            </div>
            <div class="ed-status">${visible ? "公開" : "非表示"}</div>
          </div>
          <div class="ed-body">
            <label class="ed-field">
              <span>表示時刻</span>
              <input name="displayTime" value="${escapeHtml(edit.displayTime || row.time || "")}" placeholder="07:00 / 午前 / 夜">
            </label>
            <label class="ed-field wide">
              <span>表示タイトル</span>
              <input name="displayTitle" value="${escapeHtml(edit.displayTitle || "")}" placeholder="${escapeHtml(row.title || "")}">
            </label>
            <label class="ed-field">
              <span>天気</span>
              <input name="weather" value="${escapeHtml(edit.weather || "")}" placeholder="24C / 18C">
            </label>
            <label class="ed-field wide">
              <span>表示場所</span>
              <input name="displayPlace" value="${escapeHtml(edit.displayPlace || "")}" placeholder="${escapeHtml(row.place || "")}">
            </label>
            <label class="ed-field wide">
              <span>地図検索</span>
              <input name="mapQuery" value="${escapeHtml(edit.mapQuery || "")}" placeholder="${escapeHtml(row.mapQuery || row.place || "")}">
            </label>
            <label class="ed-field full">
              <span>表示メモ</span>
              <textarea name="displayNote" placeholder="${escapeHtml(edit.rawMemo || "")}">${escapeHtml(edit.displayNote || "")}</textarea>
            </label>
            <label class="ed-field full">
              <span>必要情報</span>
              <textarea name="needed" placeholder="当日見るべき情報だけ">${escapeHtml(edit.needed || "")}</textarea>
            </label>
          </div>
          <div class="ed-actions">
            <label class="ed-visible">
              <input type="checkbox" name="visible" ${visible ? "checked" : ""}>
              <span>公開ページに表示</span>
            </label>
            <div class="ed-row-msg" data-row-msg></div>
            <button class="ed-save" type="submit">保存</button>
          </div>
        </form>`;
}

function inputControl(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

function textAreaControl(form: HTMLFormElement, name: string): HTMLTextAreaElement {
  return form.elements.namedItem(name) as HTMLTextAreaElement;
}

async function saveRow(event: Event): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
  const msg = form.querySelector<HTMLElement>("[data-row-msg]");
  const setMsg = (text: string, type: "error" | "ok" | ""): void => {
    if (!msg) return;
    msg.textContent = text || "";
    msg.className = "ed-row-msg" + (type ? ` is-${type}` : "");
  };
  if (button) button.disabled = true;
  setMsg("保存中", "");
  try {
    const response = await callAppsScript({
      action: "itineraryUpdate",
      token: getAuthToken(),
      includeHidden: "true",
      rowNumber: form.dataset.rowNumber,
      displayTime: inputControl(form, "displayTime").value,
      displayTitle: inputControl(form, "displayTitle").value,
      displayPlace: inputControl(form, "displayPlace").value,
      displayNote: textAreaControl(form, "displayNote").value,
      needed: textAreaControl(form, "needed").value,
      mapQuery: inputControl(form, "mapQuery").value,
      weather: inputControl(form, "weather").value,
      visible: inputControl(form, "visible").checked ? "TRUE" : "FALSE",
    });
    const data = response.data;
    if (!data) throw new Error("データを取得できませんでした");
    state.data = data;
    state.rows = data.itinerary || [];
    qs<HTMLElement>("[data-status]").textContent = `保存しました / 行程 ${state.rows.length}件`;
    form.dataset.dirty = "false";
    setMsg("保存しました", "ok");
    renderDayFilter();
    renderList();
  } catch (error) {
    if (isAuthError(error)) clearAuthSession();
    setMsg(errorMessage(error) || "保存に失敗しました", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

// ---- 初期化 -------------------------------------------------------------

function initFilters(): void {
  qs<HTMLInputElement>("[data-filter]").addEventListener("input", (event) => {
    state.filter = (event.target as HTMLInputElement).value || "";
    renderList();
  });
  qs<HTMLSelectElement>("[data-day-filter]").addEventListener("change", (event) => {
    state.day = (event.target as HTMLSelectElement).value || "";
    renderList();
  });
}

qs<HTMLElement>("[data-trip-title]").textContent = CONFIG.tripTitle || "旅行";

async function init(): Promise<void> {
  initFilters();
  await requestPassword();
  await loadData(false);
}

void init();
