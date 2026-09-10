import "../shared/ui.css";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";

import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { isMemberOf } from "../shared/membership";
import { joinersOn, leaversOn } from "../shared/member-period";
import { dayTracks, pickTrack, isItemInTrack, everyoneIds, type DayTrack } from "../shared/day-tracks";
import { parseFlight, parseTrain, type FlightInfo, type TrainInfo } from "../shared/flight-info";
import { currentUserId, adoptLegacyIdentity } from "../shared/identity";
import * as db from "../shared/db";
import { incrementView } from "../shared/views-store";
import { escapeHtml, errorMessage, safeHref } from "../shared/dom";
import { loadData, normalizeDate } from "./api-data-source";
import type { DayGroup } from "./types";
import { registerServiceWorker } from "../shared/pwa";
import { fetchDayWeather, weatherLabel } from "../shared/weather";
import { buildItineraryShareText } from "../shared/itinerary-text";
import * as Backend from "../shared/backend";
import { mdLabel } from "../shared/date";
import { buildGoogleMyMapsKml, googleMyMapsKmlFilename, mapsSearchUrl } from "../shared/maps";
import { formatDurationMinutes, parseDurationMinutes } from "../shared/travel-duration";
import { buildExternalAiRefinePrompt, copyExternalAiPrompt, openExternalAi, parseExternalAiRefineJson } from "../shared/external-ai";
import type { TripData, TripLink, ItineraryItem } from "../shared/types";
import { applyPlanConfig, CONFIG, getMobileView, hooks, isAccessDenied, isReadOnly, linkByKey, SAMPLE, setAccessDenied, setMobileView, setReadOnly, setRenderHooks, state } from "./state";
import { downloadTextFile, flashLabel, qs, qsa, root, setHtml, setLoading, setText } from "./dom";
import { canUseWorkspaceView, computeAccessDenied, computeReadOnly, isEditableLocalPlan, planId } from "./plan-access";
import { chooseActive, dayCoord, groupDays, nowHM, nowMinutes, timeToMinutes, todayISO, tripDateRange, untilLabel } from "./days";
import { renderAccessDenied, showError } from "./errors";
import { updateHeaderHero } from "./header-hero";
import { mapsDir, projectPlaces, refreshMapLayout, renderMapEmbed, syncGoogleMapsLink } from "./map";
import { applyMobileView, syncMobileNavLayout, syncStickyOffsets } from "./view-mode";
import { requestIdentityIfNeeded, requestPassword, saveExpenseEntryCache } from "./profile";
import { renderExpenseEntry, setExpenseSheet } from "./expense-entry";
import { applyMoneyTab, localSettlement, renderExpenseDetails, renderTransfers } from "./settlement";
import { renderPhotoAlbum, setupPhotoAlbumEditor } from "./photo-album";
import { bindChecklist, renderChecklist } from "./checklist";
import { leaveTrip, renderMembers, shareTripInvite } from "./members";
import { renderLocalInfo } from "./local-info";
import { computeRoute, renderDayTabs } from "./route";

initPageTransitions();

setRenderHooks({ renderBase, renderActive, renderData, syncData });

// セクション見出し・ボタンの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
qsa<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.innerHTML = icon(name as IconName);
});

let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

interface AiChatEntry {
  role: "user" | "assistant";
  text: string;
  proposal?: db.ItineraryRefineResult;
  externalPrompt?: string;
  applied?: boolean;
}

const aiChatEntries: AiChatEntry[] = [];
let aiChatBusy = false;

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
  applyMobileView(getMobileView());
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

