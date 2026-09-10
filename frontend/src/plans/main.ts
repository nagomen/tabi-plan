// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除を行う。

import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";
import type { PlanMeta } from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage } from "../shared/dom";
import { planDashboardHref } from "../shared/plan-url";
import { registerServiceWorker } from "../shared/pwa";
import { rememberInviteReturn } from "../shared/invite-resume";
import { icon, type IconName } from "../shared/icons";
import { mountAppHeader } from "../shared/app-header";
import { decodeInvite } from "../shared/invite";
import { isIdentified, currentUserId } from "../shared/identity";
import { showToast } from "./toast";
import { sortMinePlans, highlightedMineSlugs } from "./plan-timing";
import { rowHtml, matchesFilter, type RowVariant } from "./plan-card";
import { rankingCardLimit } from "./rankings";
import { queueLocationTransition, renderDiscover } from "./location-explorer";
import {
  qs,
  hub,
  gridMine,
  gridPublic,
  discoverSectionEl,
  toolbarEl,
  mineHeadEl,
  publicHead,
  countEl,
  countMineEl,
  countPublicEl,
  filterEl,
  createMainEl,
  inviteStripEl,
  inviteTitleEl,
  inviteNoteEl,
  destinationsEl,
  locationHeadEl,
  locationPlansEl,
} from "./dom";
import { state, planDataCache, getLastRankingLimit } from "./state";

// ---- 補助型 -------------------------------------------------------------

initPageTransitions();

// ---- DOM 取得ヘルパー ----------------------------------------------------

mountAppHeader({
  kicker: "Travel Plans",
  title: "旅行計画",
  meta: [],
  mobileFixed: true,
  actions: [
    { kind: "button", display: "icon", icon: "magnifyingGlass", label: "計画を検索", attr: "data-toggle-search" },
    { kind: "link", display: "icon", icon: "user", label: "マイページ", href: "mypage.html" },
  ],
});

const searchToggleEl = qs<HTMLButtonElement>("[data-toggle-search]");
let rankingResizeTimer = 0;

// セクション見出しの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
document.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.insertAdjacentHTML("afterbegin", icon(name as IconName));
});

function setSearchOpen(open: boolean): void {
  hub.classList.toggle("is-search-open", open);
  searchToggleEl.setAttribute("aria-expanded", String(open));
  if (open) window.setTimeout(() => filterEl.focus(), 0);
}

searchToggleEl.setAttribute("aria-expanded", "false");
searchToggleEl.addEventListener("click", () => {
  setSearchOpen(!hub.classList.contains("is-search-open"));
});

const EMPTY_TRIP_COVERS = [
  "./images/thumbs/cover_tokyo.webp",
  "./images/thumbs/cover_newyork.webp",
  "./images/thumbs/cover_africa.webp",
  "./images/thumbs/cover_india.webp",
  "./images/thumbs/cover_arizona.webp",
];

const emptyTripCover = EMPTY_TRIP_COVERS[Math.floor(Math.random() * EMPTY_TRIP_COVERS.length)];

function renderStart(): void {
  const invites = db.pendingInvites();
  createMainEl.innerHTML = icon("plusCircle") + "<span>新しい旅行計画を作る</span>";
  createMainEl.href = newPlanHref();
  inviteStripEl.classList.toggle("is-visible", invites.length > 0);
  if (invites.length) {
    inviteTitleEl.textContent = "未参加の招待があります";
    inviteNoteEl.textContent = invites.map((invite) => invite.plan_title).slice(0, 3).join("、");
  }
}

function newPlanHref(): string {
  if (!db.isEnabled() || isIdentified()) return "plan-editor.html";
  return "login.html?returnTo=" + encodeURIComponent("plan-editor.html");
}

