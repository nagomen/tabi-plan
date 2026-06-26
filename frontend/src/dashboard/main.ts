// 旅行ダッシュボード本体。docs/index.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// データ取得（sample / googleSheets / appsScript / local）、日別タイムライン、
// Leaflet 地図、費用精算・明細、本人設定・認証、Service Worker 登録を担う。

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "../shared/config";
import * as TripPlans from "../shared/plans-store";
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
import { registerServiceWorker } from "../shared/pwa";
import type {
  TripData,
  TripLink,
  ItineraryItem,
  Settlement,
  SettlementTransfer,
  ExpenseDetail,
  ChecklistItem,
  LocalInfoItem,
  SheetRow,
  LatLng,
} from "../shared/types";

// ---- 補助型 -------------------------------------------------------------

/** ローカルストレージに保存する本人プロフィール */
interface ProfileRecord {
  name?: string;
  savedAt?: string;
}

/** prepareReceiptPhoto が返すアップロード用ペイロード */
interface PreparedPhoto {
  fileName: string;
  mimeType: string;
  data: string;
}

/** 日別グループ（行程をその日の予定にまとめたもの） */
interface DayGroup {
  date: string;
  day: string;
  area: string;
  weather: string;
  items: ItineraryItem[];
}

/** 描画用に座標を持った行程ポイント */
interface RoutePoint extends ItineraryItem {
  role: string;
  dayIndex: number;
  dayLabel: string;
  lat: number;
  lng: number;
}

/** 地図に投影したプレースポイント（x/y は SVG 用の割合座標） */
type ProjectedPlace = ItineraryItem & { x: number; y: number };

/** stopGroups の集約形 */
interface StopGroup extends RoutePoint {
  dates: string[];
  dayIndexes: number[];
  places: Set<string>;
  titles: string[];
}

interface AppState {
  data: TripData;
  days: DayGroup[];
  active: number;
  source: string;
}

interface LeafletState {
  map: L.Map | null;
  layer: L.LayerGroup | null;
  followActive: boolean;
}

/** gviz JSONP レスポンスの最小形 */
interface GvizResponse {
  status?: string;
  errors?: { detailed_message?: string }[];
  table?: {
    cols: { label?: string; id?: string }[];
    rows: { c: ({ f?: string; v?: unknown } | null)[] }[];
  };
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

/** root にスコープした型付き qs/qsa（shared/dom 由来） */
const { qs, qsa } = makeScopedQuery(root);

function setText(selector: string, value: string | undefined): void {
  qs(selector).textContent = value || "";
}

function setHtml(selector: string, value: string | undefined): void {
  qs(selector).innerHTML = value || "";
}

function mapsSearch(query: string | undefined): string {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query || "");
}

function valueByKeys(row: SheetRow, keys: string[]): string {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

function numberOrNaN(value: unknown): number {
  if (value === "" || value === null || value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ---- 地名→座標（ダッシュボード固有テーブル） ---------------------------

const PLACE_COORDS: Record<string, LatLng> = {
  "成田": { lat: 35.7720, lng: 140.3929 },
  "成田空港": { lat: 35.7720, lng: 140.3929 },
  "NRT": { lat: 35.7720, lng: 140.3929 },
  "東京": { lat: 35.6812, lng: 139.7671 },
  "東京駅": { lat: 35.6812, lng: 139.7671 },
  "羽田": { lat: 35.5494, lng: 139.7798 },
  "羽田空港": { lat: 35.5494, lng: 139.7798 },
  "HND": { lat: 35.5494, lng: 139.7798 },
  "京都": { lat: 35.0116, lng: 135.7681 },
  "京都駅": { lat: 34.9858, lng: 135.7588 },
  "大阪": { lat: 34.6937, lng: 135.5023 },
  "新大阪": { lat: 34.7335, lng: 135.5002 },
  "札幌": { lat: 43.0618, lng: 141.3545 },
  "福岡": { lat: 33.5902, lng: 130.4017 },
  "那覇": { lat: 26.2124, lng: 127.6792 },
  "台北": { lat: 25.0330, lng: 121.5654 },
  "ソウル": { lat: 37.5665, lng: 126.9780 },
  "バンコク": { lat: 13.7563, lng: 100.5018 },
  "サンフランシスコ": { lat: 37.7749, lng: -122.4194 },
  "SFO": { lat: 37.6213, lng: -122.3790 },
  "リマ": { lat: -12.0464, lng: -77.0428 },
  "Lima": { lat: -12.0464, lng: -77.0428 },
  "クスコ": { lat: -13.5319, lng: -71.9675 },
  "Cusco": { lat: -13.5319, lng: -71.9675 },
  "マチュピチュ方面": { lat: -13.1631, lng: -72.5450 },
  "マチュピチュ村": { lat: -13.1547, lng: -72.5254 },
  "アグアスカリエンテス": { lat: -13.1547, lng: -72.5254 },
  "マチュピチュ": { lat: -13.1631, lng: -72.5450 },
  "プエルトマルドナド": { lat: -12.5933, lng: -69.1891 },
  "PMD": { lat: -12.5933, lng: -69.1891 },
  "プーノ": { lat: -15.8402, lng: -70.0219 },
  "ラパス": { lat: -16.4897, lng: -68.1193 },
  "ウユニ": { lat: -20.4597, lng: -66.8250 },
  "ビジャソン": { lat: -22.0866, lng: -65.5942 },
  "ラキアカ": { lat: -22.1024, lng: -65.5920 },
  "ビジャソン/ラキアカ": { lat: -22.0960, lng: -65.5930 },
  "サルタ": { lat: -24.7821, lng: -65.4232 },
  "イグアス": { lat: -25.5163, lng: -54.5854 },
  "プエルトイグアス": { lat: -25.5972, lng: -54.5786 },
  "FozdoIguacu/IGU": { lat: -25.6003, lng: -54.4850 },
  "FozdoIguacuIGU": { lat: -25.6003, lng: -54.4850 },
  "IGU": { lat: -25.6003, lng: -54.4850 },
  "Yguazu": { lat: -25.4610, lng: -55.0000 },
  "ColoniaYguazu": { lat: -25.4610, lng: -55.0000 },
  "サンパウロ": { lat: -23.5558, lng: -46.6396 },
  "サントス": { lat: -23.9608, lng: -46.3336 },
  "リオデジャネイロ": { lat: -22.9068, lng: -43.1729 },
  "モンテビデオ": { lat: -34.9011, lng: -56.1645 },
  "ブエノスアイレス": { lat: -34.6037, lng: -58.3816 },
};

function normalizePlaceName(name: string | undefined): string {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "")
    .replace(/・/g, "")
    .replace(/方面$/, "方面")
    .replace(/^移動中$/, "");
}

function coordsFor(name: string | undefined): LatLng | null {
  return PLACE_COORDS[normalizePlaceName(name)] || null;
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

const state: AppState = { data: SAMPLE, days: [], active: 0, source: "sample" };
let mobileView = "home";
const leafletState: LeafletState = { map: null, layer: null, followActive: true };
let expenseDetailsOpen = false;
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

// ---- Apps Script 通信 ---------------------------------------------------

/** shared/apps-script を CONFIG.appsScriptUrl にバインドした JSONP 取得 */
const callAppsScript = (params: AppsScriptParams): Promise<AppsScriptResponse> =>
  callAppsScriptShared(CONFIG.appsScriptUrl, params);

/** shared/apps-script を CONFIG.appsScriptUrl にバインドしたレシート用 iframe POST */
const postAppsScript = (params: AppsScriptParams): Promise<AppsScriptResponse> =>
  postAppsScriptShared(CONFIG.appsScriptUrl, params, {
    source: "trip-expense-receipt-upload",
    idPrefix: "receipt",
    timeoutMessage: "写真アップロードがタイムアウトしました",
    failMessage: "写真アップロードに失敗しました",
  });

// ---- 画像処理 -----------------------------------------------------------

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result || ""));
    reader.onerror = (): void => reject(new Error("写真を読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

function imageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = (): void => resolve(image);
    image.onerror = (): void => reject(new Error("写真を処理できませんでした"));
    image.src = dataUrl;
  });
}

