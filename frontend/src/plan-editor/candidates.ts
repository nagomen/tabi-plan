import type { Candidate } from "../shared/types";
import { escapeHtml } from "../shared/dom";
import { parseISO } from "../shared/date";
import { icon } from "../shared/icons";
import { getUser } from "../shared/user-store";
import { currentAccount } from "../shared/account-store";
import { state, model, newItem, normalizeKind, cityForDate } from "./editor-state";
import { candMount, candInput, candCountEl, toast, isComposingKey } from "./editor-dom";
import { markDirty } from "./persist";
import { renderDays } from "./days-render";
import { refreshMap } from "./map";

function candId(): string {
  return "cand_" + state.seq++ + "_" + Math.random().toString(36).slice(2, 6);
}

/** 票数の多い順（同数は作成順）に並べる。 */
function sortedCandidates(): Candidate[] {
  return model.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.voteIds?.length ?? b.c.votes?.length ?? 0) - (a.c.voteIds?.length ?? a.c.votes?.length ?? 0) || a.i - b.i)
    .map((x) => x.c);
}

function candidateDayOptions(): string {
  return model.days
    .map((day, index) => {
      const dt = parseISO(day.date);
      const date = dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : day.date;
      const city = cityForDate(day.date);
      const area = city?.name || day.area || "";
      const label = [`Day ${index + 1}`, date, area].filter(Boolean).join(" / ");
      return `<option value="${index}">${escapeHtml(label)}</option>`;
    })
    .join("");
}

export function renderCandidates(): void {
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  const list = sortedCandidates();
  candCountEl.textContent = list.length ? `${list.length}件` : "";
  if (!list.length) {
    candMount.innerHTML = "";
    return;
  }
  const canAdopt = model.days.length > 0;
  candMount.innerHTML = list
    .map((c) => {
      const voted = meId ? Boolean(c.voteIds?.includes(meId)) : Boolean(me) && (c.votes || []).includes(me);
      const n = c.voteIds?.length ?? (c.votes || []).length;
      const sub = [c.place, c.proposer ? `提案: ${c.proposer}` : ""].filter(Boolean).join(" ・ ");
      const adoptControls = canAdopt
        ? `<label class="pe-cand-day"><span>追加先</span><select data-cand-day="${escapeHtml(c.id)}">${candidateDayOptions()}</select></label>` +
          `<button class="pe-cand-act" type="button" data-cand-adopt="${escapeHtml(c.id)}">${icon("plus")}行程に追加</button>`
        : `<button class="pe-cand-act" type="button" data-cand-adopt="${escapeHtml(c.id)}" disabled title="先に日程を作ってください">${icon("plus")}行程に追加</button>`;
      return (
        `<div class="pe-cand-row${c.adopted ? " is-adopted" : ""}" data-cand="${escapeHtml(c.id)}">` +
        `<button class="pe-cand-vote${voted ? " is-voted" : ""}" type="button" data-cand-vote="${escapeHtml(c.id)}" aria-pressed="${voted}" title="行きたい">${icon("star")}<span>${n}</span></button>` +
        `<span class="pe-cand-body"><span class="pe-cand-title">${escapeHtml(c.title)}</span>${sub ? `<span class="pe-cand-sub">${escapeHtml(sub)}</span>` : ""}</span>` +
        (c.adopted
          ? `<span class="pe-cand-sub">追加済み</span>`
          : adoptControls) +
        `<button class="pe-cand-del" type="button" data-cand-del="${escapeHtml(c.id)}" aria-label="削除">${icon("xMark")}</button>` +
        `</div>`
      );
    })
    .join("");
}

function addCandidate(title: string): void {
  const t = title.trim();
  if (!t) return;
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  model.candidates.push({
    id: candId(),
    title: t,
    votes: me ? [me] : [],
    voteIds: meId ? [meId] : [],
    proposer: me || undefined,
    proposerId: meId || undefined,
    createdAt: new Date().toISOString(),
  });
  markDirty();
  renderCandidates();
}

function toggleVote(id: string): void {
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  if (!meId) {
    toast("投票するにはログインしてください");
    return;
  }
  const c = model.candidates.find((x) => x.id === id);
  if (!c) return;
  c.voteIds = c.voteIds || [];
  const idIndex = c.voteIds.indexOf(meId);
  if (idIndex >= 0) c.voteIds.splice(idIndex, 1);
  else c.voteIds.push(meId);
  // 表示用の名前配列も更新するが、保存には使用しない。
  c.votes = c.votes || [];
  const i = c.votes.indexOf(me);
  if (i >= 0) c.votes.splice(i, 1);
  else c.votes.push(me);
  markDirty();
  renderCandidates();
}

function adoptCandidate(id: string, dayIndex = 0): void {
  const c = model.candidates.find((x) => x.id === id);
  if (!c) return;
  if (!model.days.length) {
    toast("先に日程（期間）を作ってください");
    return;
  }
  const targetIndex = Math.max(0, Math.min(model.days.length - 1, dayIndex));
  const kind = normalizeKind(c.type);
  const it = newItem(kind, {
    title: c.title,
    place: c.place || "",
    note: c.note || "",
    lat: c.lat != null ? String(c.lat) : "",
    lng: c.lng != null ? String(c.lng) : "",
    mapQuery: c.place || c.title || "",
  });
  model.days[targetIndex].items.push(it);
  c.adopted = true;
  markDirty();
  renderCandidates();
  renderDays();
  refreshMap(false);
  toast(`Day ${targetIndex + 1} に追加しました。ドラッグで日や順番を調整できます`);
}

function removeCandidate(id: string): void {
  model.candidates = model.candidates.filter((x) => x.id !== id);
  markDirty();
  renderCandidates();
}

export function onCandidatesClick(event: Event): void {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const vote = t.closest<HTMLElement>("[data-cand-vote]");
  if (vote) {
    toggleVote(vote.dataset.candVote || "");
    return;
  }
  const adopt = t.closest<HTMLElement>("[data-cand-adopt]");
  if (adopt) {
    const row = t.closest<HTMLElement>("[data-cand]");
    const daySelect = row?.querySelector<HTMLSelectElement>("[data-cand-day]");
    adoptCandidate(adopt.dataset.candAdopt || "", Number(daySelect?.value || 0));
    return;
  }
  const del = t.closest<HTMLElement>("[data-cand-del]");
  if (del) {
    removeCandidate(del.dataset.candDel || "");
  }
}

export function commitCandInput(): void {
  const v = candInput.value.trim();
  if (!v) return;
  addCandidate(v);
  candInput.value = "";
  candInput.focus();
}

export function onCandInputKeydown(e: KeyboardEvent): void {
  if (isComposingKey(e)) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitCandInput();
  }
}
