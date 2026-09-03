// 旅行ダッシュボード本体。docs/index.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// データ取得（sample / local）、日別タイムライン、
// Leaflet 地図、費用精算・明細、本人設定・認証、Service Worker 登録を担う。

import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";

import { icon, type IconName } from "../shared/icons";

initPageTransitions();

import {
  readGlobalTripConfig,
  resolvedTripConfig,
  type TripConfig,
} from "../shared/config";
import * as TripPlans from "../shared/plans-store";
import { isPublished } from "../shared/plans-store";
import { getUser } from "../shared/user-store";
import { canEditPlan, canManagePlan, canViewPlan, isMemberOf, planHasOwner } from "../shared/membership";
import { joinersOn, leaversOn } from "../shared/member-period";
import { currentAccount } from "../shared/account-store";
import { currentUserId, adoptLegacyIdentity, identifyByName } from "../shared/identity";
import * as db from "../shared/db";
import { incrementView } from "../shared/views-store";
import { planCoverImage, planCoverImageForLocation } from "../shared/cover";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import * as ExpenseStore from "../shared/expense-store";
import { escapeHtml, errorMessage, makeScopedQuery, safeHref } from "../shared/dom";
import { requestPasswordGate } from "../shared/auth";
import { loadData, normalizeDate, numberOrNaN, formatYen } from "./api-data-source";
import { renderLeafletMap } from "./leaflet-map";
import type { DayGroup, LeafletState } from "./types";
import { registerServiceWorker } from "../shared/pwa";
import { mountAppHeader, setAppHeaderHero } from "../shared/app-header";
import { getPayLink, isPayUrl } from "../shared/payment-links";
import { fetchDayWeather, weatherLabel } from "../shared/weather";
import { buildItineraryShareText } from "../shared/itinerary-text";
import { taskStatus, nextTaskStatus, setTaskStatus, checklistSummary, TASK_STATUS_LABEL } from "../shared/checklist";
import * as Backend from "../shared/backend";
import { bindExpenseSplitForm, expenseCurrencyCodes, expenseParticipantNames } from "../shared/expense-form";
import { setTripDocumentTitle } from "../shared/page-meta";
import { localDateISO, parseISO, toISO, mdLabel } from "../shared/date";
import { mapsSearchUrl } from "../shared/maps";
import { formatDurationMinutes, parseDurationMinutes } from "../shared/travel-duration";
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

const BASE_TRIP_CONFIG = readGlobalTripConfig();
const PLAN_OVERRIDE = TripPlans.resolveConfigOverride(BASE_TRIP_CONFIG) || {};
const CONFIG: TripConfig = resolvedTripConfig(PLAN_OVERRIDE);
setTripDocumentTitle(CONFIG.tripTitle, (title) => `${title}ダッシュボード`, "");

/** 共有ストアを読み終えたあと、開いている計画の実体で CONFIG を補正する。 */
function applyPlanConfig(): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return;
  CONFIG.tripTitle = meta.title || CONFIG.tripTitle;
  CONFIG.mode = meta.source === "sample" ? "sample" : "local";
  setTripDocumentTitle(CONFIG.tripTitle, (title) => `${title}ダッシュボード`, "");
}

/** 正式メンバーではない、ログイン済みの公開共同編集者か。 */
function isOpenEditingVisitor(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const row = db.planBySlug(CONFIG.tripSlug);
  return Boolean(
    meta && row && currentUserId() && !isMemberOf(meta) && row.open_editing &&
    row.visibility === "public" && row.status === "published"
  );
}

// ---- サンプルデータ -----------------------------------------------------

