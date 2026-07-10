// 行程編集ページ。docs/itinerary-editor.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// JSONP（callAppsScript）で Apps Script と通信し、認証ゲート・行程の読み込み・
// 絞り込み・各行の表示上書き保存（itineraryUpdate）を行う。

import "../shared/ui.css";
import { initPageTransitions } from "../shared/page-transition";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "../shared/config";
import * as TripPlans from "../shared/plans-store";
import type { ItineraryItem, ItineraryEdit, TripData } from "../shared/types";
import { escapeHtml, errorMessage, makeScopedQuery } from "../shared/dom";
import { icon } from "../shared/icons";
import {
  hasAuthSession as hasAuthSessionShared,
  getAuthToken as getAuthTokenShared,
  saveAuthSession as saveAuthSessionShared,
  clearAuthSession as clearAuthSessionShared,
} from "../shared/auth";
import {
  callAppsScript as callAppsScriptShared,
  postAppsScript as postAppsScriptShared,
  sha256Hex,
  isAuthError,
  type AppsScriptParams,
  type AppsScriptResponse,
} from "../shared/apps-script";
import { mountAppHeader } from "../shared/app-header";

initPageTransitions();

// ---- 補助型 -------------------------------------------------------------

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

// 選択中プラン（?plan= / active）を反映して、対象の旅行を編集する。
const BASE_TRIP_CONFIG = readGlobalTripConfig();
const PLAN_OVERRIDE = TripPlans.resolveConfigOverride(BASE_TRIP_CONFIG);
const CONFIG: TripConfig = normalizeTripConfig(
  mergeConfig(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    mergeConfig(
      BASE_TRIP_CONFIG as unknown as Record<string, unknown>,
      PLAN_OVERRIDE as unknown as Record<string, unknown>,
    ),
  ) as unknown as TripConfig,
);
applyDocumentTripTitle(CONFIG.tripTitle);

// ---- DOM ヘルパー -------------------------------------------------------

const rootElement = document.getElementById("editor");
if (!rootElement) {
  throw new Error("editor 要素が見つかりません");
}
const root: HTMLElement = rootElement;

mountAppHeader({
  mount: "#editor [data-app-header]",
  kicker: "Itinerary",
  title: "行程編集",
  meta: [
    { attr: "data-trip-title", text: "旅行" },
    { attr: "data-status", text: "読み込み中" },
  ],
  actions: [
    { kind: "link", display: "text", icon: "home", text: "ダッシュボード", label: "ダッシュボードへ", href: "index.html" },
  ],
});

const { qs, qsa } = makeScopedQuery(root);
const callAppsScript = (params: AppsScriptParams): Promise<AppsScriptResponse> =>
  callAppsScriptShared(CONFIG.appsScriptUrl, params);
/** 行程更新用の iframe POST。トークンや更新内容をクエリ文字列に残す GET/JSONP を避ける。
 *  source は backend/src/main.ts の POST_ACTIONS と対応させること。 */
const postItineraryUpdate = (params: AppsScriptParams): Promise<AppsScriptResponse> =>
  postAppsScriptShared(
    CONFIG.appsScriptUrl,
    { ...params, action: "itineraryUpdate" },
    {
      source: "trip-itinerary-update",
      idPrefix: "itinerary-update",
      timeoutMessage: "通信がタイムアウトしました",
      failMessage: "保存に失敗しました",
    },
  );
const hasAuthSession = (): boolean => hasAuthSessionShared(CONFIG.auth);
const getAuthToken = (): string => getAuthTokenShared(CONFIG.auth.storageKey);
const saveAuthSession = (token?: string, expiresAt?: number): void =>
  saveAuthSessionShared(CONFIG.auth, token, expiresAt);
const clearAuthSession = (): void => clearAuthSessionShared(CONFIG.auth.storageKey);

const state: AppState = { data: null, rows: [], filter: "", day: "" };

// ---- 認証 ---------------------------------------------------------------

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
            <button class="ed-save" type="submit">${icon("check")}保存</button>
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
    const glyph =
      type === "ok"
        ? icon("checkCircle")
        : type === "error"
          ? icon("exclamationTriangle")
          : "";
    msg.innerHTML = glyph + escapeHtml(text || "");
    msg.className = "ed-row-msg" + (type ? ` is-${type}` : "");
  };
  if (button) button.disabled = true;
  setMsg("保存中", "");
  try {
    const response = await postItineraryUpdate({
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

function initIcons(): void {
  const dashboardLink = qs<HTMLAnchorElement>(".ed-dashboard");
  dashboardLink.insertAdjacentHTML("afterbegin", icon("home"));
  const searchIcon = qs<HTMLElement>("[data-search-icon]");
  searchIcon.innerHTML = icon("magnifyingGlass");
  const dayIcon = qs<HTMLElement>("[data-day-icon]");
  dayIcon.innerHTML = icon("calendarDays");
}

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
  initIcons();
  initFilters();
  await requestPassword();
  await loadData(false);
}

void init();
