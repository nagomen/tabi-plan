// 旅行計画エディタ（フル刷新版）。
// 設計方針:
//  - 2段階: まず骨組み（旅行名・期間・メンバー・ルート都市）→ 各日を後から肉付け。
//  - 種別ごとに表示を最適化: 移動=区間 / 宿泊=その日の錨 / 観光・食事=タイムライン。
//  - 折りたたみ行（タップで編集）＋ クイック追加 ＋ 編集内ライブ地図（ピン+ルート）。
//  - 保存時は従来の LocalPlanData.itinerary（ItineraryItem[]）へフラット化し、ダッシュボード互換。

import * as db from "../shared/db";
import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";
import "flatpickr/dist/flatpickr.css";

import * as TripPlans from "../shared/plans-store";
import { errorMessage } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { registerServiceWorker } from "../shared/pwa";
import { currentAccount } from "../shared/account-store";
import { canEditPlan, canEditPlanMetadata, canManagePlan } from "../shared/membership";
import { params, isNew, state, model, worthSaving } from "./editor-state";
import {
  root, qs, daysEl, statusEl, titleEcho, mapHeaderBtn, savebarNoteEl,
  citiesEl, cityInput, rangeTrigger, dayStripEl,
  aiArea, aiRun, aiRunIcon, aiErrorAction, aiCandidateList, aiToPreferences, aiBuild,
  aiImportOpen, aiImportApply,
  coverInput, coverClearBtn,
  membersMount, memberSelect, memberAddBtn, memberNameInput, memberNameAddBtn, activeInvitesMount,
  candMount, candInput, gcalBtn, icsBtn,
  saveBtn, publishBtn, localNoteEl, exportBtn, mapToggle, mapClose,
  watchComposition,
} from "./editor-dom";
import { setMapHandlers, ensureMap, setMapCollapsed, bindMapResizeGrip } from "./map";
import { stepCompletion, setViewStep } from "./steps";
import { buildData, contentFingerprint } from "./plan-data";
import { setPersistHooks, setLastSavedContentFingerprint, markDirty, persist } from "./persist";
import { onCoverInputChange, onCoverClearClick } from "./cover-image";
import {
  persistPendingMembers, refreshMemberField,
  commitMemberSelect, commitMemberName, onMembersClick, onMembersChange, onActiveInvitesClick, onMemberNameKeydown,
} from "./members";
import { onGcalClick, onIcsClick } from "./calendar-sync";
import { rebuildDays, renderDays } from "./days-render";
import { renderCities } from "./cities-render";
import { renderCandidates, onCandidatesClick, commitCandInput, onCandInputKeydown } from "./candidates";
import { lockEditor, applyEditorLock, applyMetadataLock } from "./editor-lock";
import { onRangeTriggerClick } from "./date-range";
import { syncBasicInputs, loadExisting } from "./plan-load";
import { save, publish, exportJson } from "./save-publish";
import {
  resetAiConsultation, onAiErrorActionClick, onAiRunClick, onAiImportOpenClick, onAiImportApplyClick,
  onAiAreaKeydown, onAiCandidateChange, onAiToPreferencesClick, onAiBackToCandidatesClick, onAiBuildClick,
} from "./ai-consultation";
import { onMapClick, applyGeo } from "./place-geocode";
import { onDaysClick, onDaysInput, onDaysKeydown, onDayStripClick } from "./days-actions";
import { onCityInputKeydown, onCityAddClick, onCitiesChange, onCitiesClick, onCitiesInput } from "./cities";

initPageTransitions();


// セクション見出しにアイコン
qs<HTMLElement>("[data-ic-route]").insertAdjacentHTML("afterbegin", icon("map") + " ");
qs<HTMLElement>("[data-ic-days]").insertAdjacentHTML("afterbegin", icon("calendarDays") + " ");
qs<HTMLElement>("[data-ic-cand]").insertAdjacentHTML("afterbegin", icon("star") + " ");
qs<HTMLElement>("[data-ic-ai]").insertAdjacentHTML("afterbegin", icon("sparkles") + " ");

// 入力ラベル・操作ボタンにも Heroicon を添える
const ICON_MOUNTS: [string, IconName][] = [
  ["[data-ic-name]", "bookmark"],
  ["[data-ic-period]", "calendarDays"],
  ["[data-ic-members]", "users"],
  ["[data-ic-memberadd]", "plus"],
  ["[data-ic-cal]", "calendarDays"],
  ["[data-ic-gcal]", "calendarDays"],
  ["[data-ic-ics]", "documentText"],
  ["[data-ic-note]", "documentText"],
  ["[data-ic-cover]", "photo"],
  ["[data-ic-coverpick]", "photo"],
  ["[data-city-add]", "plus"],
  ["[data-cand-add]", "plus"],
  ["[data-export]", "documentText"],
  ["[data-save]", "bookmark"],
];
ICON_MOUNTS.forEach(([selector, name]) => {
  const el = root.querySelector(selector);
  if (el) el.insertAdjacentHTML("afterbegin", icon(name) + " ");
});


