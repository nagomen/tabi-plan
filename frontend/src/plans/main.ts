// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除と、ローカルプランの
// Google Sheets への公開（JSONP 認証 + iframe-POST createTrip）を行う。

import * as TripPlans from "../shared/plans-store";
import "../shared/ui.css";
import type { PlanMeta, LocalPlanData, PlanSource } from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage, makeScopedQuery } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import { icon } from "../shared/icons";
import {
  callAppsScript,
  postAppsScript,
  sha256Hex,
  isAuthError,
  type AppsScriptResponse,
} from "../shared/apps-script";

// ---- 補助型 -------------------------------------------------------------

/** ローカルストレージに保存する公開用認証セッション */
interface PublishAuthSession {
  token?: string;
  expiresAt?: number;
}

/** askPassword が解決する値 */
interface PasswordPrompt {
  value: string;
  modal: HTMLDivElement;
  error: HTMLElement;
  input: HTMLInputElement;
}

interface AppState {
  filter: string;
}

// ---- DOM 取得ヘルパー ----------------------------------------------------

const { qs } = makeScopedQuery(document);

const grid = qs<HTMLElement>("[data-grid]");
const countEl = qs<HTMLElement>("[data-count]");
const filterEl = qs<HTMLInputElement>("[data-filter]");
const state: AppState = { filter: "" };

const SOURCE_LABEL: Record<string, string> = {
  local: "ローカル",
  googleSheets: "Sheets連携",
  appsScript: "公開",
  sample: "サンプル",
};

function sourceClass(source: PlanSource | string): string {
  return ["local", "googleSheets", "appsScript", "sample"].indexOf(source) >= 0 ? source : "sample";
}

function planText(meta: PlanMeta): string {
  return [meta.title, meta.route, meta.dates, meta.members].join(" ").toLowerCase();
}

function render(): void {
  TripPlans.ensureSeed(readGlobalTripConfig());
  const all = TripPlans.list();
  const activeSlug = TripPlans.getActiveSlug();
  const filter = state.filter.trim().toLowerCase();
  const visible = all.filter((meta) => !filter || planText(meta).indexOf(filter) >= 0);

  countEl.textContent = all.length ? "計画 " + all.length + "件" : "計画はまだありません";

  if (!visible.length) {
    grid.innerHTML =
      '<div class="hub-empty">' +
      (all.length
        ? "<b>該当する計画がありません</b><span>検索条件を変えてください</span>"
        : '<b>最初の計画を作りましょう</b><span>「＋ 新規計画」から行程を作成できます</span>') +
      "</div>";
    return;
  }

  grid.innerHTML = visible
    .map((meta) => {
      const src = sourceClass(meta.source);
      const isLocal = meta.source === "local";
      const isActive = meta.slug === activeSlug;
      const metaLine = [meta.dates, meta.members].filter(Boolean).map(escapeHtml).join(" · ");
      const menuItems =
        (isLocal || meta.source === "appsScript"
          ? '<button class="plan-menu-item" type="button" data-edit>' + icon("pencilSquare") + "<span>編集</span></button>"
          : "") +
        (isLocal
          ? '<button class="plan-menu-item" type="button" data-publish>' + icon("globeAlt") + "<span>公開</span></button>"
          : "") +
        '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>複製</span></button>" +
        (meta.builtIn
          ? ""
          : '<button class="plan-menu-item danger" type="button" data-del>' + icon("trash") + "<span>削除</span></button>");
      return (
        "" +
        '<article class="plan-row' +
        (isActive ? " is-active" : "") +
        '" data-slug="' +
        escapeHtml(meta.slug) +
        '">' +
        '<a class="plan-open" href="index.html?plan=' +
        encodeURIComponent(meta.slug) +
        '" data-open>' +
        '<span class="plan-dot ' +
        src +
        '" title="' +
        escapeHtml(SOURCE_LABEL[src] || src) +
        '" aria-label="' +
        escapeHtml(SOURCE_LABEL[src] || src) +
        '"></span>' +
        '<span class="plan-body">' +
        '<span class="plan-name">' +
        escapeHtml(meta.title || "無題の旅行") +
        (isActive ? '<span class="plan-tag">表示中</span>' : "") +
        "</span>" +
        (metaLine ? '<span class="plan-meta">' + metaLine + "</span>" : "") +
        (meta.route ? '<span class="plan-route">' + escapeHtml(meta.route) + "</span>" : "") +
        "</span>" +
        "</a>" +
        '<div class="plan-tools">' +
        '<button class="plan-menu-btn" type="button" data-menu aria-haspopup="true" aria-expanded="false" aria-label="その他の操作">' +
        icon("ellipsisHorizontal") +
        "</button>" +
        '<div class="plan-menu" data-menu-panel hidden>' +
        menuItems +
        "</div>" +
        "</div>" +
        "</article>"
      );
    })
    .join("");
}