function render(): void {
  TripPlans.ensureSeed(readGlobalTripConfig());
  planDataCache.clear();
  const activeSlug = TripPlans.getActiveSlug();
  const filter = state.filter.trim().toLowerCase();
  // 「自分の計画」は本人が確定していれば出す。
  // 旧構造はアカウントのログイン有無で出し分けていたが、いまは identity（user_id）が正。
  const loggedIn = isIdentified();

  const all = TripPlans.list();
  const mine = loggedIn ? sortMinePlans(TripPlans.listMine().filter((m) => matchesFilter(m, filter))) : [];
  const others = TripPlans.listPublic().filter((m) => matchesFilter(m, filter));
  const discoverPlans = all.filter((m) => TripPlans.isPublished(m) && TripPlans.planVisibility(m) === "public" && m.source !== "sample");
  const mineHighlights = highlightedMineSlugs(mine);

  const mineTotal = TripPlans.listMine().length;
  if (loggedIn) {
    inviteStripEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
    gridMine.after(discoverSectionEl);
  } else {
    inviteStripEl.after(discoverSectionEl);
    discoverSectionEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
  }
  mineHeadEl.hidden = !loggedIn;
  gridMine.hidden = !loggedIn;

  if (countEl) countEl.textContent = mineTotal ? "自分の計画 " + mineTotal + "件" : "計画はまだありません";
  countMineEl.textContent = mine.length ? mine.length + "件" : "";
  renderStart();
  renderDiscover(discoverPlans);

  // --- 自分の計画 ---
  if (!loggedIn) {
    gridMine.innerHTML = "";
    countMineEl.textContent = "";
  } else if (mine.length) {
    gridMine.innerHTML = mine.map((meta) => rowHtml(meta, "mine", activeSlug, mineHighlights.get(meta.slug))).join("");
  } else {
    gridMine.innerHTML =
      '<div class="hub-empty">' +
      (mineTotal
        ? '<div class="hub-empty-simple"><b>該当する計画がありません</b><span>検索条件を変えてください</span></div>'
        : '<div class="hub-empty-layout">' +
          '<span class="hub-empty-tag">' + icon("sparkles") + '<span>FIRST TRIP</span></span>' +
          '<div class="hub-empty-art" aria-hidden="true">' +
          '<img src="' + emptyTripCover + '" alt="">' +
          '<span class="hub-empty-pin start">' + icon("mapPin") + '</span>' +
          '<span class="hub-empty-pin end">' + icon("flag") + '</span>' +
          '<span class="hub-empty-route"></span>' +
          '</div>' +
          '<div class="hub-empty-copy">' +
          '<b>最初の計画を作りましょう</b>' +
          '<span>行き先、日程、メンバーを入れて旅の下書きを始められます</span>' +
          '</div>' +
          '<div class="hub-empty-steps">' +
          '<span>' + icon("mapPin") + '<i>01</i>行き先</span>' +
          '<span>' + icon("calendarDays") + '<i>02</i>日程</span>' +
          '<span>' + icon("listBullet") + '<i>03</i>行程</span>' +
          '</div>' +
          '<a class="hub-empty-cta" href="' + newPlanHref() + '">' + icon("plusCircle") + '<span>新規計画を作る</span></a>' +
          '</div>') +
      "</div>";
  }

  // --- みんなの公開計画（0件のときはセクションごと隠す） ---
  if (others.length) {
    gridPublic.innerHTML = others.map((meta) => rowHtml(meta, "public", activeSlug)).join("");
    countPublicEl.textContent = others.length + "件";
    publicHead.hidden = false;
    gridPublic.hidden = false;
  } else {
    gridPublic.innerHTML = "";
    countPublicEl.textContent = "";
    publicHead.hidden = true;
    gridPublic.hidden = true;
  }
}

function closeMenus(except?: Element | null): void {
  hub.querySelectorAll<HTMLElement>("[data-menu-panel]").forEach((panel) => {
    if (panel === except) return;
    panel.hidden = true;
    const btn = panel.parentElement?.querySelector<HTMLButtonElement>("[data-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

/**
 * 計画を自分のローカル計画へ複製する。
 * 公開計画からの複製時は、所有＝メンバーのため自分の名前をメンバーに加え、
 * 「自分の計画」セクションに出るようにする。
 */
async function duplicateToMine(slug: string, fromPublic: boolean): Promise<void> {
  if (!currentUserId()) {
    navigateWithPageTransition("login.html?returnTo=" + encodeURIComponent("plans.html"));
    return;
  }
  // 既にコピーを持っているなら、作り直さずそれを開く。
  const already = TripPlans.existingCopyOf(slug);
  if (already) {
    showToast("すでにコピーがあります。そのコピーを開きます");
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(already.slug));
    return;
  }
  let copy: PlanMeta | null = null;
  try {
    copy = await TripPlans.duplicateAndSave(slug);
  } catch (error) {
    render();
    showToast("コピーを保存できませんでした");
    console.error("[plans] duplicate", error);
    return;
  }
  if (!copy) {
    render();
    return;
  }
  // 参加者は duplicate() が複製者ひとりに揃えるので、ここでは触らない。
  render();
  showToast(fromPublic ? "自分の計画に複製しました。編集画面を開きます" : "計画を複製しました。編集画面を開きます");
  navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(copy.slug));
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".plan-tools")) return;
  closeMenus();
});

