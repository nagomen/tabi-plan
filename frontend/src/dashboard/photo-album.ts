import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { CONFIG, hooks, linkByKey, state } from "./state";
import { qs, root, setText } from "./dom";
import { canUseWorkspaceView, isEditableLocalPlan } from "./plan-access";

function normalizePhotoUrl(value: string): string {
  const url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) throw new Error("https:// から始まる共有リンクを入力してください。");
  try {
    return new URL(url).href;
  } catch {
    throw new Error("URLの形式を確認してください。");
  }
}

function upsertPhotoAlbumLink(url: string): void {
  const existing = state.data.links || [];
  const withoutPhotos = existing.filter((link) => link.key !== "photos");
  state.data.links = [
    ...withoutPhotos,
    { key: "photos", label: "写真", icon: "写", url, caption: "Google Photos" },
  ];
  const saved = TripPlans.saveData(CONFIG.tripSlug, state.data as TripPlans.LocalPlanData);
  if (!saved) throw new Error("写真アルバムリンクを保存できませんでした。");
}

export function renderPhotoAlbum(): void {
  const photo = linkByKey("photos");
  const url = photo.url || "";
  const workspaceView = canUseWorkspaceView();
  const card = root.querySelector<HTMLElement>("[data-photo-card]");
  if (card) card.hidden = !workspaceView && !url;
  const link = qs<HTMLAnchorElement>("[data-photo-link]");
  const button = qs<HTMLAnchorElement>("[data-photo-button]");
  const editButton = root.querySelector<HTMLButtonElement>("[data-photo-link-edit]");
  const input = root.querySelector<HTMLInputElement>("[data-photo-url]");

  link.href = url || "#";
  button.href = url || "#";
  link.classList.toggle("is-empty", !url);
  button.classList.toggle("is-disabled", !url);
  button.setAttribute("aria-disabled", String(!url));
  if (input) input.value = url;
  if (editButton) {
    editButton.hidden = !workspaceView || !isEditableLocalPlan();
    editButton.innerHTML = `${icon(url ? "pencilSquare" : "plus")}<span>${url ? "リンク変更" : "リンク設定"}</span>`;
  }

  const settlement = state.data.settlement || {};
  setText("[data-photo-title]", settlement.photoTitle || "写真アルバム");
  setText("[data-photo-meta]", url ? (settlement.photoMeta || "Google Photos") : "共有アルバムリンク未設定");
}

export function setupPhotoAlbumEditor(): void {
  const form = root.querySelector<HTMLFormElement>("[data-photo-link-form]");
  const editButton = root.querySelector<HTMLButtonElement>("[data-photo-link-edit]");
  const cancelButton = root.querySelector<HTMLButtonElement>("[data-photo-link-cancel]");
  const input = root.querySelector<HTMLInputElement>("[data-photo-url]");
  const status = root.querySelector<HTMLElement>("[data-photo-link-status]");
  const openLinks = [
    root.querySelector<HTMLAnchorElement>("[data-photo-link]"),
    root.querySelector<HTMLAnchorElement>("[data-photo-button]"),
  ].filter((el): el is HTMLAnchorElement => Boolean(el));
  if (!form || !editButton || !input) return;

  const setStatus = (message: string, kind: "ok" | "error" | "" = ""): void => {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-error", kind === "error");
  };
  const setOpen = (open: boolean): void => {
    form.hidden = !open;
    if (open) {
      setStatus("");
      input.value = linkByKey("photos").url || "";
      setTimeout(() => input.focus(), 30);
    }
  };

  openLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      if (linkByKey("photos").url) return;
      event.preventDefault();
      if (isEditableLocalPlan()) setOpen(true);
    });
  });
  editButton.addEventListener("click", () => setOpen(form.hidden));
  cancelButton?.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isEditableLocalPlan()) return;
    try {
      const url = normalizePhotoUrl(input.value);
      if (!url) throw new Error("共有アルバムURLを入力してください。");
      upsertPhotoAlbumLink(url);
      setOpen(false);
      hooks.renderBase();
      hooks.renderActive();
      setStatus("写真アルバムリンクを保存しました。", "ok");
    } catch (error) {
      setStatus((error as Error).message || "保存に失敗しました。", "error");
    }
  });
}
