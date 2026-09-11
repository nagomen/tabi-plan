import * as db from "../shared/db";
import * as TripPlans from "../shared/plans-store";
import type { PlanVisibility } from "../shared/plans-store";
import { errorMessage } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { navigateWithPageTransition } from "../shared/page-transition";
import { canManagePlan } from "../shared/membership";
import { validatePublishPlan } from "./validation";
import { state, model } from "./editor-state";
import { qs, statusEl, savebarNoteEl, rangeTrigger, cityInput, saveBtn, publishBtn, stepNextBtn } from "./editor-dom";
import { stepCompletion, setViewStep } from "./steps";
import { persist } from "./persist";
import { buildData } from "./plan-data";

function setSaveActionsBusy(busy: boolean): void {
  state.saveActionsBusy = busy;
  saveBtn.disabled = busy;
  publishBtn.disabled = busy;
  stepNextBtn.disabled = busy || (state.viewStep < 3 && !stepCompletion()[state.viewStep - 1]);
  saveBtn.innerHTML = busy ? icon("arrowPath") + "<span>保存中…</span>" : icon("bookmark") + "<span>下書きを保存</span>";
}

export async function save(): Promise<void> {
  if (state.editorLocked) {
    statusEl.textContent = "この計画を編集する権限がありません";
    statusEl.className = "is-dirty";
    return;
  }
  setSaveActionsBusy(true);
  try {
    await persist(true);
  } finally {
    setSaveActionsBusy(false);
  }
}

function focusPublishError(field: "title" | "dates" | "cities", step: 1 | 2): void {
  setViewStep(step);
  if (field === "title") qs<HTMLInputElement>('[data-f="title"]').focus();
  else if (field === "dates") rangeTrigger.focus();
  else cityInput.focus();
}

export function publish(): void {
  if (state.editorLocked) return;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (meta && !canManagePlan(meta)) {
    statusEl.textContent = "公開設定を変更できるのは計画の所有者だけです";
    statusEl.className = "is-dirty";
    return;
  }
  const invalid = validatePublishPlan(model);
  if (!TripPlans.isPublished(meta || { published: false }) && invalid) {
    statusEl.textContent = invalid.message;
    statusEl.className = "is-dirty";
    focusPublishError(invalid.field, invalid.step);
    return;
  }
  openVisibilityChooser((visibility) => { void doPublish(visibility); });
}

async function doPublish(visibility: PlanVisibility): Promise<void> {
  if (state.editorLocked) return;
  const invalid = validatePublishPlan(model);
  if (invalid) {
    statusEl.textContent = invalid.message;
    statusEl.className = "is-dirty";
    focusPublishError(invalid.field, invalid.step);
    return;
  }
  setSaveActionsBusy(true);
  if (!(await persist(true))) {
    setSaveActionsBusy(false);
    return;
  }
  const mutationCheckpoint = db.mutationCheckpoint();
  model.visibility = visibility;
  if (!TripPlans.upsert({ slug: state.slug, visibility, published: true })) {
    statusEl.textContent = "ログインしてから保存してください";
    statusEl.className = "is-dirty";
    setSaveActionsBusy(false);
    return;
  }
  TripPlans.setActiveSlug(state.slug);
  try {
    await db.flushMutations(mutationCheckpoint);
  } catch (error) {
    state.dirty = true;
    statusEl.textContent = "保存できませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
    setSaveActionsBusy(false);
    return;
  }
  state.dirty = false;
  const visLabel = visibility === "invite" ? "招待制" : "公開";
  statusEl.textContent = `保存しました（${visLabel}）`;
  statusEl.className = "is-ok";
  savebarNoteEl.textContent = `保存しました（${visLabel}）。右上の「表示」でダッシュボードを確認できます。`;
  try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(state.slug)); } catch { /* ignore */ }
  setSaveActionsBusy(false);
  navigateWithPageTransition("index.html?plan=" + encodeURIComponent(state.slug));
}

async function doUnpublish(): Promise<void> {
  if (!state.slug || state.editorLocked) return;
  setSaveActionsBusy(true);
  const mutationCheckpoint = db.mutationCheckpoint();
  if (!TripPlans.upsert({ slug: state.slug, published: false })) {
    setSaveActionsBusy(false);
    return;
  }
  try {
    await db.flushMutations(mutationCheckpoint);
    if (!(await persist(true))) throw new Error("下書きの内容を保存できませんでした");
    statusEl.textContent = "下書きに戻しました";
    statusEl.className = "is-ok";
    savebarNoteEl.textContent = "この計画は公開一覧に表示されません。";
  } catch (error) {
    statusEl.textContent = "下書きに戻せませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
  } finally {
    setSaveActionsBusy(false);
  }
}

function visOption(value: PlanVisibility, current: PlanVisibility, label: string, desc: string, glyph: IconName): string {
  const id = `pe-vis-${value}`;
  return (
    `<label class="pe-vis-opt" for="${id}">` +
    `<input type="radio" id="${id}" name="pe-vis" value="${value}"${value === current ? " checked" : ""}>` +
    `<span class="pe-vis-ic">${icon(glyph)}</span>` +
    `<span class="pe-vis-main"><b>${label}</b><small>${desc}</small></span>` +
    `</label>`
  );
}

/** 保存時に公開範囲を選ばせるモーダル。確定で onConfirm(選択値) を呼ぶ。 */
function openVisibilityChooser(onConfirm: (v: PlanVisibility) => void): void {
  // 初回は安全側の「限定」を既定にし、公開は利用者が明示的に選ぶ。
  const current: PlanVisibility = model.visibility === "public" ? "public" : "invite";
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const isPublished = Boolean(meta && TripPlans.isPublished(meta));
  const modal = document.createElement("div");
  modal.className = "pe-modal";
  modal.innerHTML =
    `<form class="pe-modal-box">` +
    `<h2>公開範囲を選択</h2>` +
    `<p class="pe-modal-sub">この計画を「みんなの計画」一覧に出すかを選びます。あとから変更できます。</p>` +
    `<div class="pe-vis-options">` +
    visOption("public", current, "公開", "「みんなの計画」一覧に載り、誰でも見られます。", "globeAlt") +
    visOption("invite", current, "限定", "一覧には出さず、招待リンクを渡した人にだけ共有します。", "users") +
    `</div>` +
    `<p class="pe-modal-note">限定は一覧に表示されず、参加者または招待リンクからログインして参加した人だけが閲覧できます。公開では行程・地図などの閲覧用情報が表示され、メンバー・費用・精算は公開されません。</p>` +
    `<div class="pe-modal-actions">` +
    (isPublished ? `<button type="button" class="pe-modal-btn ghost" data-unpublish>下書きに戻す</button>` : "") +
    `<button type="button" class="pe-modal-btn ghost" data-cancel>キャンセル</button>` +
    `<button type="submit" class="pe-modal-btn">この設定で公開</button>` +
    `</div></form>`;
  document.body.appendChild(modal);
  const form = modal.querySelector<HTMLFormElement>("form");
  modal.querySelector("[data-cancel]")?.addEventListener("click", () => modal.remove());
  modal.querySelector("[data-unpublish]")?.addEventListener("click", () => {
    modal.remove();
    void doUnpublish();
  });
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const picked =
      (modal.querySelector<HTMLInputElement>('input[name="pe-vis"]:checked')?.value as PlanVisibility) || current;
    modal.remove();
    onConfirm(picked);
  });
}

// 書き出し（JSON）— ローカル保存のバックアップ
export function exportJson(): void {
  const blob = new Blob([JSON.stringify(buildData(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (model.title || "trip").replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