rangeTrigger.addEventListener("click", onRangeTriggerClick);

document.querySelectorAll<HTMLElement>(".pe-step").forEach((el, i) => {
  el.addEventListener("click", () => setViewStep(i + 1));
});

document.querySelector<HTMLButtonElement>("[data-step-prev]")?.addEventListener("click", () => {
  setViewStep(state.viewStep - 1);
});

document.querySelector<HTMLButtonElement>("[data-step-next]")?.addEventListener("click", () => {
  const done = stepCompletion();
  if (state.viewStep >= 3) {
    publish();
    return;
  }
  if (!done[state.viewStep - 1]) return;
  setViewStep(state.viewStep + 1);
});

// ---- AI で下書きを作る ---------------------------------------------------

aiRunIcon.innerHTML = icon("sparkles");
aiErrorAction.addEventListener("click", onAiErrorActionClick);
aiRun.addEventListener("click", onAiRunClick);
aiImportOpen.addEventListener("click", () => { void onAiImportOpenClick(); });
aiImportApply.addEventListener("click", onAiImportApplyClick);
watchComposition(aiArea);
aiArea.addEventListener("keydown", onAiAreaKeydown);
aiCandidateList.addEventListener("change", onAiCandidateChange);
aiToPreferences.addEventListener("click", onAiToPreferencesClick);
qs<HTMLButtonElement>("[data-ai-back-candidates]").addEventListener("click", onAiBackToCandidatesClick);
qs<HTMLButtonElement>("[data-ai-reset]").addEventListener("click", resetAiConsultation);
aiBuild.addEventListener("click", onAiBuildClick);
qs<HTMLButtonElement>("[data-ai-show-itinerary]").addEventListener("click", () => setViewStep(3));

// ---- イベント委譲 -------------------------------------------------------

daysEl.addEventListener("click", onDaysClick);
daysEl.addEventListener("input", onDaysInput);

// ---- 基本情報の入力バインド ---------------------------------------------

root.querySelectorAll<HTMLInputElement>("[data-f]").forEach((input) => {
  input.addEventListener("input", () => {
    const key = input.dataset.f;
    if (key === "title" || key === "members" || key === "note") {
      model[key] = input.value;
    }
    if (key === "title") titleEcho.textContent = input.value || "新しい計画";
    markDirty();
  });
});

// ---- サムネ画像（任意・未設定なら自動/デフォルト） ----------------------

coverInput.addEventListener("change", onCoverInputChange);
coverClearBtn.addEventListener("click", onCoverClearClick);

// ---- メンバー（チップ／友達候補／招待リンク） --------------------------

setPersistHooks({ persistPendingMembers });
activeInvitesMount.addEventListener("click", onActiveInvitesClick);

// ログイン状態は別タブ（storage イベント）やマイページのドロワー（同一オリジンの
// iframeなので localStorage 変更は storage イベントとして親に届く）で変わることがある。
// このページ自身は読み込み時に1回しかログイン状態を見ないため、タブに戻ってきた
// タイミングでも再評価しないと「ログイン済みなのにメンバー欄が出ない」状態のまま残る。
window.addEventListener("storage", refreshMemberField);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshMemberField();
});

membersMount.addEventListener("click", onMembersClick);
// 途中合流/離脱の日付入力。確定した時点で参加期間を保存する。
membersMount.addEventListener("change", onMembersChange);
memberAddBtn.addEventListener("click", commitMemberSelect);
memberSelect.addEventListener("change", commitMemberSelect);
memberNameAddBtn.addEventListener("click", commitMemberName);
memberNameInput.addEventListener("keydown", onMemberNameKeydown);


// ---- 行きたい候補（投票ボード） ----------------------------------------


candMount.addEventListener("click", onCandidatesClick);
qs<HTMLButtonElement>("[data-cand-add]").addEventListener("click", commitCandInput);
watchComposition(candInput);
candInput.addEventListener("keydown", onCandInputKeydown);

gcalBtn.addEventListener("click", onGcalClick);
icsBtn.addEventListener("click", onIcsClick);

watchComposition(cityInput);
cityInput.addEventListener("keydown", onCityInputKeydown);
qs<HTMLButtonElement>("[data-city-add]").addEventListener("click", onCityAddClick);
// 都市の滞在期間（開始/終了日）の割り当て
citiesEl.addEventListener("change", onCitiesChange);
// 都市の削除・地図検索
citiesEl.addEventListener("click", onCitiesClick);
// 都市名の編集（フォーカス維持のため renderCities はしない）
citiesEl.addEventListener("input", onCitiesInput);

