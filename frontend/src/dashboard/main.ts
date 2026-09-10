import "../shared/ui.css";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";

import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { adoptLegacyIdentity } from "../shared/identity";
import * as db from "../shared/db";
import { incrementView } from "../shared/views-store";
import { escapeHtml, safeHref } from "../shared/dom";
import { loadData } from "./api-data-source";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import { buildGoogleMyMapsKml, googleMyMapsKmlFilename, mapsSearchUrl } from "../shared/maps";
import type { TripData, TripLink } from "../shared/types";
import { applyPlanConfig, CONFIG, getMobileView, isAccessDenied, isReadOnly, linkByKey, SAMPLE, setAccessDenied, setMobileView, setReadOnly, setRenderHooks, state } from "./state";
import { downloadTextFile, qs, qsa, root, setHtml, setLoading, setText } from "./dom";
import { canUseWorkspaceView, computeAccessDenied, computeReadOnly, isEditableLocalPlan } from "./plan-access";
import { chooseActive, groupDays, todayISO } from "./days";
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
import { openFlightNoteEditor, openFlightQr } from "./flight-notes";
import { dayBlockHtml, dayTrackChoice, hydrateWeather, nowNextHtml, selectedTrack, shareSchedule, trackItems } from "./itinerary-feed";
import { setupAiChat, updateAiChatContext } from "./ai-chat";
import { copyPlanToMine } from "./plan-copy";

initPageTransitions();

setRenderHooks({ renderBase, renderActive, renderData, syncData });

// セクション見出し・ボタンの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
qsa<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.innerHTML = icon(name as IconName);
});

let syncInFlight: Promise<void> | null = null;
let lastSyncAt = 0;

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