// ---- 基本描画 -----------------------------------------------------------

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
    `<button class="tl-action" type="button" data-section-nav="${tab.key}" aria-selected="${tab.key === getMobileView()}">
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
  if (!workspaceView && (getMobileView() === "members" || getMobileView() === "money")) {
    setMobileView("home");
  }

  if (workspaceView) renderMembers(data);

  syncGoogleMapsLink(projectPlaces(data.itinerary || []));
  const kmlButton = root.querySelector<HTMLButtonElement>("[data-google-maps-kml]");
  if (kmlButton && !kmlButton.dataset.bound) {
    kmlButton.dataset.bound = "true";
    kmlButton.addEventListener("click", () => {
      downloadTextFile(
        googleMyMapsKmlFilename(state.data.trip?.title),
        buildGoogleMyMapsKml(state.data),
        "application/vnd.google-earth.kml+xml;charset=utf-8",
      );
    });
  }

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
  applyMobileView(getMobileView());
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

// ---- 参加者で行程が分かれる日のタブ切替 ----------------------------------

/** 日付 → 選択中の班キー。タブ切替の記憶（フィード再描画をまたいで保持する）。 */
const dayTrackChoice = new Map<string, string>();

/** その日に旅行へ在籍しているメンバーID（途中合流/離脱を反映）。 */
function presentIdsOf(day: DayGroup): string[] {
  const id = planId();
  return id ? TripPlans.memberIdsPresentOn(id, day.date) : [];
}

/** その日の班。一部メンバーだけの予定が無い日（＝分かれない日）は空配列。 */
function tracksOf(day: DayGroup): DayTrack[] {
  return dayTracks(day.items.map((item) => item.members), presentIdsOf(day));
}

function selectedTrack(day: DayGroup): DayTrack | null {
  return pickTrack(tracksOf(day), dayTrackChoice.get(day.date), currentUserId() || "");
}

/** 班タブがある日は、全員の予定（members 空か全員入り）＋選択中の班の予定だけに絞る。 */
function trackItems(day: DayGroup, track: DayTrack | null): ItineraryItem[] {
  if (!track) return day.items;
  const everyone = everyoneIds(day.items.map((item) => item.members), presentIdsOf(day));
  return day.items.filter((item) => isItemInTrack(item.members, track, everyone));
}

/**
 * 班タブに実名を出してよいか。名前が見えるのは計画の参加者（plan_members）だけ。
 * 観覧のみの人（公開計画のゲストなど）には個人名を出さない。
 */
function canSeeTrackMemberNames(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(meta && isMemberOf(meta));
}

/** 班タブの表示名。参加者には名前（本人は「あなた」）、観覧のみの人には匿名のグループ名。 */
function trackLabel(track: DayTrack, index: number, withNames: boolean): string {
  if (!withNames) return `${String.fromCharCode(65 + (index % 26))}グループ`;
  const you = currentUserId() || "";
  const names: string[] = [];
  if (you && track.memberIds.includes(you)) names.push("あなた");
  for (const id of track.memberIds) {
    if (id === you) continue;
    const name = db.nameOf(id);
    if (name) names.push(name);
  }
  if (!names.length) return "そのほか";
  return names.slice(0, 3).join("・") + (names.length > 3 ? ` 他${names.length - 3}人` : "");
}

function dayTrackTabsHtml(day: DayGroup): string {
  const tracks = tracksOf(day);
  if (!tracks.length) return "";
  const selected = selectedTrack(day);
  const withNames = canSeeTrackMemberNames();
  return `<div class="tl-day-tabs" role="tablist" aria-label="班ごとの行程">` +
    tracks.map((track, index) =>
      `<button class="tl-day-tab" type="button" role="tab" aria-selected="${track.key === selected?.key}"` +
      ` data-track-day="${escapeHtml(day.date)}" data-track-key="${escapeHtml(track.key)}">` +
      `${icon("users")}<span class="tl-day-tab-label">${escapeHtml(trackLabel(track, index, withNames))}</span></button>`
    ).join("") +
    `</div>`;
}

/** 自分のこの便のメモ（リンク・予約番号・座席・QR）。無ければ null。 */
function myFlightNote(flightNo: string): db.FlightNoteRow | null {
  const me = currentUserId();
  const id = planId();
  if (!me || !id) return null;
  return db.flightNotes().find(
    (note) => note.plan_id === id && note.user_id === me && note.flight_no === flightNo,
  ) || null;
}

/** 便メモを編集できるか（＝ログイン済みの参加者本人）。 */
function canEditFlightNote(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(currentUserId() && meta && isMemberOf(meta));
}

/**
 * 飛行機の移動を、航空券（搭乗券）風のカードで見せる。
 * 発着（空港コード＋時刻）がパースできた便は 出発↔到着 を大きく、
 * できない便は出発地・到着地の名前で同じレイアウトに落とす。
 * 自分の便メモがあれば下段（半券の下）に座席・予約番号・QRを出し、
 * リンク設定時はカード全体を押すとそのページが開く。
 */
function flightTicketHtml(
  flight: FlightInfo,
  duration: string | undefined,
  originName: string,
  destinationName: string,
): string {
  const hasTimes = Boolean(flight.dep && flight.arr);
  const end = (code: string, time: string, arr: boolean): string =>
    `<span class="tl-ticket-end${arr ? " is-arr" : ""}">` +
    `<b class="tl-ticket-code${hasTimes ? "" : " is-name"}">${escapeHtml(code)}</b>` +
    (time ? `<span class="tl-ticket-time">${escapeHtml(time)}</span>` : "") +
    `</span>`;
  const depEnd = hasTimes && flight.dep
    ? end(flight.dep.code, flight.dep.time, false)
    : originName ? end(originName, "", false) : "";
  const arrEnd = hasTimes && flight.arr
    ? end(flight.arr.code, flight.arr.time, true)
    : destinationName ? end(destinationName, "", true) : "";

  // 自分だけの搭乗情報（座席・予約番号・QR）。他人には自分のものしか見えない。
  const note = myFlightNote(flight.flightNo);
  const editable = canEditFlightNote();
  const chips: string[] = [];
  if (note?.seat) chips.push(`<span class="tl-ticket-chip">座席 ${escapeHtml(note.seat)}</span>`);
  if (note?.booking_ref) chips.push(`<span class="tl-ticket-chip">予約 ${escapeHtml(note.booking_ref)}</span>`);
  if (note?.qr_image) {
    chips.push(
      `<button type="button" class="tl-ticket-chip is-action" data-flight-qr="${escapeHtml(flight.flightNo)}">` +
      `${icon("photo")}QR</button>`,
    );
  }
  if (editable) {
    chips.push(note
      ? `<button type="button" class="tl-ticket-edit" data-flight-edit="${escapeHtml(flight.flightNo)}"` +
        ` aria-label="自分の便情報を編集" title="自分の便情報を編集">${icon("pencilSquare")}</button>`
      : `<button type="button" class="tl-ticket-chip is-action" data-flight-edit="${escapeHtml(flight.flightNo)}">` +
        `${icon("plus")}予約番号・座席・QR</button>`);
  }
  const footer = chips.length ? `<div class="tl-ticket-foot">${chips.join("")}</div>` : "";
  const linkUrl = note?.link_url && /^https?:\/\//i.test(note.link_url) ? note.link_url : "";
  const linkAttrs = linkUrl
    ? ` data-flight-open="${escapeHtml(linkUrl)}" role="link" tabindex="0" title="タップで予約ページを開く"`
    : "";
  return `<div class="tl-ticket${linkUrl ? " is-link" : ""}"${linkAttrs}>` +
    `<div class="tl-ticket-head">` +
    `<span class="tl-ticket-airline">${escapeHtml(flight.airline || "Flight")}</span>` +
    `<span class="tl-ticket-no">${icon("paperAirplane")}${escapeHtml(flight.flightNo)}${linkUrl ? icon("arrowTopRightOnSquare") : ""}</span>` +
    `</div>` +
    `<div class="tl-ticket-divider" aria-hidden="true"></div>` +
    `<div class="tl-ticket-route">` +
    depEnd +
    `<span class="tl-ticket-path">` +
    `<span class="tl-ticket-path-line">${icon("paperAirplane")}</span>` +
    (duration ? `<span class="tl-ticket-dur">${escapeHtml(duration)}</span>` : "") +
    `</span>` +
    arrEnd +
    `</div>` +
    footer +
    `</div>`;
}

/**
 * 特急・新幹線・台湾鉄路などの移動を、必要最低限の乗車券カードで見せる。
 * 座席は「指定席」「自由席」など入力がある場合だけ表示し、個人別の詳細入力は必須にしない。
 */
function trainTicketHtml(
  train: TrainInfo,
  duration: string | undefined,
  originName: string,
  destinationName: string,
  fallbackTime: string | undefined,
): string {
  const depStation = train.dep?.station || originName || "出発駅";
  const arrStation = train.arr?.station || destinationName || "到着駅";
  const depTime = train.dep?.time || fallbackTime || "";
  const arrTime = train.arr?.time || "";
  const end = (station: string, time: string, arr = false): string =>
    `<span class="tl-train-end${arr ? " is-arr" : ""}">` +
    (time ? `<b class="tl-train-time">${escapeHtml(time)}</b>` : "") +
    `<span class="tl-train-station">${escapeHtml(station)}</span>` +
    `</span>`;

  return `<div class="tl-train-card">` +
    `<div class="tl-train-head">` +
    `<span class="tl-train-service">${icon("ticket")}${escapeHtml(train.serviceName || "Train")}</span>` +
    (train.seat ? `<span class="tl-train-seat">${escapeHtml(train.seat)}</span>` : "") +
    `</div>` +
    `<div class="tl-train-route">` +
    end(depStation, depTime) +
    `<span class="tl-train-mid">${icon("arrowLongRight")}${duration ? `<small>${escapeHtml(duration)}</small>` : ""}</span>` +
    end(arrStation, arrTime, true) +
    `</div>` +
    `</div>`;
}

/** 自分のQRコードを大きく表示する（搭乗ゲートでそのまま見せられるサイズ）。 */
function openFlightQr(flightNo: string): void {
  const note = myFlightNote(flightNo);
  if (!note?.qr_image || !/^data:image\//.test(note.qr_image)) return;
  const modal = document.createElement("div");
  modal.className = "tl-confirm-modal tl-qr-modal";
  modal.innerHTML = `
    <div class="tl-confirm-scrim" data-qr-close></div>
    <section class="tl-confirm-card tl-qr-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(flightNo)} のQRコード">
      <p class="tl-qr-title">${icon("paperAirplane")}${escapeHtml(flightNo)}${note.seat ? ` ・ 座席 ${escapeHtml(note.seat)}` : ""}</p>
      <img class="tl-qr-image" src="${escapeHtml(note.qr_image)}" alt="搭乗用QRコード">
      <button type="button" class="tl-confirm-cancel" data-qr-close>閉じる</button>
    </section>`;
  // body 直下だと .trip-live のフォント・色トークンが当たらないため root 配下に置く
  root.appendChild(modal);
  modal.querySelectorAll<HTMLElement>("[data-qr-close]").forEach((el) => {
    el.addEventListener("click", () => modal.remove());
  });
}

const MAX_QR_DATA_URL_LENGTH = 300_000;

/**
 * QR画像を縮小して data URL にする。QRは輪郭が命なので PNG（可逆）を優先し、
 * 収まらないときだけ高品質 WebP に落とす。
 */
function fileToQrDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || "")) {
      reject(new Error("画像ファイルを選択してください"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = (): void => reject(new Error("画像を読み込めませんでした"));
    reader.onload = (): void => {
      const img = new Image();
      img.onerror = (): void => reject(new Error("画像を処理できませんでした"));
      img.onload = (): void => {
        const nw = img.naturalWidth || img.width;
        const nh = img.naturalHeight || img.height;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas を初期化できませんでした"));
          return;
        }
        const attempts: { maxSize: number; type: string; quality?: number }[] = [
          { maxSize: 640, type: "image/png" },
          { maxSize: 480, type: "image/png" },
          { maxSize: 360, type: "image/png" },
          { maxSize: 640, type: "image/webp", quality: 0.92 },
        ];
        for (const attempt of attempts) {
          const scale = Math.min(1, attempt.maxSize / Math.max(nw, nh));
          canvas.width = Math.max(1, Math.round(nw * scale));
          canvas.height = Math.max(1, Math.round(nh * scale));
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL(attempt.type, attempt.quality);
          if (dataUrl.length <= MAX_QR_DATA_URL_LENGTH) {
            resolve(dataUrl);
            return;
          }
        }
        reject(new Error("画像を十分に小さくできませんでした。QR部分を切り抜いた画像を選んでください"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/** 自分の便メモ（リンク・予約番号・座席・QR）を編集するモーダル。 */
function openFlightNoteEditor(flightNo: string): void {
  const me = currentUserId();
  const id = planId();
  if (!me || !id || !canEditFlightNote()) return;
  const note = myFlightNote(flightNo);
  let qrImage = note?.qr_image || "";
  const modal = document.createElement("div");
  modal.className = "tl-confirm-modal tl-fnote-modal";
  modal.innerHTML = `
    <div class="tl-confirm-scrim" data-fnote-cancel></div>
    <section class="tl-confirm-card tl-fnote-card" role="dialog" aria-modal="true" aria-labelledby="fnoteTitle">
      <div class="tl-fnote-head">
        <span class="tl-fnote-plane">${icon("paperAirplane")}</span>
        <span class="tl-fnote-headtext">
          <b id="fnoteTitle">${escapeHtml(flightNo)}</b>
          <span>自分用メモ ・ 自分にだけ表示されます</span>
        </span>
      </div>
      <div class="tl-fnote-divider" aria-hidden="true"></div>
      <div class="tl-fnote-body">
        <label class="tl-fnote-field">
          <span>リンク（カードを押すと開く）</span>
          <input type="url" data-fnote-link placeholder="https://…（予約確認ページなど）" value="${escapeHtml(note?.link_url || "")}">
        </label>
        <div class="tl-fnote-grid">
          <label class="tl-fnote-field">
            <span>予約番号</span>
            <input type="text" data-fnote-ref maxlength="100" placeholder="ABC123" value="${escapeHtml(note?.booking_ref || "")}">
          </label>
          <label class="tl-fnote-field">
            <span>座席</span>
            <input type="text" data-fnote-seat maxlength="50" placeholder="32A" value="${escapeHtml(note?.seat || "")}">
          </label>
        </div>
        <div class="tl-fnote-field">
          <span>QRコード画像</span>
          <div class="tl-fnote-qr">
            <img data-fnote-qr-preview alt="QRコードのプレビュー"${qrImage ? ` src="${escapeHtml(qrImage)}"` : " hidden"}>
            <label class="tl-fnote-qr-pick">${icon("photo")}画像を選ぶ<input type="file" accept="image/*" data-fnote-qr hidden></label>
            <button type="button" class="tl-fnote-qr-clear" data-fnote-qr-clear${qrImage ? "" : " hidden"}>削除</button>
          </div>
        </div>
        <p class="tl-fnote-status" data-fnote-status aria-live="polite"></p>
        <div class="tl-fnote-actions">
          <button type="button" class="tl-fnote-cancel" data-fnote-cancel>キャンセル</button>
          <button type="button" class="tl-fnote-save" data-fnote-save>${icon("check")}保存</button>
        </div>
      </div>
    </section>`;
  // body 直下だと .trip-live のフォント・色トークンが当たらないため root 配下に置く
  root.appendChild(modal);
  const field = <T extends HTMLElement>(selector: string): T => modal.querySelector<T>(selector) as T;
  const status = field<HTMLElement>("[data-fnote-status]");
  const preview = field<HTMLImageElement>("[data-fnote-qr-preview]");
  const clearButton = field<HTMLButtonElement>("[data-fnote-qr-clear]");
  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("is-error", isError);
  };
  const syncQr = (): void => {
    preview.hidden = !qrImage;
    if (qrImage) preview.src = qrImage;
    else preview.removeAttribute("src");
    clearButton.hidden = !qrImage;
  };
  field<HTMLInputElement>("[data-fnote-qr]").addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    fileToQrDataUrl(file)
      .then((dataUrl) => { qrImage = dataUrl; syncQr(); setStatus(""); })
      .catch((error) => setStatus((error as Error).message, true));
  });
  clearButton.addEventListener("click", () => { qrImage = ""; syncQr(); });
  modal.querySelectorAll<HTMLElement>("[data-fnote-cancel]").forEach((el) => {
    el.addEventListener("click", () => modal.remove());
  });
  field<HTMLButtonElement>("[data-fnote-save]").addEventListener("click", () => {
    const linkUrl = field<HTMLInputElement>("[data-fnote-link]").value.trim();
    if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
      setStatus("リンクは http(s):// で始まるURLにしてください", true);
      return;
    }
    db.setFlightNote(id, me, flightNo, {
      link_url: linkUrl,
      booking_ref: field<HTMLInputElement>("[data-fnote-ref]").value.trim(),
      seat: field<HTMLInputElement>("[data-fnote-seat]").value.trim(),
      qr_image: qrImage,
    });
    modal.remove();
    hooks.renderActive();
  });
}

function timelineHtmlForDay(idx: number): string {
  const day = state.days[idx];
  if (!day) return "";
  // 予定ごとに対象メンバー名は書かない。行程が班に分かれる日は
  // dayTrackTabsHtml の帯タブで切り替え、名前はタブにだけ出す。
  const track = selectedTrack(day);
  return trackItems(day, track).filter((i) => String(i.type) !== "stay").map((item) => {
    const type = String(item.type || "todo");
    let segA = item.origin || "";
    let segB = item.destination || "";
    if (type === "move" && (!segA || !segB) && /→|->/.test(item.title || "")) {
      const parts = (item.title || "").split(/→|->/);
      segA = segA || (parts[0] || "").trim();
      segB = segB || (parts[1] || "").trim();
    }
    // 飛行機・鉄道の移動は専用カードで見せ、メタ行では重複しない。
    const flight = type === "move" ? parseFlight(item) : null;
    const train = type === "move" && !flight ? parseTrain({ ...item, origin: segA, destination: segB }) : null;
    const placeText = item.place && item.place !== item.title ? `場所: ${item.place}` : "";
    const moveText = type === "move" && !flight && !train ? [item.transport, item.duration].filter(Boolean).join("・") : "";
    const noteText = flight ? flight.restNote : train ? train.restNote : item.note;
    const metaText = [moveText || placeText, noteText].filter(Boolean).join(" / ");
    const label = `<span class="tl-kind ${escapeHtml(type)}">${escapeHtml(item.typeLabel || item.type || "予定")}</span>`;
    const title = type === "move" && (segA || segB)
      ? `<div class="tl-seg"><span>${escapeHtml(segA || "出発")}</span><span class="tl-seg-arr">${icon("arrowLongRight")}</span><span>${escapeHtml(segB || "到着")}</span></div>`
      : `<h3>${escapeHtml(item.title || "")}</h3>`;

    return `<article class="tl-item" data-kind="${escapeHtml(type)}">
      <time class="tl-time">${escapeHtml(item.time || "")}</time>
      <span class="tl-rail"><span class="tl-dot ${escapeHtml(type)}">${kindIcon(type)}</span></span>
      <div class="tl-plan">
        <div class="tl-plan-line">${label}${title}</div>
        ${flight ? flightTicketHtml(flight, item.duration, segA, segB) : train ? trainTicketHtml(train, item.duration, segA, segB, item.time) : ""}
        ${item.needed ? `<p class="tl-needed">${escapeHtml(item.needed)}</p>` : ""}
        <p class="tl-meta">${metaText ? `<span class="tl-meta-text">${escapeHtml(metaText)}</span>` : ""}<a class="tl-maplink" href="${mapsSearchUrl(item.mapQuery || item.place || item.title)}" target="_blank" rel="noopener">地図 ${icon("arrowTopRightOnSquare")}</a></p>
      </div>
    </article>`;
  }).join("");
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
    ${dayTrackTabsHtml(day)}
    ${stayHtmlForDay(idx)}
    ${items || `<p class="tl-dayblock-empty">予定はまだありません</p>`}
  </section>`;
}

