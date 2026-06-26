// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除と、ローカルプランの
// Google Sheets への公開（JSONP 認証 + iframe-POST createTrip）を行う。

import * as TripPlans from "../shared/plans-store";
import type { PlanMeta, LocalPlanData, PlanSource } from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";

// ---- 補助型 -------------------------------------------------------------

/** Apps Script JSONP/POST のレスポンス共通形 */
interface AppsScriptResponse {
  ok?: boolean;
  error?: string;
  token?: string;
  expiresAt?: number;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  shared?: boolean;
}

/** callAppsScript / postAppsScript に渡すパラメータ */
type AppsScriptParams = Record<string, string | number | undefined>;

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

/** document 配下から要素を取得し、無ければ throw する型付き qs */
function qs<E extends Element = Element>(selector: string): E {
  const el = document.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

const grid = qs<HTMLElement>("[data-grid]");
const countEl = qs<HTMLElement>("[data-count]");
const filterEl = qs<HTMLInputElement>("[data-filter]");
const state: AppState = { filter: "" };

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown): string {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

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
      return (
        "" +
        '<article class="plan-card' +
        (isActive ? " is-active" : "") +
        '" data-slug="' +
        escapeHtml(meta.slug) +
        '">' +
        '<div class="plan-badges">' +
        '<span class="plan-badge ' +
        src +
        '">' +
        escapeHtml(SOURCE_LABEL[src] || src) +
        "</span>" +
        (isActive ? '<span class="plan-badge current">表示中</span>' : "") +
        "</div>" +
        '<h2 class="plan-name">' +
        escapeHtml(meta.title || "無題の旅行") +
        "</h2>" +
        '<div class="plan-meta">' +
        (meta.dates ? "<span><b>期間</b> " + escapeHtml(meta.dates) + "</span>" : "") +
        (meta.members ? "<span><b>メンバー</b> " + escapeHtml(meta.members) + "</span>" : "") +
        "</div>" +
        (meta.route ? '<div class="plan-route">' + escapeHtml(meta.route) + "</div>" : "") +
        '<div class="plan-actions">' +
        '<a class="plan-btn primary" href="index.html?plan=' +
        encodeURIComponent(meta.slug) +
        '" data-open>開く</a>' +
        (isLocal
          ? '<a class="plan-btn" href="plan-editor.html?plan=' + encodeURIComponent(meta.slug) + '">編集</a>'
          : "") +
        (isLocal ? '<button class="plan-btn" type="button" data-publish>公開</button>' : "") +
        '<button class="plan-btn" type="button" data-dup>複製</button>' +
        (meta.builtIn ? "" : '<button class="plan-btn danger" type="button" data-del>削除</button>') +
        "</div>" +
        "</article>"
      );
    })
    .join("");
}

grid.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
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

function isAuthError(error: unknown): boolean {
  const message = errorMessage(error);
  return /auth|token|password|Authentication|Invalid token|Token expired|認証|権限|Password/i.test(message);
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

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function callAppsScript(url: string, params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    const callback = "__tripPlansCb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const search: Record<string, string> = {};
    Object.entries({ ...params, callback, cachebust: Date.now() }).forEach(([key, value]) => {
      search[key] = value == null ? "" : String(value);
    });
    const query = new URLSearchParams(search);
    const cb = callback as keyof Window & string;
    (window as unknown as Record<string, unknown>)[cb] = (response: AppsScriptResponse | undefined) => {
      delete (window as unknown as Record<string, unknown>)[cb];
      script.remove();
      if (!response || response.ok === false) {
        reject(new Error(response && response.error ? response.error : "Apps Script API error"));
        return;
      }
      resolve(response);
    };
    script.onerror = () => {
      delete (window as unknown as Record<string, unknown>)[cb];
      script.remove();
      reject(new Error("Apps Script API を読み込めませんでした"));
    };
    script.src = url + (url.indexOf("?") >= 0 ? "&" : "?") + query.toString();
    document.head.appendChild(script);
  });
}

function postAppsScript(url: string, params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    const uploadId = "plan-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const iframeName = "tripPlanFrame_" + uploadId.replace(/[^A-Za-z0-9_]/g, "_");
    const iframe: HTMLIFrameElement = document.createElement("iframe");
    const form: HTMLFormElement = document.createElement("form");
    function cleanup(): void {
      window.removeEventListener("message", onMessage);
      form.remove();
      iframe.remove();
    }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("公開がタイムアウトしました"));
    }, 90000);
    function onMessage(event: MessageEvent): void {
      const data = (event.data || {}) as {
        source?: string;
        uploadId?: string;
        response?: {
          ok?: boolean;
          error?: string;
          spreadsheetId?: string;
          spreadsheetUrl?: string;
          shared?: boolean;
        };
      };
      if (data.source !== "trip-plan-publish" || data.uploadId !== uploadId) return;
      clearTimeout(timer);
      cleanup();
      const response = data.response || {};
      if (response.ok === false) {
        reject(new Error(response.error || "公開に失敗しました"));
        return;
      }
      resolve(response);
    }
    iframe.name = iframeName;
    iframe.hidden = true;
    form.hidden = true;
    form.method = "POST";
    form.action = url;
    form.target = iframeName;
    Object.entries({ ...params, uploadId }).forEach(([name, value]) => {
      const input: HTMLInputElement = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value == null ? "" : String(value);
      form.appendChild(input);
    });
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
  });
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
  toast.textContent = message;
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
    let token = getPublishToken();
    let res: AppsScriptResponse;
    try {
      res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" });
    } catch (err) {
      if (isAuthError(err)) {
        try {
          localStorage.removeItem(AUTH_KEY);
        } catch {
          /* ignore */
        }
        token = await authenticate(url);
        res = await postAppsScript(url, { action: "createTrip", plan: planJson, token: token || "" });
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

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