async function prepareReceiptPhoto(file: File): Promise<PreparedPhoto> {
  const originalDataUrl = await fileAsDataUrl(file);
  if (!/^image\//.test(file.type || "")) {
    throw new Error("画像ファイルを選択してください");
  }

  try {
    const image = await imageFromDataUrl(originalDataUrl);
    const maxSize = 1600;
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas context を取得できませんでした");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    return {
      fileName: String(file.name || "receipt.jpg").replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: "image/jpeg",
      data: dataUrl.split(",")[1] || "",
    };
  } catch {
    return {
      fileName: file.name || "receipt.jpg",
      mimeType: file.type || "image/jpeg",
      data: originalDataUrl.split(",")[1] || "",
    };
  }
}

async function uploadReceiptPhoto(file: File): Promise<AppsScriptResponse> {
  const prepared = await prepareReceiptPhoto(file);
  if (!prepared.data) throw new Error("写真データがありません");
  if (prepared.data.length > 7000000) {
    throw new Error("写真サイズが大きすぎます。小さめの画像で再試行してください");
  }
  return postAppsScript({
    action: "receiptUpload",
    token: getAuthToken(),
    fileName: prepared.fileName,
    mimeType: prepared.mimeType,
    data: prepared.data,
  });
}

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

function updateProfileButton(): void {
  const button = root.querySelector<HTMLButtonElement>("[data-profile-button]");
  if (!button) return;
  const profile = readProfile();
  button.textContent = profile && profile.name ? profile.name : "本人設定";
  button.setAttribute("aria-label", profile && profile.name ? `本人設定を変更: ${profile.name}` : "本人設定");
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
      updateProfileButton();
      const expenseForm = root.querySelector<HTMLFormElement>("[data-expense-form-native]");
      applyProfileDefaults(expenseForm, participants);
      renderBase();
      renderActive();
      resolve(true);
    });
  });
}

