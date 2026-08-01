// 旅行ダッシュボード本体。docs/index.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// データ取得（sample / googleSheets / appsScript / local）、日別タイムライン、
// Leaflet 地図、費用精算・明細、本人設定・認証、Service Worker 登録を担う。

import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";

import { icon, type IconName } from "../shared/icons";

initPageTransitions();

import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "../shared/config";
import * as TripPlans from "../shared/plans-store";
import { getUser } from "../shared/user-store";
import { canEditPlan, canViewPlan, planHasOwner } from "../shared/membership";
import { currentAccount } from "../shared/account-store";
import { incrementView } from "../shared/views-store";
import { planCoverImage, planCoverImageForLocation } from "../shared/cover";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import * as Permissions from "../shared/permissions-store";
import * as ExpenseStore from "../shared/expense-store";
import { escapeHtml, makeScopedQuery } from "../shared/dom";
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
import { uploadReceiptPhoto as uploadReceiptPhotoShared } from "../shared/receipt-photo";
import { loadData, normalizeDate, numberOrNaN, formatYen } from "./data-source";
import { renderLeafletMap } from "./leaflet-map";
import type { DayGroup, LeafletState } from "./types";
import { registerServiceWorker } from "../shared/pwa";
import { mountAppHeader, setAppHeaderHero } from "../shared/app-header";
import { getPayLink, isPayUrl } from "../shared/payment-links";
import { fetchDayWeather, weatherLabel } from "../shared/weather";
import { buildItineraryShareText } from "../shared/itinerary-text";
import { taskStatus, nextTaskStatus, setTaskStatus, checklistSummary, TASK_STATUS_LABEL } from "../shared/checklist";
import * as Backend from "../shared/backend";
import type {
  TripData,
  TripLink,
  ItineraryItem,
  Settlement,
  SettlementTransfer,
  ExpenseDetail,
  LocalInfoItem,
  LatLng,
} from "../shared/types";

// ---- 補助型 -------------------------------------------------------------

/** ローカルストレージに保存する本人プロフィール */
interface ProfileRecord {
  name?: string;
  savedAt?: string;
}

/** 地図に投影したプレースポイント（x/y は SVG 用の割合座標） */
type ProjectedPlace = ItineraryItem & { x: number; y: number };

interface HeaderCoverMeta {
  slug: string;
  route?: string;
  title: string;
  cover?: string;
}

interface AppState {
  data: TripData;
  days: DayGroup[];
  active: number;
  /** 「この日の予定」フィードで下に展開して表示している最後の日 index */
  viewEnd: number;
  source: string;
}

// ---- 設定 ---------------------------------------------------------------

function applyDocumentTripTitle(title: string | undefined): void {
  const tripTitle = title || "旅行";
  document.title = `${tripTitle}ダッシュボード`;
  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute("content", tripTitle);
}

const BASE_TRIP_CONFIG = readGlobalTripConfig();
const PLAN_OVERRIDE = TripPlans.resolveConfigOverride(BASE_TRIP_CONFIG) || {};
const CONFIG: TripConfig = normalizeTripConfig(
  mergeConfig(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    mergeConfig(
      BASE_TRIP_CONFIG as Record<string, unknown>,
      PLAN_OVERRIDE as Record<string, unknown>,
    ) as Record<string, unknown>,
  ) as unknown as TripConfig,
);
applyDocumentTripTitle(CONFIG.tripTitle);

// ---- サンプルデータ -----------------------------------------------------

const SAMPLE: TripData = {
  trip: {
    title: CONFIG.tripTitle || "サンプル旅行",
    dates: "2027/3/10 - 3/12",
    members: "参加者A / 参加者B",
    note: "共有メモ: 予約番号や住所などの詳細はスプレッドシート側で管理してください。",
  },
  links: [
    { key: "itinerary", label: "旅程", icon: "旅", url: "https://docs.google.com/spreadsheets/", caption: "Google Sheets" },
    { key: "maps", label: "My Maps", icon: "地", url: "https://www.google.com/maps/d/", caption: "Google My Maps" },
    { key: "expenseSheet", label: "費用", icon: "￥", url: "https://docs.google.com/spreadsheets/", caption: "Google Sheets" },
    { key: "photos", label: "写真", icon: "写", url: "https://photos.google.com/", caption: "Google Photos" },
    { key: "packing", label: "持ち物リスト", icon: "荷", url: "https://docs.google.com/spreadsheets/", caption: "Google Sheets" },
  ],
  settlement: {
    paid: "¥3,200",
    paidLabel: "精算額",
    expenseTotal: "¥28,400",
    progress: 50,
    yourPaid: "¥14,200",
    yourDue: "¥3,200",
    transfers: [
      { from: "参加者B", to: "参加者A", amount: 3200, amountLabel: "¥3,200" },
    ],
    rateDetails: [
      { date: "2027-03-10", payer: "参加者A", title: "夕食", currency: "JPY", amount: "¥8,000", rateDate: "2027-03-10", rate: 1, converted: "¥8,000" },
      { date: "2027-03-11", payer: "参加者B", title: "タクシー", currency: "USD", amount: "USD 35", rateDate: "2027-03-11", rate: 150, converted: "¥5,250" },
    ],
    expenseDetails: [
      { date: "2027-03-10", payer: "参加者A", category: "食費", title: "夕食", mode: "全員で等分", amountLabel: "¥8,000", convertedLabel: "¥8,000", myShareLabel: "¥4,000", targetNames: ["参加者A", "参加者B"], shares: [{ name: "参加者A", amount: 4000, amountLabel: "¥4,000" }] },
      { date: "2027-03-11", payer: "参加者B", category: "交通", title: "タクシー", mode: "選んだ人だけで等分", amountLabel: "USD 35", convertedLabel: "¥5,250", myShareLabel: "¥2,625", targetNames: ["参加者A", "参加者B"], shares: [{ name: "参加者A", amount: 2625, amountLabel: "¥2,625" }] },
    ],
    rateWarnings: [],
    baseCurrency: "JPY",
    photoTitle: "旅行アルバム",
    photoMeta: "Google Photos",
  },
  checklist: [
    { label: "交通と宿の予約状況確認", done: true },
    { label: "保険と緊急連絡先の確認", done: false },
    { label: "モバイル通信の設定", done: false },
    { label: "荷物の最終確認", done: false },
  ],
  localInfo: [
    { country: "日本", currencyCode: "JPY", currencyName: "円", approxRate: "1 JPY = ¥1", rateUpdatedAt: "", feeFreeAtm: "必要に応じて記入", atmBest: "", atmFee: "", atmNote: "", rideBest: "タクシーアプリ", rideAlt: "公共交通", paymentNote: "国内旅行では原則JPYで入力" },
    { country: "海外渡航先", currencyCode: "USD", currencyName: "現地通貨", approxRate: "為替レートシートで管理", rateUpdatedAt: "", feeFreeAtm: "現地で確認", atmBest: "", atmFee: "", atmNote: "DCCは原則拒否", rideBest: "", rideAlt: "", paymentNote: "カードと少額現金を併用" },
  ],
  itinerary: [
    { date: "2027-03-10", day: "Day 1", area: "東京", time: "10:00", type: "move", typeLabel: "移動", title: "集合", place: "東京駅", note: "集合場所を確認。", lat: 35.6812, lng: 139.7671, mapQuery: "東京駅", weather: "" },
    { date: "2027-03-10", day: "Day 1", area: "京都", time: "13:00", type: "move", typeLabel: "移動", title: "京都へ移動", place: "京都駅", note: "新幹線または航空券を確認。", lat: 34.9858, lng: 135.7588, mapQuery: "京都駅", weather: "" },
    { date: "2027-03-10", day: "Day 1", area: "京都", time: "18:30", type: "food", typeLabel: "食事", title: "夕食", place: "京都市内", note: "予約名を確認。", lat: 35.0116, lng: 135.7681, mapQuery: "京都市", weather: "" },
    { date: "2027-03-11", day: "Day 2", area: "京都", time: "09:30", type: "sight", typeLabel: "観光", title: "市内観光", place: "京都市内", note: "混雑状況を見て順番を調整。", lat: 35.0116, lng: 135.7681, mapQuery: "京都市 観光", weather: "" },
  ],
};

// ---- DOM ヘルパー -------------------------------------------------------

const rootElement = document.getElementById("tripLive");
if (!rootElement) {
  throw new Error("tripLive 要素が見つかりません");
}
const root: HTMLElement = rootElement;

// 計画のカバー画像（サムネ）をヘッダー背景のヒーローに使う。
const coverMeta = TripPlans.get(CONFIG.tripSlug) ?? {
  slug: CONFIG.tripSlug,
  route: "",
  title: CONFIG.tripTitle,
};

const appHeaderEl = mountAppHeader({
  mount: "#tripLive [data-app-header]",
  hero: planCoverImage(coverMeta),
  kicker: "Shared Travel Dashboard",
  title: "Tabi Plan",
  titleAttr: "data-title",
  back: { href: "plans.html", label: "計画一覧へ戻る" },
  actions: [
    {
      kind: "link",
      display: "icon",
      icon: "pencilSquare",
      label: "計画を編集",
      href: "#",
      attr: "data-edit-head",
      hidden: true,
    },
    { kind: "button", display: "icon", icon: "user", label: "マイページ", attr: "data-mypage" },
  ],
});

/** root にスコープした型付き qs/qsa（shared/dom 由来） */
const { qs, qsa } = makeScopedQuery(root);

// セクション見出し・ボタンの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
qsa<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.innerHTML = icon(name as IconName);
});

function setText(selector: string, value: string | undefined): void {
  qs(selector).textContent = value || "";
}

function setHtml(selector: string, value: string | undefined): void {
  qs(selector).innerHTML = value || "";
}

function mapsSearch(query: string | undefined): string {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query || "");
}

function mapsDir(places: ItineraryItem[]): string {
  const clean = places.map((p) => p.mapQuery || p.place).filter(Boolean) as string[];
  if (clean.length < 2) return mapsSearch(clean[0] || "");
  const origin = clean[0];
  const destination = clean[clean.length - 1];
  const waypoints = clean.slice(1, -1).join("|");
  return "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(origin) +
    "&destination=" + encodeURIComponent(destination) +
    (waypoints ? "&waypoints=" + encodeURIComponent(waypoints) : "");
}

function mapsEmbedDirections(places: ItineraryItem[]): string {
  const clean = places.map((p) => p.mapQuery || p.place).filter(Boolean) as string[];
  if (!CONFIG.mapEmbed.mapsEmbedApiKey || clean.length < 2) return "";
  const origin = clean[0];
  const destination = clean[clean.length - 1];
  const waypoints = clean.slice(1, -1).join("|");
  return "https://www.google.com/maps/embed/v1/directions?key=" + encodeURIComponent(CONFIG.mapEmbed.mapsEmbedApiKey) +
    "&origin=" + encodeURIComponent(origin) +
    "&destination=" + encodeURIComponent(destination) +
    (waypoints ? "&waypoints=" + encodeURIComponent(waypoints) : "") +
    "&mode=transit";
}

// ---- 状態 ---------------------------------------------------------------

