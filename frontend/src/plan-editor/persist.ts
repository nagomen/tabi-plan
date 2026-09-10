import * as db from "../shared/db";
import * as TripPlans from "../shared/plans-store";
import { errorMessage } from "../shared/dom";
import { state, model, hasContent, worthSaving, UNTITLED, nowHM, datesString } from "./editor-state";
import { statusEl, savebarNoteEl } from "./editor-dom";
import { buildData, contentFingerprint } from "./plan-data";
import { updateSteps } from "./steps";

let lastSavedContentFingerprint = "";
let persistRunning: Promise<boolean> | null = null;
let persistRequested = false;
let persistTimer = 0;

interface PersistHooks {
  persistPendingMembers: () => Promise<void>;
}

let hooks: PersistHooks = {
  persistPendingMembers: async () => undefined,
};

export function setPersistHooks(next: PersistHooks): void {
  hooks = next;
}

export function setLastSavedContentFingerprint(value: string): void {
  lastSavedContentFingerprint = value;
}

export function markDirty(): void {
  if (state.editorLocked) return;
  state.dirty = true;
  state.editRevision += 1;
  statusEl.textContent = model.title.trim() || hasContent()
    ? "編集中…"
    : "旅行名か行程を入れると自動保存されます";
  statusEl.className = "is-dirty";
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => { void persist(); }, 900);
  updateSteps();
}

/**
 * 1回分の保存処理。旅行名・メモなどメタ情報だけの変更では本文を全置換しない。
 * 行程等が変わった時だけ content API を使う。
 */
// 別の端末が先に保存していた（409）ときは、こちらの自動保存で相手の変更を
// 上書きしないよう、読み込み直すまで保存を止める。
let versionConflictHalt = false;

function haltOnVersionConflict(error: db.ApiRequestError): void {
  versionConflictHalt = true;
  state.dirty = true;
  statusEl.textContent = "保存を一時停止しました";
  statusEl.className = "is-dirty";
  savebarNoteEl.textContent = "計画が別の端末で更新されています。相手の変更を上書きしないよう保存を止めました。";
  const link = document.createElement("a");
  link.href = location.href;
  link.textContent = "読み込み直す";
  savebarNoteEl.append(" ", link);
  console.warn("[plan-editor] version conflict", error.message);
}

async function performPersist(explicit = false, slugRetry = 0): Promise<boolean> {
  if (state.editorLocked) return false;
  if (versionConflictHalt) {
    if (explicit) {
      statusEl.textContent = "別の端末の更新があるため保存できません。読み込み直してください";
      statusEl.className = "is-dirty";
    }
    return false;
  }
  if (!worthSaving()) {
    if (explicit) {
      statusEl.textContent = "旅行名または旅行内容を入力してください";
      statusEl.className = "is-dirty";
    }
    return false;
  }
  const revision = state.editRevision;
  const mutationCheckpoint = db.mutationCheckpoint();
  if (!state.slug) {
    state.slug = TripPlans.uniqueSlug(model.title.trim() || UNTITLED);
    model.slug = state.slug;
    try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(state.slug)); } catch { /* ignore */ }
  }
  const data = buildData();
  const nextContentFingerprint = contentFingerprint(data);
  const contentChanged = nextContentFingerprint !== lastSavedContentFingerprint;
  const existing = TripPlans.get(state.slug);
  const saved = contentChanged
    ? TripPlans.saveLocalPlan(state.slug, data, model.memberIds)
    : TripPlans.upsert({
      slug: state.slug,
      title: model.title.trim() || UNTITLED,
      dates: datesString(),
      members: model.members,
      memberIds: model.memberIds,
      note: model.note,
      cover: model.cover,
      ...(!existing ? { source: "local" as const, published: false } : {}),
    });
  if (!saved) {
    state.dirty = true;
    statusEl.textContent = "ログインしてから保存してください";
    statusEl.className = "is-dirty";
    return false;
  }
  TripPlans.setActiveSlug(state.slug);
  try {
    await db.flushMutations(mutationCheckpoint);
    await hooks.persistPendingMembers();
    if (contentChanged) lastSavedContentFingerprint = nextContentFingerprint;
    if (revision !== state.editRevision) return true;
    state.dirty = false;
    statusEl.textContent = explicit
      ? `下書きを保存しました ${nowHM()}`
      : model.title.trim()
        ? `自動保存しました ${nowHM()}`
      : `下書きを保存しました ${nowHM()}（旅行名は未入力）`;
    statusEl.className = "is-ok";
    savebarNoteEl.textContent = "";
    return true;
  } catch (error) {
    // bootstrapには他人の非公開slugが含まれない。旧方式で採番済みのタブや
    // 極めて稀な乱数衝突は、入力内容を保ったまま別slugで作り直す。
    if (slugRetry < 2 && error instanceof db.ApiRequestError && error.code === "ER_DUP_ENTRY" && !TripPlans.get(state.slug)) {
      state.slug = TripPlans.uniqueSlug(model.title.trim() || UNTITLED);
      model.slug = state.slug;
      try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(state.slug)); } catch { /* ignore */ }
      return performPersist(explicit, slugRetry + 1);
    }
    if (error instanceof db.ApiRequestError &&
        (error.code === "plan_version_conflict" || (error.status === 409 && /別の端末で更新/.test(error.message)))) {
      haltOnVersionConflict(error);
      return false;
    }
    state.dirty = true;
    statusEl.textContent = "保存できませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
    return false;
  }
}

// 自動保存。連続入力中の保存要求は同時実行せず、最新状態を最後にもう一度保存する。
export async function persist(explicit = false): Promise<boolean> {
  window.clearTimeout(persistTimer);
  if (persistRunning) {
    persistRequested = true;
    const result = await persistRunning;
    if (explicit && state.dirty) return persist(true);
    return result;
  }
  persistRunning = performPersist(explicit);
  const result = await persistRunning.finally(() => { persistRunning = null; });
  if (persistRequested) {
    persistRequested = false;
    void persist();
  }
  return result;
}
