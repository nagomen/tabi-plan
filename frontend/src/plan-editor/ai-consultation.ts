import * as db from "../shared/db";
import { escapeHtml, errorMessage } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { formatDurationMinutes } from "../shared/travel-duration";
import { buildExternalAiCreatePrompt, copyExternalAiPrompt, openExternalAi, parseExternalAiCreateJson } from "../shared/external-ai";
import { AiConsultationState, type AiStage } from "./ai-consultation-state";
import { aiErrorGuidance, retryWaitLabel, type AiErrorPhase } from "./ai-error-guidance";
import { state, model } from "./editor-state";
import {
  root,
  aiArea, aiNote, aiRun, aiRunLabel, aiBar, aiStatus, aiError, aiErrorTitle, aiErrorMessage,
  aiErrorAction, aiErrorReference, aiIntro, aiDialog, aiThread, aiCandidatesStage, aiPreferencesStage, aiDoneStage,
  aiCandidateList, aiSelection, aiToPreferences, aiBuild, aiWalking, aiTransport, aiExtra, aiImportDetails,
  aiImportJson, aiImportApply, aiImportStatus,
  isComposingKey,
} from "./editor-dom";
import { setViewStep } from "./steps";
import { markDirty, persist } from "./persist";
import { rebuildDays, renderDays } from "./days-render";
import { renderCities } from "./cities-render";
import { refreshMap } from "./map";
import { syncBasicInputs } from "./plan-load";
import { applyItineraryDraft, registerAiDraftPlacesOnMap } from "./ai-draft-apply";

type AiPreferences = db.ItineraryAiPreferences;
const aiConsultation = new AiConsultationState();
let aiErrorTimer: number | null = null;
let aiErrorHandler: (() => void | Promise<void>) | null = null;

/** 考えている間の見た目。ボタンごと状態を持たせる。 */
function setAiBusy(busy: boolean, label = "考えています"): void {
  aiRun.disabled = busy;
  aiBuild.disabled = busy;
  aiRun.classList.toggle("is-busy", busy);
  aiRunLabel.textContent = busy ? label : "AI生成する";
  aiBar.hidden = !busy;
}

function clearAiError(): void {
  if (aiErrorTimer !== null) window.clearInterval(aiErrorTimer);
  aiErrorTimer = null;
  aiErrorHandler = null;
  aiError.hidden = true;
  aiErrorAction.hidden = true;
  aiErrorAction.disabled = false;
  aiErrorReference.hidden = true;
}

function setAiStatus(text: string, kind?: "warn" | "ok"): void {
  clearAiError();
  aiStatus.textContent = text;
  aiStatus.className = "pe-ai-status" + (kind ? " is-" + kind : "");
}

function showAiError(error: unknown, phase: AiErrorPhase): void {
  clearAiError();
  const source = error instanceof db.ApiRequestError
    ? error
    : { message: errorMessage(error), code: "request_failed", retryable: false };
  const guidance = aiErrorGuidance(source, phase);
  aiStatus.textContent = "";
  aiStatus.className = "pe-ai-status";
  aiError.hidden = false;
  aiErrorTitle.textContent = guidance.title;
  aiErrorMessage.textContent = guidance.message;
  aiErrorReference.hidden = !guidance.requestId;
  aiErrorReference.textContent = guidance.requestId ? `問い合わせ番号: ${guidance.requestId}` : "";

  if (guidance.action === "contact_support") {
    aiErrorAction.hidden = true;
    return;
  }
  aiErrorAction.hidden = false;
  aiErrorHandler = guidance.action === "retry"
    ? () => { void (phase === "candidates" ? startAiConsultation() : runAiDraft()); }
    : guidance.action === "restart"
      ? () => { resetAiConsultation(); aiArea.focus(); }
      : guidance.action === "sign_in"
        ? () => {
          window.open(
            "login.html?returnTo=" + encodeURIComponent("plan-editor.html" + location.search),
            "_blank",
            "noopener",
          );
        }
        : guidance.action === "external_ai"
          ? async () => {
            aiImportDetails.open = true;
            openExternalAi("chatgpt");
            const copied = await copyExternalAiPrompt(externalAiCreatePrompt());
            setAiStatus(
              copied
                ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
                : "質問文を表示しました。すべてコピーしてChatGPTへ貼り付けてください。",
              copied ? "ok" : "warn",
            );
          }
        : () => {
          clearAiError();
          if (phase === "candidates") aiNote.focus();
          else aiExtra.focus();
        };

  if (!guidance.retryAfter) {
    aiErrorAction.textContent = guidance.actionLabel;
    return;
  }
  const availableAt = Date.now() + guidance.retryAfter * 1000;
  const updateCountdown = (): void => {
    const remaining = Math.max(0, Math.ceil((availableAt - Date.now()) / 1000));
    aiErrorAction.disabled = remaining > 0;
    aiErrorAction.textContent = remaining > 0
      ? `${retryWaitLabel(remaining)}後に再試行できます`
      : guidance.actionLabel;
    if (!remaining && aiErrorTimer !== null) {
      window.clearInterval(aiErrorTimer);
      aiErrorTimer = null;
    }
  };
  updateCountdown();
  if (aiErrorAction.disabled) aiErrorTimer = window.setInterval(updateCountdown, 1000);
}