function openAuthorPage(link: HTMLElement): void {
  const href = link.dataset.authorLink;
  if (!href) return;
  navigateWithPageTransition(href);
}

hub.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (authorLink) {
    event.preventDefault();
    event.stopPropagation();
    openAuthorPage(authorLink);
    return;
  }
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";
  const variant = (card.dataset.variant as RowVariant) || "mine";

  const menuButton = target.closest<HTMLButtonElement>("[data-menu]");
  if (menuButton) {
    event.preventDefault();
    const panel = card.querySelector<HTMLElement>("[data-menu-panel]");
    if (!panel) return;
    const willOpen = panel.hidden;
    closeMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
  }
  closeMenus();
  if (target.closest("[data-edit]")) {
    event.preventDefault();
    TripPlans.setActiveSlug(slug);
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(slug));
    return;
  }
  if (target.closest("[data-dup]")) {
    event.preventDefault();
    void duplicateToMine(slug, variant === "public");
    return;
  }
  if (target.closest("[data-del]")) {
    event.preventDefault();
    const meta = TripPlans.get(slug);
    const name = meta && meta.title ? meta.title : "この計画";
    if (window.confirm("「" + name + "」を削除しますか？この操作は元に戻せません。")) {
      void TripPlans.remove(slug).then(
        () => render(),
        (error) => showToast("削除できませんでした: " + errorMessage(error), true),
      );
    }
    return;
  }
});

hub.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (!authorLink) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openAuthorPage(authorLink);
});

filterEl.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  state.filter = (target && target.value) || "";
  hub.classList.toggle("has-search-filter", Boolean(state.filter.trim()));
  render();
});

destinationsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-dest-filter]");
  if (!link) return;
  event.preventDefault();
  const value = link.dataset.destFilter || "";
  queueLocationTransition("forward");
  state.selectedLocation = value;
  state.selectedPlanSlug = "";
  render();
});

locationHeadEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("[data-location-back]")) return;
  event.preventDefault();
  queueLocationTransition("back");
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  render();
});

locationPlansEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-location-plan]");
  if (!link) return;
  event.preventDefault();
  queueLocationTransition("swap");
  state.selectedPlanSlug = link.dataset.locationPlan || "";
  render();
});

window.addEventListener("trip-backend-sync", () => {
  render();
});

window.addEventListener("trip-account-logout", () => {
  state.filter = "";
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  filterEl.value = "";
  hub.classList.remove("is-search-open", "has-search-filter");
  searchToggleEl.setAttribute("aria-expanded", "false");
  render();
});

window.addEventListener("resize", () => {
  window.clearTimeout(rankingResizeTimer);
  rankingResizeTimer = window.setTimeout(() => {
    if (rankingCardLimit() !== getLastRankingLimit()) render();
  }, 120);
});

registerServiceWorker();