const state: AppState = { data: SAMPLE, days: [], active: 0, viewEnd: 0, source: "sample" };
let mobileView = "home";
const leafletState: LeafletState = { map: null, layer: null, followActive: true };
let expenseDetailsOpen = false;
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

function activeDayCoverMeta(): HeaderCoverMeta {
  const configuredCover = "cover" in coverMeta ? coverMeta.cover : "";
  return {
    ...coverMeta,
    cover: configuredCover || state.data.trip?.cover || "",
    route: coverMeta.route || "",
    title: state.data.trip?.title || coverMeta.title || CONFIG.tripTitle,
  };
}

function dayCoverLocation(day: DayGroup): string {
  const items = day.items || [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const loc = item.area || (String(item.type) === "move" ? item.destination : "") || item.place || item.mapQuery || "";
    if (loc.trim()) return loc.trim();
  }
  return day.area || "";
}

function updateHeaderHero(day: DayGroup): void {
  const meta = activeDayCoverMeta();
  setAppHeaderHero(appHeaderEl, planCoverImageForLocation(meta, dayCoverLocation(day)));
}

// ---- Apps Script 通信 ---------------------------------------------------

/** Apps Script(Web App) が無い構成では、費用は端末内 JSON で保存・精算する。 */
function usingLocalExpenses(): boolean {
  return !CONFIG.appsScriptUrl;
}

/** ローカル保存の費用記録から精算を計算し、settlement に反映する。 */
function localSettlement(): Settlement {
  const participants = expenseParticipants(state.data || SAMPLE);
  const profileName = currentProfileName(participants);
  const records = ExpenseStore.list(CONFIG.tripSlug);
  return ExpenseStore.computeSettlement(records, participants, profileName);
}

/** shared/apps-script を CONFIG.appsScriptUrl にバインドした JSONP 取得 */
const callAppsScript = (params: AppsScriptParams): Promise<AppsScriptResponse> =>
  callAppsScriptShared(CONFIG.appsScriptUrl, params);

/** 費用登録・精算完了など、状態を変更するアクション用の iframe POST。
 *  トークンや金額をクエリ文字列に残す GET/JSONP を避けるため POST で送る。
 *  source は backend/src/main.ts の POST_ACTIONS と対応させること。 */
const MUTATING_ACTION_SOURCE = {
  expense: "trip-expense-save",
  settlementComplete: "trip-settlement-complete",
  itineraryUpdate: "trip-itinerary-update",
} as const;

const postAppsScriptAction = (
  action: keyof typeof MUTATING_ACTION_SOURCE,
  params: AppsScriptParams,
): Promise<AppsScriptResponse> =>
  postAppsScriptShared(
    CONFIG.appsScriptUrl,
    { ...params, action },
    {
      source: MUTATING_ACTION_SOURCE[action],
      idPrefix: action,
      timeoutMessage: "通信がタイムアウトしました",
      failMessage: "保存に失敗しました",
    },
  );

// ---- 画像処理 -----------------------------------------------------------

const uploadReceiptPhoto = (file: File): Promise<AppsScriptResponse> =>
  uploadReceiptPhotoShared(CONFIG.appsScriptUrl, getAuthToken(), file);

// ---- 描画フロー ---------------------------------------------------------

function renderData(data: TripData | null | undefined, source?: string): void {
  const previousDay = state.days[state.active];
  const previousDate = previousDay ? previousDay.date : "";
  state.data = data || SAMPLE;
  state.source = source || CONFIG.mode;
  state.days = groupDays(state.data.itinerary || []);
  const sameDayIndex = previousDate ? state.days.findIndex((day) => day.date === previousDate) : -1;
  state.active = sameDayIndex >= 0 ? sameDayIndex : chooseActive(state.days);
  renderBase();
  renderActive();
  applyMobileView(mobileView);
}

function setLoading(isLoading: boolean, label?: string): void {
  root.classList.toggle("is-loading", Boolean(isLoading));
  const loading = root.querySelector("[data-loading]");
  const loadingLabel = root.querySelector("[data-loading-label]");
  if (loading) loading.setAttribute("aria-busy", String(Boolean(isLoading)));
  if (loadingLabel && label) loadingLabel.textContent = label;
}

// ---- 認証 / プロフィール ------------------------------------------------

// 認証セッション系は shared/auth を CONFIG.auth にバインドして使う。
const hasAuthSession = (): boolean => hasAuthSessionShared(CONFIG.auth);
const getAuthToken = (): string => getAuthTokenShared(CONFIG.auth.storageKey);
const saveAuthSession = (token?: string, expiresAt?: number): void =>
  saveAuthSessionShared(CONFIG.auth, token, expiresAt);
const clearAuthSession = (): void => clearAuthSessionShared(CONFIG.auth.storageKey);

function readProfile(): ProfileRecord | null {
  try {
    const profile = JSON.parse(localStorage.getItem(CONFIG.profile.storageKey) || "{}") as ProfileRecord;
    return profile && profile.name ? profile : null;
  } catch {
    return null;
  }
}

function saveProfile(name: string): void {
  localStorage.setItem(CONFIG.profile.storageKey, JSON.stringify({
    name,
    savedAt: new Date().toISOString(),
  }));
}

function saveExpenseEntryCache(data: TripData): void {
  const participants = expenseParticipants(data || SAMPLE);
  if (!participants.length) return;
  localStorage.setItem(CONFIG.expenseCache.storageKey, JSON.stringify({
    participants,
    tripTitle: (data && data.trip && data.trip.title) || CONFIG.tripTitle || "旅行",
    savedAt: new Date().toISOString(),
  }));
}

function currentProfileName(participants: string[]): string {
  const profile = readProfile();
  if (!profile || !profile.name) return "";
  if (!participants || !participants.length) return profile.name;
  return participants.includes(profile.name) ? profile.name : "";
}

function profileInitial(name: string | undefined): string {
  return String(name || "?").trim().slice(0, 1) || "?";
}

function applyProfileDefaults(form: HTMLFormElement | null, participants: string[]): void {
  const name = currentProfileName(participants);
  const payer = form?.elements.namedItem("payer") as HTMLSelectElement | null;
  if (!name || !payer) return;
  payer.value = name;
}

function showIdentityModal(required: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(".tl-identity-modal");
    if (existing) existing.remove();

    const participants = expenseParticipants(state.data || SAMPLE);
    const savedName = currentProfileName(participants);
    const options = participants.map((name) =>
      `<option value="${escapeHtml(name)}" ${name === savedName ? "selected" : ""}>${escapeHtml(name)}</option>`,
    ).join("");
    const modal = document.createElement("div");
    modal.className = "tl-identity-modal";
    modal.innerHTML = `
      <form class="tl-identity-card" role="dialog" aria-modal="true" aria-labelledby="identityTitle">
        <header>
          <div>
            <h2 id="identityTitle">あなたは誰ですか</h2>
            <p>この端末に保存して、支払者などの初期値に使います。</p>
          </div>
          <div class="tl-identity-mark" data-identity-mark>${escapeHtml(profileInitial(savedName))}</div>
        </header>
        <div class="tl-identity-body">
          <label class="tl-identity-field">
            <span>本人として使う名前</span>
            <select name="profileName" required>
              <option value="">選択してください</option>
              ${options}
            </select>
          </label>
          <div class="tl-identity-actions">
            <span class="tl-identity-note">ブラウザのローカルストレージにだけ保存されます。</span>
            <button type="submit">登録する</button>
            ${required ? "" : `<button class="secondary" type="button" data-identity-close>閉じる</button>`}
          </div>
        </div>
      </form>`;
    document.body.appendChild(modal);

    const form = qs<HTMLFormElement>("form", modal);
    const select = qs<HTMLSelectElement>("select", modal);
    const mark = qs<HTMLElement>("[data-identity-mark]", modal);
    const close = modal.querySelector<HTMLButtonElement>("[data-identity-close]");
    select.focus();
    select.addEventListener("change", () => {
      mark.textContent = profileInitial(select.value);
    });
    if (close) {
      close.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = select.value;
      if (!name) {
        select.focus();
        return;
      }
      saveProfile(name);
      modal.remove();
      const expenseForm = root.querySelector<HTMLFormElement>("[data-expense-form-native]");
      applyProfileDefaults(expenseForm, participants);
      renderBase();
      renderActive();
      resolve(true);
    });
  });
}

async function requestIdentityIfNeeded(): Promise<void> {
  // 読み取り専用（他人の公開計画の閲覧）では費用に関わらないので本人設定は求めない。
  if (READ_ONLY) return;
  // ログイン済みなら本人確認は不要。端末プロフィール未設定ならアカウント名を本人に使う。
  const account = currentAccount();
  if (account) {
    if (!readProfile() && account.name) saveProfile(account.name);
    return;
  }
  const participants = expenseParticipants(state.data || SAMPLE);
  if (!currentProfileName(participants)) {
    await showIdentityModal(true);
  }
}

function requestPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!CONFIG.auth.enabled || hasAuthSession()) {
      resolve(true);
      return;
    }

    const gate = document.createElement("div");
    gate.className = "tl-auth";
    gate.innerHTML = `
      <form class="tl-auth-box">
        <h2>旅行ページを開く</h2>
        <div class="tl-auth-body">
          <p>共有されたパスワードを入力してください。</p>
          <label>
            パスワード
            <input type="password" autocomplete="current-password" autofocus aria-label="パスワード" placeholder="パスワードを入力">
          </label>
          <button type="submit">送信</button>
          <div class="tl-auth-error" aria-live="polite"></div>
        </div>
      </form>`;
    document.body.appendChild(gate);

    const form = qs<HTMLFormElement>("form", gate);
    const input = qs<HTMLInputElement>("input", gate);
    const error = qs<HTMLElement>(".tl-auth-error", gate);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value || "";
      if (CONFIG.auth.mode === "appsScript") {
        try {
          const passwordHash = await sha256Hex(value);
          const response = await callAppsScript({ action: "auth", passwordHash });
          saveAuthSession(response.token, response.expiresAt);
          gate.remove();
          resolve(true);
        } catch (apiError) {
          input.value = "";
          input.focus();
          error.textContent = (apiError as Error).message || "認証に失敗しました。";
        }
        return;
      }
      if (!CONFIG.auth.passwordHash) {
        error.textContent = "passwordHash が未設定です。";
        return;
      }
      const hash = await sha256Hex(value);
      if (hash === CONFIG.auth.passwordHash) {
        saveAuthSession();
        gate.remove();
        resolve(true);
      } else {
        input.value = "";
        input.focus();
        error.textContent = "パスワードが違います。";
      }
    });
  });
}

// ---- 日付ユーティリティ -------------------------------------------------

