import "../shared/ui.css";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";

import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { adoptLegacyIdentity } from "../shared/identity";
import * as db from "../shared/db";
import { incrementView } from "../shared/views-store";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import { applyPlanConfig, CONFIG, getMobileView, isAccessDenied, isReadOnly, setAccessDenied, setReadOnly, setRenderHooks } from "./state";
import { qs, qsa, root } from "./dom";
import { canUseWorkspaceView, computeAccessDenied, computeReadOnly, isEditableLocalPlan } from "./plan-access";
import { renderAccessDenied, showError } from "./errors";
import { refreshMapLayout } from "./map";
import { applyMobileView, syncMobileNavLayout, syncStickyOffsets } from "./view-mode";
import { requestIdentityIfNeeded, requestPassword } from "./profile";
import { setExpenseSheet } from "./expense-entry";
import { applyMoneyTab } from "./settlement";
import { setupPhotoAlbumEditor } from "./photo-album";
import { bindChecklist } from "./checklist";
import { leaveTrip, shareTripInvite } from "./members";
import { shareSchedule } from "./itinerary-feed";
import { setupAiChat } from "./ai-chat";
import { copyPlanToMine } from "./plan-copy";
import { renderActive, renderBase, renderData } from "./render";
import { syncData } from "./sync";

initPageTransitions();

setRenderHooks({ renderBase, renderActive, renderData, syncData });

// セクション見出し・ボタンの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
qsa<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.innerHTML = icon(name as IconName);
});

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