/** 今日が選択中の日のとき、現在時刻と「いま/次の予定」を示すカード。 */
function nowNextHtml(day: DayGroup): string {
  if (day.date !== todayISO()) return "";
  const cur = nowMinutes();
  const timed = trackItems(day, selectedTrack(day))
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

  // 地図も選択中の班の行程に合わせる（班タブが無い日は全予定のまま）。
  const activePlaces = projectPlaces(trackItems(day, selectedTrack(day)));
  const placeNames = activePlaces.map((place) => place.place || place.title).filter(Boolean);
  setText("[data-location-caption]", `現在地: ${day.area || placeNames[0] || "-"} / 次: ${placeNames[1] || placeNames[0] || "-"}`);
  syncGoogleMapsLink(activePlaces);
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
  qsa<HTMLElement>("[data-track-key]").forEach((b) => b.addEventListener("click", () => {
    dayTrackChoice.set(b.dataset.trackDay || "", b.dataset.trackKey || "");
    renderActive();
  }));
  // 航空券カード：編集・QR表示・リンクを開く（ボタン上のタップはカードのリンクに流さない）
  qsa<HTMLElement>("[data-flight-edit]").forEach((b) => b.addEventListener("click", (event) => {
    event.stopPropagation();
    openFlightNoteEditor(b.dataset.flightEdit || "");
  }));
  qsa<HTMLElement>("[data-flight-qr]").forEach((b) => b.addEventListener("click", (event) => {
    event.stopPropagation();
    openFlightQr(b.dataset.flightQr || "");
  }));
  qsa<HTMLElement>("[data-flight-open]").forEach((card) => {
    const open = (): void => {
      const url = card.dataset.flightOpen || "";
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener");
    };
    card.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-flight-edit],[data-flight-qr]")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  });
}

// ---- 同期・初期化 -------------------------------------------------------

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
      members: Array.isArray(item.members) && item.members.length ? [...item.members] : [],
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
      members: Array.isArray(item.members) && item.members.length ? [...item.members] : undefined,
    };
  });
}