function todayISO(): string {
  if (CONFIG.todayOverride) return CONFIG.todayOverride;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 現在時刻を分（0-1439）で返す。 */
function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function nowHM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" を分に変換（解析不可なら null）。 */
function timeToMinutes(time: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分差を「あとN分 / あとN時間M分」の形にする。 */
function untilLabel(minutes: number): string {
  if (minutes <= 0) return "まもなく";
  if (minutes < 60) return `あと${minutes}分`;
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `あと${h}時間${mm}分` : `あと${h}時間`;
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tripDateRange(data: TripData): string[] {
  const datesText = String(data.trip?.dates || "");
  const parts = datesText.split(/\s+-\s+/);
  let start = normalizeDate(parts[0]);
  let end = normalizeDate(parts[1] || parts[0]);
  if (start && end && /^\d{1,2}-\d{1,2}$/.test(end)) {
    end = normalizeDate(`${start.slice(0, 4)}-${end}`);
  }
  if ((!start || !end) && data.cities && data.cities.length) {
    const cityDates = data.cities.flatMap((city) => [normalizeDate(city.fromDate), normalizeDate(city.toDate)]).filter(Boolean).sort();
    start = start || cityDates[0] || "";
    end = end || cityDates[cityDates.length - 1] || "";
  }
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a || !b || b < a) return [];
  const dates: string[] = [];
  let cursor = a;
  let guard = 0;
  while (cursor <= b && guard < 400) {
    dates.push(toIsoDate(cursor));
    cursor = addDays(cursor, 1);
    guard++;
  }
  return dates;
}

function cityNameForDate(data: TripData, date: string): string {
  const cities = data.cities || [];
  let current = "";
  let currentFrom = "";
  cities.forEach((city) => {
    const from = normalizeDate(city.fromDate);
    const to = normalizeDate(city.toDate);
    if (city.name && from && to && from <= date && date <= to && from >= currentFrom) {
      current = city.name;
      currentFrom = from;
    }
  });
  return current;
}

function groupDays(itinerary: ItineraryItem[], data: TripData = state.data): DayGroup[] {
  const map = new Map<string, DayGroup>();
  itinerary
    .map((item) => ({ ...item, date: normalizeDate(item.date), lat: numberOrNaN(item.lat), lng: numberOrNaN(item.lng) }))
    .forEach((item) => {
      const key = item.date || "undated";
      if (!map.has(key)) {
        map.set(key, { date: key, day: item.day || "", area: item.area || item.place || "", weather: item.weather || "", items: [] });
      }
      const day = map.get(key)!;
      day.items.push(item);
      day.day = day.day || item.day || "";
      day.area = day.area || item.area || item.place || "";
      day.weather = day.weather || item.weather || "";
    });
  tripDateRange(data).forEach((date) => {
    if (!map.has(date)) {
      map.set(date, { date, day: "", area: cityNameForDate(data, date), weather: "", items: [] });
    }
  });
  return Array.from(map.values())
    .sort((a, b) => {
      if (a.date === "undated") return 1;
      if (b.date === "undated") return -1;
      return a.date.localeCompare(b.date);
    })
    .map((day, index) => ({
      ...day,
      day: day.day || `Day ${index + 1}`,
      area: day.area || cityNameForDate(data, day.date),
    }));
}

function chooseActive(days: DayGroup[]): number {
  const today = todayISO();
  let index = days.findIndex((day) => day.date === today);
  if (index >= 0) return index;
  index = days.findIndex((day) => day.date > today);
  return index >= 0 ? index : Math.max(0, days.length - 1);
}

function linkByKey(key: string): TripLink | Partial<TripLink> {
  return state.data.links.find((link) => link.key === key) || {};
}

/** リンク種別ごとに Heroicon を返す（タイルアイコン用、data の icon は据え置き） */
function linkIcon(key: string): string {
  switch (key) {
    case "itinerary": return icon("ticket");
    case "maps": return icon("map");
    case "expenseSheet": return icon("banknotes");
    case "budget": return icon("banknotes");
    case "photos": return icon("photo");
    case "packing": return icon("briefcase");
    case "reservations": return icon("calendarDays");
    default: return icon("arrowTopRightOnSquare");
  }
}

function uniquePlaces(items: ItineraryItem[]): ItineraryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.mapQuery || item.place || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function projectPlaces(items: ItineraryItem[]): ProjectedPlace[] {
  const places = uniquePlaces(items);
  const withLatLng = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) as (ItineraryItem & { lat: number; lng: number })[];
  if (withLatLng.length >= 2) {
    const lats = withLatLng.map((p) => p.lat);
    const lngs = withLatLng.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latSpan = maxLat - minLat || 1;
    const lngSpan = maxLng - minLng || 1;
    return places.map((p, index) => ({
      ...p,
      x: Number.isFinite(p.lng) ? 10 + ((Number(p.lng) - minLng) / lngSpan) * 80 : 15 + index * 16,
      y: Number.isFinite(p.lat) ? 82 - ((Number(p.lat) - minLat) / latSpan) * 64 : 50,
    }));
  }
  return places.map((p, index) => ({ ...p, x: 12 + index * (76 / Math.max(1, places.length - 1)), y: index % 2 ? 42 : 58 }));
}

// ---- 表示モード（モバイル / セクション） --------------------------------

function applyMobileView(view?: string): void {
  mobileView = view || mobileView || "home";
  if (mobileView === "map") leafletState.followActive = true;
  root.dataset.sectionView = mobileView;
  root.dataset.mobileView = mobileView;
  root.classList.add("is-mobile-responsive");
  syncStickyOffsets();
  qsa<HTMLElement>("[data-mobile-view]").forEach((node) => {
    const views = String(node.dataset.mobileView || "").split(/\s+/);
    node.classList.toggle("is-mobile-active", views.includes(mobileView));
  });
  qsa<HTMLElement>("[data-section-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sectionNav === mobileView));
  });
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.mobileNav === mobileView));
  });
  if (mobileView === "home" || mobileView === "map") {
    setTimeout(() => {
      refreshMapLayout();
      if (mobileView === "map" && state.days.length && !leafletState.map) renderActive();
    }, 80);
  }
}

function syncStickyOffsets(): void {
  const head = root.querySelector<HTMLElement>(".ah");
  if (!head) return;
  root.style.setProperty("--tl-head-height", `${Math.ceil(head.getBoundingClientRect().height)}px`);
}

function refreshMapLayout(): void {
  const map = leafletState.map;
  if (!map) return;
  map.invalidateSize();
  window.requestAnimationFrame(() => {
    leafletState.map?.invalidateSize();
    window.setTimeout(() => leafletState.map?.invalidateSize(), 120);
  });
}

/** 費用入力ボトムシートの開閉。入力フォームは [data-expense-entry] にマウント済み。 */
function setExpenseSheet(open: boolean): void {
  const sheet = root.querySelector<HTMLElement>("[data-expense-sheet]");
  if (!sheet) return;
  sheet.hidden = !open;
  document.documentElement.style.overflow = open ? "hidden" : "";
  if (open) {
    const first = sheet.querySelector<HTMLInputElement | HTMLSelectElement>(
      "input:not([type=hidden]):not([type=file]), select",
    );
    if (first) setTimeout(() => first.focus(), 60);
  }
}

// ---- 費用・精算描画 -----------------------------------------------------

function renderTransfers(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-transfers]");
  if (!mount) return;
  const transfers = settlement.transfers || [];
  if (!transfers.length) {
    mount.innerHTML = `<h3>精算する金額</h3><div class="tl-transfer-row"><span>現時点で精算する支払いはありません</span><b>¥0</b></div><div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
    return;
  }
  mount.innerHTML = `<h3>精算する金額</h3>` + transfers.map((transfer: SettlementTransfer & { completedLabel?: string }) =>
    `<div class="tl-transfer-row">
      <span>${escapeHtml(transfer.from)} → ${escapeHtml(transfer.to)}</span>
      <div class="tl-transfer-act">
        <b>${escapeHtml(transfer.amountLabel || "")}</b>
        <button type="button" class="tl-paypay" data-paypay data-to="${escapeHtml(transfer.to)}" data-amount="${Number(transfer.amount || 0)}">PayPayで送る</button>
        <button type="button" data-settlement-complete data-from="${escapeHtml(transfer.from)}" data-to="${escapeHtml(transfer.to)}" data-amount="${Number(transfer.amount || 0)}">精算完了</button>
      </div>
      ${transfer.completedLabel ? `<small>完了済み ${escapeHtml(transfer.completedLabel)} を差し引き済み</small>` : ""}
    </div>`,
  ).join("") + `<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
  setupSettlementCompleteHandlers(mount);
}

/** PayPay 受取リンクを開き、金額をクリップボードへコピーして送金を補助する。 */
async function payViaPayPay(to: string, amount: number, status: HTMLElement | null): Promise<void> {
  const link = getPayLink(to);
  let copied = false;
  try {
    await navigator.clipboard.writeText(String(Math.round(amount)));
    copied = true;
  } catch {
    /* クリップボード不可でも続行 */
  }
  const setStatus = (text: string): void => {
    if (status) {
      status.textContent = text;
      status.classList.remove("is-error");
    }
  };
  if (link?.paypay && isPayUrl(link.paypay)) {
    window.open(link.paypay, "_blank", "noopener");
    setStatus(
      `${to} の PayPay を開きました。${copied ? `金額 ${formatYen(amount)} をコピー済み。貼り付けて送金してください。` : `金額は ${formatYen(amount)} です。`}`,
    );
  } else if (link?.paypay) {
    setStatus(`${to} の PayPay ID: ${link.paypay}（金額 ${formatYen(amount)}${copied ? " をコピー済み" : ""}）`);
  } else {
    setStatus(`${to} の受取リンクが未登録です。マイページ → 送金 で登録できます。`);
  }
}

function setupSettlementCompleteHandlers(mount: HTMLElement): void {
  const status = mount.querySelector<HTMLElement>("[data-settlement-status]");
  mount.querySelectorAll<HTMLButtonElement>("[data-paypay]").forEach((button) => {
    button.addEventListener("click", () => {
      void payViaPayPay(button.dataset.to || "", Number(button.dataset.amount || 0), status);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-settlement-complete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const from = button.dataset.from || "";
      const to = button.dataset.to || "";
      const amount = Number(button.dataset.amount || 0);
      if (!from || !to || !amount) return;
      button.disabled = true;
      if (status) status.textContent = `${from} → ${to} を精算完了にしています...`;
      try {
        if (usingLocalExpenses()) {
          // 端末内 JSON に精算記録を追加（from→to の振込を相殺）。
          ExpenseStore.add(CONFIG.tripSlug, {
            kind: "settlement",
            payer: from,
            targets: [to],
            amount,
            title: `${from} → ${to} 精算`,
            splitMode: "精算不要",
            note: `サイト上で${from}から${to}への精算完了`,
          });
        } else {
          const response = await postAppsScriptAction("settlementComplete", {
            token: getAuthToken(),
            from,
            to,
            amount,
            note: `サイト上で${from}から${to}への精算完了`,
          });
          if (response.data) {
            state.data = response.data;
            state.days = groupDays(state.data.itinerary || []);
          }
        }
        renderBase();
        renderActive();
        const nextStatus = root.querySelector<HTMLElement>("[data-settlement-status]");
        if (nextStatus) {
          nextStatus.textContent = `${from} → ${to} を精算完了にしました。`;
          nextStatus.classList.add("is-ok");
        }
      } catch (error) {
        if (isAuthError(error)) clearAuthSession();
        if (status) {
          status.textContent = (error as Error).message || "精算完了の登録に失敗しました。";
          status.classList.add("is-error");
        }
      } finally {
        button.disabled = false;
      }
    });
  });
}

