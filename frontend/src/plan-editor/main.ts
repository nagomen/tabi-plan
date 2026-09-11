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
import { escapeHtml, errorMessage } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { registerServiceWorker } from "../shared/pwa";
import { currentAccount } from "../shared/account-store";
import { canEditPlan, canEditPlanMetadata, canManagePlan } from "../shared/membership";
import { formatDurationMinutes } from "../shared/travel-duration";
import { AiConsultationState, type AiStage } from "./ai-consultation-state";
import { aiErrorGuidance, retryWaitLabel, type AiErrorPhase } from "./ai-error-guidance";
import { resolveAiMapGeocodeJobs, type AiMapGeocodeSummary } from "./ai-map-geocoding";
import { buildExternalAiCreatePrompt, copyExternalAiPrompt, openExternalAi, parseExternalAiCreateJson } from "../shared/external-ai";
import {
  automaticGeocodingAvailable,
  type GeoResult,
} from "../shared/geocoding";
import {
  type ItemKind, type Item, type GeoTarget,
  params, isNew, state, model, newItem,
  autoCoords, latLngKeys,
  worthSaving,
} from "./editor-state";
import {
  root, qs, daysEl, statusEl, titleEcho, mapHeaderBtn, savebarNoteEl,
  citiesEl, cityInput, rangeTrigger, dayStripEl,
  aiArea, aiNote, aiRun, aiRunLabel, aiRunIcon, aiBar, aiStatus, aiError, aiErrorTitle, aiErrorMessage,
  aiErrorAction, aiErrorReference, aiIntro, aiDialog, aiThread, aiCandidatesStage, aiPreferencesStage, aiDoneStage,
  aiCandidateList, aiSelection, aiToPreferences, aiBuild, aiWalking, aiTransport, aiExtra, aiImportDetails,
  aiImportOpen, aiImportJson, aiImportApply, aiImportStatus,
  coverInput, coverClearBtn,
  membersMount, memberSelect, memberAddBtn, memberNameInput, memberNameAddBtn, activeInvitesMount,
  candMount, candInput, gcalBtn, icsBtn,
  saveBtn, publishBtn, localNoteEl, exportBtn, mapToggle, mapClose,
  watchComposition, isComposingKey,
} from "./editor-dom";
import { setMapHandlers, ensureMap, refreshMap, setMapCollapsed, bindMapResizeGrip } from "./map";
import { stepCompletion, setViewStep } from "./steps";
import { buildData, contentFingerprint } from "./plan-data";
import { setPersistHooks, setLastSavedContentFingerprint, markDirty, persist } from "./persist";
import { countryFromText } from "./move-transport";
import { MAPBOX_TOKEN, geocodeSearch, geocodeContextForDay, geoQueryForItem, conciseGeoLabel } from "./geo-search";
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

// ---- レンダリング: 都市（ルート） ---------------------------------------


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


type AiPreferences = db.ItineraryAiPreferences;
const aiConsultation = new AiConsultationState();
let aiErrorTimer: number | null = null;
let aiErrorHandler: (() => void | Promise<void>) | null = null;

aiRunIcon.innerHTML = icon("sparkles");

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

aiErrorAction.addEventListener("click", () => {
  if (aiErrorAction.disabled) return;
  const handler = aiErrorHandler;
  clearAiError();
  void handler?.();
});

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

function resetAiConsultation(): void {
  if (aiConsultation.stage === "building") return;
  aiConsultation.reset();
  setAiStatus("");
  setAiStage("idle");
}

function contextualMapQuery(place: string, area: string): string {
  const query = place.trim();
  const city = area.trim();
  if (!query || !city || query.normalize("NFKC").toLowerCase().includes(city.normalize("NFKC").toLowerCase())) {
    return query;
  }
  return `${query}, ${city}`;
}

function aiCoordinate(value: number | null | undefined, minimum: number, maximum: number): string {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= minimum && number <= maximum
    ? String(number)
    : "";
}