export function onAiErrorActionClick(): void {
  if (aiErrorAction.disabled) return;
  const handler = aiErrorHandler;
  clearAiError();
  void handler?.();
}

function selectedAiCandidates(): db.ItineraryOptions["candidates"] {
  return aiConsultation.selectedCandidates();
}

function aiCandidateGroups(): { city: string; candidates: db.ItineraryOptions["candidates"] }[] {
  return aiConsultation.candidateGroups();
}

function unselectedAiCities(): string[] {
  return aiConsultation.unselectedCities();
}

function aiPreferences(): AiPreferences {
  const pace = root.querySelector<HTMLInputElement>('input[name="ai-pace"]:checked')?.value || "標準";
  return {
    pace: pace as AiPreferences["pace"],
    interests: Array.from(root.querySelectorAll<HTMLInputElement>('input[name="ai-interest"]:checked'))
      .map((input) => input.value),
    walking: aiWalking.value as AiPreferences["walking"],
    transport: aiTransport.value as AiPreferences["transport"],
    extra: aiExtra.value.trim() || undefined,
  };
}

function aiBaseInputForExternal(): db.ItineraryAiBaseInput | null {
  const cities = model.cities
    .filter((city) => city.name.trim())
    .map((city) => ({ name: city.name.trim(), from_date: city.fromDate, to_date: city.toDate }));
  const area = aiArea.value.trim() || cities.map((city) => city.name).join("、") || model.title.trim();
  return area || model.startDate || model.endDate
    ? {
      area,
      start_date: model.startDate,
      end_date: model.endDate,
      note: aiNote.value.trim() || undefined,
      cities,
    }
    : null;
}

function externalAiCreatePrompt(): string {
  return buildExternalAiCreatePrompt({
    base: aiBaseInputForExternal(),
    title: model.title,
    members: model.members,
    selectedCandidates: selectedAiCandidates(),
    preferences: aiConsultation.stage === "preferences" ? aiPreferences() : undefined,
  });
}

function aiBubble(role: "assistant" | "user", text: string): string {
  // チャットの見た目に寄せる: AI は左にアイコン＋吹き出し、利用者は右寄せ。
  // 名前は毎回出さず、話し手はアイコンと左右で示す。
  const avatar = role === "assistant"
    ? `<span class="pe-ai-avatar" aria-hidden="true">${icon("sparkles")}</span>`
    : "";
  return `<div class="pe-ai-line is-${role}">` +
    avatar +
    `<div class="pe-ai-bubble is-${role}">` +
    `<b class="pe-ai-who">${role === "assistant" ? "AIプランナー" : "あなた"}</b>` +
    `<p>${escapeHtml(text)}</p>` +
    "</div></div>";
}

/** AI が考えている間に出す、点が動く吹き出し。 */
function aiTypingBubble(): string {
  return `<div class="pe-ai-line is-assistant">` +
    `<span class="pe-ai-avatar" aria-hidden="true">${icon("sparkles")}</span>` +
    `<div class="pe-ai-bubble is-assistant is-typing" role="status" aria-label="AI が考えています">` +
    "<i></i><i></i><i></i>" +
    "</div></div>";
}