function renderExpenseDetails(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-details]");
  const button = root.querySelector<HTMLButtonElement>("[data-expense-detail-toggle]");
  if (!mount || !button) return;

  const participants = expenseParticipants(state.data || SAMPLE);
  const profileName = currentProfileName(participants);
  const details = settlement.expenseDetails || [];
  const related = profileName ? details.filter((detail) => {
    const shares = detail.shares || [];
    const targetNames = detail.targetNames || [];
    return targetNames.includes(profileName) ||
      shares.some((share) => share.name === profileName && Number(share.amount || 0) > 0);
  }) : [];

  button.textContent = expenseDetailsOpen ? "費用明細を閉じる" : "費用明細を見る";
  button.setAttribute("aria-expanded", String(expenseDetailsOpen));
  mount.classList.toggle("is-visible", expenseDetailsOpen);

  button.onclick = (): void => {
    expenseDetailsOpen = !expenseDetailsOpen;
    renderExpenseDetails(settlement);
  };

  if (!expenseDetailsOpen) {
    mount.innerHTML = "";
    return;
  }

  if (!profileName) {
    mount.innerHTML = `<div class="tl-expense-empty">本人設定を登録すると、自分に関連する費用明細を表示できます。</div>`;
    return;
  }

  if (!related.length) {
    mount.innerHTML = `<div class="tl-expense-empty">${escapeHtml(profileName)}に関連する費用はまだありません。</div>`;
    return;
  }

  const shareFor = (detail: ExpenseDetail): string => {
    const share = (detail.shares || []).find((item) => item.name === profileName);
    if (share) return share.amountLabel || formatYen(share.amount);
    if (detail.myShareLabel) return detail.myShareLabel;
    return "-";
  };
  const roleFor = (detail: ExpenseDetail): string => {
    const isPayer = detail.payer === profileName;
    const hasShare = (detail.shares || []).some((item) => item.name === profileName && Number(item.amount || 0) > 0) ||
      (detail.targetNames || []).includes(profileName);
    if (isPayer && hasShare) return "支払・負担";
    if (isPayer) return "立替のみ";
    return "負担";
  };

  mount.innerHTML = `
    <div class="tl-expense-details-head">
      <b>${escapeHtml(profileName)}に関連する費用</b>
      <span>${related.length}件</span>
    </div>
    <div class="tl-expense-table-wrap">
      <table class="tl-expense-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>内容</th>
            <th>支払者</th>
            <th>区分</th>
            <th>精算範囲</th>
            <th>支払額</th>
            <th>自分の負担</th>
          </tr>
        </thead>
        <tbody>
          ${related.map((detail) => `
            <tr>
              <td>${escapeHtml(detail.date || "")}</td>
              <td>${escapeHtml(detail.title || "立替")}${detail.category ? `<br><small>${escapeHtml(detail.category)}</small>` : ""}</td>
              <td>${escapeHtml(detail.payer || "")}</td>
              <td>${escapeHtml(roleFor(detail))}</td>
              <td>${escapeHtml(detail.mode || "")}</td>
              <td>${escapeHtml(detail.convertedLabel || detail.amountLabel || "")}${detail.amountLabel && detail.convertedLabel && detail.amountLabel !== detail.convertedLabel ? `<br><small>${escapeHtml(detail.amountLabel)}</small>` : ""}</td>
              <td>${escapeHtml(shareFor(detail))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>`;
}

interface ParticipantSource {
  participants?: { name?: string; displayName?: string; [key: string]: unknown }[];
  trip?: { members?: string };
}

/** 本人の名前（ログイン中のアカウント名 → 端末のユーザー名 → 保存済みプロフィール）。 */
function selfName(): string {
  const account = currentAccount();
  if (account && account.name.trim()) return account.name.trim();
  const user = getUser().name.trim();
  if (user) return user;
  const profile = readProfile();
  return (profile && profile.name ? profile.name : "").trim();
}

/**
 * 参加者一覧に本人を必ず含める。
 * メンバー未設定の計画（1人で作った計画・招待前の計画）では支払者の候補に自分が出ず、
 * 本人設定も参加者一覧に一致しないため費用を自分名義で追加できなくなる。
 * 閲覧のみの計画では他人の割り勘に自分を混ぜないので、追加しない。
 */
function withSelf(names: string[]): string[] {
  const me = READ_ONLY ? "" : selfName();
  if (!me || names.includes(me)) return names;
  return [me, ...names];
}

function expenseParticipants(data: TripData): string[] {
  const source = data as TripData & ParticipantSource;
  const fromData = (source.participants || [])
    .map((member) => member && (member.name || member.displayName || (member["表示名"] as string | undefined)))
    .filter((name): name is string => Boolean(name));
  if (fromData.length) return withSelf(fromData);
  const fromMembers = String((data.trip && data.trip.members) || "")
    .split(/\s*\/\s*|、|,|\n/)
    .map((name) => name.trim())
    .filter((name) => name && !/\d+人|共有メンバー/.test(name));
  if (fromMembers.length) return withSelf(fromMembers);
  // メンバーも本人も分からないときだけダミー名にフォールバックする。
  const onlySelf = withSelf([]);
  return onlySelf.length ? onlySelf : CONFIG.defaultParticipants || ["参加者A", "参加者B"];
}

function expenseCurrencies(data: TripData): string[] {
  const localInfoRows = (data.localInfo || []) as (LocalInfoItem & Record<string, unknown>)[];
  const fromLocalInfo = localInfoRows
    .map((row) => row && (row.currencyCode || (row["currency"] as string | undefined) || (row["通貨コード"] as string | undefined)))
    .filter((code): code is string => Boolean(code));
  return Array.from(new Set(["JPY"].concat(CONFIG.currencies || [], fromLocalInfo)))
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);
}

function renderExpenseEntry(data: TripData): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-entry]");
  if (!mount) return;
  const existingForm = mount.querySelector<HTMLFormElement>("[data-expense-form-native]");
  if (existingForm && existingForm.dataset.dirty === "true") return;
  const participants = expenseParticipants(data);
  const currencyOptions = expenseCurrencies(data).map((code) => `<option>${escapeHtml(code)}</option>`).join("");
  const profileName = currentProfileName(participants);
  const payerOptions = participants.map((name) => `<option value="${escapeHtml(name)}" ${name === profileName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const targetPicks = participants.map((name) => `
    <label class="tl-pick">
      <input type="checkbox" name="targets" value="${escapeHtml(name)}" checked>
      <span>${escapeHtml(name)}</span>
    </label>`).join("");
  const shareInputs = participants.map((name) => `
    <label class="tl-field">
      <span>${escapeHtml(name)}</span>
      <input type="number" name="share-${escapeHtml(name)}" data-share-name="${escapeHtml(name)}" min="0" step="1" inputmode="numeric" placeholder="0">
    </label>`).join("");

  mount.innerHTML = `
    ${usingLocalExpenses() ? "" : `<div class="tl-expense-head">
      <a href="expense-entry.html">別ページで入力する</a>
    </div>`}
    <form class="tl-expense-form" data-expense-form-native>
      <div class="tl-expense-grid">
        <label class="tl-field">
          <span>支払日 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="date" name="paidDate" required>
        </label>
        <label class="tl-field">
          <span>支払者 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <select name="payer" required>${payerOptions}</select>
        </label>
        <label class="tl-field">
          <span>カテゴリ <b class="tl-required-mark" aria-label="必須">*</b></span>
          <select name="category" required>
            <option>食費</option>
            <option>交通</option>
            <option>宿泊</option>
            <option>観光</option>
            <option>通信</option>
            <option>その他</option>
          </select>
        </label>
        <label class="tl-field">
          <span>通貨 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <select name="currency" required>${currencyOptions}</select>
        </label>
        <label class="tl-field wide">
          <span>内容 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="text" name="title" required placeholder="例: 空港からホテルまでのタクシー">
        </label>
        <label class="tl-field wide">
          <span>金額 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="number" name="amount" required min="1" step="1" inputmode="decimal" placeholder="例: 12000">
        </label>
      </div>

      <div class="tl-split">
        <span class="tl-split-label">精算方法 <b class="tl-required-mark" aria-label="必須">*</b></span>
        <div class="tl-segments">
          <label class="tl-segment"><input type="radio" name="splitMode" value="全員で等分" required checked><span>全員で等分</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="選んだ人だけで等分" required><span>選んだ人だけ</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="個別金額を入力" required><span>個別金額</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="精算不要" required><span>精算不要</span></label>
        </div>
      </div>

      <div class="tl-split-detail" data-selected-detail>
        <span class="tl-split-label">割り勘する人</span>
        <div class="tl-participant-picks">${targetPicks}</div>
      </div>

      <div class="tl-split-detail" data-individual-detail>
        <span class="tl-split-label">各自の負担額</span>
        <div class="tl-individual-grid">${shareInputs}</div>
        <div class="tl-share-total" data-share-total>合計 ¥0</div>
      </div>

      <div class="tl-expense-grid">
        <label class="tl-field">
          <span>支払方法</span>
          <select name="paymentMethod">
            <option>カード</option>
            <option>現金</option>
            <option>送金</option>
            <option>その他</option>
          </select>
        </label>
        ${usingLocalExpenses() ? "" : `<label class="tl-field tl-photo-field">
          <span>レシート写真</span>
          <input type="file" name="receiptPhoto" accept="image/*" capture="environment">
        </label>`}
        <label class="tl-field wide">
          <span>メモ</span>
          <textarea name="note" placeholder="任意。為替メモや補足があれば入力"></textarea>
        </label>
      </div>

      <div class="tl-expense-submit">
        <div class="tl-expense-status" data-expense-status aria-live="polite"></div>
        <button type="submit">保存</button>
      </div>
    </form>`;

  const form = qs<HTMLFormElement>("[data-expense-form-native]", mount);
  (form.elements.namedItem("paidDate") as HTMLInputElement).value = todayISO();
  applyProfileDefaults(form, participants);
  setupExpenseEntryHandlers(form, participants);
}

function setupExpenseEntryHandlers(form: HTMLFormElement, participants: string[]): void {
  const selectedDetail = qs<HTMLElement>("[data-selected-detail]", form);
  const individualDetail = qs<HTMLElement>("[data-individual-detail]", form);
  const status = qs<HTMLElement>("[data-expense-status]", form);
  const totalNode = qs<HTMLElement>("[data-share-total]", form);
  const button = qs<HTMLButtonElement>("button[type='submit']", form);
  const amountInput = form.elements.namedItem("amount") as HTMLInputElement;

  const field = (name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  const setStatus = (message: string, type: "error" | "ok" | ""): void => {
    status.textContent = message || "";
    status.classList.toggle("is-error", type === "error");
    status.classList.toggle("is-ok", type === "ok");
  };

  const activeMode = (): string => (field("splitMode") as HTMLInputElement).value;
  const numberValue = (value: unknown): number => {
    const n = Number(String(value || "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const formatInputAmount = (value: number): string => {
    const currency = (field("currency") as HTMLSelectElement).value || "JPY";
    if (currency === "JPY") return formatYen(value);
    return `${currency} ${Math.round(value * 100) / 100}`;
  };
  const shareInputFor = (name: string): HTMLInputElement | undefined =>
    qsa<HTMLInputElement>("[data-share-name]", form).find((input) => input.dataset.shareName === name);
  const individualTotal = (): number => participants.reduce((sum, name) => {
    const input = shareInputFor(name);
    return sum + numberValue(input && input.value);
  }, 0);

  const updateShareTotal = (): void => {
    const total = individualTotal();
    const amount = numberValue(amountInput.value);
    const message = amount ? `合計 ${formatInputAmount(total)} / 支払額 ${formatInputAmount(amount)}` : `合計 ${formatInputAmount(total)}`;
    totalNode.textContent = message;
    totalNode.style.color = /個別金額/.test(activeMode()) && amount && Math.abs(total - amount) > 1 ? "var(--red)" : "var(--muted)";
  };

  const updateMode = (): void => {
    const mode = activeMode();
    selectedDetail.classList.toggle("is-visible", /選んだ人だけ/.test(mode));
    individualDetail.classList.toggle("is-visible", /個別金額/.test(mode));
    updateShareTotal();
  };

  form.addEventListener("change", (event) => {
    form.dataset.dirty = "true";
    if ((event.target as HTMLInputElement).name === "splitMode") updateMode();
    updateShareTotal();
  });
  form.addEventListener("input", () => {
    form.dataset.dirty = "true";
    updateShareTotal();
  });
  updateMode();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (READ_ONLY) {
      setStatus("閲覧のみの計画では費用を追加できません。", "error");
      return;
    }
    const mode = activeMode();
    const targets = qsa<HTMLInputElement>("input[name='targets']:checked", form).map((input) => input.value);
    const individual: Record<string, number> = {};
    participants.forEach((name) => {
      const input = shareInputFor(name);
      const amount = numberValue(input && input.value);
      if (amount) individual[name] = amount;
    });
    const amount = numberValue((field("amount") as HTMLInputElement).value);

    if (/選んだ人だけ/.test(mode) && !targets.length) {
      setStatus("割り勘する人を1人以上選んでください。", "error");
      return;
    }
    if (/個別金額/.test(mode)) {
      const total = individualTotal();
      if (!total) {
        setStatus("個別金額を入力してください。", "error");
        return;
      }
      if (Math.abs(total - amount) > 1) {
        setStatus("個別金額の合計が支払額と一致していません。", "error");
        return;
      }
    }

    button.disabled = true;
    setStatus("保存中...", "");
    try {
      if (usingLocalExpenses()) {
        // 端末内 JSON に保存（Apps Script 不要）。精算は renderBase で再計算。
        ExpenseStore.add(CONFIG.tripSlug, {
          kind: "expense",
          paidDate: (field("paidDate") as HTMLInputElement).value,
          payer: (field("payer") as HTMLSelectElement).value,
          category: (field("category") as HTMLSelectElement).value,
          title: (field("title") as HTMLInputElement).value,
          amount,
          currency: (field("currency") as HTMLSelectElement).value,
          splitMode: mode,
          targets,
          individual,
          paymentMethod: (field("paymentMethod") as HTMLSelectElement).value,
          note: (field("note") as HTMLTextAreaElement).value,
        });
      } else {
        const receiptInput = field("receiptPhoto") as HTMLInputElement;
        const photo = receiptInput && receiptInput.files ? receiptInput.files[0] : null;
        let receiptUrl = "";
        if (photo) {
          setStatus("写真アップロード中...", "");
          const upload = await uploadReceiptPhoto(photo);
          receiptUrl = upload.url || "";
          setStatus("保存中...", "");
        }
        const response = await postAppsScriptAction("expense", {
          token: getAuthToken(),
          paidDate: (field("paidDate") as HTMLInputElement).value,
          payer: (field("payer") as HTMLSelectElement).value,
          category: (field("category") as HTMLSelectElement).value,
          title: (field("title") as HTMLInputElement).value,
          amount: (field("amount") as HTMLInputElement).value,
          currency: (field("currency") as HTMLSelectElement).value,
          splitMode: mode,
          targets: JSON.stringify(targets),
          individual: JSON.stringify(individual),
          paymentMethod: (field("paymentMethod") as HTMLSelectElement).value,
          receiptUrl,
          note: (field("note") as HTMLTextAreaElement).value,
        });
        if (response.data) {
          state.data = response.data;
          state.days = groupDays(state.data.itinerary || []);
        }
      }
      form.reset();
      form.dataset.dirty = "false";
      (field("paidDate") as HTMLInputElement).value = todayISO();
      applyProfileDefaults(form, participants);
      qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => { input.checked = true; });
      updateMode();
      renderBase();
      renderActive();
      setExpenseSheet(false);
      const nextStatus = root.querySelector<HTMLElement>("[data-expense-status]");
      if (nextStatus) {
        nextStatus.textContent = "保存しました。費用を更新済みです。";
        nextStatus.classList.add("is-ok");
      }
    } catch (error) {
      if (isAuthError(error)) clearAuthSession();
      setStatus((error as Error).message || "保存に失敗しました。", "error");
    } finally {
      button.disabled = false;
    }
  });
}

// ---- 基本描画 -----------------------------------------------------------

// ---- ルート（滞在都市セグメント） --------------------------------------

const ROUTE_PALETTE = ["#0b5a42", "#22719d", "#b87418", "#6246a6", "#cf4f3d", "#2f7d6b", "#8a5a2b", "#3b4c8a"];

interface RouteSeg {
  name: string;
  fromDate: string;
  toDate: string;
  firstDayIndex: number;
  nights: number;
  color: string;
}

function nightsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

function mdLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso || "";
}