/** 生成結果を編集中のモデルへ流し込む。 */
function applyItineraryDraft(draft: db.ItineraryDraft): void {
  model.cities = draft.cities.map((city) => {
    const name = city.name.trim();
    const coords = TripPlans.coordsFor(name);
    const latitude = aiCoordinate(city.latitude, -90, 90);
    const longitude = aiCoordinate(city.longitude, -180, 180);
    return {
      id: state.seq++,
      name,
      lat: latitude || (coords ? String(coords.lat) : ""),
      lng: longitude || (coords ? String(coords.lng) : ""),
      fromDate: city.from_date || "",
      toDate: city.to_date || city.from_date || "",
    };
  });
  const byDate = new Map(draft.days.map((day) => [day.date, day]));
  for (const day of model.days) {
    const source = byDate.get(day.date);
    if (!source) {
      // 置き換えに同意してもらっているので、生成が届かなかった日は空にする。
      // 前の予定が混ざったまま残るほうが分かりにくい。
      day.items = [];
      day.stay = null;
      continue;
    }
    if (source.area) day.area = source.area;
    const kinds: ItemKind[] = ["sight", "food", "move", "stay", "todo", "form"];
    const items = source.items.filter((item) => kinds.includes(item.kind as ItemKind));
    // 宿泊はその日の「錨」として別枠に持つ。予定の列には入れない。
    const stay = items.find((item) => item.kind === "stay");
    day.items = items
      .filter((item) => item.kind !== "stay")
      .map((item) => {
        const created = newItem(item.kind as ItemKind, {
          time: item.time || "",
          title: item.title || "",
          place: item.place || "",
          mapQuery: item.kind === "move"
            ? item.address || ""
            : item.address || contextualMapQuery(item.place || item.title, source.area),
          lat: aiCoordinate(item.latitude, -90, 90),
          lng: aiCoordinate(item.longitude, -180, 180),
          note: item.note || "",
          ...(item.kind === "move" ? {
            ...splitMoveTitle(item.title),
            from: item.from_place || splitMoveTitle(item.title).from || "",
            fromLat: aiCoordinate(item.from_latitude, -90, 90),
            fromLng: aiCoordinate(item.from_longitude, -180, 180),
            to: item.to_place || splitMoveTitle(item.title).to || "",
            toLat: aiCoordinate(item.to_latitude ?? item.latitude, -90, 90),
            toLng: aiCoordinate(item.to_longitude ?? item.longitude, -180, 180),
            transport: item.transport || "",
            duration: formatDurationMinutes(item.duration_minutes),
          } : {}),
        });
        if (created.kind === "move") {
          autoCoords(created, "from");
          autoCoords(created, "to");
        } else {
          autoCoords(created, "place");
        }
        return created;
      });
    day.stay = stay
      ? newItem("stay", {
          title: stay.title || "",
          place: stay.place || "",
          mapQuery: stay.address || contextualMapQuery(stay.place || stay.title, source.area),
          lat: aiCoordinate(stay.latitude, -90, 90),
          lng: aiCoordinate(stay.longitude, -180, 180),
          note: stay.note || "",
          nights: 1,
        })
      : null;
    if (day.stay) autoCoords(day.stay, "place");
  }
}

interface AiMapRegistrationSummary extends AiMapGeocodeSummary {
  available: boolean;
}