function renderAiThread(): void {
  if (aiConsultation.stage === "idle") {
    aiThread.innerHTML = "";
    return;
  }
  const selectedNames = selectedAiCandidates().map((candidate) => candidate.name);
  const messages = [aiBubble("assistant", aiConsultation.options?.message || "候補から行きたい場所を選んでください。")];
  if (["preferences", "building", "done"].includes(aiConsultation.stage)) {
    messages.push(aiBubble("user", `行きたい場所: ${selectedNames.join("、")}`));
    messages.push(aiBubble("assistant", "選択を受け取りました。最後に旅のペースと移動条件を決めてください。"));
  }
  if (["building", "done"].includes(aiConsultation.stage)) {
    const preferences = aiPreferences();
    const condition = [
      `ペースは${preferences.pace}`,
      `徒歩は${preferences.walking}`,
      `移動は${preferences.transport}`,
      preferences.interests.length ? `興味は${preferences.interests.join("・")}` : "",
      preferences.extra || "",
    ].filter(Boolean).join("、");
    messages.push(aiBubble("user", condition));
    messages.push(aiBubble("assistant", aiConsultation.stage === "done"
      ? "行程を作成しました。相談はここで完了です。"
      : "条件を反映して、都市間移動を含む行程を組み立てています。"));
  }
  if (aiConsultation.stage === "building") messages.push(aiTypingBubble());
  aiThread.innerHTML = messages.join("");
  // 会話が伸びたら最後の発言が見えるようにする
  aiThread.scrollTop = aiThread.scrollHeight;
}

function setAiStage(stage: AiStage): void {
  aiConsultation.stage = stage;
  aiIntro.hidden = stage !== "idle";
  aiDialog.hidden = stage === "idle";
  aiCandidatesStage.hidden = stage !== "candidates";
  aiPreferencesStage.hidden = stage !== "preferences";
  aiDoneStage.hidden = stage !== "done";
  const index = stage === "idle" || stage === "candidates" ? 0 : stage === "preferences" ? 1 : 2;
  root.querySelectorAll<HTMLElement>("[data-ai-flow]").forEach((item, itemIndex) => {
    item.classList.toggle("is-current", itemIndex === index);
    item.classList.toggle("is-done", itemIndex < index || stage === "done");
  });
  renderAiThread();
}

function updateAiSelection(): void {
  const count = aiConsultation.selectedIds.size;
  const groups = aiCandidateGroups();
  const missing = unselectedAiCities();
  aiSelection.textContent = missing.length
    ? `各都市から1件以上選んでください。未選択: ${missing.join("、")}`
    : `${groups.length}都市から合計${count}件選択中。次にペースや移動条件を指定します。`;
  aiSelection.classList.toggle("is-warn", missing.length > 0);
  aiToPreferences.disabled = count === 0 || missing.length > 0;
  for (const group of groups) {
    const selectedCount = group.candidates.filter((candidate) => aiConsultation.selectedIds.has(candidate.id)).length;
    const counter = aiCandidateList.querySelector<HTMLElement>(`[data-ai-city-count="${CSS.escape(group.city)}"]`);
    if (counter) counter.textContent = `${selectedCount}/${group.candidates.length}件選択`;
  }
}

/**
 * 候補の種類ごとの色とアイコン。
 * 一覧が文字だけだと似た箱が並ぶので、種類が目で分かるようにする。
 */
const AI_CATEGORY_LOOK: Record<string, { icon: IconName; tone: string }> = {
  定番: { icon: "star", tone: "classic" },
  文化: { icon: "buildingOffice2", tone: "culture" },
  自然: { icon: "sun", tone: "nature" },
  グルメ: { icon: "cake", tone: "food" },
  体験: { icon: "sparkles", tone: "activity" },
  買い物: { icon: "shoppingBag", tone: "shopping" },
};