const SAMPLE: TripData = {
  trip: {
    title: CONFIG.tripTitle || "サンプル旅行",
    dates: "2027/3/10 - 3/12",
    members: "参加者A / 参加者B",
    note: "共有メモ: 予約番号や住所などの機密情報は公開ページに載せないでください。",
  },
  links: [
    { key: "maps", label: "My Maps", icon: "地", url: "https://www.google.com/maps/d/", caption: "Google My Maps" },
    { key: "photos", label: "写真", icon: "写", url: "https://photos.google.com/", caption: "Google Photos" },
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
    { country: "海外渡航先", currencyCode: "USD", currencyName: "現地通貨", approxRate: "最新レートを確認", rateUpdatedAt: "", feeFreeAtm: "現地で確認", atmBest: "", atmFee: "", atmNote: "DCCは原則拒否", rideBest: "", rideAlt: "", paymentNote: "カードと少額現金を併用" },
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
    // 人の公開計画を見ているときだけ出す。自分用の下書きに持ち帰る導線。
    {
      kind: "button",
      display: "icon",
      icon: "documentDuplicate",
      label: "コピーして自分用に作る",
      attr: "data-copy-head",
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

function mapsDir(places: ItineraryItem[]): string {
  const clean = places.map((p) => p.mapQuery || p.place).filter(Boolean) as string[];
  if (clean.length < 2) return mapsSearchUrl(clean[0] || "");
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
/** スマホの費用タブ。既定は精算する金額。PC では両方出すので使わない。 */
let moneyTab: "settle" | "details" = "settle";

function applyMoneyTab(next?: "settle" | "details"): void {
  if (next) moneyTab = next;
  qsa<HTMLElement>("[data-money-tab]").forEach((tab) => {
    const active = tab.dataset.moneyTab === moneyTab;
    tab.setAttribute("aria-selected", String(active));
    tab.classList.toggle("is-active", active);
  });
  qsa<HTMLElement>("[data-money-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.moneyPanel === moneyTab);
  });
}
let editingExpenseId: string | null = null;
let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

interface AiChatEntry {
  role: "user" | "assistant";
  text: string;
  proposal?: db.ItineraryRefineResult;
  applied?: boolean;
}

const aiChatEntries: AiChatEntry[] = [];
let aiChatBusy = false;

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

// フォームは日本語ラベルを value に持つ。列挙へ寄せる変換をここに集約する。
function categoryFromLabel(label: string): ExpenseStore.ExpenseCategory {
  return (ExpenseStore.CATEGORIES.find((c) => ExpenseStore.CATEGORY_LABEL[c] === label) || "other");
}
function splitFromLabel(label: string): ExpenseStore.SplitMethod {
  return (ExpenseStore.SPLIT_METHODS.find((m) => ExpenseStore.SPLIT_LABEL[m] === label) || "equal_all");
}
function paymentFromLabel(label: string): ExpenseStore.PaymentMethod | null {
  return ExpenseStore.PAYMENT_METHODS.find((m) => ExpenseStore.PAYMENT_LABEL[m] === label) || null;
}

/** この計画の DB 上の id。無ければ空文字。 */
function planId(): string {
  return TripPlans.planIdOf(CONFIG.tripSlug);
}

/** 参加者の user_id。表示名ではなくこちらを操作に使う。 */
function memberIds(): string[] {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const ids = meta?.memberIds || [];
  const me = currentUserId();
  // 自分がまだメンバーでない計画でも、自分名義で費用を入れられるようにする
  return me && !ids.includes(me) && !READ_ONLY ? [me, ...ids] : ids;
}

/** 費用と精算から Settlement を組み立てる。 */
function localSettlement(): Settlement {
  return ExpenseStore.computeSettlement(planId(), memberIds(), currentUserId());
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

function readProfile(): ProfileRecord | null {
  try {
    const profile = JSON.parse(localStorage.getItem(CONFIG.profile.storageKey) || "{}") as ProfileRecord;
    return profile && profile.name ? profile : null;
  } catch {
    return null;
  }
}

function saveProfile(name: string): void {
  try {
    localStorage.setItem(CONFIG.profile.storageKey, JSON.stringify({
      name,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // プライベートモード等。名前はこのセッション内でだけ有効になる。
  }
}

function saveExpenseEntryCache(data: TripData): void {
  const participants = expenseParticipants(data || SAMPLE);
  if (!participants.length) return;
  try {
    localStorage.setItem(CONFIG.expenseCache.storageKey, JSON.stringify({
      participants,
      tripTitle: (data && data.trip && data.trip.title) || CONFIG.tripTitle || "旅行",
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // 保存できなくても入力補助が効かなくなるだけなので続行する。
  }
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
    const savedName = currentProfileName(participants) || (readProfile()?.name || "");
    // 公開共同編集者は正式メンバー表に載っていない。
    // 選択肢から選ばせると誰も自分を選べないので、自由入力（既存メンバーは候補表示）にする。
    const freeText = isOpenEditingVisitor();
    const control = freeText
      ? `<input type="text" name="profileName" list="tlIdentityNames" required maxlength="24"
               autocomplete="name" placeholder="例: たろう" value="${escapeHtml(savedName)}">
         <datalist id="tlIdentityNames">
           ${participants.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}
         </datalist>`
      : `<select name="profileName" required>
           <option value="">選択してください</option>
           ${participants.map((name) =>
             `<option value="${escapeHtml(name)}" ${name === savedName ? "selected" : ""}>${escapeHtml(name)}</option>`,
           ).join("")}
         </select>`;
    const modal = document.createElement("div");
    modal.className = "tl-identity-modal";
    modal.innerHTML = `
      <form class="tl-identity-card" role="dialog" aria-modal="true" aria-labelledby="identityTitle">
        <header>
          <div>
            <h2 id="identityTitle">あなたは誰ですか</h2>
            <p>${freeText
              ? "名前を入れるだけでこの旅行に参加できます。ログインは不要です。"
              : "この端末に保存して、支払者などの初期値に使います。"}</p>
          </div>
          <div class="tl-identity-mark" data-identity-mark>${escapeHtml(profileInitial(savedName))}</div>
        </header>
        <div class="tl-identity-body">
          <label class="tl-identity-field">
            <span>本人として使う名前</span>
            ${control}
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
    const field = qs<HTMLSelectElement | HTMLInputElement>(freeText ? "input[name='profileName']" : "select", modal);
    const mark = qs<HTMLElement>("[data-identity-mark]", modal);
    const close = modal.querySelector<HTMLButtonElement>("[data-identity-close]");
    field.focus();
    const syncMark = (): void => {
      mark.textContent = profileInitial(field.value);
    };
    field.addEventListener("change", syncMark);
    field.addEventListener("input", syncMark);
    if (close) {
      close.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = field.value.trim();
      if (!name) {
        field.focus();
        return;
      }
      saveProfile(name);
      // 表示名から利用者を確定する（users に無ければ作る）。
      void identifyByName(name).then(() => {
        renderBase();
        renderActive();
      });
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
  // 利用者は identity（user_id）が正。確定済みなら訊かない。
  if (currentUserId()) {
    // 旧プロフィール（計画ごとの表示名）が空なら表示名で埋めておく（明細の見た目用）。
    if (!readProfile()) {
      const name = db.nameOf(currentUserId());
      if (name) saveProfile(name);
    }
    return;
  }
  // MySQL/API 版の本人確認はアカウントのセッションが正であり、端末ごとの
  // 表示名選択を使わない。招待された人の「誰として参加するか」は、署名付き
  // 招待リンクを開いた plans 画面で選択・承諾する。
  if (db.isEnabled()) {
    const back = "index.html?plan=" + encodeURIComponent(CONFIG.tripSlug);
    navigateWithPageTransition(
      "login.html?returnTo=" + encodeURIComponent(back),
      { replace: true },
    );
    return;
  }
  await showIdentityModal(true);
}

function requestPassword(): Promise<boolean> {
  return requestPasswordGate({
    auth: CONFIG.auth,
    classPrefix: "tl-auth",
    title: "旅行ページを開く",
    submitLabel: "送信",
  });
}

// ---- 日付ユーティリティ -------------------------------------------------

function todayISO(): string {
  return localDateISO(CONFIG.todayOverride);
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

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
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
  const a = parseISO(start);
  const b = parseISO(end);
  if (!a || !b || b < a) return [];
  const dates: string[] = [];
  let cursor = a;
  let guard = 0;
  while (cursor <= b && guard < 400) {
    dates.push(toISO(cursor));
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

function isEditableLocalPlan(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return !READ_ONLY && CONFIG.mode === "local" && Boolean(meta && isMemberOf(meta) && canEditPlan(meta));
}

function normalizePhotoUrl(value: string): string {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) throw new Error("https:// から始まる共有リンクを入力してください。");
  try {
    return new URL(url).href;
  } catch {
    throw new Error("URLの形式を確認してください。");
  }
}

function upsertPhotoAlbumLink(url: string): void {
  const existing = state.data.links || [];
  const withoutPhotos = existing.filter((link) => link.key !== "photos");
  state.data.links = [
    ...withoutPhotos,
    { key: "photos", label: "写真", icon: "写", url, caption: "Google Photos" },
  ];
  const saved = TripPlans.saveData(CONFIG.tripSlug, state.data as TripPlans.LocalPlanData);
  if (!saved) throw new Error("写真アルバムリンクを保存できませんでした。");
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
  if (!open) {
    editingExpenseId = null;
    renderExpenseEntry(state.data || SAMPLE, { force: true });
  }
  const title = sheet.querySelector<HTMLElement>("[data-expense-sheet-title]");
  if (title) title.textContent = editingExpenseId ? "費用を編集" : "費用を追加";
  const panel = sheet.querySelector<HTMLElement>("[role='dialog']");
  if (panel) panel.setAttribute("aria-label", editingExpenseId ? "費用を編集" : "費用を追加");
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

/** 費用まわりのセクション見出し。アイコン・文字サイズ・件数の位置をここで統一する。 */
function subhead(iconName: IconName, title: string, count?: string): string {
  return (
    `<h3 class="tl-subhead"><span class="tl-subhead-ic">${icon(iconName)}</span><b>${escapeHtml(title)}</b>` +
    (count ? `<small>${escapeHtml(count)}</small>` : "") +
    `</h3>`
  );
}

function renderTransfers(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-transfers]");
  if (!mount) return;
  const transfers = settlement.transfers || [];
  const history = settlement.settlementHistory || [];
  const historyHtml = history.length ? `
    <div class="tl-settlement-history">
      ${subhead("checkCircle", "精算履歴", `${history.length}件`)}
      ${history.map((item) => `
        <div class="tl-settlement-history-row">
          <span>${escapeHtml(mdLabel(item.date || ""))}</span>
          <b>${escapeHtml(item.from)} → ${escapeHtml(item.to)}</b>
          <strong>${escapeHtml(item.amountLabel)}</strong>
        </div>
      `).join("")}
    </div>` : "";
  if (!transfers.length) {
    mount.innerHTML = `${subhead("banknotes", "精算する金額")}<div class="tl-transfer-row"><span>現時点で精算する支払いはありません</span><b>¥0</b></div>${historyHtml}<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
    return;
  }
  mount.innerHTML = subhead("banknotes", "精算する金額", `${transfers.length}件`) + transfers.map((transfer: SettlementTransfer & { completedLabel?: string }) =>
    `<div class="tl-transfer-row">
      <span>${escapeHtml(transfer.from)} → ${escapeHtml(transfer.to)}</span>
      <div class="tl-transfer-act">
        <b>${escapeHtml(transfer.amountLabel || "")}</b>
        <button type="button" class="tl-icon-action tl-paypay" data-paypay data-to="${escapeHtml(transfer.to)}" data-amount="${Number(transfer.amount || 0)}" aria-label="${escapeHtml(transfer.to)}へPayPayで送る" title="PayPayで送る">${icon("paperAirplane")}</button>
        <button type="button" class="tl-icon-action" data-settlement-complete data-from="${escapeHtml(transfer.from)}" data-to="${escapeHtml(transfer.to)}" data-from-id="${escapeHtml(transfer.fromId || "")}" data-to-id="${escapeHtml(transfer.toId || "")}" data-amount="${Number(transfer.amount || 0)}" aria-label="${escapeHtml(transfer.from)}から${escapeHtml(transfer.to)}への精算を完了" title="精算完了">${icon("checkCircle")}</button>
      </div>
      ${transfer.completedLabel ? `<small>完了済み ${escapeHtml(transfer.completedLabel)} を差し引き済み</small>` : ""}
    </div>`,
  ).join("") + historyHtml + `<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
  setupSettlementCompleteHandlers(mount);
}

function renderPhotoAlbum(): void {
  const photo = linkByKey("photos");
  const url = photo.url || "";
  const workspaceView = canUseWorkspaceView();
  const card = root.querySelector<HTMLElement>("[data-photo-card]");
  if (card) card.hidden = !workspaceView && !url;
  const link = qs<HTMLAnchorElement>("[data-photo-link]");
  const button = qs<HTMLAnchorElement>("[data-photo-button]");
  const editButton = root.querySelector<HTMLButtonElement>("[data-photo-link-edit]");
  const input = root.querySelector<HTMLInputElement>("[data-photo-url]");

  link.href = url || "#";
  button.href = url || "#";
  link.classList.toggle("is-empty", !url);
  button.classList.toggle("is-disabled", !url);
  button.setAttribute("aria-disabled", String(!url));
  if (input) input.value = url;
  if (editButton) {
    editButton.hidden = !workspaceView || !isEditableLocalPlan();
    editButton.innerHTML = `${icon(url ? "pencilSquare" : "plus")}<span>${url ? "リンク変更" : "リンク設定"}</span>`;
  }

  const settlement = state.data.settlement || {};
  setText("[data-photo-title]", settlement.photoTitle || "写真アルバム");
  setText("[data-photo-meta]", url ? (settlement.photoMeta || "Google Photos") : "共有アルバムリンク未設定");
}

function confirmTransferAction(options: {
  tone?: "paypay" | "complete" | "danger";
  iconName: IconName;
  title: string;
  message: string;
  confirmLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(".tl-confirm-modal");
    if (existing) existing.remove();
    const modal = document.createElement("div");
    modal.className = `tl-confirm-modal ${options.tone ? `is-${options.tone}` : ""}`;
    modal.innerHTML = `
      <div class="tl-confirm-scrim" data-confirm-cancel></div>
      <section class="tl-confirm-card" role="dialog" aria-modal="true" aria-labelledby="transferConfirmTitle">
        <div class="tl-confirm-icon">${icon(options.iconName)}</div>
        <div class="tl-confirm-copy">
          <h2 id="transferConfirmTitle">${escapeHtml(options.title)}</h2>
          <p>${escapeHtml(options.message)}</p>
        </div>
        <div class="tl-confirm-actions">
          <button type="button" class="tl-confirm-cancel" data-confirm-cancel>キャンセル</button>
          <button type="button" class="tl-confirm-ok" data-confirm-ok>${escapeHtml(options.confirmLabel)}</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const finish = (ok: boolean): void => {
      document.documentElement.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeydown);
      modal.remove();
      resolve(ok);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(false);
    };
    modal.querySelectorAll<HTMLElement>("[data-confirm-cancel]").forEach((el) => {
      el.addEventListener("click", () => finish(false));
    });
    modal.querySelector<HTMLButtonElement>("[data-confirm-ok]")?.addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKeydown);
    setTimeout(() => modal.querySelector<HTMLButtonElement>("[data-confirm-ok]")?.focus(), 30);
  });
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
    button.addEventListener("click", async () => {
      const to = button.dataset.to || "";
      const amount = Number(button.dataset.amount || 0);
      if (!to || !amount) return;
      const ok = await confirmTransferAction({
        tone: "paypay",
        iconName: "paperAirplane",
        title: "PayPayで送金しますか",
        message: `${to} に ${formatYen(amount)} を送る準備をします。金額をコピーしてPayPayを開きます。`,
        confirmLabel: "PayPayを開く",
      });
      if (!ok) return;
      void payViaPayPay(to, amount, status);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-settlement-complete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const from = button.dataset.from || "";
      const to = button.dataset.to || "";
      const amount = Number(button.dataset.amount || 0);
      if (!from || !to || !amount) return;
      const ok = await confirmTransferAction({
        tone: "complete",
        iconName: "checkCircle",
        title: "精算完了マークをつけますか",
        message: `${from} から ${to} への ${formatYen(amount)} の精算を完了として記録します。実際の送金が済んでいる場合だけ進めてください。`,
        confirmLabel: "完了にする",
      });
      if (!ok) return;
      button.disabled = true;
      if (status) status.textContent = `${from} → ${to} を精算完了にしています...`;
      try {
        // 精算は settlements テーブルへ（費用と同居させない）。
        const fromId = button.dataset.fromId || "";
        const toId = button.dataset.toId || "";
        if (!fromId || !toId) throw new Error("精算相手を特定できませんでした");
        await ExpenseStore.addSettlement(planId(), {
          fromUserId: fromId,
          toUserId: toId,
          amountBaseMinor: amount,
          note: `サイト上で${from}から${to}への精算完了`,
        });
        renderBase();
        renderActive();
        const nextStatus = root.querySelector<HTMLElement>("[data-settlement-status]");
        if (nextStatus) {
          nextStatus.textContent = `${from} → ${to} を精算完了にしました。`;
          nextStatus.classList.add("is-ok");
        }
      } catch (error) {
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

function setupPhotoAlbumEditor(): void {
  const form = root.querySelector<HTMLFormElement>("[data-photo-link-form]");
  const editButton = root.querySelector<HTMLButtonElement>("[data-photo-link-edit]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-photo-link-cancel]");
  const input = root.querySelector<HTMLInputElement>("[data-photo-url]");
  const status = root.querySelector<HTMLElement>("[data-photo-link-status]");
  const openLinks = [
    root.querySelector<HTMLAnchorElement>("[data-photo-link]"),
    root.querySelector<HTMLAnchorElement>("[data-photo-button]"),
  ].filter((el): el is HTMLAnchorElement => Boolean(el));
  if (!form || !editButton || !input) return;

  const setStatus = (message: string, kind: "ok" | "error" | "" = ""): void => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-error", kind === "error");
  };
  const setOpen = (open: boolean): void => {
    form.hidden = !open;
    if (open) {
      setStatus("");
      input.value = linkByKey("photos").url || "";
      setTimeout(() => input.focus(), 30);
    }
  };

  openLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      if (linkByKey("photos").url) return;
      event.preventDefault();
      if (isEditableLocalPlan()) setOpen(true);
    });
  });
  editButton.addEventListener("click", () => setOpen(form.hidden));
  cancelButton?.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isEditableLocalPlan()) return;
    try {
      const url = normalizePhotoUrl(input.value);
      if (!url) throw new Error("共有アルバムURLを入力してください。");
      upsertPhotoAlbumLink(url);
      setOpen(false);
      renderBase();
      renderActive();
      setStatus("写真アルバムリンクを保存しました。", "ok");
    } catch (error) {
      setStatus((error as Error).message || "保存に失敗しました。", "error");
    }
  });
}

function renderExpenseDetails(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-details]");
  const button = root.querySelector<HTMLButtonElement>("[data-expense-detail-toggle]");
  if (!mount || !button) return;

  // 利用者は identity（user_id）が正。表示名は users から引く。
  const profileName = db.nameOf(currentUserId());
  const canManageExpenses = !READ_ONLY;
  const details = settlement.expenseDetails || [];
  const related = canManageExpenses ? details : profileName ? details.filter((detail) => {
    const shares = detail.shares || [];
    const targetNames = detail.targetNames || [];
    return targetNames.includes(profileName) ||
      shares.some((share) => share.name === profileName && Number(share.amount || 0) > 0);
  }) : [];

  // タブになったので常に描画しておく（切り替えは CSS の表示だけ）。
  mount.classList.add("is-visible");
  button.onclick = (): void => {
    applyMoneyTab("details");
  };

  if (!profileName) {
    mount.innerHTML = `<div class="tl-expense-empty">本人設定を登録すると、自分に関連する費用明細を表示できます。</div>`;
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
  const canceled = canManageExpenses
    ? ExpenseStore.canceledList(planId()).map((entry) => ExpenseStore.entryDetail(entry, currentUserId()))
    : [];
  const canceledHtml = canceled.length ? `
    <div class="tl-canceled-expenses">
      <div class="tl-subhead"><span>${icon("xCircle")}</span><b>取り消した費用</b><small>${canceled.length}件</small></div>
      ${canceled.map((detail) => `
        <div class="tl-canceled-expense" data-canceled-expense="${escapeHtml(detail.id || "")}">
          <span>${escapeHtml(mdLabel(detail.date || ""))}</span>
          <b>${escapeHtml(detail.title || "立替")}</b>
          <strong>${escapeHtml(detail.convertedLabel || detail.amountLabel || "")}</strong>
          <button type="button" class="tl-restore-expense" data-expense-restore="${escapeHtml(detail.id || "")}">${icon("arrowPath")}復活</button>
        </div>
      `).join("")}
    </div>` : "";
  // カテゴリごとの色。台帳の左に小さな丸を置いて、一覧の中で種別が拾えるようにする。
  const CAT_TONE: Record<string, string> = {
    食費: "food", 交通: "transport", 宿泊: "lodging",
    観光: "sightseeing", 通信: "communication", 精算: "settle",
  };
  const rowsHtml = related.length ? related.map((detail) => {
    const tone = CAT_TONE[detail.category || ""] || "other";
    const paid = detail.convertedLabel || detail.amountLabel || "";
    return `
    <li class="tl-ledger-row" data-expense-row="${escapeHtml(detail.id || "")}">
      <span class="tl-ledger-dot" data-cat="${tone}" aria-hidden="true"></span>
      <div class="tl-ledger-body">
        <b class="tl-ledger-title">${escapeHtml(detail.title || "立替")}</b>
        <span class="tl-ledger-meta">
          <span class="tl-ledger-cat">${escapeHtml(detail.category || "その他")}</span>
          <i>·</i>${escapeHtml(mdLabel(detail.date || ""))}
          <i>·</i>${escapeHtml(detail.payer || "")}が${escapeHtml(paid)}
        </span>
      </div>
      <div class="tl-ledger-amount">
        <strong>${escapeHtml(shareFor(detail))}</strong>
        <span>${escapeHtml(roleFor(detail))}</span>
      </div>
      ${canManageExpenses ? `<div class="tl-ledger-act">
        <button type="button" class="tl-icon-action" data-expense-edit="${escapeHtml(detail.id || "")}" aria-label="${escapeHtml(detail.title || "費用")}を編集" title="編集">${icon("pencilSquare")}</button>
        <button type="button" class="tl-icon-action danger" data-expense-remove="${escapeHtml(detail.id || "")}" aria-label="${escapeHtml(detail.title || "費用")}を取り消す" title="取り消し">${icon("xCircle")}</button>
      </div>` : ""}
    </li>`;
  }).join("") : `
    <li class="tl-ledger-empty">
      ${canManageExpenses ? "支払い台帳に表示する費用はありません。" : `${escapeHtml(profileName)}に関連する支払いはまだありません。`}
    </li>`;

  mount.innerHTML = `
    ${subhead("documentText", canManageExpenses ? "支払い台帳" : `${escapeHtml(profileName)}に関連する支払い`, `${related.length}件`)}
    <ul class="tl-ledger">
      ${rowsHtml}
    </ul>
    ${canceledHtml}`;
  setupExpenseDetailActions(mount);
}

function setupExpenseDetailActions(mount: HTMLElement): void {
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.expenseEdit || "";
      const record = ExpenseStore.get(planId(), id);
      if (!record) return;
      editingExpenseId = id;
      renderExpenseEntry(state.data || SAMPLE, { force: true });
      setExpenseSheet(true);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.expenseRemove || "";
      const record = ExpenseStore.get(planId(), id);
      if (!record) return;
      const ok = await confirmTransferAction({
        tone: "danger",
        iconName: "xCircle",
        title: "この費用を取り消しますか",
        message: `${record.row.title || "費用"}（${formatYen(record.row.amount_base_minor)}）を支払い台帳から外します。取り消し履歴からあとで復活できます。`,
        confirmLabel: "取り消す",
      });
      if (!ok) return;
      const removed = ExpenseStore.remove(id);
      if (!removed.row) return;
      renderBase();
      renderActive();
      showExpenseUndo(removed.row, removed.shares);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-restore]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.expenseRestore || "";
      if (!id || !ExpenseStore.restoreById(planId(), id)) return;
      renderBase();
      renderActive();
      const status = root.querySelector<HTMLElement>("[data-settlement-status]");
      if (status) {
        status.textContent = "取り消した費用を支払い台帳へ戻しました。";
        status.classList.add("is-ok");
      }
    });
  });
}

