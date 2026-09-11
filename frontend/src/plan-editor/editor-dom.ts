import { makeScopedQuery } from "../shared/dom";
import { mountAppHeader } from "../shared/app-header";

// ---- DOM ----------------------------------------------------------------

const rootOrNull = document.getElementById("editor");
if (!rootOrNull) throw new Error("エディタのルート要素が見つかりません: #editor");
export const root: HTMLElement = rootOrNull;

export const { qs } = makeScopedQuery(root);

mountAppHeader({
  kicker: "Plan Editor",
  title: "新しい計画",
  titleAttr: "data-title-echo",
  back: { href: "plans.html", label: "計画一覧へ戻る", attr: "data-back" },
  meta: [{ attr: "data-status" }],
  actions: [
    // スマホでは画面下に浮いていた「地図を表示」をここへ移す。
    // 本文の上に被らず、いつでも同じ場所から開けるようにするため。
    {
      kind: "button",
      display: "icon",
      icon: "map",
      label: "地図を表示",
      attr: "data-map-header",
    },
  ],
});

export const daysEl = qs<HTMLElement>("[data-days]");
export const statusEl = qs<HTMLElement>("[data-status]");
export const titleEcho = qs<HTMLElement>("[data-title-echo]");
export const mapHeaderBtn = qs<HTMLButtonElement>("[data-map-header]");
export const warnEl = qs<HTMLElement>("[data-daterange-warn]");
export const dayCountEl = qs<HTMLElement>("[data-day-count]");
export const savebarNoteEl = qs<HTMLElement>("[data-savebar-note]");
export const stepReasonEl = qs<HTMLElement>("[data-step-reason]");
export const citiesEl = qs<HTMLElement>("[data-cities]");
export const cityInput = qs<HTMLInputElement>("[data-city-input]");
export const cityOptions = qs<HTMLDataListElement>("#pe-city-options", document);
export const mapEl = qs<HTMLElement>("[data-map]");
export const mapHintEl = qs<HTMLElement>("[data-map-hint]");
export const rangeEl = qs<HTMLInputElement>("[data-range]");
export const rangeTrigger = qs<HTMLButtonElement>("[data-range-trigger]");
export const rangeLabel = qs<HTMLElement>("[data-range-label]");
export const dayStripEl = qs<HTMLElement>("[data-daystrip]");
export const tripSummaryEl = qs<HTMLElement>("[data-trip-summary]");

// ---- AI で下書きを作る ---------------------------------------------------

export const aiArea = qs<HTMLInputElement>("[data-ai-area]");
export const aiNote = qs<HTMLInputElement>("[data-ai-note]");
export const aiRun = qs<HTMLButtonElement>("[data-ai-run]");
export const aiRunLabel = qs<HTMLElement>("[data-ai-run-label]");
export const aiRunIcon = qs<HTMLElement>("[data-ai-run-ic]");
export const aiBar = qs<HTMLElement>("[data-ai-bar]");
export const aiStatus = qs<HTMLElement>("[data-ai-status]");
export const aiError = qs<HTMLElement>("[data-ai-error]");
export const aiErrorTitle = qs<HTMLElement>("[data-ai-error-title]");
export const aiErrorMessage = qs<HTMLElement>("[data-ai-error-message]");
export const aiErrorAction = qs<HTMLButtonElement>("[data-ai-error-action]");
export const aiErrorReference = qs<HTMLElement>("[data-ai-error-reference]");
export const aiIntro = qs<HTMLElement>("[data-ai-intro]");
export const aiDialog = qs<HTMLElement>("[data-ai-dialog]");
export const aiThread = qs<HTMLElement>("[data-ai-thread]");
export const aiCandidatesStage = qs<HTMLElement>("[data-ai-candidates]");
export const aiPreferencesStage = qs<HTMLElement>("[data-ai-preferences]");
export const aiDoneStage = qs<HTMLElement>("[data-ai-done]");
export const aiCandidateList = qs<HTMLElement>("[data-ai-candidate-list]");
export const aiSelection = qs<HTMLElement>("[data-ai-selection]");
export const aiToPreferences = qs<HTMLButtonElement>("[data-ai-to-preferences]");
export const aiBuild = qs<HTMLButtonElement>("[data-ai-build]");
export const aiWalking = qs<HTMLSelectElement>("[data-ai-walking]");
export const aiTransport = qs<HTMLSelectElement>("[data-ai-transport]");
export const aiExtra = qs<HTMLTextAreaElement>("[data-ai-extra]");
export const aiImportDetails = qs<HTMLDetailsElement>("[data-ai-import] details");
export const aiImportOpen = qs<HTMLButtonElement>("[data-ai-import-open]");
export const aiImportJson = qs<HTMLTextAreaElement>("[data-ai-import-json]");
export const aiImportApply = qs<HTMLButtonElement>("[data-ai-import-apply]");
export const aiImportStatus = qs<HTMLElement>("[data-ai-import-status]");