function renderAiCandidates(): void {
  aiCandidateList.innerHTML = aiCandidateGroups().map((group) =>
    `<section class="pe-ai-city-group">` +
      `<header><h3>${icon("mapPin")}<span>${escapeHtml(group.city)}</span></h3>` +
      `<span data-ai-city-count="${escapeHtml(group.city)}">0/${group.candidates.length}件選択</span></header>` +
      `<div class="pe-ai-city-options">` + group.candidates.map((candidate) => {
        const look = AI_CATEGORY_LOOK[candidate.category] || { icon: "mapPin" as IconName, tone: "other" };
        return `<label class="pe-ai-candidate" data-tone="${look.tone}">` +
          `<input type="checkbox" data-ai-candidate value="${escapeHtml(candidate.id)}">` +
          `<span class="pe-ai-candidate-check">${icon("check")}</span>` +
          `<span class="pe-ai-candidate-body">` +
          `<span class="pe-ai-candidate-top">` +
          `<b>${escapeHtml(candidate.name)}</b>` +
          `<em class="pe-ai-cat">${icon(look.icon)}<span>${escapeHtml(candidate.category)}</span></em>` +
          "</span>" +
          `<small>${icon("clock")}<span>${escapeHtml(formatDurationMinutes(candidate.duration_minutes))}</span></small>` +
          `<p>${escapeHtml(candidate.reason)}</p></span>` +
          "</label>";
      }).join("") + `</div></section>`
  ).join("");
  updateAiSelection();
}

export function resetAiConsultation(): void {
  if (aiConsultation.stage === "building") return;
  aiConsultation.reset();
  setAiStatus("");
  setAiStage("idle");
}
function aiBaseInput(): db.ItineraryAiBaseInput | null {
  const cities = model.cities
    .filter((city) => city.name.trim())
    .map((city) => ({ name: city.name.trim(), from_date: city.fromDate, to_date: city.toDate }));
  const area = aiArea.value.trim() || cities.map((city) => city.name).join("、") || model.title.trim();
  if (!area) {
    setAiStatus("行き先を入れるか、訪問地を登録してください", "warn");
    aiArea.focus();
    return null;
  }
  if (!model.startDate || !model.endDate) {
    setAiStatus("先に期間を決めてください", "warn");
    return null;
  }
  return {
    area,
    start_date: model.startDate,
    end_date: model.endDate,
    note: aiNote.value.trim() || undefined,
    cities,
  };
}

async function startAiConsultation(): Promise<void> {
  if (state.editorLocked || aiConsultation.stage !== "idle") return;
  const input = aiBaseInput();
  if (!input) return;

  setAiBusy(true, "候補を探しています");
  setAiStatus("旅程を作る前に、行きたい場所の候補を絞っています。");
  try {
    aiConsultation.start(await db.suggestItineraryOptions(input));
    renderAiCandidates();
    setAiStage("candidates");
    setAiStatus("候補を選ぶと、次にペースや移動条件を指定できます。", "ok");
  } catch (error) {
    showAiError(error, "candidates");
  } finally {
    setAiBusy(false);
  }
}

async function runAiDraft(): Promise<void> {
  if (state.editorLocked || aiConsultation.stage !== "preferences") return;
  const input = aiBaseInput();
  if (!input) return;
  const selected = selectedAiCandidates();
  const missing = unselectedAiCities();
  if (!selected.length || missing.length) {
    setAiStage("candidates");
    setAiStatus(`各都市から1件以上選んでください。未選択: ${missing.join("、")}`, "warn");
    return;
  }
  const filled = model.days.some((day) => day.items.length || day.stay);
  if (filled && !window.confirm("現在の行程を、AIが作る新しい行程に置き換えます。よろしいですか。")) return;

  setAiStage("building");
  setAiBusy(true);
  setAiStatus("選んだ場所と条件から、都市間移動を含む行程を作っています。");
  try {
    const draft = await db.generateItinerary({
      ...input,
      consultation_token: aiConsultation.options?.consultation_token || "",
      selected_candidate_ids: selected.map((candidate) => candidate.id),
      preferences: aiPreferences(),
    });
    applyItineraryDraft(draft);
    markDirty();
    renderCities();
    renderDays();
    refreshMap(true);
    setAiStatus("行程を作成しました。施設の住所を確認して地図へ登録しています。");
    await registerAiDraftPlacesOnMap();
    renderCities();
    renderDays();
    refreshMap(true);
    // 先行する自動保存があっても、AI適用後のrevisionがDBへ届くまで待つ。
    const saved = await persist(true);
    setAiStage("done");
    // 完了カードだけで十分なので、成功ログは残さない。保存失敗だけは操作が必要なため表示する。
    setAiStatus(saved ? "" : "行程を作成しましたが保存できませんでした。", saved ? undefined : "warn");
  } catch (error) {
    if (error instanceof db.ApiRequestError && error.code === "invalid_ai_input") {
      aiConsultation.reset();
      setAiStage("idle");
    } else {
      setAiStage("preferences");
    }
    showAiError(error, "itinerary");
  } finally {
    setAiBusy(false);
  }
}

