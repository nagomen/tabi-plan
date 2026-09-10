import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { planCoverImage } from "../shared/cover";
import { escapeHtml, makeScopedQuery } from "../shared/dom";
import { mountAppHeader } from "../shared/app-header";
import { CONFIG } from "./state";

// ---- DOM ヘルパー -------------------------------------------------------

const rootElement = document.getElementById("tripLive");
if (!rootElement) {
  throw new Error("tripLive 要素が見つかりません");
}
export const root: HTMLElement = rootElement;

// 計画のカバー画像（サムネ）をヘッダー背景のヒーローに使う。
export const coverMeta = TripPlans.get(CONFIG.tripSlug) ?? {
  slug: CONFIG.tripSlug,
  route: "",
  title: CONFIG.tripTitle,
};

export const appHeaderEl = mountAppHeader({
  mount: "#tripLive [data-app-header]",
  hero: planCoverImage(coverMeta),
  kicker: "Shared Travel Dashboard",
  title: "Tabi Plan",
  titleAttr: "data-title",
  back: { href: "plans.html", label: "計画一覧へ戻る" },
  actions: [
    {
      kind: "link",
      display: "icon",
      icon: "pencilSquare",
      label: "計画を編集",
      href: "#",
      attr: "data-edit-head",
      hidden: true,
    },
    // 人の公開計画を見ているときだけ出す。自分用の下書きに持ち帰る導線。
    {
      kind: "button",
      display: "icon",
      icon: "documentDuplicate",
      label: "コピーして自分用に作る",
      attr: "data-copy-head",
      hidden: true,
    },
    { kind: "button", display: "icon", icon: "user", label: "マイページ", attr: "data-mypage" },
  ],
});

/** root にスコープした型付き qs/qsa（shared/dom 由来） */
export const { qs, qsa } = makeScopedQuery(root);

export function setText(selector: string, value: string | undefined): void {
  qs(selector).textContent = value || "";
}

export function setHtml(selector: string, value: string | undefined): void {
  qs(selector).innerHTML = value || "";
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setLoading(isLoading: boolean, label?: string): void {
  root.classList.toggle("is-loading", Boolean(isLoading));
  const loading = root.querySelector("[data-loading]");
  const loadingLabel = root.querySelector("[data-loading-label]");
  if (loading) loading.setAttribute("aria-busy", String(Boolean(isLoading)));
  if (loadingLabel && label) loadingLabel.textContent = label;
}

/** 費用まわりのセクション見出し。アイコン・文字サイズ・件数の位置をここで統一する。 */
export function subhead(iconName: IconName, title: string, count?: string): string {
  return (
    `<h3 class="tl-subhead"><span class="tl-subhead-ic">${icon(iconName)}</span><b>${escapeHtml(title)}</b>` +
    (count ? `<small>${escapeHtml(count)}</small>` : "") +
    `</h3>`
  );
}

export function flashButton(btn: HTMLButtonElement, msg: string): void {
  const orig = btn.textContent || "";
  btn.textContent = msg;
  btn.disabled = true;
  window.setTimeout(() => {
    btn.textContent = orig;
    btn.disabled = false;
  }, 1800);
}

/** ボタン内のラベル span だけを一時的に書き換える（アイコンを消さずにフィードバック）。 */
export function flashLabel(btn: HTMLButtonElement, labelSel: string, msg: string): void {
  const label = btn.querySelector<HTMLElement>(labelSel);
  if (!label) {
    flashButton(btn, msg);
    return;
  }
  const orig = label.textContent || "";
  label.textContent = msg;
  btn.disabled = true;
  window.setTimeout(() => {
    label.textContent = orig;
    btn.disabled = false;
  }, 1800);
}