function showExpenseUndo(record: ExpenseStore.ExpenseRow, shares: ExpenseStore.ExpenseShareRow[]): void {
  const status = root.querySelector<HTMLElement>("[data-settlement-status]");
  if (!status) return;
  status.classList.remove("is-error");
  status.classList.add("is-ok");
  status.innerHTML = `${escapeHtml(record.title || "費用")}を取り消しました。<button type="button" class="tl-inline-undo" data-expense-undo="${escapeHtml(record.id)}">元に戻す</button>`;
  const undo = status.querySelector<HTMLButtonElement>("[data-expense-undo]");
  if (!undo) return;
  undo.addEventListener("click", () => {
    ExpenseStore.restore(record, shares);
    renderBase();
    renderActive();
    const nextStatus = root.querySelector<HTMLElement>("[data-settlement-status]");
    if (nextStatus) {
      nextStatus.textContent = `${record.title || "費用"}を元に戻しました。`;
      nextStatus.classList.add("is-ok");
    }
  });
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
  if (READ_ONLY) return names;
  // 保存済みの本人設定も必ず含める。端末のユーザー名と本人設定が食い違っていると
  // currentProfileName() が空を返し、本人設定モーダルが毎回出てしまうため。
  const mine = [selfName(), (readProfile()?.name || "").trim()].filter(Boolean);
  const out = [...names];
  mine.forEach((name) => {
    if (!out.includes(name)) out.unshift(name);
  });
  return out;
}