// 滞在都市セグメントを算出。cities があればそれ、無ければ各日 area の連続区間。
function computeRoute(): { segs: RouteSeg[]; dayToSeg: number[] } {
  const days = state.days;
  const dayToSeg: number[] = new Array(days.length).fill(-1);
  const segs: RouteSeg[] = [];
  const cities = (state.data.cities || []).filter((c) => c.name && c.fromDate && c.toDate);

  if (cities.length) {
    cities.forEach((c, i) =>
      segs.push({
        name: c.name,
        fromDate: c.fromDate,
        toDate: c.toDate,
        firstDayIndex: -1,
        nights: nightsBetween(c.fromDate, c.toDate),
        color: ROUTE_PALETTE[i % ROUTE_PALETTE.length],
      }),
    );
    days.forEach((day, di) => {
      // その日をカバーする都市のうち、開始日が最も新しい（=現在地）ものに割り当て
      let best = -1;
      let bestFrom = "";
      cities.forEach((c, ci) => {
        if (c.fromDate <= day.date && day.date <= c.toDate && c.fromDate >= bestFrom) {
          best = ci;
          bestFrom = c.fromDate;
        }
      });
      dayToSeg[di] = best;
    });
    segs.forEach((s, si) => {
      const idx = dayToSeg.indexOf(si);
      s.firstDayIndex = idx >= 0 ? idx : 0;
    });
  } else {
    let prev: string | null = null;
    days.forEach((day, di) => {
      const area = (day.area || "").trim();
      if (!area) {
        dayToSeg[di] = segs.length ? segs.length - 1 : -1;
        return;
      }
      if (area !== prev) {
        segs.push({
          name: area,
          fromDate: day.date,
          toDate: day.date,
          firstDayIndex: di,
          nights: 0,
          color: ROUTE_PALETTE[segs.length % ROUTE_PALETTE.length],
        });
        prev = area;
      }
      const seg = segs[segs.length - 1];
      seg.toDate = day.date;
      seg.nights = nightsBetween(seg.fromDate, seg.toDate);
      dayToSeg[di] = segs.length - 1;
    });
  }
  return { segs, dayToSeg };
}

function jumpToDay(index: number): void {
  state.active = index;
  state.viewEnd = index; // 日を切り替えたらフィードは1日だけに戻す
  leafletState.followActive = true;
  renderActive();
}

function renderDayTabs(route: { segs: RouteSeg[]; dayToSeg: number[] }): void {
  const dayTab = (day: (typeof state.days)[number], index: number, withArea: boolean): string =>
    `<button class="tl-day" type="button" data-day-index="${index}" aria-selected="${index === state.active}">` +
    `<b>${escapeHtml(day.day || `Day ${index + 1}`)}${withArea ? `<br>${escapeHtml(day.area || "")}` : ""}</b>` +
    `<small>${escapeHtml(mdLabel(day.date))}</small></button>`;

  if (route.segs.length >= 2) {
    let html = "";
    let cur = -2;
    state.days.forEach((day, index) => {
      const seg = route.dayToSeg[index];
      if (seg !== cur) {
        if (cur !== -2) html += "</div></div>";
        const s = route.segs[seg];
        html += `<div class="tl-daygroup" style="--c:${s ? s.color : "#68746e"}">` +
          `<span class="tl-daygroup-label">${escapeHtml(s ? s.name : "—")}</span><div class="tl-daygroup-days">`;
        cur = seg;
      }
      html += dayTab(day, index, false);
    });
    if (cur !== -2) html += "</div></div>";
    setHtml("[data-days]", html);
  } else {
    setHtml("[data-days]", state.days.map((day, index) => dayTab(day, index, true)).join(""));
  }

  qsa<HTMLElement>("[data-day-index]").forEach((button) => {
    button.addEventListener("click", () => jumpToDay(Number(button.dataset.dayIndex)));
  });
}

function renderBase(): void {
  const data = state.data;
  setText("[data-title]", data.trip.title);
  setText("[data-note]", data.trip.note);
  setText("[data-updated]", "最終更新: " + new Date().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));

  const tabs: { key: string; label: string; glyph: string }[] = [
    { key: "home", label: "ホーム", glyph: icon("home") },
    // メンバーは参加メンバー（!READ_ONLY）だけに見せる
    ...(READ_ONLY ? [] : [{ key: "members", label: "メンバー", glyph: icon("users") }]),
    { key: "map", label: "地図", glyph: icon("map") },
    { key: "money", label: "費用", glyph: icon("banknotes") },
    { key: "links", label: "リンク", glyph: icon("link") },
  ];
  qs<HTMLElement>("[data-actions]").style.setProperty("--tl-action-count", String(tabs.length));
  setHtml("[data-actions]", tabs.map((tab) =>
    `<button class="tl-action" type="button" data-section-nav="${tab.key}" aria-selected="${tab.key === mobileView}">
      ${tab.glyph}<b>${tab.label}</b>
    </button>`,
  ).join(""));
  qsa<HTMLElement>("[data-section-nav]").forEach((button) => {
    button.addEventListener("click", () => applyMobileView(button.dataset.sectionNav));
  });

  renderMembers(data);

  qs<HTMLAnchorElement>("[data-my-maps]").href = linkByKey("maps").url || "#";
  qs<HTMLAnchorElement>("[data-photo-link]").href = linkByKey("photos").url || "#";
  qs<HTMLAnchorElement>("[data-photo-button]").href = linkByKey("photos").url || "#";

  if (usingLocalExpenses()) {
    data.settlement = { ...data.settlement, ...localSettlement() };
  }
  const settlement = data.settlement || {};
  setText("[data-paid]", settlement.expenseTotal || "¥0");
  setText("[data-your-paid]", settlement.yourPaid || "—");
  setText("[data-your-due]", settlement.yourDue || "¥0");
  renderTransfers(settlement);
  renderExpenseDetails(settlement);
  setText("[data-photo-title]", settlement.photoTitle || "写真アルバム");
  setText("[data-photo-meta]", settlement.photoMeta || "Google Photos");
  saveExpenseEntryCache(data);
  renderExpenseEntry(data);
  renderLocalInfo(data.localInfo || []);

  const primaryLinks = ["itinerary", "maps", "expenseSheet", "photos"].map(linkByKey).filter((link): link is TripLink => Boolean(link.url));
  const docs = data.links.filter((link) => !["itinerary", "maps", "expenseForm", "photos", "expenseSheet"].includes(link.key)).concat(primaryLinks);
  setHtml("[data-docs]", docs.slice(0, 5).map((doc) =>
    `<a class="tl-doc" href="${doc.url}" target="_blank" rel="noopener">
      <span class="tl-doc-icon">${linkIcon(doc.key)}</span><b>${doc.label}</b><span>${icon("arrowTopRightOnSquare")}</span>
    </a>`,
  ).join(""));

  renderChecklist();

  const route = computeRoute();
  renderDayTabs(route);
  applyMobileView(mobileView);
}