function closeMenus(except?: Element | null): void {
  grid.querySelectorAll<HTMLElement>("[data-menu-panel]").forEach((panel) => {
    if (panel === except) return;
    panel.hidden = true;
    const btn = panel.parentElement?.querySelector<HTMLButtonElement>("[data-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".plan-tools")) return;
  closeMenus();
});

grid.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";

  const menuButton = target.closest<HTMLButtonElement>("[data-menu]");
  if (menuButton) {
    event.preventDefault();
    const panel = card.querySelector<HTMLElement>("[data-menu-panel]");
    if (!panel) return;
    const willOpen = panel.hidden;
    closeMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
  }
  closeMenus();
  if (target.closest("[data-edit]")) {
    event.preventDefault();
    TripPlans.setActiveSlug(slug);
    const meta = TripPlans.get(slug);
    const path = meta && meta.source === "local" ? "plan-editor.html?plan=" : "itinerary-editor.html?plan=";
    location.href = path + encodeURIComponent(slug);
    return;
  }
  if (target.closest("[data-dup]")) {
    event.preventDefault();
    TripPlans.duplicate(slug);
    render();
    return;
  }
  if (target.closest("[data-del]")) {
    event.preventDefault();
    const meta = TripPlans.get(slug);
    const name = meta && meta.title ? meta.title : "この計画";
    if (window.confirm("「" + name + "」を削除しますか？この操作は元に戻せません。")) {
      TripPlans.remove(slug);
      render();
    }
    return;
  }
  const publishButton = target.closest<HTMLButtonElement>("[data-publish]");
  if (publishButton) {
    event.preventDefault();
    void publishPlan(slug, publishButton);
    return;
  }
});

// ---- 公開（Google Sheets へ書き出し） ----
const AUTH_KEY = "trip-dashboard-publish-auth";

function appsScriptUrlFor(meta: PlanMeta | null): string {
  const config = readGlobalTripConfig();
  return (meta && meta.appsScriptUrl) || config.appsScriptUrl || "";
}

function getPublishToken(): string {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_KEY) || "{}") as PublishAuthSession;
    return s && s.expiresAt && Date.now() < s.expiresAt ? s.token || "" : "";
  } catch {
    return "";
  }
}

function savePublishToken(token: string | undefined, expiresAt: number | undefined): void {
  try {
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        token: token || "",
        expiresAt: expiresAt || Date.now() + 14 * 24 * 60 * 60 * 1000,
      }),
    );
  } catch {
    /* ignore */
  }
}

function askPassword(): Promise<PasswordPrompt> {
  return new Promise((resolve, reject) => {
    const modal: HTMLDivElement = document.createElement("div");
    modal.className = "pub-modal";
    modal.innerHTML =
      '<form class="pub-box">' +
      "<h2>公開用パスワード</h2>" +
      '<div class="pub-body">' +
      "<p>Apps Script に設定した共有パスワードを入力してください。</p>" +
      '<input type="password" autocomplete="current-password" aria-label="パスワード">' +
      '<div class="pub-error" aria-live="polite"></div>' +
      '<div class="pub-actions">' +
      '<button type="submit">認証して公開</button>' +
      '<button type="button" class="secondary" data-cancel>キャンセル</button>' +
      "</div>" +
      "</div>" +
      "</form>";
    document.body.appendChild(modal);
    const input = modal.querySelector<HTMLInputElement>("input");
    const errorEl = modal.querySelector<HTMLElement>(".pub-error");
    const formEl = modal.querySelector<HTMLFormElement>("form");
    const cancelEl = modal.querySelector<HTMLButtonElement>("[data-cancel]");
    if (!input || !errorEl || !formEl || !cancelEl) {
      modal.remove();
      reject(new Error("パスワード入力欄を初期化できませんでした"));
      return;
    }
    input.focus();
    cancelEl.addEventListener("click", () => {
      modal.remove();
      reject(new Error("cancelled"));
    });
    formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      resolve({ value: input.value || "", modal, error: errorEl, input });
    });
  });
}