/** AIが登録した施設名を住所へ正規化し、地図用座標と完全な住所文字列をモデルへ付与する。 */
async function registerAiDraftPlacesOnMap(): Promise<AiMapRegistrationSummary> {
  const placeItems = model.days.flatMap((day) => [
    ...day.items.map((item) => ({ day, item })),
    ...(day.stay ? [{ day, item: day.stay }] : []),
  ]);
  const targetCount = model.cities.filter((city) => city.name.trim()).length + placeItems.reduce((count, { item }) => {
    if (item.kind === "move") return count + Number(Boolean(item.from.trim())) + Number(Boolean(item.to.trim()));
    return count + Number(["sight", "food", "stay"].includes(item.kind) && Boolean(geoQueryForItem(item, "place")));
  }, 0);
  if (!automaticGeocodingAvailable(MAPBOX_TOKEN)) {
    return { available: false, attempted: targetCount, resolved: 0, unresolved: targetCount };
  }

  const citySummary = await resolveAiMapGeocodeJobs(
    model.cities.map((city) => ({
      query: city.name,
      context: { countryCode: countryFromText(city.name) || undefined, purpose: "city" as const },
      apply: (result: GeoResult) => {
        city.lat = String(result.lat);
        city.lng = String(result.lng);
      },
    })),
    (query, context) => geocodeSearch(query, context, true),
  );

  const jobs = placeItems.flatMap(({ day, item }) => {
    const targets: GeoTarget[] = item.kind === "move" ? ["from", "to"] : ["place"];
    if (item.kind !== "move" && !["sight", "food", "stay"].includes(item.kind)) return [];
    return targets.flatMap((target) => {
      const query = geoQueryForItem(item, target);
      if (!query) return [];
      return [{
        query,
        context: geocodeContextForDay(day, item, target),
        apply: (result: GeoResult) => {
          const [latKey, lngKey] = latLngKeys(target);
          item[latKey] = String(result.lat);
          item[lngKey] = String(result.lng);
          if (target === "place") {
            // providerの完全な住所を、Google Mapsリンクと再保存にも使う。
            item.mapQuery = result.label;
            if (!item.place.trim()) item.place = conciseGeoLabel(result.label);
          }
        },
      }];
    });
  });
  const itemSummary = await resolveAiMapGeocodeJobs(
    jobs,
    (query, context) => geocodeSearch(query, context, true),
  );
  return {
    available: true,
    attempted: citySummary.attempted + itemSummary.attempted,
    resolved: citySummary.resolved + itemSummary.resolved,
    unresolved: citySummary.unresolved + itemSummary.unresolved,
  };
}

/** 「A → B」の移動タイトルから出発地・到着地を拾う。 */
function splitMoveTitle(title: string): Partial<Item> {
  const parts = String(title || "").split(/[→⇒]|->/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? { from: parts[0], to: parts[1] } : {};
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

aiRun.addEventListener("click", () => { void startAiConsultation(); });
aiImportOpen.addEventListener("click", async () => {
  openExternalAi("chatgpt");
  const copied = await copyExternalAiPrompt(externalAiCreatePrompt());
  aiImportStatus.textContent = copied
    ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
    : "表示された質問文をすべてコピーし、ChatGPTへ貼り付けてください。";
  aiImportStatus.className = "pe-ai-import-status" + (copied ? " is-ok" : " is-warn");
});
aiImportApply.addEventListener("click", () => { void importExternalAiDraft(); });
watchComposition(aiArea);
aiArea.addEventListener("keydown", (e) => {
  if (isComposingKey(e)) return;
  if (e.key === "Enter") { e.preventDefault(); void startAiConsultation(); }
});
aiCandidateList.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-ai-candidate]")) return;
  if (input.checked) {
    aiConsultation.select(input.value, true);
    setAiStatus("");
  } else {
    aiConsultation.select(input.value, false);
  }
  updateAiSelection();
});
aiToPreferences.addEventListener("click", () => {
  const missing = unselectedAiCities();
  if (!aiConsultation.selectedIds.size || missing.length) {
    setAiStatus(`各都市から1件以上選んでください。未選択: ${missing.join("、")}`, "warn");
    return;
  }
  setAiStatus("");
  setAiStage("preferences");
});
qs<HTMLButtonElement>("[data-ai-back-candidates]").addEventListener("click", () => {
  setAiStatus("");
  setAiStage("candidates");
});
qs<HTMLButtonElement>("[data-ai-reset]").addEventListener("click", resetAiConsultation);
aiBuild.addEventListener("click", () => { void runAiDraft(); });
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