// ---- タスク（チェックリスト） -------------------------------------------

/** タスクを編集・保存できるのはこの端末のローカル計画のみ。 */
function tasksEditable(): boolean {
  return !READ_ONLY && CONFIG.mode === "local";
}

/** ローカル計画のチェックリストを localStorage に保存する。 */
function persistChecklist(): void {
  if (!tasksEditable()) return;
  const stored = TripPlans.getData(CONFIG.tripSlug);
  if (!stored) return;
  stored.checklist = state.data.checklist || [];
  TripPlans.saveData(CONFIG.tripSlug, stored);
}

/** チェックリストを3状態（未着手/進行中/完了）のタスクリストとして描画する。 */
function renderChecklist(): void {
  const items = state.data.checklist || [];
  const editable = tasksEditable();
  const rows = items
    .map((item, index) => {
      const status = taskStatus(item);
      const stateBtn = editable
        ? `<button class="tl-task-state" type="button" data-task-toggle="${index}" aria-label="状態: ${TASK_STATUS_LABEL[status]}（クリックで変更）">${TASK_STATUS_LABEL[status]}</button>`
        : `<span class="tl-task-state" aria-label="状態: ${TASK_STATUS_LABEL[status]}">${TASK_STATUS_LABEL[status]}</span>`;
      const del = editable
        ? `<button class="tl-task-del" type="button" data-task-del="${index}" aria-label="このタスクを削除">${icon("xMark")}</button>`
        : "";
      return `<li class="tl-task is-${status}">${stateBtn}<span class="tl-task-label">${escapeHtml(item.label)}</span>${del}</li>`;
    })
    .join("");

  const summary = checklistSummary(items);
  const summaryHtml = summary.total
    ? `<p class="tl-task-summary">完了 ${summary.done}/${summary.total}<i>·</i>進行中 ${summary.doing}<i>·</i>未着手 ${summary.todo}</p>`
    : "";
  const addHtml = editable
    ? `<form class="tl-task-add" data-task-add><input data-task-input type="text" maxlength="60" placeholder="タスクを追加" aria-label="タスクを追加" autocomplete="off"><button type="submit" aria-label="追加">${icon("plus")}</button></form>`
    : "";
  const emptyHtml = !items.length && !editable ? `<p class="tl-task-empty">タスクはありません</p>` : "";
  setHtml("[data-checks]", `<ul class="tl-tasks">${rows}</ul>${emptyHtml}${addHtml}${summaryHtml}`);
}

/** タスクの状態変更・削除・追加を [data-checks] にデリゲートで束ねる（初期化時に1回）。 */
function bindChecklist(): void {
  const container = root.querySelector<HTMLElement>("[data-checks]");
  if (!container) return;
  container.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const toggle = target.closest<HTMLElement>("[data-task-toggle]");
    if (toggle) {
      const item = (state.data.checklist || [])[Number(toggle.dataset.taskToggle)];
      if (!item) return;
      setTaskStatus(item, nextTaskStatus(taskStatus(item)));
      persistChecklist();
      renderChecklist();
      return;
    }
    const del = target.closest<HTMLElement>("[data-task-del]");
    if (del) {
      const items = state.data.checklist || [];
      items.splice(Number(del.dataset.taskDel), 1);
      persistChecklist();
      renderChecklist();
    }
  });
  container.addEventListener("submit", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-task-add]")) return;
    event.preventDefault();
    const input = container.querySelector<HTMLInputElement>("[data-task-input]");
    const label = (input?.value || "").trim();
    if (!label) return;
    const items = state.data.checklist || (state.data.checklist = []);
    items.push({ label, done: false, status: "todo" });
    if (input) input.value = "";
    persistChecklist();
    renderChecklist();
  });
}

// ---- メンバー（参加者一覧・招待） ---------------------------------------

/** 参加メンバー一覧を描画。招待はローカル計画かつ参加メンバーのみ表示。 */
function renderMembers(data: TripData): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const membersStr = (meta && meta.members) || (data.trip && data.trip.members) || "";
  const names = splitNames(membersStr);
  const myName = getUser().name.trim();

  const countEl = root.querySelector<HTMLElement>("[data-members-count]");
  if (countEl) countEl.textContent = names.length ? `${names.length}人` : "";

  const listEl = root.querySelector<HTMLElement>("[data-members-list]");
  if (listEl) {
    listEl.innerHTML = names.length
      ? names
          .map((n) => {
            const self = Boolean(myName) && n === myName;
            // アイコン/名前をタップするとその人の旅行履歴ページへ。
            return (
              `<a class="tl-member-chip${self ? " is-self" : ""}" href="person.html?name=${encodeURIComponent(n)}" title="${escapeHtml(n)}さんの旅行履歴を見る">` +
              `<span class="tl-member-avatar">${escapeHtml(n.slice(0, 1) || "?")}</span>` +
              `<span>${escapeHtml(n)}</span>` +
              (self ? `<span class="tl-member-self-badge">自分</span>` : "") +
              "</a>"
            );
          })
          .join("")
      : `<div class="tl-members-empty">まだメンバーがいません。下から招待できます。</div>`;
  }

  const inviteEl = root.querySelector<HTMLElement>("[data-members-invite]");
  if (inviteEl) inviteEl.hidden = READ_ONLY || CONFIG.mode !== "local";

  // 脱退は「名前を設定した参加メンバー」だけ（＝自分が一覧にいる）。
  const leaveEl = root.querySelector<HTMLElement>("[data-members-leave]");
  if (leaveEl) leaveEl.hidden = READ_ONLY || !myName || !names.includes(myName);
}

/** 自分をこの旅行のメンバーから外して一覧へ戻る（脱退）。 */
function leaveTrip(): void {
  if (READ_ONLY) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  const myName = getUser().name.trim();
  if (!meta || !myName) return;
  const remaining = splitNames(meta.members || "").filter((n) => n !== myName);
  const merged = remaining.join("、");
  const data = TripPlans.getData(meta.slug);
  if (meta.source === "local" && data) {
    // ローカル計画: 本体データの members も更新（saveLocalPlan が meta も更新）
    data.trip = { ...(data.trip || { title: "", dates: "", members: "", note: "" }), members: merged };
    TripPlans.saveLocalPlan(meta.slug, data);
  } else {
    TripPlans.upsert({ slug: meta.slug, members: merged });
  }
  navigateWithPageTransition("plans.html");
}

function flashButton(btn: HTMLButtonElement, msg: string): void {
  const orig = btn.textContent || "";
  btn.textContent = msg;
  btn.disabled = true;
  window.setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
  }, 1800);
}

/** ボタン内のラベル span だけを一時的に書き換える（アイコンを消さずにフィードバック）。 */
function flashLabel(btn: HTMLButtonElement, labelSel: string, msg: string): void {
  const label = btn.querySelector<HTMLElement>(labelSel);
  if (!label) {
    flashButton(btn, msg);
    return;
  }
  const orig = label.textContent || "";
  label.textContent = msg;
  btn.disabled = true;
  window.setTimeout(() => {
    label.textContent = orig;
    btn.disabled = false;
  }, 1800);
}