// ---- ヘッダーアイコン・初期化 -------------------------------------------

// 戻る（<）は共通ヘッダー側で描画済み。開くボタンだけ eye アイコンに差し替える。
saveBtn.innerHTML = icon("bookmark") + "<span>下書きを保存</span>";
publishBtn.innerHTML = icon("globeAlt") + "<span>公開設定</span>";
saveBtn.addEventListener("click", () => { void save(); });
publishBtn.addEventListener("click", publish);
qs<HTMLButtonElement>("[data-city-add]").innerHTML = icon("plus") + "<span>追加</span>";
localNoteEl.innerHTML = icon("informationCircle") + (db.isEnabled()
  ? "クラウドに自動保存（公開するまでは下書き）"
  : "保存先が未設定（JSON書き出しのみ利用できます）");

exportBtn.innerHTML = icon("documentText") + "<span>書き出し</span>";
exportBtn.addEventListener("click", exportJson);

// 地図の表示/非表示

mapClose.innerHTML = icon("xMark");
setMapHandlers({ onMapClick, applyGeo });
mapToggle.addEventListener("click", () => setMapCollapsed(!root.classList.contains("map-collapsed")));
mapHeaderBtn.addEventListener("click", () => setMapCollapsed(!root.classList.contains("map-collapsed")));
mapClose.addEventListener("pointerdown", (event) => event.stopPropagation());
mapClose.addEventListener("click", (event) => { event.stopPropagation(); setMapCollapsed(true); });

bindMapResizeGrip();

// 行のキーボード操作（Enter/Space で開閉）
daysEl.addEventListener("keydown", onDaysKeydown);

// 日へジャンプ
dayStripEl.addEventListener("click", onDayStripClick);
window.addEventListener("beforeunload", (event) => {
  if (state.editorLocked) return;
  if (state.dirty) { event.preventDefault(); event.returnValue = ""; }
});

// タブが背面へ移る時は、beforeunload の非同期処理に頼らず先に保存を開始する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.dirty && worthSaving()) void persist();
});

// 共有ストア（MySQL）を読み終えてから既存計画を読み込む。
// 読む前に触ると「権限がありません」になったり、計画を二重に作ってしまう。
function bootstrapEditor(): void {
  if (db.isEnabled() && !currentAccount()) {
    navigateWithPageTransition(
      "login.html?returnTo=" + encodeURIComponent("plan-editor.html" + location.search),
      { replace: true },
    );
    return;
  }
  const editable = loadExisting();
  syncBasicInputs();
  rebuildDays();
  setLastSavedContentFingerprint(contentFingerprint(buildData()));
  renderCities();
  renderDays();
  renderCandidates();
  // 地図の初期表示：スマホは入力を優先し、地図は必要な時だけ開く。
  let savedMapPref: string | null = null;
  try {
    savedMapPref = localStorage.getItem("pe-map-collapsed");
  } catch { /* localStorage が使えない環境では既定の表示にする */ }
  if (window.matchMedia("(max-width: 680px)").matches) {
    setMapCollapsed(true);
  } else if (savedMapPref === "1" || (savedMapPref == null && window.matchMedia("(max-width: 760px)").matches)) {
    setMapCollapsed(true);
  }
  // 畳まない構成（PC など）はこの時点で見えているので、ここで作る。
  if (!root.classList.contains("map-collapsed")) ensureMap();
  statusEl.textContent = isNew ? "下書き（自動保存・未保存）" : editable ? "読み込み完了" : statusEl.textContent;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  state.metadataLocked = Boolean(meta && canEditPlan(meta) && !canEditPlanMetadata(meta));
  publishBtn.hidden = Boolean(meta && !canManagePlan(meta));
  if (!editable || state.editorLocked) applyEditorLock();
  else if (state.metadataLocked) applyMetadataLock();
  // ダッシュボードの「AIサポート」から来たとき（?ai=1）は、AI相談ブロックへ案内する。
  if (params.get("ai") === "1" && editable && !state.editorLocked) {
    const aiBlock = root.querySelector<HTMLElement>("[data-ai-block]");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      if (!aiBlock || !aiBlock.offsetParent) return; // スマホのステップ表示などで隠れていたら何もしない
      aiBlock.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      aiArea.focus({ preventScroll: true });
    }, 0);
  }
}

// 編集画面は控え（キャッシュ）を使わずサーバーの最新を待つ。
// 裏で snap が差し替わると、編集中の内容と食い違うため。
void db.load({ fresh: true, strict: db.isEnabled() }).then(bootstrapEditor).catch((error) => {
  lockEditor("旅行データを読み込めませんでした。接続を確認して再読み込みしてください");
  savebarNoteEl.textContent = errorMessage(error);
  applyEditorLock();
});

registerServiceWorker();