function expenseParticipants(data: TripData): string[] {
  const discovered = expenseParticipantNames(data);
  if (discovered.length) return withSelf(discovered);
  // メンバーも本人も分からないときだけダミー名にフォールバックする。
  const onlySelf = withSelf([]);
  return onlySelf.length ? onlySelf : CONFIG.defaultParticipants || ["参加者A", "参加者B"];
}

function expenseCurrencies(data: TripData): string[] {
  return expenseCurrencyCodes(data, CONFIG.currencies);
}

function renderExpenseEntry(data: TripData, options: { force?: boolean } = {}): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-entry]");
  if (!mount) return;
  const existingForm = mount.querySelector<HTMLFormElement>("[data-expense-form-native]");
  if (!options.force && existingForm && existingForm.dataset.dirty === "true") return;
  const editingRecord = editingExpenseId ? ExpenseStore.get(planId(), editingExpenseId) : undefined;
  const participants = expenseParticipants(data);
  if (editingExpenseId && !editingRecord) {
    mount.innerHTML = `<div class="tl-expense-empty">編集する費用が見つかりませんでした。台帳を更新してからもう一度開いてください。</div>`;
    return;
  }
  if (editingRecord) {
    const editingNames = [
      db.nameOf(editingRecord.row.payer_user_id),
      ...editingRecord.shares.map((share) => db.nameOf(share.user_id)),
    ].filter(Boolean);
    editingNames.forEach((name) => {
      if (!participants.includes(name)) participants.push(name);
    });
  }
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
    <form class="tl-expense-form" data-expense-form-native>
      <div class="tl-expense-primary">
        <label class="tl-field tl-amount-field">
          <span>金額 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="number" name="amount" required min="1" step="1" inputmode="decimal" placeholder="0">
        </label>
        <label class="tl-field wide">
          <span>内容 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="text" name="title" required placeholder="例: 空港からホテルまでのタクシー">
        </label>
        <label class="tl-field">
          <span>支払者 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <select name="payer" required>${payerOptions}</select>
        </label>
      </div>

      <div class="tl-expense-editors" aria-label="費用の詳細">
        <details class="tl-expense-editor">
          <summary>${icon("calendarDays")}<span>支払日</span><b data-expense-summary-date></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>支払日 <b class="tl-required-mark" aria-label="必須">*</b></span>
            <input type="date" name="paidDate" required>
          </label>
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("listBullet")}<span>カテゴリ</span><b data-expense-summary-category></b>${icon("chevronDown")}</summary>
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
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("currencyYen")}<span>通貨</span><b data-expense-summary-currency></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>通貨 <b class="tl-required-mark" aria-label="必須">*</b></span>
            <select name="currency" required>${currencyOptions}</select>
          </label>
        </details>
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

      <div class="tl-expense-editors" aria-label="任意項目">
        <details class="tl-expense-editor">
          <summary>${icon("banknotes")}<span>支払方法</span><b data-expense-summary-payment></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>支払方法</span>
            <select name="paymentMethod">
              <option>カード</option>
              <option>現金</option>
              <option>送金</option>
              <option>その他</option>
            </select>
          </label>
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("pencilSquare")}<span>メモ</span><b data-expense-summary-note>任意</b>${icon("chevronDown")}</summary>
          <label class="tl-field wide">
            <span>メモ</span>
            <textarea name="note" placeholder="任意。為替メモや補足があれば入力"></textarea>
          </label>
        </details>
      </div>

      <div class="tl-expense-submit">
        <div class="tl-expense-status" data-expense-status aria-live="polite"></div>
        <button type="submit">${editingRecord ? "更新" : "保存"}</button>
      </div>
    </form>`;

  const form = qs<HTMLFormElement>("[data-expense-form-native]", mount);
  (form.elements.namedItem("paidDate") as HTMLInputElement).value = todayISO();
  applyProfileDefaults(form, participants);
  if (editingRecord) {
    fillExpenseForm(form, editingRecord, participants);
  }
  setupExpenseEntryHandlers(form, participants);
}

function fillExpenseForm(form: HTMLFormElement, entry: ExpenseStore.ExpenseEntry, participants: string[]): void {
  const record = {
    paidDate: entry.row.paid_on || "",
    payer: db.nameOf(entry.row.payer_user_id),
    category: ExpenseStore.CATEGORY_LABEL[entry.row.category],
    title: entry.row.title,
    amount: entry.row.amount_minor,
    currency: entry.row.currency,
    splitMode: ExpenseStore.SPLIT_LABEL[entry.row.split_method],
    paymentMethod: entry.row.payment_method ? ExpenseStore.PAYMENT_LABEL[entry.row.payment_method] : "",
    note: entry.row.note || "",
    targets: entry.shares.map((s) => db.nameOf(s.user_id)).filter(Boolean),
    individual: Object.fromEntries(entry.shares.map((s) => [db.nameOf(s.user_id), s.amount_base_minor])),
  };
  const setField = (name: string, value: string | number | undefined): void => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (field) field.value = String(value ?? "");
  };
  setField("paidDate", record.paidDate || todayISO());
  setField("payer", record.payer);
  setField("category", record.category);
  setField("currency", record.currency || "JPY");
  setField("title", record.title);
  setField("amount", record.amount);
  setField("paymentMethod", record.paymentMethod);
  setField("note", record.note);
  qsa<HTMLInputElement>("input[name='splitMode']", form).forEach((input) => {
    input.checked = input.value === record.splitMode;
  });
  qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => {
    input.checked = record.targets && record.targets.length ? record.targets.includes(input.value) : true;
  });
  participants.forEach((name) => {
    const input = qsa<HTMLInputElement>("[data-share-name]", form).find((item) => item.dataset.shareName === name);
    if (input) input.value = record.individual && record.individual[name] ? String(record.individual[name]) : "";
  });
}

function setupExpenseEntryHandlers(form: HTMLFormElement, participants: string[]): void {
  const status = qs<HTMLElement>("[data-expense-status]", form);
  const button = qs<HTMLButtonElement>("button[type='submit']", form);

  const field = (name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  const setStatus = (message: string, type: "error" | "ok" | ""): void => {
    status.textContent = message || "";
    status.classList.toggle("is-error", type === "error");
    status.classList.toggle("is-ok", type === "ok");
  };
  const setSummary = (selector: string, value: string): void => {
    const node = form.querySelector<HTMLElement>(selector);
    if (node) node.textContent = value;
  };
  const updateEditorSummaries = (): void => {
    setSummary("[data-expense-summary-date]", mdLabel((field("paidDate") as HTMLInputElement).value || todayISO()));
    setSummary("[data-expense-summary-category]", (field("category") as HTMLSelectElement).value || "食費");
    setSummary("[data-expense-summary-currency]", (field("currency") as HTMLSelectElement).value || "JPY");
    setSummary("[data-expense-summary-payment]", (field("paymentMethod") as HTMLSelectElement).value || "カード");
    const note = ((field("note") as HTMLTextAreaElement).value || "").trim();
    setSummary("[data-expense-summary-note]", note ? "入力済み" : "任意");
  };

  const markChanged = (): void => {
    form.dataset.dirty = "true";
    updateEditorSummaries();
  };
  const split = bindExpenseSplitForm(form, participants, {
    onChange: markChanged,
    onInput: markChanged,
  });
  updateEditorSummaries();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (READ_ONLY) {
      setStatus("閲覧のみの計画では費用を追加できません。", "error");
      return;
    }
    const validation = split.validationMessage();
    if (validation) { setStatus(validation, "error"); return; }
    const mode = split.mode();
    const targets = split.selectedNames();
    const individual = split.individualAmounts();
    const amount = split.amount();

    button.disabled = true;
    setStatus("保存中...", "");
    try {
      // フォームは表示名と日本語ラベルを持つので、user_id と列挙へ変換して保存する。
      const idOf = (name: string): string => db.ensureUserLocal(name).id;
      const custom: Record<string, number> = {};
      for (const [name, value] of Object.entries(individual)) custom[idOf(name)] = value;
      const paidOn = (field("paidDate") as HTMLInputElement).value || "";
      const payload: ExpenseStore.AddInput = {
        paidOn: paidOn || null,
        payerUserId: idOf((field("payer") as HTMLSelectElement).value),
        category: categoryFromLabel((field("category") as HTMLSelectElement).value),
        title: (field("title") as HTMLInputElement).value,
        amountMinor: amount,
        currency: (field("currency") as HTMLSelectElement).value,
        splitMethod: splitFromLabel(mode),
        paymentMethod: paymentFromLabel((field("paymentMethod") as HTMLSelectElement).value),
        note: (field("note") as HTMLTextAreaElement).value,
        // 「全員で等分」は、その費用の日に旅行へ在籍していたメンバーだけを対象にする
        // （途中合流/離脱を反映）。日付未指定なら全員。
        memberIds: TripPlans.memberIdsPresentOn(planId(), paidOn),
        selectedIds: targets.map(idOf),
        customAmounts: custom,
      };
      if (editingExpenseId) {
        await ExpenseStore.update(editingExpenseId, payload);
      } else {
        await ExpenseStore.add(planId(), payload);
      }
      form.reset();
      form.dataset.dirty = "false";
      editingExpenseId = null;
      (field("paidDate") as HTMLInputElement).value = todayISO();
      applyProfileDefaults(form, participants);
      qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => { input.checked = true; });
      split.refresh();
      renderBase();
      renderActive();
      setExpenseSheet(false);
      const nextStatus = root.querySelector<HTMLElement>("[data-expense-status]");
      if (nextStatus) {
        nextStatus.textContent = "保存しました。費用を更新済みです。";
        nextStatus.classList.add("is-ok");
      }
    } catch (error) {
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
  const workspaceView = canUseWorkspaceView();

  const tabs: { key: string; label: string; glyph: string }[] = [
    { key: "home", label: "ホーム", glyph: icon("home") },
    ...(workspaceView ? [{ key: "members", label: "メンバー", glyph: icon("users") }] : []),
    { key: "map", label: "地図", glyph: icon("map") },
    ...(workspaceView ? [{ key: "money", label: "費用", glyph: icon("banknotes") }] : []),
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

  qsa<HTMLElement>("[data-workspace-only]").forEach((el) => {
    el.hidden = !workspaceView;
  });
  qsa<HTMLElement>("[data-mobile-nav='members'], [data-mobile-nav='money']").forEach((el) => {
    el.hidden = !workspaceView;
  });
  syncMobileNavLayout();
  if (!workspaceView && (mobileView === "members" || mobileView === "money")) {
    mobileView = "home";
  }

  if (workspaceView) renderMembers(data);

  qs<HTMLAnchorElement>("[data-my-maps]").href = linkByKey("maps").url || "#";

  if (workspaceView) {
    data.settlement = { ...data.settlement, ...localSettlement() };
  }
  const settlement = data.settlement || {};
  setText("[data-paid]", settlement.expenseTotal || "¥0");
  setText("[data-your-paid]", settlement.yourPaid || "—");
  setText("[data-your-due]", settlement.yourDue || "¥0");
  if (workspaceView) {
    renderTransfers(settlement);
    renderExpenseDetails(settlement);
    applyMoneyTab();
  }
  renderPhotoAlbum();
  if (workspaceView) {
    saveExpenseEntryCache(data);
    renderExpenseEntry(data);
  }
  renderLocalInfo(data.localInfo || []);

  const primaryLinkKeys = workspaceView ? ["itinerary", "maps", "expenseSheet", "photos"] : ["itinerary", "maps", "photos"];
  const primaryLinks = primaryLinkKeys.map(linkByKey).filter((link): link is TripLink => Boolean(link.url));
  const docs = data.links.filter((link) => !["itinerary", "maps", "expenseForm", "photos", "expenseSheet"].includes(link.key)).concat(primaryLinks);
  setHtml("[data-docs]", docs.slice(0, 5).map((doc) =>
    `<a class="tl-doc" href="${escapeHtml(safeHref(doc.url))}" target="_blank" rel="noopener">
      <span class="tl-doc-icon">${linkIcon(doc.key)}</span><b>${escapeHtml(doc.label)}</b><span>${icon("arrowTopRightOnSquare")}</span>
    </a>`,
  ).join(""));
  setText("[data-links-title]", workspaceView ? "リンク・タスク" : "リンク");

  const checksEl = root.querySelector<HTMLElement>("[data-checks]");
  if (checksEl) checksEl.hidden = !workspaceView;
  if (workspaceView) renderChecklist();
  else setHtml("[data-checks]", "");

  const route = computeRoute();
  renderDayTabs(route);
  applyMobileView(mobileView);
}

// ---- タスク（チェックリスト） -------------------------------------------

/** タスクを編集・保存できるのはこの端末のローカル計画のみ。 */
function tasksEditable(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return !READ_ONLY && CONFIG.mode === "local" && Boolean(meta && isMemberOf(meta) && canEditPlan(meta));
}

function canUseWorkspaceView(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return !READ_ONLY;
  if (isMemberOf(meta)) return true;
  if (!planHasOwner(meta) && !READ_ONLY) return true;
  return false;
}

function syncMobileNavLayout(): void {
  const nav = root.querySelector<HTMLElement>(".tl-mobile-nav");
  if (!nav) return;
  const visibleCount = qsa<HTMLElement>("[data-mobile-nav]").filter((button) => !button.hidden).length;
  nav.style.setProperty("--tl-mobile-nav-count", String(Math.max(1, visibleCount)));
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
  const summary = checklistSummary(items);
  // 状態はアイコンだけで示す。「未着手」などの文字を毎行に置くと
  // 幅を食ってタスク名が折り返し、行の高さがばらついていた。
  const STATE_ICON: Record<string, IconName> = { todo: "minus", doing: "clock", done: "check" };

  const rows = items
    .map((item, index) => {
      const status = taskStatus(item);
      const label = TASK_STATUS_LABEL[status];
      const mark = `<span class="tl-task-mark">${icon(STATE_ICON[status] || "minus")}</span>`;
      const state = editable
        ? `<button class="tl-task-state" type="button" data-task-toggle="${index}" aria-label="状態: ${label}（押すと変更）" title="${label}">${mark}</button>`
        : `<span class="tl-task-state" aria-label="状態: ${label}" title="${label}">${mark}</span>`;
      const del = editable
        ? `<button class="tl-task-del" type="button" data-task-del="${index}" aria-label="このタスクを削除">${icon("xMark")}</button>`
        : "";
      return `<li class="tl-task is-${status}">${state}<span class="tl-task-label">${escapeHtml(item.label)}</span>${del}</li>`;
    })
    .join("");

  // 進捗は細い罫線1本で示す（箱やゲージを置かない）。
  const pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const progress = summary.total
    ? `<div class="tl-task-progress" role="img" aria-label="完了 ${summary.done} / ${summary.total}">
         <span style="width:${pct}%"></span>
       </div>`
    : "";
  const addHtml = editable
    ? `<form class="tl-task-add" data-task-add>
         <input data-task-input type="text" maxlength="60" placeholder="タスクを追加" aria-label="タスクを追加" autocomplete="off">
         <button type="submit" aria-label="追加">${icon("plus")}</button>
       </form>`
    : "";
  const emptyHtml = !items.length
    ? `<p class="tl-task-empty">${editable ? "タスクを追加すると、ここに並びます。" : "タスクはありません"}</p>`
    : "";

  setHtml(
    "[data-checks]",
    `${subhead("listBullet", "タスク", summary.total ? `${summary.done}/${summary.total}` : "")}
     ${progress}
     <ul class="tl-tasks">${rows}</ul>${emptyHtml}${addHtml}`,
  );
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

/** 参加メンバー一覧を描画。招待は owner、脱退は owner 以外の正式メンバーに表示。 */
function renderMembers(data: TripData): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const membersStr = (meta && meta.members) || (data.trip && data.trip.members) || "";
  // 公開共同編集者は正式メンバーではないため、本人設定した名前を候補として扱う。
  // （連携元のメンバー表には載らないため、ここで補って「参加している」状態に見せる）。
  const openEditingVisitor = isOpenEditingVisitor();
  const myName = getUser().name.trim() || (openEditingVisitor ? (readProfile()?.name || "").trim() : "");
  const names = splitNames(membersStr);
  if (openEditingVisitor && myName && !names.includes(myName)) names.unshift(myName);

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
              `<a class="tl-member-row${self ? " is-self" : ""}" href="person.html?name=${encodeURIComponent(n)}" title="${escapeHtml(n)}さんの旅行履歴を見る">` +
              `<span class="tl-member-avatar">${escapeHtml(n.slice(0, 1) || "?")}</span>` +
              `<span class="tl-member-name">${escapeHtml(n)}</span>` +
              (self ? `<span class="tl-member-self-badge">自分</span>` : "") +
              `<span class="tl-member-go">${icon("chevronRight")}</span>` +
              "</a>"
            );
          })
          .join("")
      : `<div class="tl-members-empty">まだメンバーがいません。下から招待できます。</div>`;
  }

  const inviteEl = root.querySelector<HTMLElement>("[data-members-invite]");
  if (inviteEl) inviteEl.hidden = READ_ONLY || CONFIG.mode !== "local" || !meta || !canManagePlan(meta);

  // 脱退は「名前を設定した参加メンバー」だけ（＝自分が一覧にいる）。
  const leaveEl = root.querySelector<HTMLElement>("[data-members-leave]");
  if (leaveEl) leaveEl.hidden = READ_ONLY || !meta || !isMemberOf(meta) || canManagePlan(meta);
}

/** 自分をこの旅行のメンバーから外して一覧へ戻る（脱退）。 */
async function leaveTrip(): Promise<void> {
  if (READ_ONLY) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta || !meta.id || !isMemberOf(meta) || canManagePlan(meta)) return;
  try {
    await db.leavePlan(meta.id);
    navigateWithPageTransition("plans.html");
  } catch (error) {
    const leaveButton = root.querySelector<HTMLButtonElement>("[data-leave-trip]");
    if (leaveButton) flashButton(leaveButton, errorMessage(error) || "脱退できませんでした");
  }
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
  const text = buildItineraryShareText(state.data.trip, state.days, (id) => db.nameOf(id));
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
  if (!canManagePlan(meta)) {
    if (btn) flashButton(btn, "所有者のみ招待できます");
    return;
  }
  const nameInput = root.querySelector<HTMLInputElement>("[data-invite-name]");
  const name = (nameInput?.value || "").trim();
  try {
    const planId = TripPlans.planIdOf(meta.slug);
    if (!planId) throw new Error("計画IDが見つかりません");
    const invite = await db.createInvite(planId, { invited_name: name || undefined, role: "editor" });
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
      token: invite.token,
      invitedName: name || undefined,
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
  } catch (error) {
    // 権限なし・回数制限・期限切れを見分けられるよう、サーバーの説明をそのまま出す
    if (btn) flashButton(btn, errorMessage(error) || "作成できませんでした");
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
    <a class="tl-stay-map" href="${mapsSearchUrl(s.mapQuery || s.place || s.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a>
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
  const you = currentUserId();
  return day.items.filter((i) => String(i.type) !== "stay").map((item) => {
    const type = String(item.type || "todo");
    const placeText = item.place && item.place !== item.title ? `場所: ${item.place}` : "";
    const moveText = type === "move" ? [item.transport, item.duration].filter(Boolean).join("・") : "";
    const metaText = [moveText || placeText, item.note].filter(Boolean).join(" / ");
    const label = `<span class="tl-kind ${escapeHtml(type)}">${escapeHtml(item.typeLabel || item.type || "予定")}</span>`;

    // 一部メンバーだけの予定（途中合流の個人移動など）は名前チップを出し、
    // 自分が含まれない予定はさらに淡くして「自分の行程」が目で追えるようにする。
    const subsetIds = Array.isArray(item.members) ? item.members.filter(Boolean) : [];
    const subsetNames = subsetIds.map((id) => db.nameOf(id)).filter(Boolean);
    const notYou = subsetIds.length > 0 && Boolean(you) && !subsetIds.includes(you);
    const itemCls = subsetIds.length ? (notYou ? " is-subset is-not-you" : " is-subset") : "";
    const membersChip = subsetIds.length
      ? `<span class="tl-item-members" title="この予定の対象メンバー">${icon("users")}${escapeHtml(subsetNames.join("・") || "一部メンバー")}${notYou ? `<i>あなたは別行動</i>` : ""}</span>`
      : "";

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

    return `<article class="tl-item${itemCls}" data-kind="${escapeHtml(type)}">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot ${escapeHtml(type)}">${kindIcon(type)}</span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">${label}${title}</div>
        ${membersChip}
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        <p class="tl-meta">${metaText ? `<span class="tl-meta-text">${escapeHtml(metaText)}</span>` : ""}<a class="tl-maplink" href="${mapsSearchUrl(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a></p>
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