/** 旅行の全日程を LINE で送れるテキストにして共有／コピーする。 */
async function shareSchedule(): Promise<void> {
  const btn = root.querySelector<HTMLButtonElement>("[data-copy-schedule]");
  const text = buildItineraryShareText(state.data.trip, state.days);
  if (!text.trim()) {
    if (btn) flashLabel(btn, "[data-copy-schedule-label]", "日程がありません");
    return;
  }
  // モバイルは共有シート（LINE を直接選べる）、非対応環境はクリップボードへコピー。
  if (navigator.share) {
    try {
      await navigator.share({ title: state.data.trip.title || "旅行日程", text });
    } catch {
      /* 共有キャンセルは無視 */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (btn) flashLabel(btn, "[data-copy-schedule-label]", "コピーしました");
  } catch {
    window.prompt("日程をコピーしてLINEに貼り付けてください", text);
  }
}

/** 招待リンクを作成して共有／コピーする（ローカル計画のみ）。 */
async function shareTripInvite(): Promise<void> {
  if (READ_ONLY) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  const planData = TripPlans.getData(CONFIG.tripSlug);
  const btn = root.querySelector<HTMLButtonElement>("[data-invite-share]");
  if (!meta || !planData) {
    if (btn) flashButton(btn, "招待に未対応");
    return;
  }
  const nameInput = root.querySelector<HTMLInputElement>("[data-invite-name]");
  const name = (nameInput?.value || "").trim();
  try {
    const invite = Permissions.createInvite(meta.slug, name || undefined, "editor");
    const link = await buildInviteLink({
      v: 1,
      meta: {
        slug: meta.slug,
        title: meta.title,
        dates: meta.dates,
        members: meta.members,
        route: meta.route,
        updatedAt: meta.updatedAt,
      },
      data: planData,
      // 費用台帳は計画データと別ストアなので、明示的に同梱しないと共有されない。
      expenses: ExpenseStore.list(meta.slug),
      invitedName: name || undefined,
      inviteId: invite?.id,
      role: "editor",
    });
    const shareData = {
      title: meta.title || "旅行計画",
      text: `「${meta.title || "旅行"}」に${name ? `${name}さんを` : ""}招待します`,
      url: link,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        /* 共有キャンセル */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      if (btn) flashButton(btn, "リンクをコピーしました");
    } catch {
      window.prompt("招待リンクをコピーしてください", link);
    }
    if (nameInput) nameInput.value = "";
  } catch {
    if (btn) flashButton(btn, "作成できませんでした");
  }
}

function renderLocalInfo(rows: LocalInfoItem[]): void {
  const items = (rows || []).slice(0, 9);
  setHtml("[data-local-info]", items.map((item) => {
    const currency = [item.currencyCode, item.currencyName].filter(Boolean).join(" / ");
    const rate = [item.approxRate, item.rateUpdatedAt ? `更新 ${item.rateUpdatedAt}` : ""].filter(Boolean).join(" · ");
    const rideRecommendations = [item.rideBest].concat(String(item.rideAlt || "").split("/"))
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .slice(0, 2)
      .join(" / ");
    return `<article class="tl-local-card">
      <div class="tl-local-top">
        <b class="tl-local-country">${escapeHtml(item.country)}</b>
        <span class="tl-local-currency">${escapeHtml(currency || item.approxRate || "")}</span>
      </div>
      <dl class="tl-local-meta">
        <div><dt>為替</dt><dd>${escapeHtml(rate || "-")}</dd></div>
        <div><dt>無料ATM</dt><dd>${escapeHtml(item.feeFreeAtm || "-")}</dd></div>
        <div><dt>配車おすすめ</dt><dd>${escapeHtml(rideRecommendations || "-")}</dd></div>
      </dl>
      <p class="tl-local-note">${escapeHtml([item.atmNote, item.paymentNote].filter(Boolean).join(" / "))}</p>
    </article>`;
  }).join(""));
}

const KIND_ICON: Record<string, IconName> = {
  sight: "camera",
  food: "cake",
  move: "arrowsRightLeft",
  stay: "buildingOffice2",
  todo: "check",
  form: "documentText",
};

function kindIcon(type: string): string {
  return icon(KIND_ICON[type] || "check");
}

// ---- 1日分の「予定」ブロック（複数日を縦に積めるように分離） ----------

function stayOfDay(d: DayGroup | undefined): ItineraryItem | null {
  return d ? d.items.find((i) => String(i.type) === "stay") || null : null;
}

function sameHotel(a: ItineraryItem | null, b: ItineraryItem | null): boolean {
  return !!a && !!b && (a.title || "").trim() === (b.title || "").trim();
}

function stayRowHtml(s: ItineraryItem, variant: string, label: string): string {
  const place = s.place && s.place !== s.title ? s.place : "";
  const sub = variant === " is-prev"
    ? `${label} ・ チェックアウト`
    : s.time ? `${label} ・ IN ${s.time}` : label;
  return `<div class="tl-stay${variant}">
    <span class="tl-stay-ic">${icon("buildingOffice2")}</span>
    <div class="tl-stay-body">
      <span class="tl-stay-label">${escapeHtml(sub)}</span>
      <span class="tl-stay-name">${escapeHtml(s.title || "宿泊先")}</span>
      ${place ? `<span class="tl-stay-place">${escapeHtml(place)}</span>` : ""}
    </div>
    <a class="tl-stay-map" href="${mapsSearch(s.mapQuery || s.place || s.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a>
  </div>`;
}

function stayHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  const todayStay = stayOfDay(day);
  let prevStay: ItineraryItem | null = null;
  for (let k = idx - 1; k >= 0; k--) {
    const s = stayOfDay(state.days[k]);
    if (s) { prevStay = s; break; }
  }
  const continued = sameHotel(prevStay, todayStay);
  const tonight = day.date === todayISO() ? "今夜の宿" : "宿泊";
  const rows: string[] = [];
  if (prevStay && !continued) rows.push(stayRowHtml(prevStay, " is-prev", "前泊"));
  if (todayStay) rows.push(stayRowHtml(todayStay, "", continued ? "連泊" : tonight));
  if (!rows.length) {
    rows.push(`<div class="tl-stay is-empty"><span class="tl-stay-ic">${icon("buildingOffice2")}</span><div class="tl-stay-body"><span class="tl-stay-label">${tonight}</span><span class="tl-stay-name tl-stay-muted">未定</span></div></div>`);
  }
  return rows.join("");
}

function timelineHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  return day.items.filter((i) => String(i.type) !== "stay").map((item) => {
    const type = String(item.type || "todo");
    const placeText = item.place && item.place !== item.title ? `場所: ${item.place}` : "";
    const metaText = [placeText, item.note].filter(Boolean).join(" / ");
    const label = `<span class="tl-kind ${escapeHtml(type)}">${escapeHtml(item.typeLabel || item.type || "予定")}</span>`;

    let segA = item.origin || "";
    let segB = item.destination || "";
    if (type === "move" && (!segA || !segB) && /→|->/.test(item.title || "")) {
      const parts = (item.title || "").split(/→|->/);
      segA = segA || (parts[0] || "").trim();
      segB = segB || (parts[1] || "").trim();
    }
    const title = type === "move" && (segA || segB)
      ? `<div class="tl-seg"><span>${escapeHtml(segA || "出発")}</span><span class="tl-seg-arr">${icon("arrowLongRight")}</span><span>${escapeHtml(segB || "到着")}</span></div>`
      : `<h3>${escapeHtml(item.title || "")}</h3>`;

    return `<article class="tl-item" data-kind="${escapeHtml(type)}">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot ${escapeHtml(type)}">${kindIcon(type)}</span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">${label}${title}</div>
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        <p class="tl-meta">${metaText ? `<span class="tl-meta-text">${escapeHtml(metaText)}</span>` : ""}<a class="tl-maplink" href="${mapsSearch(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a></p>
      </div>
    </article>`;
  }).join("");
}

/** その日を代表する座標（最初の座標付き予定、無ければ area の地名辞書）。 */
function dayCoord(day: DayGroup): LatLng | null {
  for (const it of day.items) {
    const la = Number(it.lat);
    const ln = Number(it.lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) return { lat: la, lng: ln };
  }
  return TripPlans.coordsFor(day.area || "");
}

/** 表示中の各日について、座標と日付から天気を非同期取得してチップを埋める。 */
function hydrateWeather(fromIdx: number, toIdx: number): void {
  for (let i = fromIdx; i <= toIdx; i++) {
    const day = state.days[i];
    if (!day || day.weather) continue; // 手入力（Sheets の天気欄）があれば優先
    const coord = dayCoord(day);
    if (!coord || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    void fetchDayWeather(coord.lat, coord.lng, day.date).then((w) => {
      if (!w) return;
      const span = root.querySelector<HTMLElement>(`[data-weather-for="${day.date}"]`);
      if (span) span.textContent = `${weatherLabel(w)}${w.label ? " " + w.label : ""}`;
    });
  }
}

function dayBlockHtml(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  const head = [day.day, day.area, mdLabel(day.date)].filter(Boolean).join(" ・ ");
  // 手入力があれば表示。無ければ空にしておき、hydrateWeather が自動取得で埋める。
  const weather = `<span class="tl-dayblock-weather" data-weather-for="${escapeHtml(day.date)}">${day.weather ? "☀ " + escapeHtml(day.weather) : ""}</span>`;
  const items = timelineHtmlForDay(idx);
  return `<section class="tl-dayblock" data-day-block="${idx}">
    <div class="tl-dayblock-head"><span>${escapeHtml(head)}</span>${weather}</div>
    ${stayHtmlForDay(idx)}
    ${items || `<p class="tl-dayblock-empty">予定はまだありません</p>`}
  </section>`;
}

/** 今日が選択中の日のとき、現在時刻と「いま/次の予定」を示すカード。 */
function nowNextHtml(day: DayGroup): string {
  if (day.date !== todayISO()) return "";
  const cur = nowMinutes();
  const timed = day.items
    .filter((i) => String(i.type) !== "stay")
    .map((i) => ({ i, m: timeToMinutes(i.time) }))
    .filter((x): x is { i: ItineraryItem; m: number } => x.m != null)
    .sort((a, b) => a.m - b.m);

  let nowLine = "";
  let nextLine = "";
  if (timed.length) {
    const next = timed.find((x) => x.m >= cur);
    const past = [...timed].reverse().find((x) => x.m <= cur);
    if (past && (!next || past.m !== next.m)) {
      nowLine = `<div class="tl-now-line"><span class="tl-now-lead">いま</span><b>${escapeHtml(past.i.time || "")} ${escapeHtml(past.i.title || past.i.typeLabel || "")}</b></div>`;
    }
    if (next) {
      nextLine = `<div class="tl-now-line"><span class="tl-now-lead">次</span><b>${escapeHtml(next.i.time || "")} ${escapeHtml(next.i.title || next.i.typeLabel || "")}</b><span class="tl-now-until">${escapeHtml(untilLabel(next.m - cur))}</span></div>`;
    } else {
      nextLine = `<div class="tl-now-line"><span class="tl-now-lead">次</span><b>本日の予定は終了です</b></div>`;
    }
  }
  return `<section class="tl-now">
    <div class="tl-now-head">${icon("clock")}<span>現在 ${nowHM()} ・ 旅行中</span></div>
    ${nowLine}${nextLine || `<div class="tl-now-line"><span class="tl-now-lead">予定</span><b>時刻つきの予定がありません</b></div>`}
  </section>`;
}

function renderActive(): void {
  const day = state.days[state.active];
  if (!day) return;
  updateHeaderHero(day);
  qsa<HTMLElement>("[data-day-index]").forEach((button) => {
    button.setAttribute("aria-selected", String(Number(button.dataset.dayIndex) === state.active));
  });

  const titleMain = day.date === todayISO() ? "今日の予定" : "この日の予定";
  setHtml("[data-day-title]", `<span>${escapeHtml(titleMain)}</span>`);

  const activePlaces = projectPlaces(day.items);
  const placeNames = activePlaces.map((place) => place.place || place.title).filter(Boolean);
  setText("[data-location-caption]", `現在地: ${day.area || placeNames[0] || "-"} / 次: ${placeNames[1] || placeNames[0] || "-"}`);
  qs<HTMLAnchorElement>("[data-directions]").href = mapsDir(activePlaces);
  void renderMapEmbed(activePlaces, day);
  qs("[data-route]").setAttribute("points", activePlaces.map((p) => `${p.x},${p.y}`).join(" "));
  qsa(".tl-pin").forEach((pin) => pin.remove());
  activePlaces.forEach((place, index) => {
    const pin = document.createElement("a");
    pin.className = "tl-pin" + (index === Math.min(1, activePlaces.length - 1) ? " is-active" : "");
    pin.href = mapsSearch(place.mapQuery || place.place || place.title);
    pin.target = "_blank";
    pin.rel = "noopener";
    pin.style.left = `${place.x}%`;
    pin.style.top = `${place.y}%`;
    pin.innerHTML = `<span class="tl-pin-num">${index + 1}</span><span class="tl-pin-name">${escapeHtml(place.place || place.title)}</span>`;
    qs("[data-map]").appendChild(pin);
  });

  // 「この日の予定」フィード：選択中の日から、展開した日までを縦に積む。
  // 「次の日」を押すと、いまの日の予定を残したまま下に翌日が増える。
  const last = state.days.length - 1;
  const end = Math.min(Math.max(state.active, state.viewEnd), last);
  let feed = nowNextHtml(day);
  for (let i = state.active; i <= end; i++) feed += dayBlockHtml(i);
  if (end < last) {
    const nx = state.days[end + 1];
    const label = [nx.day, nx.area].filter(Boolean).join(" ・ ");
    const remaining = last - end;
    feed += `<div class="tl-more-wrap">` +
      `<button class="tl-more" type="button" data-more-index="${end + 1}">` +
        `<span class="tl-more-label">次の日を表示${label ? ` ・ ${escapeHtml(label)}` : ""}</span>` +
        `<span class="tl-more-ic">${icon("chevronDown")}</span></button>` +
      (remaining > 1 ? `<button class="tl-more-all" type="button" data-more-all="${last}">全て見る（残り${remaining}日）</button>` : "") +
      `</div>`;
  }
  setHtml("[data-day-feed]", feed);
  hydrateWeather(state.active, end);
  const firstNew = end + 1;
  const expand = (target: number): void => {
    state.viewEnd = target;
    renderActive();
    const block = root.querySelector<HTMLElement>(`[data-day-block="${firstNew}"]`);
    if (block) block.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  qsa<HTMLElement>("[data-more-index]").forEach((b) => b.addEventListener("click", () => expand(Number(b.dataset.moreIndex))));
  qsa<HTMLElement>("[data-more-all]").forEach((b) => b.addEventListener("click", () => expand(Number(b.dataset.moreAll))));
}

// ---- 地図描画 -----------------------------------------------------------

async function renderMapEmbed(activePlaces: ItineraryItem[], _day: DayGroup): Promise<void> {
  const map = qs<HTMLElement>("[data-map]");
  const existing = root.querySelector(".tl-map-iframe");
  if (existing) existing.remove();
  const existingLeaflet = root.querySelector(".tl-leaflet-map");
  map.classList.remove("has-leaflet");

  let src = "";
  if (CONFIG.mapEmbed.mode === "myMaps" && CONFIG.mapEmbed.myMapsEmbedUrl) {
    src = CONFIG.mapEmbed.myMapsEmbedUrl;
  } else if (CONFIG.mapEmbed.mode === "mapsEmbedApi") {
    src = mapsEmbedDirections(activePlaces);
  } else if (CONFIG.mapEmbed.mode === "leaflet") {
    try {
      await renderLeafletMap(map, leafletState, state.days, state.active, CONFIG.mapDefaults);
      refreshMapLayout();
    } catch (error) {
      console.warn(error);
    }
    return;
  }

  map.classList.toggle("has-embed", Boolean(src));
  if (existingLeaflet) existingLeaflet.remove();
  if (!src) return;

  const iframe = document.createElement("iframe");
  iframe.className = "tl-map-iframe";
  iframe.src = src;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  iframe.allowFullscreen = true;
  iframe.title = "Google Map";
  map.prepend(iframe);
}

// ---- 同期・初期化 -------------------------------------------------------

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || "");
  const box = document.createElement("div");
  box.className = "tl-error";
  box.textContent = `データ読み込みに失敗しました。サンプル表示に戻します: ${message}`;
  root.insertAdjacentElement("afterbegin", box);
}

