import { icon } from "../shared/icons";
import { escapeHtml, safeHref } from "../shared/dom";
import { buildGoogleMyMapsKml, googleMyMapsKmlFilename, mapsSearchUrl } from "../shared/maps";
import type { TripData, TripLink } from "../shared/types";
import { CONFIG, getMobileView, linkByKey, SAMPLE, setMobileView, state } from "./state";
import { downloadTextFile, qs, qsa, root, setHtml, setText } from "./dom";
import { canUseWorkspaceView } from "./plan-access";
import { chooseActive, groupDays, todayISO } from "./days";
import { updateHeaderHero } from "./header-hero";
import { mapsDir, projectPlaces, renderMapEmbed, syncGoogleMapsLink } from "./map";
import { applyMobileView, syncMobileNavLayout } from "./view-mode";
import { saveExpenseEntryCache } from "./profile";
import { renderExpenseEntry } from "./expense-entry";
import { applyMoneyTab, localSettlement, renderExpenseDetails, renderTransfers } from "./settlement";
import { renderPhotoAlbum } from "./photo-album";
import { renderChecklist } from "./checklist";
import { renderMembers } from "./members";
import { renderLocalInfo } from "./local-info";
import { computeRoute, renderDayTabs } from "./route";
import { openFlightNoteEditor, openFlightQr } from "./flight-notes";
import { dayBlockHtml, dayTrackChoice, hydrateWeather, nowNextHtml, selectedTrack, trackItems } from "./itinerary-feed";
import { updateAiChatContext } from "./ai-chat";

// ---- 描画フロー ---------------------------------------------------------

export function renderData(data: TripData | null | undefined, source?: string): void {
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

export function renderBase(): void {
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

export function renderActive(): void {
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