async function requestIdentityIfNeeded(): Promise<void> {
  updateProfileButton();
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

function normalizeDate(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim().replace(/\//g, "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatHeaderDate(value: string): string {
  const normalized = normalizeDate(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}/${match[3]}` : normalized;
}

function formatHeaderDateRange(value: string | undefined): string {
  return String(value || "")
    .split(/\s+-\s+/)
    .map(formatHeaderDate)
    .filter(Boolean)
    .join(" - ");
}

function groupDays(itinerary: ItineraryItem[]): DayGroup[] {
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
  return Array.from(map.values());
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

function shortDate(date: string | undefined): string {
  return String(date || "").replace(/^\d{4}-0?/, "").replace("-", "/");
}

function compactDateRange(dates: string[]): string {
  const cleanDates = Array.from(new Set((dates || []).filter(Boolean))).sort();
  if (!cleanDates.length) return "";
  const first = shortDate(cleanDates[0]);
  const last = shortDate(cleanDates[cleanDates.length - 1]);
  return first === last ? first : `${first}-${last}`;
}

function itineraryRoutePoints(): RoutePoint[] {
  const points: RoutePoint[] = [];
  const pushPoint = (
    item: ItineraryItem,
    day: DayGroup,
    dayIndex: number,
    lat: unknown,
    lng: unknown,
    place: string | undefined,
    role: string,
  ): void => {
    const nextLat = Number(lat);
    const nextLng = Number(lng);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) return;
    const previous = points[points.length - 1];
    const sameAsPrevious = previous && Math.abs(previous.lat - nextLat) < .0001 && Math.abs(previous.lng - nextLng) < .0001;
    if (sameAsPrevious && previous.dayIndex === dayIndex) return;
    points.push({
      ...item,
      role,
      dayIndex,
      dayLabel: item.day || day.day || `Day ${dayIndex + 1}`,
      date: item.date || day.date,
      area: item.area || day.area,
      place: place || item.place || item.area || item.title,
      lat: nextLat,
      lng: nextLng,
    });
  };

  state.days.forEach((day, dayIndex) => {
    day.items.forEach((item) => {
      if (Number.isFinite(item.originLat) && Number.isFinite(item.originLng) && Number.isFinite(item.destinationLat) && Number.isFinite(item.destinationLng)) {
        pushPoint(item, day, dayIndex, item.originLat, item.originLng, item.origin, "origin");
        pushPoint(item, day, dayIndex, item.destinationLat, item.destinationLng, item.destination || item.place, "destination");
        return;
      }
      pushPoint(item, day, dayIndex, item.lat, item.lng, item.place || item.area, "stay");
    });
  });
  return points;
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
    node.classList.toggle("is-mobile-active", mobileView === "home" || views.includes(mobileView));
  });
  qsa<HTMLElement>("[data-section-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sectionNav === mobileView));
  });
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.mobileNav === mobileView));
  });
  if (mobileView === "home" || mobileView === "map") {
    setTimeout(() => {
      if (leafletState.map) leafletState.map.invalidateSize();
      if (mobileView === "map" && state.days.length && !leafletState.map) renderActive();
    }, 80);
  }
}

function syncStickyOffsets(): void {
  const head = root.querySelector<HTMLElement>(".tl-head");
  if (!head) return;
  root.style.setProperty("--tl-head-height", `${Math.ceil(head.getBoundingClientRect().height)}px`);
}

// ---- Sheets / gviz ------------------------------------------------------

function rowsFromGviz(response: GvizResponse): SheetRow[] {
  if (!response || !response.table) return [];
  const labels = response.table.cols.map((col, index) => col.label || col.id || `col${index}`);
  return response.table.rows.map((row) => {
    const obj: SheetRow = {};
    labels.forEach((label, index) => {
      const cell = row.c[index];
      obj[label] = cell ? String(cell.f ?? cell.v ?? "") : "";
    });
    return obj;
  });
}

function formatYen(value: number): string {
  return value ? "¥" + Math.round(value).toLocaleString("ja-JP") : "未入力";
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
      <b>${escapeHtml(transfer.amountLabel || "")}</b>
      <button type="button" data-settlement-complete data-from="${escapeHtml(transfer.from)}" data-to="${escapeHtml(transfer.to)}" data-amount="${Number(transfer.amount || 0)}">精算完了</button>
      ${transfer.completedLabel ? `<small>完了済み ${escapeHtml(transfer.completedLabel)} を差し引き済み</small>` : ""}
    </div>`,
  ).join("") + `<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
  setupSettlementCompleteHandlers(mount);
}

function setupSettlementCompleteHandlers(mount: HTMLElement): void {
  const status = mount.querySelector<HTMLElement>("[data-settlement-status]");
  mount.querySelectorAll<HTMLButtonElement>("[data-settlement-complete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const from = button.dataset.from || "";
      const to = button.dataset.to || "";
      const amount = Number(button.dataset.amount || 0);
      if (!from || !to || !amount) return;
      button.disabled = true;
      if (status) status.textContent = `${from} → ${to} を精算完了にしています...`;
      try {
        const response = await callAppsScript({
          action: "settlementComplete",
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

interface SelectedExpenseTotal {
  amountLabel: string;
  label: string;
}

function selectedExpenseTotal(settlement: Settlement): SelectedExpenseTotal {
  const profileName = currentProfileName(expenseParticipants(state.data || SAMPLE));
  const byPerson = settlement.expenseByPerson || {};
  const personExpense = profileName ? byPerson[profileName] : undefined;
  if (personExpense !== undefined && personExpense !== null) {
    return {
      amountLabel: formatYen(personExpense),
      label: `${profileName}の費用合計`,
    };
  }
  return {
    amountLabel: settlement.expenseTotal || "¥0",
    label: "費用総額",
  };
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

function expenseParticipants(data: TripData): string[] {
  const source = data as TripData & ParticipantSource;
  const fromData = (source.participants || [])
    .map((member) => member && (member.name || member.displayName || (member["表示名"] as string | undefined)))
    .filter((name): name is string => Boolean(name));
  if (fromData.length) return fromData;
  const fromMembers = String((data.trip && data.trip.members) || "")
    .split(/\s*\/\s*|、|,|\n/)
    .map((name) => name.trim())
    .filter((name) => name && !/\d+人|共有メンバー/.test(name));
  return fromMembers.length ? fromMembers : (CONFIG.defaultParticipants || ["参加者A", "参加者B"]);
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
    <div class="tl-expense-head">
      <b>ページ内で立替入力</b>
      <a href="expense-entry.html">入力専用ページを開く</a>
    </div>
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
        <label class="tl-field tl-photo-field">
          <span>レシート写真</span>
          <input type="file" name="receiptPhoto" accept="image/*" capture="environment">
        </label>
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
      const receiptInput = field("receiptPhoto") as HTMLInputElement;
      const photo = receiptInput && receiptInput.files ? receiptInput.files[0] : null;
      let receiptUrl = "";
      if (photo) {
        setStatus("写真アップロード中...", "");
        const upload = await uploadReceiptPhoto(photo);
        receiptUrl = upload.url || "";
        setStatus("保存中...", "");
      }
      const response = await callAppsScript({
        action: "expense",
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
      form.reset();
      form.dataset.dirty = "false";
      (field("paidDate") as HTMLInputElement).value = todayISO();
      applyProfileDefaults(form, participants);
      qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => { input.checked = true; });
      updateMode();
      renderBase();
      renderActive();
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

// ---- Sheets スキーマ別データ構築 ---------------------------------------

interface BasicInfo {
  [key: string]: string;
}

function makeSheetUrl(sheetName: string): string {
  return "https://docs.google.com/spreadsheets/d/" + CONFIG.spreadsheetId + "/edit#gid=0&range=" + encodeURIComponent(sheetName + "!A1");
}

function buildBasicInfo(rows: SheetRow[]): BasicInfo {
  const info: BasicInfo = {};
  (rows || []).forEach((row) => {
    const key = valueByKeys(row, ["key", "キー"]);
    if (!key) return;
    const visible = String(valueByKeys(row, ["公開ページに表示", "表示", "enabled"]) || "TRUE").toUpperCase() !== "FALSE";
    if (!visible) return;
    info[key] = valueByKeys(row, ["value", "値"]);
  });
  return info;
}

function buildTripLinks(linkRows: SheetRow[], fallbackLinks: TripLink[], basicInfo: BasicInfo): TripLink[] {
  const rows = (linkRows || [])
    .filter((row) => String(valueByKeys(row, ["enabled", "有効", "公開ページに表示"]) || "TRUE").toUpperCase() !== "FALSE")
    .filter((row) => valueByKeys(row, ["key"]) || valueByKeys(row, ["label", "表示名"]));
  if (!rows.length) return fallbackLinks;
  return rows.map((row) => {
    const key = valueByKeys(row, ["key"]);
    let url = valueByKeys(row, ["url", "URL"]);
    if (key === "maps" && basicInfo.myMapsUrl) url = basicInfo.myMapsUrl;
    if (key === "photos" && basicInfo.photosUrl) url = basicInfo.photosUrl;
    return {
      key,
      label: valueByKeys(row, ["label", "表示名"]) || key,
      icon: valueByKeys(row, ["icon", "アイコン"]) || "↗",
      url,
      caption: valueByKeys(row, ["caption", "説明"]) || "",
    };
  });
}

function buildTripChecklist(rows: SheetRow[]): ChecklistItem[] {
  return (rows || [])
    .filter((row) => String(valueByKeys(row, ["有効", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .map((row) => ({
      label: valueByKeys(row, ["項目", "label", "チェック項目"]) || "",
      done: valueByKeys(row, ["完了", "done"]) || false,
    }))
    .filter((row) => row.label);
}

function buildTripSheetData(
  itineraryRows: SheetRow[],
  _reservationRows: SheetRow[],
  _budgetRows: SheetRow[],
  basicInfoRows: SheetRow[],
  linkRows: SheetRow[],
  checklistRows: SheetRow[],
): TripData {
  const basicInfo = buildBasicInfo(basicInfoRows);
  const tripSheetName = CONFIG.sheets.tripItinerary || CONFIG.sheets.southAmericaItinerary;
  const sheetUrl = makeSheetUrl(tripSheetName);
  const link = (key: keyof typeof CONFIG.linkOverrides, fallback: string): string => CONFIG.linkOverrides[key] || fallback || "";
  const itinerary: ItineraryItem[] = itineraryRows
    .filter((row) => row["日付"] && row["Day"])
    .filter((row) => String(valueByKeys(row, ["公開ページに表示", "表示", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .map((row) => {
      const origin = valueByKeys(row, ["移動元", "出発地"]) || "";
      const destination = valueByKeys(row, ["移動先", "到着地"]) || "";
      const city = valueByKeys(row, ["都市", "宿泊地", "エリア"]) || destination || origin || "";
      const purpose = valueByKeys(row, ["主目的", "目的"]) || "予定";
      const displayTime = valueByKeys(row, ["表示時刻", "時刻", "開始時刻", "出発時刻", "集合時刻"]);
      const displayPlace = valueByKeys(row, ["表示場所", "場所", "集合場所"]) || destination || city || origin;
      const displayTitle = valueByKeys(row, ["表示タイトル", "タイトル", "予定名"]);
      const displayNote = valueByKeys(row, ["表示メモ", "当日メモ", "メモ"]);
      const needed = valueByKeys(row, ["必要情報", "当日必要情報", "持ち物/注意", "確認事項"]);
      const weather = valueByKeys(row, ["天気", "気温", "weather"]);
      const moving = origin && destination;
      const type = valueByKeys(row, ["type", "種別"]) || (moving ? "move" : (purpose === "宿泊" ? "stay" : (purpose === "休養" ? "todo" : "sight")));
      const title = displayTitle || (moving ? `${origin} → ${destination}` : `${city} / ${purpose}`);
      const noteParts = displayNote ? [displayNote] : [
        row["移動手段"],
        row["所要時間"],
        row["予約状況"],
        row["確定度"],
        row["メモ"],
      ];
      const rowLat = numberOrNaN(valueByKeys(row, ["lat", "緯度"]));
      const rowLng = numberOrNaN(valueByKeys(row, ["lng", "経度"]));
      const coords = Number.isFinite(rowLat) && Number.isFinite(rowLng) ? { lat: rowLat, lng: rowLng } : coordsFor(displayPlace);
      const originCoords = coordsFor(origin);
      const destinationCoords = coordsFor(destination || city);
      return {
        date: normalizeDate(row["日付"]),
        day: row["Day"] || row["day"],
        area: city,
        time: displayTime,
        type,
        typeLabel: valueByKeys(row, ["表示ラベル", "ラベル"]) || (moving ? "移動" : purpose),
        title,
        place: displayPlace,
        note: noteParts.filter(Boolean).join(" / "),
        needed,
        origin,
        destination,
        originLat: originCoords ? originCoords.lat : NaN,
        originLng: originCoords ? originCoords.lng : NaN,
        destinationLat: destinationCoords ? destinationCoords.lat : NaN,
        destinationLng: destinationCoords ? destinationCoords.lng : NaN,
        lat: coords ? coords.lat : NaN,
        lng: coords ? coords.lng : NaN,
        mapQuery: valueByKeys(row, ["地図検索", "mapQuery"]) || displayPlace,
        weather,
      };
    });

  const fallbackLinks: TripLink[] = [
    { key: "itinerary", label: "旅程", icon: "旅", url: link("itinerary", sheetUrl), caption: "Google Sheets" },
    { key: "maps", label: "My Maps", icon: "地", url: link("maps", basicInfo.myMapsUrl || "https://www.google.com/maps/d/"), caption: "Google My Maps" },
    { key: "expenseSheet", label: "費用", icon: "￥", url: link("expenseSheet", makeSheetUrl(CONFIG.sheets.budget)), caption: "Google Sheets" },
    { key: "photos", label: "写真", icon: "写", url: link("photos", basicInfo.photosUrl || "https://photos.google.com/"), caption: "Google Photos" },
    { key: "reservations", label: "予約管理", icon: "予", url: makeSheetUrl(CONFIG.sheets.reservations), caption: "Google Sheets" },
    { key: "budget", label: "予算", icon: "￥", url: makeSheetUrl(CONFIG.sheets.budget), caption: "Google Sheets" },
  ];
  const checklist = buildTripChecklist(checklistRows);

  return {
    trip: {
      title: basicInfo.tripTitle || CONFIG.tripTitle || "旅行",
      dates: basicInfo.dateStart && basicInfo.dateEnd ? `${normalizeDate(basicInfo.dateStart)} - ${normalizeDate(basicInfo.dateEnd)}` : (itinerary[0] && itinerary[itinerary.length - 1] ? `${itinerary[0].date} - ${itinerary[itinerary.length - 1].date}` : ""),
      members: basicInfo.members || "共有メンバー",
      note: basicInfo.dashboardNote ? `共有メモ: ${basicInfo.dashboardNote}` : "共有メモ: 詳細な予約番号や宿泊先住所は公開ページに載せず、スプレッドシート側で管理してください。",
    },
    links: buildTripLinks(linkRows, fallbackLinks, basicInfo),
    settlement: {
      paid: formatYen(0),
      paidLabel: "精算額",
      expenseTotal: "¥0",
      expenseByPerson: {},
      progress: 0,
      yourPaid: "-",
      yourDue: "精算不要",
      photoTitle: basicInfo.photoTitle || `${CONFIG.tripTitle || "旅行"}アルバム`,
      photoMeta: "Google Photos",
    },
    checklist: checklist.length ? checklist : [
      { label: "航空券・宿の予約状況確認", done: false },
      { label: "保険と緊急連絡先の確認", done: false },
      { label: "パスポート・ビザ・入国条件の確認（海外のみ）", done: false },
      { label: "現地通信手段の確認", done: false },
    ],
    localInfo: [],
    itinerary,
  };
}

function buildLocalInfo(rows: SheetRow[]): LocalInfoItem[] {
  return (rows || [])
    .filter((row) => String(valueByKeys(row, ["有効", "enabled"]) || "TRUE").toUpperCase() !== "FALSE")
    .filter((row) => valueByKeys(row, ["国", "country"]))
    .map((row) => ({
      country: valueByKeys(row, ["国", "country"]),
      currencyCode: valueByKeys(row, ["通貨コード", "currencyCode", "currency"]),
      currencyName: valueByKeys(row, ["通貨名", "currencyName"]),
      approxRate: valueByKeys(row, ["概算円レート", "rateToJpy", "円換算レート"]),
      rateUpdatedAt: valueByKeys(row, ["レート更新日", "rateUpdatedAt", "更新日"]),
      feeFreeAtm: valueByKeys(row, ["手数料無料ATM候補", "無料ATM候補", "feeFreeAtm"]),
      atmBest: valueByKeys(row, ["ATMおすすめ", "atmBest"]),
      atmFee: valueByKeys(row, ["ATM手数料目安", "atmFee"]),
      atmNote: valueByKeys(row, ["避けたい/注意", "注意", "atmNote"]),
      rideBest: valueByKeys(row, ["配車おすすめ", "rideBest"]),
      rideAlt: valueByKeys(row, ["代替アプリ", "rideAlt"]),
      paymentNote: valueByKeys(row, ["支払いメモ", "paymentNote"]),
      source: valueByKeys(row, ["情報ソース", "source"]),
      order: Number(valueByKeys(row, ["表示順", "order"]) || 999),
    }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.country).localeCompare(String(b.country), "ja"));
}

function loadGvizSheet(spreadsheetId: string, sheetName: string, range?: string): Promise<SheetRow[]> {
  return new Promise((resolve, reject) => {
    const callback = "__tripSheetCallback_" + Math.random().toString(36).slice(2);
    const globalScope = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    globalScope[callback] = (response: GvizResponse): void => {
      delete globalScope[callback];
      script.remove();
      if (response.status && response.status !== "ok") {
        reject(new Error(response.errors && response.errors[0] ? response.errors[0].detailed_message || "Google Sheets response error" : "Google Sheets response error"));
        return;
      }
      resolve(rowsFromGviz(response));
    };
    const tqx = "out:json;responseHandler:" + callback;
    script.src = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(spreadsheetId) +
      "/gviz/tq?tqx=" + encodeURIComponent(tqx) +
      "&sheet=" + encodeURIComponent(sheetName) +
      (range ? "&range=" + encodeURIComponent(range) : "") +
      "&cachebust=" + Date.now();
    script.onerror = (): void => {
      delete globalScope[callback];
      script.remove();
      reject(new Error("Google Sheetsを読み込めませんでした"));
    };
    document.head.appendChild(script);
  });
}

async function loadData(): Promise<TripData> {
  if (CONFIG.mode === "local") {
    const local = TripPlans.getData(CONFIG.tripSlug);
    return TripPlans.toDashboardData(local);
  }
  if (CONFIG.mode === "googleSheets" && CONFIG.spreadsheetId) {
    if (CONFIG.schema === "trip" || CONFIG.schema === "southAmerica") {
      const tripSheetName = CONFIG.sheets.tripItinerary || CONFIG.sheets.southAmericaItinerary;
      const tripRange = CONFIG.ranges.tripItinerary || CONFIG.ranges.southAmericaItinerary;
      const [itineraryRows, reservationRows, budgetRows, localInfoRows, basicInfoRows, linkRows, checklistRows] = await Promise.all([
        loadGvizSheet(CONFIG.spreadsheetId, tripSheetName, tripRange),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.reservations, CONFIG.ranges.reservations),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.budget, CONFIG.ranges.budget),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.localInfo, CONFIG.ranges.localInfo).catch(() => [] as SheetRow[]),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.basicInfo, CONFIG.ranges.basicInfo).catch(() => [] as SheetRow[]),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.tripLinks, CONFIG.ranges.tripLinks).catch(() => [] as SheetRow[]),
        loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.tripChecklist, CONFIG.ranges.tripChecklist).catch(() => [] as SheetRow[]),
      ]);
      const data = buildTripSheetData(itineraryRows, reservationRows, budgetRows, basicInfoRows, linkRows, checklistRows);
      data.localInfo = buildLocalInfo(localInfoRows);
      return data;
    }
    const [itinerary, links, settlementRows, checklist] = await Promise.all([
      loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.itinerary),
      loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.links),
      loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.settlement),
      loadGvizSheet(CONFIG.spreadsheetId, CONFIG.sheets.checklist),
    ]);
    const settlement: Record<string, string> = {};
    settlementRows.forEach((row) => { settlement[row.key] = row.value; });
    return {
      trip: {
        title: settlement.title || SAMPLE.trip.title,
        dates: settlement.dates || SAMPLE.trip.dates,
        members: settlement.members || SAMPLE.trip.members,
        note: settlement.note || SAMPLE.trip.note,
      },
      itinerary: itinerary as unknown as ItineraryItem[],
      links: links as unknown as TripLink[],
      checklist: checklist as unknown as ChecklistItem[],
      settlement: settlement as Settlement,
      localInfo: [],
    };
  }
  if (CONFIG.mode === "appsScript" && CONFIG.appsScriptUrl) {
    const response = await callAppsScript({ action: "data", token: getAuthToken() });
    return response.data || SAMPLE;
  }
  return SAMPLE;
}

// ---- 基本描画 -----------------------------------------------------------

function renderBase(): void {
  const data = state.data;
  setText("[data-title]", data.trip.title);
  setText("[data-dates]", formatHeaderDateRange(data.trip.dates));
  setText("[data-note]", data.trip.note);
  setText("[data-sync-label]", "最終同期: " + new Date().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  setText("[data-updated]", "最終更新: " + new Date().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  updateProfileButton();

  const tabs = [
    { key: "home", label: "ホーム" },
    { key: "plan", label: "予定" },
    { key: "map", label: "地図" },
    { key: "money", label: "費用" },
    { key: "links", label: "リンク" },
  ];
  setHtml("[data-actions]", tabs.map((tab) =>
    `<button class="tl-action" type="button" data-section-nav="${tab.key}" aria-selected="${tab.key === mobileView}">
      <b>${tab.label}</b>
    </button>`,
  ).join(""));
  qsa<HTMLElement>("[data-section-nav]").forEach((button) => {
    button.addEventListener("click", () => applyMobileView(button.dataset.sectionNav));
  });

  qs<HTMLAnchorElement>("[data-my-maps]").href = linkByKey("maps").url || "#";
  qs<HTMLAnchorElement>("[data-photo-link]").href = linkByKey("photos").url || "#";
  qs<HTMLAnchorElement>("[data-photo-button]").href = linkByKey("photos").url || "#";

  const settlement = data.settlement || {};
  const progress = Number(settlement.progress || 0);
  const expenseTotal = selectedExpenseTotal(settlement);
  setText("[data-paid]", expenseTotal.amountLabel || settlement.paid || "¥0");
  setText("[data-progress-label]", expenseTotal.label);
  qs<HTMLElement>("[data-progress]").style.setProperty("--value", `${Math.max(0, Math.min(100, progress))}%`);
  setText("[data-your-paid]", settlement.yourPaid || "-");
  setText("[data-your-due]", settlement.yourDue || "-");
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
      <span class="tl-doc-icon">${doc.icon || "↗"}</span><b>${doc.label}</b><span>↗</span>
    </a>`,
  ).join(""));

  setHtml("[data-checks]", (data.checklist || []).slice(0, 4).map((check) =>
    `<label><input type="checkbox" ${String(check.done).toLowerCase() === "true" || check.done === true ? "checked" : ""}><span>${check.label}</span></label>`,
  ).join(""));

  setHtml("[data-days]", state.days.map((day, index) =>
    `<button class="tl-day" type="button" data-day-index="${index}" aria-selected="${index === state.active}">
      <b>${day.day || `Day ${index + 1}`}<br>${day.area || ""}</b>
      <small>${day.date.replace(/^\\d{4}-/, "").replace("-", "/")}</small>
    </button>`,
  ).join(""));
  qsa<HTMLElement>("[data-day-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.active = Number(button.dataset.dayIndex);
      leafletState.followActive = true;
      renderActive();
    });
  });
  applyMobileView(mobileView);
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