/** その日の途中合流/離脱バッジ。参加期間（plan_members の from/to_date）から導出する。 */
function presenceBadgesHtml(day: DayGroup): string {
  const id = planId();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return "";
  const periods = TripPlans.memberPeriods(id);
  if (!periods.length) return "";
  const first = state.days[0]?.date || "";
  const last = state.days[state.days.length - 1]?.date || "";
  const joins = joinersOn(periods, day.date, first).map((uid) => db.nameOf(uid)).filter(Boolean);
  const leaves = leaversOn(periods, day.date, last).map((uid) => db.nameOf(uid)).filter(Boolean);
  const parts: string[] = [];
  if (joins.length) parts.push(`<span class="tl-day-presence is-join">${icon("users")}${escapeHtml(joins.join("・"))} 合流</span>`);
  if (leaves.length) parts.push(`<span class="tl-day-presence is-leave">${escapeHtml(leaves.join("・"))} この日まで</span>`);
  return parts.join("");
}

function dayBlockHtml(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  const head = [day.day, day.area, mdLabel(day.date)].filter(Boolean).join(" ・ ");
  // 手入力があれば表示。無ければ空にしておき、hydrateWeather が自動取得で埋める。
  const weather = `<span class="tl-dayblock-weather" data-weather-for="${escapeHtml(day.date)}">${day.weather ? "☀ " + escapeHtml(day.weather) : ""}</span>`;
  const items = timelineHtmlForDay(idx);
  return `<section class="tl-dayblock" data-day-block="${idx}">
    <div class="tl-dayblock-head"><span class="tl-dayblock-lead"><span>${escapeHtml(head)}</span>${presenceBadgesHtml(day)}</span>${weather}</div>
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
  updateAiChatContext();

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
    pin.href = mapsSearchUrl(place.mapQuery || place.place || place.title);
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

async function syncData(isInitial: boolean): Promise<void> {
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
  // 公開共同編集はログイン済み利用者だけ。正式メンバー権限とは分離する。
  if (isOpenEditingVisitor()) return false;
  const forcedView = new URLSearchParams(location.search).get("view") === "1";
  if (forcedView) return true;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return false;
  if (canEditPlan(meta)) return false;
  // 公開されている計画は、参加者でなければ閲覧のみ。
  //
  // ここは planHasOwner だけで判断していたが、bootstrap は自分が
  // 関わらない計画の参加者行を返さない。そのため人の公開計画は
  // 「持ち主が居ない」と見えてしまい、編集できる扱いになっていた
  // （保存はサーバーが 403 で止めるが、編集ボタンが出て、
  //   代わりに出すべき「コピーして自分用に作る」が出なかった）。
  if (isPublished(meta)) return true;
  // 未公開の計画で参加者も権限行も無いものは、持ち主が居ないと見なして
  // ロックしない（ログアウト状態で作った下書きを、本人が二度と
  // 編集できなくなるのを防ぐ）。
  return planHasOwner(meta);
}

/**
 * 見ている計画を自分の下書きとして複製し、そのまま編集画面へ移る。
 * 元の計画には触らない（参加者も引き継がない）。
 */
async function copyPlanToMine(button: HTMLButtonElement): Promise<void> {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return;
  if (!currentUserId()) {
    const back = "index.html?plan=" + encodeURIComponent(CONFIG.tripSlug);
    location.href = "login.html?returnTo=" + encodeURIComponent(back);
    return;
  }
  // 既にこの計画のコピーを持っているなら、作り直さずそれを開く。
  const already = TripPlans.existingCopyOf(CONFIG.tripSlug);
  if (already) {
    TripPlans.setActiveSlug(already.slug);
    location.href = "plan-editor.html?plan=" + encodeURIComponent(already.slug);
    return;
  }
  button.disabled = true;
  try {
    const copy = await TripPlans.duplicateAndSave(CONFIG.tripSlug);
    if (!copy) {
      window.alert("コピーできませんでした。読み込みが終わってからもう一度お試しください。");
      return;
    }
    TripPlans.setActiveSlug(copy.slug);
    location.href = "plan-editor.html?plan=" + encodeURIComponent(copy.slug);
  } catch (error) {
    window.alert("コピーを保存できませんでした。" + (error instanceof Error ? error.message : ""));
  } finally {
    button.disabled = false;
  }
}

function numberOrNull(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return value !== "" && value !== null && value !== undefined && Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function moveCities(item: ItineraryItem): { from: string; to: string } {
  const title = String(item.title || "");
  const parts = title.split(/\s*(?:→|⇒|->|から)\s*/).map((part) => part.trim()).filter(Boolean);
  return {
    from: parts.length > 1 ? parts[0] : "",
    to: parts.length > 1 ? parts[parts.length - 1] : String(item.area || ""),
  };
}

function itineraryForAi(items: ItineraryItem[]): db.ItineraryRefineItem[] {
  return items.map((item) => {
    const move = String(item.type) === "move";
    const cities = moveCities(item);
    const city = move ? cities.to || String(item.area || "") : String(item.area || "");
    return {
      date: normalizeDate(item.date),
      time: String(item.time || "").slice(0, 5),
      kind: (["sight", "move", "food", "stay", "todo", "form"].includes(String(item.type))
        ? item.type
        : "sight") as db.ItineraryKind,
      city,
      title: String(item.title || ""),
      place: String(item.place || ""),
      address: String(item.mapQuery || item.place || ""),
      latitude: numberOrNull(item.lat, -90, 90),
      longitude: numberOrNull(item.lng, -180, 180),
      note: String(item.note || ""),
      from_city: move ? cities.from : "",
      from_place: move ? String(item.origin || "") : "",
      from_address: move ? String(item.origin || "") : "",
      from_latitude: move ? numberOrNull(item.originLat, -90, 90) : null,
      from_longitude: move ? numberOrNull(item.originLng, -180, 180) : null,
      to_city: move ? cities.to || city : "",
      to_place: move ? String(item.destination || item.place || "") : "",
      to_address: move ? String(item.destination || item.mapQuery || "") : "",
      to_latitude: move ? numberOrNull(item.destinationLat ?? item.lat, -90, 90) : null,
      to_longitude: move ? numberOrNull(item.destinationLng ?? item.lng, -180, 180) : null,
      transport: move ? String(item.transport || "その他") : "",
      duration_minutes: move ? parseDurationMinutes(item.duration) || 0 : 0,
    };
  }).filter((item) => item.date);
}

function latestAiItinerary(): db.ItineraryRefineItem[] {
  for (let index = aiChatEntries.length - 1; index >= 0; index -= 1) {
    if (aiChatEntries[index].proposal) return aiChatEntries[index].proposal!.itinerary;
  }
  return itineraryForAi(state.data.itinerary || []);
}

function itineraryFromAi(items: db.ItineraryRefineItem[]): ItineraryItem[] {
  const dates = tripDateRange(state.data);
  return items.map((item) => {
    const dayIndex = Math.max(0, dates.indexOf(item.date));
    const move = item.kind === "move";
    return {
      date: item.date,
      day: `Day ${dayIndex + 1}`,
      time: item.time,
      type: item.kind,
      title: item.title,
      place: move ? item.to_place || item.place : item.place,
      area: item.city,
      note: item.note,
      mapQuery: move ? item.to_address || item.address : item.address,
      lat: move ? item.to_latitude ?? item.latitude ?? "" : item.latitude ?? "",
      lng: move ? item.to_longitude ?? item.longitude ?? "" : item.longitude ?? "",
      origin: move ? item.from_place : "",
      originLat: move ? item.from_latitude ?? undefined : undefined,
      originLng: move ? item.from_longitude ?? undefined : undefined,
      destination: move ? item.to_place : "",
      destinationLat: move ? item.to_latitude ?? undefined : undefined,
      destinationLng: move ? item.to_longitude ?? undefined : undefined,
      transport: move ? item.transport : "",
      duration: move ? formatDurationMinutes(item.duration_minutes) : "",
    };
  });
}

/**
 * AI提案で行程を丸ごと置き換えるとき、対象メンバー指定（一部の人だけの予定）を
 * 旧行程から引き継ぐ。AIのDTOは member 情報を持たないため、同じ予定
 * （日付+種別+タイトル、移動は日付+区間）を探して移し替える。
 */
function carryOverItemMembers(next: ItineraryItem[]): ItineraryItem[] {
  const tagged = (state.data.itinerary || []).filter((it) => Array.isArray(it.members) && it.members.length);
  if (!tagged.length) return next;
  const norm = (v: unknown): string => String(v || "").trim();
  const remaining = [...tagged];
  const take = (match: (it: ItineraryItem) => boolean): string[] | undefined => {
    const i = remaining.findIndex(match);
    if (i < 0) return undefined;
    const [hit] = remaining.splice(i, 1);
    return hit.members ? [...hit.members] : undefined;
  };
  return next.map((item) => {
    const members =
      take((it) => norm(it.date) === norm(item.date) && norm(it.type) === norm(item.type) && norm(it.title) === norm(item.title)) ||
      (String(item.type) === "move"
        ? take((it) => String(it.type) === "move" && norm(it.date) === norm(item.date) &&
            norm(it.origin) === norm(item.origin) && norm(it.destination) === norm(item.destination))
        : undefined);
    return members ? { ...item, members } : item;
  });
}

function updateAiChatContext(): void {
  const context = root.querySelector<HTMLElement>("[data-ai-chat-context]");
  const day = state.days[state.active];
  if (!context || !day) return;
  context.textContent = `${day.day || "選択中の日"}・${mdLabel(day.date)}を中心に、旅行全体を相談できます`;
}

function renderAiChat(): void {
  const log = root.querySelector<HTMLElement>("[data-ai-chat-log]");
  if (!log) return;
  const greeting = aiChatEntries.length ? "" : `
    <div class="tl-ai-message is-assistant">
      <span>選択中の日だけでなく、別の日や旅行全体についても変更を頼めます。提案を確認してから行程へ反映します。</span>
    </div>`;
  log.innerHTML = greeting + aiChatEntries.map((entry, index) => `
    <div class="tl-ai-message is-${entry.role}">
      <span>${escapeHtml(entry.text).replace(/\n/g, "<br>")}</span>
      ${entry.proposal ? `<button type="button" data-ai-apply="${index}" ${entry.applied ? "disabled" : ""}>${entry.applied ? "反映済み" : "この提案を行程に反映"}</button>` : ""}
    </div>`).join("") + (aiChatBusy ? `
    <div class="tl-ai-message is-assistant is-thinking"><span>全日程を確認して修正案を作っています…</span></div>` : "");
  log.scrollTop = log.scrollHeight;
  log.querySelectorAll<HTMLButtonElement>("[data-ai-apply]").forEach((button) => {
    button.addEventListener("click", () => void applyAiProposal(Number(button.dataset.aiApply)));
  });
}

async function applyAiProposal(index: number): Promise<void> {
  const entry = aiChatEntries[index];
  if (!entry?.proposal || entry.applied || aiChatBusy) return;
  const status = root.querySelector<HTMLElement>("[data-ai-chat-status]");
  const checkpoint = db.mutationCheckpoint();
  state.data.itinerary = carryOverItemMembers(itineraryFromAi(entry.proposal.itinerary));
  const saved = TripPlans.saveData(CONFIG.tripSlug, state.data as TripPlans.LocalPlanData);
  if (!saved) {
    if (status) status.textContent = "行程を保存できませんでした。";
    return;
  }
  aiChatBusy = true;
  if (status) status.textContent = "保存しています…";
  renderAiChat();
  try {
    await db.flushMutations(checkpoint);
    entry.applied = true;
    if (status) status.textContent = "行程に反映して保存しました。";
    renderData(state.data, CONFIG.mode);
  } catch (error) {
    if (status) status.textContent = errorMessage(error) || "保存できませんでした。もう一度お試しください。";
    await syncData(false);
  } finally {
    aiChatBusy = false;
    renderAiChat();
  }
}

function setupAiChat(aiSupport: HTMLButtonElement): void {
  const chat = root.querySelector<HTMLElement>("[data-ai-chat]");
  const close = root.querySelector<HTMLButtonElement>("[data-ai-chat-close]");
  const form = root.querySelector<HTMLFormElement>("[data-ai-chat-form]");
  const input = root.querySelector<HTMLTextAreaElement>("[data-ai-chat-input]");
  const send = root.querySelector<HTMLButtonElement>("[data-ai-chat-send]");
  const status = root.querySelector<HTMLElement>("[data-ai-chat-status]");
  if (!chat || !close || !form || !input || !send || !status) return;
  const setOpen = (open: boolean): void => {
    chat.hidden = !open;
    aiSupport.setAttribute("aria-expanded", String(open));
    if (open) {
      updateAiChatContext();
      renderAiChat();
      chat.scrollIntoView({ behavior: "smooth", block: "nearest" });
      input.focus({ preventScroll: true });
    }
  };
  aiSupport.setAttribute("aria-controls", "tl-ai-chat-input");
  aiSupport.setAttribute("aria-expanded", "false");
  aiSupport.addEventListener("click", () => setOpen(chat.hidden));
  close.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const instruction = input.value.trim();
    if (!instruction || aiChatBusy) return;
    const dates = tripDateRange(state.data);
    const activeDate = state.days[state.active]?.date || dates[0] || "";
    if (!dates.length || !activeDate || !planId()) {
      status.textContent = "旅行期間または旅行計画を確認できませんでした。";
      return;
    }
    const history = aiChatEntries.map((entry) => ({ role: entry.role, content: entry.text })).slice(-6);
    aiChatEntries.push({ role: "user", text: instruction });
    input.value = "";
    aiChatBusy = true;
    send.disabled = true;
    input.disabled = true;
    status.textContent = "AIが考えています…";
    renderAiChat();
    try {
      const proposal = await db.refineItinerary({
        plan_id: planId(),
        start_date: dates[0],
        end_date: dates[dates.length - 1],
        active_date: activeDate,
        instruction,
        history,
        current_itinerary: latestAiItinerary(),
      });
      aiChatEntries.push({ role: "assistant", text: proposal.message, proposal });
      status.textContent = "提案を確認して、反映するか選んでください。";
    } catch (error) {
      aiChatEntries.push({ role: "assistant", text: errorMessage(error) || "修正案を作れませんでした。もう一度お試しください。" });
      status.textContent = "";
    } finally {
      aiChatBusy = false;
      send.disabled = false;
      input.disabled = false;
      renderAiChat();
      input.focus();
    }
  });
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
    .querySelectorAll<HTMLElement>(".tl-actions, .tl-days, .tl-main, .tl-mobile-nav")
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
  // 関係テーブル（MySQL）を読み込む。費用・精算はこちらが正。
  // 権限と本人の判定に古いキャッシュを使うと、LINEログイン後に未ログイン扱いの
  // 画面が一瞬復元される。ダッシュボードは必ず最新の viewer / membership で開く。
  await db.load({ fresh: db.isEnabled(), strict: db.isEnabled() });
  adoptLegacyIdentity();
  // CONFIG はモジュール読み込み時に決まるが、そのとき計画の情報はまだ無い。
  // 読み終えた時点で、開いている計画の実体に合わせて上書きする。
  applyPlanConfig();
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
    qsa<HTMLElement>("[data-members-nav], [data-mobile-nav='money']").forEach((nav) => {
      nav.hidden = !canUseWorkspaceView();
    });
    syncMobileNavLayout();
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
        void leaveTrip();
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
  // 下部ナビにアイコンを差し込む（セクション見出しと同じ heroicon を使う）。
  const MOBILE_NAV_ICONS: Record<string, IconName> = {
    home: "home", map: "map", members: "users", money: "banknotes", links: "link",
  };
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    const name = MOBILE_NAV_ICONS[button.dataset.mobileNav || ""];
    const slot = button.querySelector(".tl-nav-ic");
    if (name && slot) slot.innerHTML = icon(name);
    button.addEventListener("click", () => {
      applyMobileView(button.dataset.mobileNav);
    });
  });
  // 費用入力はボトムシートに分離（読む画面と書く画面を分ける）。
  // 読み取り専用ビュー（他人の公開計画）では費用追加を出さない。
  // リスナーは hidden でも必ず付ける: 表示されているのに何も起きないボタンは
  // 「壊れている」としか見えないため、押されたら理由を出せるようにしておく。
  qsa<HTMLElement>("[data-expense-open]").forEach((button) => {
    button.hidden = READ_ONLY || !canUseWorkspaceView();
    button.addEventListener("click", () => {
      if (READ_ONLY || !canUseWorkspaceView()) {
        const status = root.querySelector<HTMLElement>("[data-settlement-status]");
        if (status) {
          status.textContent = "費用を追加できるのは計画の参加者だけです。";
          status.classList.add("is-error");
        }
        return;
      }
      setExpenseSheet(true);
    });
  });
  // 精算 / 費用詳細のタブ切り替え（スマホ）。
  qsa<HTMLElement>("[data-money-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const next = tab.dataset.moneyTab === "details" ? "details" : "settle";
      applyMoneyTab(next);
    });
  });
  applyMoneyTab("settle");
  qsa<HTMLElement>("[data-expense-close]").forEach((button) => {
    button.addEventListener("click", () => setExpenseSheet(false));
  });
  setupPhotoAlbumEditor();
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const sheet = root.querySelector<HTMLElement>("[data-expense-sheet]");
    if (sheet && !sheet.hidden) setExpenseSheet(false);
  });
  // マイページはヘッダーの [data-mypage] を共通ドロワー（mypage-drawer）が拾って
  // 右からスライドインで開く。ここでの遷移は不要。
  // ローカル計画は計画エディタで編集する。サンプルは閲覧のみ。
  const editWrap = root.querySelector<HTMLElement>("[data-edit-wrap]");
  const editLink = root.querySelector<HTMLAnchorElement>("[data-edit-link]");
  const editHead = root.querySelector<HTMLAnchorElement>("[data-edit-head]");
  const planQuery = "?plan=" + encodeURIComponent(CONFIG.tripSlug);
  // 読み取り専用ビューでは編集導線（ヘッダー鉛筆 / フッター編集）を出さない。
  const editTarget =
    READ_ONLY ? null
    : CONFIG.mode === "local" ? { href: "plan-editor.html" + planQuery, label: "計画を編集" }
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
  // 「この日の予定」ヘッダーのAIサポート。正式な編集メンバーの計画だけに出す。
  // 閲覧専用や公開共同編集では表示もAPI利用も許可しない。
  const aiSupport = root.querySelector<HTMLButtonElement>("[data-ai-support]");
  if (aiSupport && editTarget && isEditableLocalPlan()) {
    aiSupport.hidden = false;
    aiSupport.setAttribute("title", "AI旅行相談を開く");
    aiSupport.setAttribute("aria-label", "AI旅行相談を開く");
    setupAiChat(aiSupport);
  }
  // 編集できない（＝人の計画を見ている）ときは、コピーして持ち帰れるようにする
  const copyHead = root.querySelector<HTMLButtonElement>("[data-copy-head]");
  if (copyHead) {
    copyHead.hidden = Boolean(editTarget) || CONFIG.mode !== "local";
    copyHead.addEventListener("click", () => void copyPlanToMine(copyHead));
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

// 初期化のどこかで落ちても「最新データを取得しています」のまま固まらせない。
void init().catch((error) => {
  console.error("[dashboard] init failed", error);
  showError(error);
});