function citiesForAiRefinement(): db.ItineraryRefineCity[] {
  return (state.data.cities || [])
    .map((city) => ({
      name: String(city.name || "").trim(),
      from_date: normalizeDate(city.fromDate),
      to_date: normalizeDate(city.toDate),
    }))
    .filter((city) => city.name);
}

function membersForAiRefinement(): db.ItineraryRefineMember[] {
  const id = planId();
  return db.members()
    .filter((member) => member.plan_id === id && member.status === "active")
    .map((member) => ({
      user_id: member.user_id,
      name: db.nameOf(member.user_id),
      from_date: member.from_date ? normalizeDate(member.from_date) : null,
      to_date: member.to_date ? normalizeDate(member.to_date) : null,
    }))
    .filter((member) => member.user_id);
}

function externalAiRefinePrompt(instruction: string): string {
  const dates = tripDateRange(state.data);
  return buildExternalAiRefinePrompt({
    title: state.data.trip?.title || CONFIG.tripTitle || "旅行計画",
    startDate: dates[0] || "",
    endDate: dates[dates.length - 1] || "",
    instruction,
    cities: state.data.cities || [],
    members: membersForAiRefinement(),
    currentItinerary: latestAiItinerary(),
  });
}

function importExternalAiRefineJson(raw: string): void {
  const status = root.querySelector<HTMLElement>("[data-ai-chat-import-status]");
  if (!status) return;
  if (!raw.trim()) {
    status.textContent = "ChatGPTから返ってきた答えを貼り付けてください。";
    status.className = "is-warn";
    return;
  }
  try {
    const dates = tripDateRange(state.data);
    const proposal = parseExternalAiRefineJson(raw, dates);
    aiChatEntries.push({ role: "assistant", text: proposal.message, proposal });
    status.textContent = "旅行の修正案を読み込みました。内容を確認して反映してください。";
    status.className = "is-ok";
    renderAiChat();
  } catch (error) {
    status.textContent = errorMessage(error) || "修正案を読み取れませんでした。答えを最初から最後までコピーして、もう一度お試しください。";
    status.className = "is-warn";
  }
}