async function importExternalAiDraft(): Promise<void> {
  if (state.editorLocked) {
    aiImportStatus.textContent = "この計画を編集する権限がありません。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }
  const raw = aiImportJson.value.trim();
  if (!raw) {
    aiImportStatus.textContent = "ChatGPTから返ってきた答えを貼り付けてください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }
  let imported: ReturnType<typeof parseExternalAiCreateJson>;
  try {
    imported = parseExternalAiCreateJson(raw, {
      startDate: model.startDate,
      endDate: model.endDate,
      title: model.title,
    });
  } catch (error) {
    aiImportStatus.textContent = errorMessage(error) || "旅行案を読み取れませんでした。答えを最初から最後までコピーして、もう一度お試しください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }

  const filled = model.days.some((day) => day.items.length || day.stay);
  if (filled && !window.confirm("現在の行程を、貼り付けた旅行案で置き換えます。よろしいですか。")) return;

  aiImportApply.disabled = true;
  aiImportStatus.textContent = "旅行案を取り込んでいます…";
  aiImportStatus.className = "pe-ai-import-status";
  try {
    if (imported.title) model.title = imported.title;
    model.startDate = imported.startDate;
    model.endDate = imported.endDate;
    rebuildDays();
    applyItineraryDraft(imported.draft);
    markDirty();
    syncBasicInputs();
    renderCities();
    renderDays();
    refreshMap(true);
    aiImportStatus.textContent = "行程に反映しました。住所と座標を確認しています…";
    await registerAiDraftPlacesOnMap();
    renderCities();
    renderDays();
    refreshMap(true);
    const saved = await persist(true);
    aiImportStatus.textContent = saved
      ? "旅行案を取り込み、保存しました。"
      : "旅行案は取り込めましたが、保存できませんでした。";
    aiImportStatus.className = "pe-ai-import-status" + (saved ? " is-ok" : " is-warn");
    setViewStep(3);
  } catch (error) {
    aiImportStatus.textContent = errorMessage(error) || "旅行案を読み取れませんでした。答えを最初から最後までコピーして、もう一度お試しください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
  } finally {
    aiImportApply.disabled = false;
  }
}

export function onAiRunClick(): void { void startAiConsultation(); }

export async function onAiImportOpenClick(): Promise<void> {
  openExternalAi("chatgpt");
  const copied = await copyExternalAiPrompt(externalAiCreatePrompt());
  aiImportStatus.textContent = copied
    ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
    : "表示された質問文をすべてコピーし、ChatGPTへ貼り付けてください。";
  aiImportStatus.className = "pe-ai-import-status" + (copied ? " is-ok" : " is-warn");
}

export function onAiImportApplyClick(): void { void importExternalAiDraft(); }

export function onAiAreaKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return;
  if (e.key === "Enter") { e.preventDefault(); void startAiConsultation(); }
}

export function onAiCandidateChange(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-ai-candidate]")) return;
  if (input.checked) {
    aiConsultation.select(input.value, true);
    setAiStatus("");
  } else {
    aiConsultation.select(input.value, false);
  }
  updateAiSelection();
}

export function onAiToPreferencesClick(): void {
  const missing = unselectedAiCities();
  if (!aiConsultation.selectedIds.size || missing.length) {
    setAiStatus(`各都市から1件以上選んでください。未選択: ${missing.join("、")}`, "warn");
    return;
  }
  setAiStatus("");
  setAiStage("preferences");
}

export function onAiBackToCandidatesClick(): void {
  setAiStatus("");
  setAiStage("candidates");
}

export function onAiBuildClick(): void { void runAiDraft(); }