async function syncData(isInitial: boolean, didRetryAuth?: boolean): Promise<void> {
  if (syncInFlight) return syncInFlight;
  const minInterval = Number(CONFIG.minRefreshSeconds || 0) * 1000;
  if (!isInitial && minInterval && Date.now() - lastSyncAt < minInterval) return;
  if (isInitial) setLoading(true, "最新データを取得しています");

  syncInFlight = (async (): Promise<void> => {
    try {
      const data = await loadData(CONFIG, SAMPLE);
      lastSyncAt = Date.now();
      renderData(data, CONFIG.mode);
      if (isInitial) setLoading(false);
    } catch (error) {
      if (CONFIG.mode === "appsScript" && CONFIG.auth.enabled && !didRetryAuth && isAuthError(error)) {
        clearAuthSession();
        await requestPassword();
        await syncData(isInitial, true);
        return;
      }
      showError(error);
      if (isInitial || !state.days.length) renderData(SAMPLE, "sample");
      if (isInitial) setLoading(false);
    }
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

/**
 * 読み取り専用ビュー判定。
 * 他人の公開計画は plans ホームから `?view=1` 付きで開かれる（明示シグナル）。
 * 加えて、持ち主が居る計画（権限行 or メンバー名がある）の非メンバーなら読み取り専用にする。
 * 持ち主が居ない計画は、名前未設定の本人までロックしないよう planHasOwner でガードする。
 */
function computeReadOnly(): boolean {
  const forcedView = new URLSearchParams(location.search).get("view") === "1";
  if (forcedView) return true;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return false;
  if (canEditPlan(meta)) return false;
  // 権限行もメンバー名も無い計画は持ち主が居ない＝ロックしない。
  // （ログアウト状態で作った計画を、本人が二度と編集できなくなるのを防ぐ）
  return planHasOwner(meta);
}

function computeAccessDenied(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(meta) && !canViewPlan(meta!);
}

let READ_ONLY = computeReadOnly();
let ACCESS_DENIED = computeAccessDenied();

function renderAccessDenied(): void {
  setLoading(false);
  root.classList.add("is-readonly");
  root
    .querySelectorAll<HTMLElement>(".tl-actions, .tl-days, .tl-main, .tl-foot, .tl-mobile-nav")
    .forEach((el) => {
      el.hidden = true;
    });
  const box = document.createElement("div");
  box.className = "tl-error";
  box.textContent = "この旅行計画は限定公開です。招待リンクから参加するか、権限のあるアカウントでログインしてください。";
  const header = root.querySelector(".ah");
  if (header) header.insertAdjacentElement("afterend", box);
  else root.insertAdjacentElement("afterbegin", box);
}

async function init(): Promise<void> {
  registerServiceWorker();
  await Backend.preload();
  READ_ONLY = computeReadOnly();
  ACCESS_DENIED = computeAccessDenied();
  if (ACCESS_DENIED) {
    renderAccessDenied();
    return;
  }
  // この計画を開いた＝1閲覧としてカウント（ホームの観覧数に反映）。
  if (CONFIG.tripSlug) incrementView(CONFIG.tripSlug);
  if (READ_ONLY) {
    root.classList.add("is-readonly");
    const headMain = root.querySelector<HTMLElement>(".ah-main");
    if (headMain && !headMain.querySelector(".tl-ro-badge")) {
      headMain.insertAdjacentHTML(
        "beforeend",
        '<span class="tl-ro-badge">' + icon("eye") + "閲覧のみ</span>",
      );
    }
    // 非メンバーはメンバー画面を見られない（下部ナビのメンバーも隠す）
    const membersNav = root.querySelector<HTMLElement>("[data-members-nav]");
    if (membersNav) membersNav.hidden = true;
  }
  // 日程を LINE 用テキストで共有／コピー
  const copyScheduleBtn = root.querySelector<HTMLButtonElement>("[data-copy-schedule]");
  if (copyScheduleBtn) copyScheduleBtn.addEventListener("click", () => void shareSchedule());
  // タスク（チェックリスト）の状態変更・追加・削除
  bindChecklist();
  // 招待リンクの共有ボタン（メンバー画面）
  const inviteBtn = root.querySelector<HTMLButtonElement>("[data-invite-share]");
  if (inviteBtn) inviteBtn.addEventListener("click", () => void shareTripInvite());
  const inviteName = root.querySelector<HTMLInputElement>("[data-invite-name]");
  if (inviteName) {
    inviteName.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void shareTripInvite();
      }
    });
  }
  // 脱退（この旅行のメンバーから自分を外す）
  const leaveBtn = root.querySelector<HTMLButtonElement>("[data-leave-trip]");
  if (leaveBtn) {
    leaveBtn.addEventListener("click", () => {
      const meta = TripPlans.get(CONFIG.tripSlug);
      const title = (meta && meta.title) || "この旅行";
      if (window.confirm(`「${title}」から脱退しますか？この操作でメンバーから外れます。`)) {
        leaveTrip();
      }
    });
  }
  syncStickyOffsets();
  window.addEventListener("resize", () => {
    syncStickyOffsets();
    refreshMapLayout();
  });
  if ("ResizeObserver" in window) {
    new ResizeObserver(syncStickyOffsets).observe(qs(".ah"));
    new ResizeObserver(refreshMapLayout).observe(qs("[data-map]"));
  }
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      applyMobileView(button.dataset.mobileNav);
    });
  });
  // 費用入力はボトムシートに分離（読む画面と書く画面を分ける）。
  // 読み取り専用ビュー（他人の公開計画）では費用追加を出さない。
  // リスナーは hidden でも必ず付ける: 表示されているのに何も起きないボタンは
  // 「壊れている」としか見えないため、押されたら理由を出せるようにしておく。
  qsa<HTMLElement>("[data-expense-open]").forEach((button) => {
    button.hidden = READ_ONLY;
    button.addEventListener("click", () => {
      if (READ_ONLY) {
        const status = root.querySelector<HTMLElement>("[data-settlement-status]");
        if (status) {
          status.textContent = "閲覧のみの計画では費用を追加できません。";
          status.classList.add("is-error");
        }
        return;
      }
      setExpenseSheet(true);
    });
  });
  qsa<HTMLElement>("[data-expense-close]").forEach((button) => {
    button.addEventListener("click", () => setExpenseSheet(false));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const sheet = root.querySelector<HTMLElement>("[data-expense-sheet]");
    if (sheet && !sheet.hidden) setExpenseSheet(false);
  });
  // マイページはヘッダーの [data-mypage] を共通ドロワー（mypage-drawer）が拾って
  // 右からスライドインで開く。ここでの遷移は不要。
  // フッターの「編集」を source で振り分け（ローカル→計画エディタ / appsScript→行程編集）。
  // googleSheets/sample は閲覧のみなので非表示。
  const editWrap = root.querySelector<HTMLElement>("[data-edit-wrap]");
  const editLink = root.querySelector<HTMLAnchorElement>("[data-edit-link]");
  const editHead = root.querySelector<HTMLAnchorElement>("[data-edit-head]");
  const planQuery = "?plan=" + encodeURIComponent(CONFIG.tripSlug);
  // 読み取り専用ビューでは編集導線（ヘッダー鉛筆 / フッター編集）を出さない。
  const editTarget =
    READ_ONLY ? null
    : CONFIG.mode === "local" ? { href: "plan-editor.html" + planQuery, label: "計画を編集" }
    : CONFIG.mode === "appsScript" ? { href: "itinerary-editor.html" + planQuery, label: "行程編集" }
    : null;
  if (editWrap && editLink && editTarget) {
    editLink.href = editTarget.href;
    editLink.textContent = editTarget.label;
    editWrap.hidden = false;
  }
  if (editHead) {
    if (editTarget) {
      editHead.href = editTarget.href;
      editHead.setAttribute("aria-label", editTarget.label);
      editHead.setAttribute("title", editTarget.label);
      editHead.hidden = false;
    } else {
      editHead.hidden = true;
    }
  }
  applyMobileView(mobileView);
  await requestPassword();
  await syncData(true);
  await requestIdentityIfNeeded();
  if (CONFIG.refreshMinutes > 0) {
    setInterval(() => void syncData(false), CONFIG.refreshMinutes * 60 * 1000);
  }
  if (CONFIG.refreshOnFocus) {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void syncData(false);
    });
    window.addEventListener("focus", () => void syncData(false));
  }
}

void init();