/**
 * AI提案で行程を丸ごと置き換えるとき、対象メンバー指定（一部の人だけの予定）を
 * AI出力から反映する。AIが既存予定のmembersを省略した場合に備えて、同じ予定
 * （日付+種別+タイトル、移動は日付+区間）から旧行程のmembersを補完する。
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
      ${entry.externalPrompt ? `<button type="button" data-ai-external="${index}">ChatGPTで続きを作る</button>` : ""}
    </div>`).join("") + (aiChatBusy ? `
    <div class="tl-ai-message is-assistant is-thinking"><span>全日程を確認して修正案を作っています…</span></div>` : "");
  log.scrollTop = log.scrollHeight;
  log.querySelectorAll<HTMLButtonElement>("[data-ai-apply]").forEach((button) => {
    button.addEventListener("click", () => void applyAiProposal(Number(button.dataset.aiApply)));
  });
  log.querySelectorAll<HTMLButtonElement>("[data-ai-external]").forEach((button) => {
    button.addEventListener("click", async () => {
      const entry = aiChatEntries[Number(button.dataset.aiExternal)];
      if (!entry?.externalPrompt) return;
      const importPanel = root.querySelector<HTMLDetailsElement>("[data-ai-chat-import]");
      if (importPanel) importPanel.open = true;
      openExternalAi("chatgpt");
      const copied = await copyExternalAiPrompt(entry.externalPrompt);
      const status = root.querySelector<HTMLElement>("[data-ai-chat-status]");
      if (status) status.textContent = copied
        ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
        : "表示された質問文をすべてコピーし、ChatGPTへ貼り付けてください。";
    });
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
    hooks.renderData(state.data, CONFIG.mode);
  } catch (error) {
    if (status) status.textContent = errorMessage(error) || "保存できませんでした。もう一度お試しください。";
    await hooks.syncData(false);
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
  const importDetails = root.querySelector<HTMLDetailsElement>("[data-ai-chat-import]");
  const importOpen = root.querySelector<HTMLButtonElement>("[data-ai-chat-import-open]");
  const importJson = root.querySelector<HTMLTextAreaElement>("[data-ai-chat-import-json]");
  const importApply = root.querySelector<HTMLButtonElement>("[data-ai-chat-import-apply]");
  if (!chat || !close || !form || !input || !send || !status || !importDetails || !importOpen || !importJson || !importApply) return;
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
  importOpen.addEventListener("click", async () => {
    const instruction = input.value.trim();
    const importStatus = root.querySelector<HTMLElement>("[data-ai-chat-import-status]");
    if (!instruction) {
      status.textContent = "まず上の相談欄に、変えたいことを書いてください。";
      input.focus();
      return;
    }
    openExternalAi("chatgpt");
    const copied = await copyExternalAiPrompt(externalAiRefinePrompt(instruction));
    if (importStatus) {
      importStatus.textContent = copied
        ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
        : "表示された質問文をすべてコピーし、ChatGPTへ貼り付けてください。";
      importStatus.className = copied ? "is-ok" : "is-warn";
    }
  });
  importApply.addEventListener("click", () => importExternalAiRefineJson(importJson.value));
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
        cities: citiesForAiRefinement(),
        members: membersForAiRefinement(),
      });
      aiChatEntries.push({ role: "assistant", text: proposal.message, proposal });
      status.textContent = "提案を確認して、反映するか選んでください。";
    } catch (error) {
      if (error instanceof db.ApiRequestError && (error.code === "ai_daily_limit" || error.action === "use_external_ai")) {
        aiChatEntries.push({
          role: "assistant",
          text: errorMessage(error) || "本日のAI利用上限に達しました。ChatGPTを使って続けられます。",
          externalPrompt: externalAiRefinePrompt(instruction),
        });
      } else {
        aiChatEntries.push({ role: "assistant", text: errorMessage(error) || "修正案を作れませんでした。もう一度お試しください。" });
      }
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

setReadOnly(computeReadOnly());
setAccessDenied(computeAccessDenied());

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
  setReadOnly(computeReadOnly());
  setAccessDenied(computeAccessDenied());
  if (isAccessDenied()) {
    renderAccessDenied();
    return;
  }
  // この計画を開いた＝1閲覧としてカウント（ホームの観覧数に反映）。
  if (CONFIG.tripSlug) incrementView(CONFIG.tripSlug);
  if (isReadOnly()) {
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
    button.hidden = isReadOnly() || !canUseWorkspaceView();
    button.addEventListener("click", () => {
      if (isReadOnly() || !canUseWorkspaceView()) {
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
    isReadOnly() ? null
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
  applyMobileView(getMobileView());
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
