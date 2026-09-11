import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import { escapeHtml, errorMessage } from "../shared/dom";
import { normalizeDate } from "./api-data-source";
import { mdLabel } from "../shared/date";
import { formatDurationMinutes, parseDurationMinutes } from "../shared/travel-duration";
import { buildExternalAiRefinePrompt, copyExternalAiPrompt, openExternalAi, parseExternalAiRefineJson } from "../shared/external-ai";
import type { ItineraryItem } from "../shared/types";
import { CONFIG, hooks, state } from "./state";
import { root } from "./dom";
import { planId } from "./plan-access";
import { tripDateRange } from "./days";

interface AiChatEntry {
  role: "user" | "assistant";
  text: string;
  proposal?: db.ItineraryRefineResult;
  externalPrompt?: string;
  applied?: boolean;
}

const aiChatEntries: AiChatEntry[] = [];
let aiChatBusy = false;

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

export function updateAiChatContext(): void {
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

export function setupAiChat(aiSupport: HTMLButtonElement): void {
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