function chooseInviteMember(inspection: db.InviteInspection): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "pub-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "join-member-title");
    modal.innerHTML = `
      <div class="pub-box">
        <h2 id="join-member-title">旅行メンバーの中で、あなたは誰ですか？</h2>
        <div class="pub-body">
          <p>「${escapeHtml(inspection.planTitle || "旅行計画")}」に登録されている名前を選んでください。参加後、その名前はあなたのアカウント名に置き換わります。</p>
          <div class="join-member-options">
            ${inspection.memberOptions.map((member) => `
              <label class="join-member-option">
                <input type="radio" name="join-member" value="${escapeHtml(member.userId)}">
                <span>${escapeHtml(member.displayName)}</span>
              </label>
            `).join("")}
          </div>
          <div class="pub-error" data-join-error></div>
          <div class="pub-actions">
            <button type="button" class="secondary" data-join-cancel>キャンセル</button>
            <button type="button" data-join-next disabled>次へ</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const next = modal.querySelector<HTMLButtonElement>("[data-join-next]");
    const finish = (value: string | null): void => {
      modal.remove();
      resolve(value);
    };
    modal.addEventListener("change", () => {
      if (next) next.disabled = !modal.querySelector<HTMLInputElement>('input[name="join-member"]:checked');
    });
    modal.querySelector("[data-join-cancel]")?.addEventListener("click", () => finish(null));
    next?.addEventListener("click", () => {
      const selected = modal.querySelector<HTMLInputElement>('input[name="join-member"]:checked')?.value || "";
      if (selected) finish(selected);
    });
    modal.querySelector<HTMLInputElement>('input[name="join-member"]')?.focus();
  });
}

// 招待リンク（plans.html#join=<token>）を開いたら、計画を取り込んでダッシュボードへ。
// 同じ計画（slug 一致）が既にあれば重複作成せず、本文を最新に更新しつつ候補の票はマージする。
async function handleJoinLink(): Promise<boolean> {
  const m = /(?:^|[#&])join=([^&]+)/.exec(location.hash || "");
  if (!m) return false;
  const payload = await decodeInvite(m[1]);
  if (!payload) {
    history.replaceState(null, "", location.pathname + location.search);
    showToast("招待リンクを読み込めませんでした。", true);
    return false;
  }
  const slug = TripPlans.safeSlug(payload.meta.slug || payload.meta.title || "trip");
  if (payload.token) {
    let selectedMemberId = /(?:^|[&#])member=([^&]+)/.exec(location.hash || "")?.[1] || "";
    try { selectedMemberId = decodeURIComponent(selectedMemberId); } catch { selectedMemberId = ""; }
    let inspection: db.InviteInspection;
    try {
      inspection = await db.inspectInvite(payload.token);
    } catch (error) {
      history.replaceState(null, "", location.pathname + location.search);
      showToast(errorMessage(error) || "この招待リンクは利用できません。", true);
      return true;
    }
    const validSelectedMember = inspection.memberOptions.some((member) => member.userId === selectedMemberId);
    if (inspection.requiresMemberSelection && !validSelectedMember) {
      selectedMemberId = await chooseInviteMember(inspection) || "";
      if (!selectedMemberId) {
        history.replaceState(null, "", location.pathname + location.search);
        return false;
      }
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#join=${encodeURIComponent(m[1])}&member=${encodeURIComponent(selectedMemberId)}`,
      );
    }
    if (!isIdentified()) {
      const memberPart = selectedMemberId ? `&member=${encodeURIComponent(selectedMemberId)}` : "";
      const returnTo = `${location.pathname}${location.search}#join=${encodeURIComponent(m[1])}${memberPart}`;
      if (!rememberInviteReturn(returnTo)) throw new Error("招待情報をこの端末に保存できませんでした");
      navigateWithPageTransition("login.html?resumeInvite=1&returnTo=plans.html", { replace: true });
      return true;
    }
    try {
      const accepted = await db.acceptInvite(payload.token, selectedMemberId);
      const nextSlug = accepted.planSlug || slug;
      TripPlans.setActiveSlug(nextSlug);
      history.replaceState(null, "", location.pathname + location.search);
      navigateWithPageTransition(planDashboardHref(nextSlug), { replace: true });
    } catch (error) {
      history.replaceState(null, "", location.pathname + location.search);
      showToast(errorMessage(error) || "招待リンクを受け取れませんでした。ログインしてからもう一度開いてください。", true);
    }
    return true;
  }
  history.replaceState(null, "", location.pathname + location.search);
  showToast("この招待リンクは旧形式です。計画の所有者に新しいリンクの発行を依頼してください。", true);
  return true;
}

// 共有ストア（MySQL）を読み終えてから描画する。
// 読む前に描くと計画0件に見え、書き込むと実在しない行を作ってしまう。
void db.load().then(() => handleJoinLink()).then((joined) => {
  if (!joined) render();
});

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(render);