function renderActive(): void {
  const day = state.days[state.active];
  if (!day) return;
  qsa<HTMLElement>("[data-day-index]").forEach((button) => {
    button.setAttribute("aria-selected", String(Number(button.dataset.dayIndex) === state.active));
  });

  const titleMain = day.date === todayISO() ? "今日の予定" : "この日の予定";
  const titleMeta = [day.day, day.area].filter(Boolean).join(" | ");
  setHtml("[data-day-title]", `<span>${escapeHtml(titleMain)}</span>${titleMeta ? `<span class="tl-day-heading-meta">${escapeHtml(titleMeta)}</span>` : ""}`);
  setText("[data-weather]", day.weather ? "☀ " + day.weather : "");

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

  setHtml("[data-timeline]", day.items.map((item) => {
    const place = item.place && item.place !== item.title ? `場所: ${item.place}` : "";
    const note = [place, item.note].filter(Boolean).join(" / ");
    return `<article class="tl-item">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot"></span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">
          <span class="tl-chip ${escapeHtml(item.type || "todo")}">${escapeHtml(item.typeLabel || item.type || "予定")}</span>
          <h3>${escapeHtml(item.title || "")}</h3>
        </div>
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        <p class="tl-note">${escapeHtml(note)}</p>
      </div>
      <a class="tl-maplink" href="${mapsSearch(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">Google Maps ↗</a>
    </article>`;
  }).join(""));

  const upcoming = state.days.slice(state.active + 1, state.active + 6)
    .map((next, offset) => ({ ...next, index: state.active + offset + 1 }));
  setHtml("[data-upcoming]", upcoming.length ? upcoming.map((next) => {
    const items = (next.items || []).slice(0, 6).map((item) => {
      const place = item.place && item.place !== next.area ? ` / ${item.place}` : "";
      return `<div class="tl-upcoming-item">
        <span class="tl-upcoming-time">${escapeHtml(item.time || "")}</span>
        <span class="tl-upcoming-text">${escapeHtml(item.title || "予定")}${escapeHtml(place)}</span>
      </div>`;
    }).join("");
    return `<a class="tl-upcoming-row" href="#" data-upcoming-index="${next.index}">
      <span class="tl-upcoming-date">${next.date.replace(/^\\d{4}-/, "").replace("-", "/")}</span>
      <span class="tl-upcoming-title">${next.day || ""}　${next.area || ""}</span>
      <span class="tl-upcoming-arrow">›</span>
      ${items ? `<div class="tl-upcoming-items">${items}</div>` : ""}
    </a>`;
  }).join("") : `<div class="tl-upcoming-row"><span class="tl-upcoming-date">完了</span><span class="tl-upcoming-title">今後の予定はありません</span><span></span></div>`);
  qsa<HTMLElement>("[data-upcoming-index]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      state.active = Number(link.dataset.upcomingIndex);
      renderActive();
    });
  });
}