function showToast(message: string, isError?: boolean): void {
  const toast = document.createElement("div");
  toast.className = "pub-toast" + (isError ? " is-error" : "");
  const glyph = isError ? icon("exclamationTriangle") : icon("checkCircle");
  const text = document.createElement("span");
  text.textContent = message;
  toast.innerHTML = glyph;
  toast.appendChild(text);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 6000);
}

async function authenticate(url: string): Promise<string> {
  // 既存トークンがあれば先に使う
  const existing = getPublishToken();
  if (existing) return existing;
  for (;;) {
    const prompt = await askPassword();
    try {
      const passwordHash = await sha256Hex(prompt.value);
      const res = await callAppsScript(url, { action: "auth", passwordHash });
      savePublishToken(res.token, res.expiresAt);
      prompt.modal.remove();
      return res.token || "";
    } catch (err) {
      prompt.input.value = "";
      prompt.input.focus();
      prompt.error.textContent = errorMessage(err) || "認証に失敗しました";
    }
  }
}

async function publishPlan(slug: string, button: HTMLButtonElement | null): Promise<void> {
  const meta = TripPlans.get(slug);
  if (!meta) return;
  const url = appsScriptUrlFor(meta);
  if (!url) {
    showToast(
      "公開には Apps Script の Web App URL が必要です。docs/trip-config.js の appsScriptUrl を設定し、最新コードでデプロイしてください。",
      true,
    );
    return;
  }
  const data = TripPlans.getData(slug);
  if (!data) {
    showToast("計画データが見つかりませんでした。", true);
    return;
  }
  if (!window.confirm("「" + (meta.title || "この計画") + "」を新しい Google スプレッドシートへ公開します。よろしいですか？"))
    return;

  const planJson = buildPlanJson(data);
  if (button) {
    button.disabled = true;
    button.textContent = "公開中…";
  }

  try {
    const publishOptions = {
      source: "trip-plan-publish",
      idPrefix: "plan",
      timeoutMs: 90000,
      timeoutMessage: "公開がタイムアウトしました",
      failMessage: "公開に失敗しました",
    } as const;
    let token = getPublishToken();
    let res: AppsScriptResponse;
    try {
      res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" }, publishOptions);
    } catch (err) {
      if (isAuthError(err)) {
        try {
          localStorage.removeItem(AUTH_KEY);
        } catch {
          /* ignore */
        }
        token = await authenticate(url);
        res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" }, publishOptions);
      } else {
        throw err;
      }
    }
    TripPlans.upsert({
      slug,
      source: "googleSheets",
      spreadsheetId: res.spreadsheetId,
      appsScriptUrl: url,
      published: true,
      builtIn: false,
    });
    render();
    showToast(
      "公開しました。共有用スプレッドシートに行程を書き出しました。" +
        (res.shared === false ? "（共有設定は手動で確認してください）" : ""),
    );
  } catch (err) {
    if (errorMessage(err) !== "cancelled") {
      showToast("公開に失敗しました: " + errorMessage(err), true);
    }
    render();
  }
}

function buildPlanJson(data: LocalPlanData): string {
  return JSON.stringify({
    trip: data.trip,
    itinerary: data.itinerary,
    checklist: data.checklist || [],
  });
}

filterEl.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  state.filter = (target && target.value) || "";
  render();
});

registerServiceWorker();

render();