// ---- サムネ画像（任意・未設定なら自動/デフォルト） ----------------------

export const coverInput = qs<HTMLInputElement>("[data-cover-input]");
export const coverClearBtn = qs<HTMLButtonElement>("[data-cover-clear]");
export const coverPreview = qs<HTMLElement>("[data-cover-preview]");

// ---- メンバー（チップ／友達候補／招待リンク） --------------------------

export const membersMount = qs<HTMLElement>("[data-members]");
export const memberField = qs<HTMLElement>("[data-member-field]");
export const memberSelect = qs<HTMLSelectElement>("[data-member-select]");
export const memberAddBtn = qs<HTMLButtonElement>("[data-member-add]");
export const memberNameInput = qs<HTMLInputElement>("[data-member-name]");
export const memberNameAddBtn = qs<HTMLButtonElement>("[data-member-name-add]");
export const memberHint = qs<HTMLElement>("[data-member-hint]");
export const activeInvitesMount = qs<HTMLElement>("[data-active-invites]");

// ---- 行きたい候補（投票ボード） ----------------------------------------

export const candMount = qs<HTMLElement>("[data-candidates]");
export const candInput = qs<HTMLInputElement>("[data-cand-input]");
export const candCountEl = qs<HTMLElement>("[data-cand-count]");

// ---- カレンダー連携（Google テンプレート / .ics） ----------------------

export const gcalBtn = qs<HTMLButtonElement>("[data-gcal]");
export const icsBtn = qs<HTMLButtonElement>("[data-ics]");

// ---- ヘッダーアイコン・初期化 -------------------------------------------

export const saveBtn = qs<HTMLButtonElement>("[data-save]");
export const publishBtn = qs<HTMLButtonElement>("[data-publish-plan]");
export const stepNextBtn = qs<HTMLButtonElement>("[data-step-next]");
export const localNoteEl = qs<HTMLElement>("[data-local-note]");
export const exportBtn = qs<HTMLButtonElement>("[data-export]");

// 地図の表示/非表示
export const mapToggle = qs<HTMLButtonElement>("[data-map-toggle]");
export const mapClose = qs<HTMLButtonElement>("[data-map-close]");

export function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "pe-toast";
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 3200);
}

/**
 * 日本語入力の変換中に来た Enter か。
 *
 * 変換確定の Enter を操作として拾うと、確定した文字が入力欄へ
 * 書き戻されて残る（「金門島」を入れたのに欄に残る、が起きていた）。
 * 判定は compositionstart / compositionend で持つ。keyCode 229 を見る書き方は、
 * 変換を終えたあとの Enter まで 229 で来る環境があり、
 * 「Enter を押しても追加されない」になってしまう。
 */
const composingInputs = new WeakSet<EventTarget>();

export function watchComposition(input: HTMLElement): void {
  input.addEventListener("compositionstart", () => { composingInputs.add(input); });
  input.addEventListener("compositionend", () => { composingInputs.delete(input); });
}

export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || (event.target !== null && composingInputs.has(event.target));
}