// ---- 地図描画 -----------------------------------------------------------

async function renderMapEmbed(activePlaces: ItineraryItem[], day: DayGroup): Promise<void> {
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
      await renderLeafletMap(day);
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

type Segment = [[number, number], [number, number]];

function splitAntimeridianSegment(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Segment[] {
  const start = { lat: Number(from.lat), lng: Number(from.lng) };
  const end = { lat: Number(to.lat), lng: Number(to.lng) };
  if (![start.lat, start.lng, end.lat, end.lng].every(Number.isFinite)) return [];
  const delta = end.lng - start.lng;
  if (Math.abs(delta) <= 180) return [[[start.lat, start.lng], [end.lat, end.lng]]];

  const adjustedEndLng = delta > 180 ? end.lng - 360 : end.lng + 360;
  const edgeLng = delta > 180 ? -180 : 180;
  const wrappedEdgeLng = delta > 180 ? 180 : -180;
  const ratio = (edgeLng - start.lng) / (adjustedEndLng - start.lng);
  const edgeLat = start.lat + (end.lat - start.lat) * ratio;
  return [
    [[start.lat, start.lng], [edgeLat, edgeLng]],
    [[edgeLat, wrappedEdgeLng], [end.lat, end.lng]],
  ];
}

function addRoutePolylines(points: { lat: number; lng: number }[], options: L.PolylineOptions): void {
  if (!leafletState.layer) return;
  const layer = leafletState.layer;
  for (let index = 0; index < points.length - 1; index++) {
    splitAntimeridianSegment(points[index], points[index + 1]).forEach((segment) => {
      L.polyline(segment, options).addTo(layer);
    });
  }
}

function crossesAntimeridian(points: { lng: number | string }[]): boolean {
  return (points || []).some((point, index) => {
    const next = points[index + 1];
    return next ? Math.abs(Number(next.lng) - Number(point.lng)) > 180 : false;
  });
}

function pacificMapPoint<T extends { lng: number }>(point: T, enabled: boolean): T {
  if (!enabled || Number(point.lng) >= 0) return point;
  return { ...point, lng: Number(point.lng) + 360 };
}

function boundsAroundPoint(point: { lat: number; lng: number } | undefined, radiusKm: number): L.LatLngBounds | null {
  const lat = Number(point && point.lat);
  const lng = Number(point && point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.max(.18, Math.abs(Math.cos(lat * Math.PI / 180)));
  const lngDelta = radiusKm / (111.32 * cosLat);
  return L.latLngBounds([[lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]]);
}

function boundsAroundPoints(points: { lat: number; lng: number }[], radiusKm: number): L.LatLngBounds | null {
  const validPoints = uniqueMapPoints(points);
  if (!validPoints.length) return null;
  if (validPoints.length === 1) return boundsAroundPoint(validPoints[0], radiusKm);
  const pointBounds = L.latLngBounds(validPoints.map((point) => [point.lat, point.lng] as [number, number]));
  const centerBounds = boundsAroundPoint(pointBounds.getCenter(), radiusKm);
  if (centerBounds && centerBounds.contains(pointBounds.getSouthWest()) && centerBounds.contains(pointBounds.getNorthEast())) {
    return centerBounds;
  }
  return pointBounds;
}

function uniqueMapPoints<T extends { lat: number; lng: number }>(points: T[]): T[] {
  const seen = new Set<string>();
  return (points || []).filter((point) => {
    const lat = Number(point && point.lat);
    const lng = Number(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function renderLeafletMap(_activeDay: DayGroup): Promise<void> {
  const mapEl = qs<HTMLElement>("[data-map]");
  mapEl.classList.remove("has-embed");
  mapEl.classList.add("has-leaflet");
  qsa(".tl-map-iframe").forEach((node) => node.remove());

  let container = mapEl.querySelector<HTMLElement>(".tl-leaflet-map");
  if (!container) {
    container = document.createElement("div");
    container.className = "tl-leaflet-map";
    mapEl.prepend(container);
  }

  if (!leafletState.map) {
    leafletState.map = L.map(container, {
      zoomControl: true,
      scrollWheelZoom: true,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(leafletState.map);
  }
  const lmap = leafletState.map;

  if (leafletState.layer) {
    leafletState.layer.remove();
  }
  leafletState.layer = L.layerGroup().addTo(lmap);

  const allPoints = itineraryRoutePoints();
  const activeIndex = state.active;
  const activePoints = allPoints.filter((point) => point.dayIndex === activeIndex);
  const usePacificWorld = crossesAntimeridian(activePoints);
  const displayAllPoints = allPoints.map((point) => pacificMapPoint(point, usePacificWorld));
  const displayActivePoints = activePoints.map((point) => pacificMapPoint(point, usePacificWorld));
  const allLatLngs = displayAllPoints.map((point) => [point.lat, point.lng]);
  const activeLatLngs = displayActivePoints.map((point) => [point.lat, point.lng]);
  const showActiveDetail = leafletState.followActive && activeLatLngs.length;

  for (let index = 0; index < displayAllPoints.length - 1; index++) {
    const point = displayAllPoints[index];
    const next = displayAllPoints[index + 1];
    addRoutePolylines([point, next], {
      color: "#7b8f86",
      weight: 2,
      opacity: .55,
      dashArray: "6 8",
    });
  }

  if (showActiveDetail && activeLatLngs.length >= 2) {
    addRoutePolylines(displayActivePoints, {
      color: "#0b5a42",
      weight: 4,
      opacity: .95,
    });
  }

  const stopGroups: StopGroup[] = [];
  const stopByCoord = new Map<string, StopGroup>();
  displayAllPoints.forEach((point) => {
    const key = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
    if (!stopByCoord.has(key)) {
      const group: StopGroup = { ...point, dates: [], dayIndexes: [], places: new Set<string>(), titles: [] };
      stopByCoord.set(key, group);
      stopGroups.push(group);
    }
    const group = stopByCoord.get(key)!;
    group.dates.push(point.date);
    group.dayIndexes.push(point.dayIndex + 1);
    if (point.place || point.area) group.places.add(point.place || point.area || "");
    if (point.title) group.titles.push(point.title);
  });

  stopGroups.forEach((point) => {
    const days = Array.from(new Set(point.dayIndexes)).sort((a, b) => a - b);
    const dateLabel = compactDateRange(point.dates);
    const placeLabel = Array.from(point.places)[0] || point.place || point.area || point.title || "";
    const icon = L.divIcon({
      className: "",
      html: `<div class="tl-map-marker is-route-stop" tabindex="0" aria-label="${dateLabel} ${placeLabel}">
        <span class="tl-map-marker-num">${shortDate(point.date) || days[0]}</span>
      </div>`,
      iconSize: [42, 26],
      iconAnchor: [19, 15],
    });
    L.marker([point.lat, point.lng], { icon })
      .bindPopup(`<b>${dateLabel} / ${placeLabel}</b><br>${point.titles.slice(0, 4).join("<br>")}`)
      .addTo(leafletState.layer!);
  });

  if (showActiveDetail) {
    displayActivePoints.forEach((point) => {
      const icon = L.divIcon({
        className: "",
        html: `<div class="tl-map-marker is-active" tabindex="0" aria-label="${shortDate(point.date)} ${point.place || point.area || point.title}">
          <span class="tl-map-marker-num">${shortDate(point.date) || point.dayIndex + 1}</span>
        </div>`,
        iconSize: [46, 28],
        iconAnchor: [21, 16],
      });
      L.marker([point.lat, point.lng], { icon })
        .bindPopup(`<b>${shortDate(point.date)} / ${point.place || point.area || ""}</b><br>${point.title || ""}<br>${point.note || ""}`)
        .addTo(leafletState.layer!);
    });
  }

  const defaultCenter: [number, number] = Array.isArray(CONFIG.mapDefaults.center) && CONFIG.mapDefaults.center.length === 2
    ? CONFIG.mapDefaults.center
    : [20, 0];
  const defaultZoom = Number(CONFIG.mapDefaults.zoom) || 2;
  const activeRadiusKm = Number(CONFIG.mapDefaults.activeRadiusKm) || 300;
  const overviewRadiusKm = Number(CONFIG.mapDefaults.overviewRadiusKm) || 800;
  let bounds: L.LatLngBounds | null = null;
  if (!leafletState.followActive && displayAllPoints.length) {
    bounds = boundsAroundPoints(displayAllPoints, overviewRadiusKm);
  } else if (leafletState.followActive && activeLatLngs.length) {
    bounds = boundsAroundPoints(displayActivePoints, activeRadiusKm);
  } else if (allLatLngs.length) {
    bounds = boundsAroundPoints(displayAllPoints, overviewRadiusKm);
  }
  if (bounds && bounds.isValid()) {
    lmap.fitBounds(bounds.pad(.25), {
      animate: false,
      maxZoom: 18,
    });
  } else {
    lmap.setView(defaultCenter, defaultZoom, { animate: false });
  }

  setTimeout(() => lmap.invalidateSize(), 0);
}

// ---- 同期・初期化 -------------------------------------------------------

function showError(error: unknown): void {
  root.insertAdjacentHTML("afterbegin", `<div class="tl-error">データ読み込みに失敗しました。サンプル表示に戻します: ${(error as Error).message}</div>`);
}

async function syncData(isInitial: boolean, didRetryAuth?: boolean): Promise<void> {
  if (syncInFlight) return syncInFlight;
  const minInterval = Number(CONFIG.minRefreshSeconds || 0) * 1000;
  if (!isInitial && minInterval && Date.now() - lastSyncAt < minInterval) return;
  if (isInitial) setLoading(true, "最新データを取得しています");

  syncInFlight = (async (): Promise<void> => {
    try {
      const data = await loadData();
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

async function init(): Promise<void> {
  registerServiceWorker();
  syncStickyOffsets();
  window.addEventListener("resize", syncStickyOffsets);
  if ("ResizeObserver" in window) {
    new ResizeObserver(syncStickyOffsets).observe(qs(".tl-head"));
  }
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      applyMobileView(button.dataset.mobileNav);
    });
  });
  qs<HTMLButtonElement>("[data-profile-button]").addEventListener("click", () => {
    void showIdentityModal(false);
  });
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
