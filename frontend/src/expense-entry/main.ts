// 費用入力ページ。docs/expense-entry.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// JSONP（callAppsScript）と iframe-POST（postAppsScript）で Apps Script と通信し、
// レシート写真のリサイズ、認証、入力フォームの送信・キャッシュを行う。

import {
  DEFAULT_CONFIG,
  mergeConfig,
  normalizeTripConfig,
  readGlobalTripConfig,
  type TripConfig,
} from "../shared/config";
import type { TripData } from "../shared/types";

// ---- 補助型 -------------------------------------------------------------

/** Apps Script JSONP/POST のレスポンス共通形 */
interface AppsScriptResponse {
  ok?: boolean;
  error?: string;
  token?: string;
  expiresAt?: number;
  url?: string;
  data?: TripData;
  [key: string]: unknown;
}

/** callAppsScript / postAppsScript に渡すパラメータ */
type AppsScriptParams = Record<string, string | number | undefined>;

/** ローカルストレージに保存する認証セッション */
interface AuthSession {
  ok?: boolean;
  token?: string;
  expiresAt?: number;
}

/** ローカルストレージに保存する本人プロフィール */
interface ProfileRecord {
  name?: string;
  savedAt?: string;
}

/** ローカルストレージに保存する費用入力キャッシュ */
interface ExpenseCache {
  participants: string[];
  tripTitle?: string;
  savedAt?: string;
}

/** prepareReceiptPhoto が返すアップロード用ペイロード */
interface PreparedPhoto {
  fileName: string;
  mimeType: string;
  data: string;
}

/** init / renderExpenseEntry に渡す部分的な TripData 形状 */
type ExpenseSourceData = Partial<TripData> & {
  participants?: unknown;
};

/** postMessage で受け取るレシートアップロード結果 */
interface ReceiptUploadMessage {
  source?: string;
  uploadId?: string;
  response?: AppsScriptResponse;
}

interface AppState {
  data: TripData | null;
  participants: string[];
}

// ---- 設定 ---------------------------------------------------------------

function applyDocumentTripTitle(title: string | undefined): void {
  const tripTitle = title || "旅行";
  document.title = `費用入力 | ${tripTitle}`;
  const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) appleTitle.setAttribute("content", "費用入力");
}

const CONFIG: TripConfig = normalizeTripConfig(
  mergeConfig(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    readGlobalTripConfig() as Record<string, unknown>,
  ) as unknown as TripConfig,
);
applyDocumentTripTitle(CONFIG.tripTitle);

const FALLBACK_PARTICIPANTS: string[] = CONFIG.defaultParticipants.length
  ? CONFIG.defaultParticipants
  : ["参加者A", "参加者B"];

// ---- DOM ヘルパー -------------------------------------------------------

const rootElement = document.getElementById("expenseApp");
if (!rootElement) {
  throw new Error("expenseApp 要素が見つかりません");
}
const root: HTMLElement = rootElement;

/** root 配下から要素を取得し、無ければ throw する型付き qs */
function qs<E extends Element = Element>(selector: string): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const state: AppState = { data: null, participants: FALLBACK_PARTICIPANTS };

// ---- Apps Script 通信 ---------------------------------------------------

function callAppsScript(params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    if (!CONFIG.appsScriptUrl) {
      reject(new Error("appsScriptUrl が未設定です"));
      return;
    }
    const callback = "__tripExpenseCallback_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const queryParams: Record<string, string> = { callback, cachebust: String(Date.now()) };
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) queryParams[key] = String(value);
    });
    const query = new URLSearchParams(queryParams);
    const globalScope = window as unknown as Record<string, unknown>;
    globalScope[callback] = (response: AppsScriptResponse | undefined): void => {
      delete globalScope[callback];
      script.remove();
      if (!response || response.ok === false) {
        reject(new Error(response && response.error ? response.error : "Apps Script API error"));
        return;
      }
      resolve(response);
    };
    script.onerror = (): void => {
      delete globalScope[callback];
      script.remove();
      reject(new Error("Apps Script APIを読み込めませんでした"));
    };
    script.async = true;
    script.src =
      CONFIG.appsScriptUrl +
      (CONFIG.appsScriptUrl.includes("?") ? "&" : "?") +
      query.toString();
    document.head.appendChild(script);
  });
}

function postAppsScript(params: AppsScriptParams): Promise<AppsScriptResponse> {
  return new Promise((resolve, reject) => {
    if (!CONFIG.appsScriptUrl) {
      reject(new Error("appsScriptUrl が未設定です"));
      return;
    }
    const uploadId = "receipt-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const iframeName = "receiptUploadFrame_" + uploadId.replace(/[^A-Za-z0-9_]/g, "_");
    const iframe = document.createElement("iframe");
    const form = document.createElement("form");
    const cleanup = (): void => {
      window.removeEventListener("message", onMessage);
      form.remove();
      iframe.remove();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("写真アップロードがタイムアウトしました"));
    }, 60000);
    const onMessage = (event: MessageEvent): void => {
      const data = (event.data || {}) as ReceiptUploadMessage;
      if (data.source !== "trip-expense-receipt-upload" || data.uploadId !== uploadId) return;
      clearTimeout(timer);
      cleanup();
      const response = data.response || {};
      if (response.ok === false) {
        reject(new Error(response.error || "写真アップロードに失敗しました"));
        return;
      }
      resolve(response);
    };

    iframe.name = iframeName;
    iframe.hidden = true;
    form.hidden = true;
    form.method = "POST";
    form.action = CONFIG.appsScriptUrl;
    form.target = iframeName;

    const allParams: AppsScriptParams = { ...params, uploadId };
    Object.entries(allParams).forEach(([key, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value == null ? "" : String(value);
      form.appendChild(input);
    });

    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
  });
}

// ---- 画像処理 -----------------------------------------------------------

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result || ""));
    reader.onerror = (): void => reject(new Error("写真を読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

function imageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = (): void => resolve(image);
    image.onerror = (): void => reject(new Error("写真を処理できませんでした"));
    image.src = dataUrl;
  });
}

async function prepareReceiptPhoto(file: File): Promise<PreparedPhoto> {
  const originalDataUrl = await fileAsDataUrl(file);
  if (!/^image\//.test(file.type || "")) {
    throw new Error("画像ファイルを選択してください");
  }

  try {
    const image = await imageFromDataUrl(originalDataUrl);
    const maxSize = 1600;
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas context を取得できませんでした");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    return {
      fileName: String(file.name || "receipt.jpg").replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: "image/jpeg",
      data: dataUrl.split(",")[1] || "",
    };
  } catch (_) {
    return {
      fileName: file.name || "receipt.jpg",
      mimeType: file.type || "image/jpeg",
      data: originalDataUrl.split(",")[1] || "",
    };
  }
}

async function uploadReceiptPhoto(file: File): Promise<AppsScriptResponse> {
  const prepared = await prepareReceiptPhoto(file);
  if (!prepared.data) throw new Error("写真データがありません");
  if (prepared.data.length > 7000000) {
    throw new Error("写真サイズが大きすぎます。小さめの画像で再試行してください");
  }
  return postAppsScript({
    action: "receiptUpload",
    token: getAuthToken(),
    fileName: prepared.fileName,
    mimeType: prepared.mimeType,
    data: prepared.data,
  });
}

// ---- 認証 ---------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readAuthSession(): AuthSession {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.auth.storageKey) || "{}") as AuthSession;
  } catch (_) {
    return {};
  }
}

function hasAuthSession(): boolean {
  if (!CONFIG.auth.enabled) return true;
  try {
    const session = readAuthSession();
    return Boolean(session && session.expiresAt && Date.now() < session.expiresAt && session.token);
  } catch (_) {
    return false;
  }
}

function getAuthToken(): string {
  try {
    const session = readAuthSession();
    return session && session.expiresAt && Date.now() < session.expiresAt
      ? session.token || ""
      : "";
  } catch (_) {
    return "";
  }
}

function saveAuthSession(token: string | undefined, expiresAt: number | undefined): void {
  const days = Number(CONFIG.auth.rememberDays || 1);
  localStorage.setItem(
    CONFIG.auth.storageKey,
    JSON.stringify({
      ok: true,
      token: token || "",
      expiresAt: expiresAt || Date.now() + days * 24 * 60 * 60 * 1000,
    }),
  );
}

function clearAuthSession(): void {
  localStorage.removeItem(CONFIG.auth.storageKey);
}

// ---- プロフィール -------------------------------------------------------

function readProfile(): ProfileRecord | null {
  try {
    const profile = JSON.parse(
      localStorage.getItem(CONFIG.profile.storageKey) || "{}",
    ) as ProfileRecord;
    return profile && profile.name ? profile : null;
  } catch (_) {
    return null;
  }
}

function saveProfile(name: string): void {
  localStorage.setItem(
    CONFIG.profile.storageKey,
    JSON.stringify({
      name,
      savedAt: new Date().toISOString(),
    }),
  );
}

function profileInitial(name: string | undefined): string {
  return String(name || "?").trim().slice(0, 1) || "?";
}

function updateProfileButton(): void {
  const button = root.querySelector<HTMLButtonElement>("[data-profile-button]");
  if (!button) return;
  const profile = readProfile();
  button.textContent = profile && profile.name ? profile.name : "本人設定";
  button.setAttribute(
    "aria-label",
    profile && profile.name ? `本人設定を変更: ${profile.name}` : "本人設定",
  );
}

function applyProfileDefaults(form: HTMLFormElement | null, participants: string[]): void {
  const name = currentProfileName(participants);
  const payer = form ? (form.elements.namedItem("payer") as HTMLSelectElement | null) : null;
  if (!name || !form || !payer) return;
  payer.value = name;
}

function currentProfileName(participants: string[]): string {
  const profile = readProfile();
  if (!profile || !profile.name) return "";
  if (!participants || !participants.length) return profile.name;
  return participants.includes(profile.name) ? profile.name : "";
}

// ---- 本人設定モーダル ---------------------------------------------------

function showIdentityModal(required: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(".identity-modal");
    if (existing) existing.remove();

    const participants =
      state.participants && state.participants.length ? state.participants : FALLBACK_PARTICIPANTS;
    const savedName = currentProfileName(participants);
    const options = participants
      .map(
        (name) =>
          `<option value="${escapeHtml(name)}" ${name === savedName ? "selected" : ""}>${escapeHtml(name)}</option>`,
      )
      .join("");
    const modal = document.createElement("div");
    modal.className = "identity-modal";
    modal.innerHTML = `
          <form class="identity-card" role="dialog" aria-modal="true" aria-labelledby="identityTitle">
            <header>
              <div>
                <h2 id="identityTitle">あなたは誰ですか</h2>
                <p>この端末に保存して、支払者の初期値に使います。</p>
              </div>
              <div class="identity-mark" data-identity-mark>${escapeHtml(profileInitial(savedName))}</div>
            </header>
            <div class="identity-body">
              <label class="identity-field">
                <span>本人として使う名前</span>
                <select name="profileName" required>
                  <option value="">選択してください</option>
                  ${options}
                </select>
              </label>
              <div class="identity-actions">
                <span class="identity-note">ブラウザのローカルストレージに保存されます。</span>
                <button type="submit">登録する</button>
                ${required ? "" : `<button class="secondary" type="button" data-identity-close>閉じる</button>`}
              </div>
            </div>
          </form>`;
    document.body.appendChild(modal);

    const form = modal.querySelector("form");
    const select = modal.querySelector("select");
    const mark = modal.querySelector<HTMLElement>("[data-identity-mark]");
    const close = modal.querySelector<HTMLButtonElement>("[data-identity-close]");
    if (!form || !select || !mark) {
      modal.remove();
      resolve(false);
      return;
    }
    select.focus();
    select.addEventListener("change", () => {
      mark.textContent = profileInitial(select.value);
    });
    if (close) {
      close.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = select.value;
      if (!name) {
        select.focus();
        return;
      }
      saveProfile(name);
      modal.remove();
      updateProfileButton();
      applyProfileDefaults(
        root.querySelector<HTMLFormElement>("[data-expense-form-native]"),
        participants,
      );
      resolve(true);
    });
  });
}

async function requestIdentityIfNeeded(): Promise<void> {
  updateProfileButton();
  const participants =
    state.participants && state.participants.length ? state.participants : FALLBACK_PARTICIPANTS;
  if (!currentProfileName(participants)) {
    await showIdentityModal(true);
  }
}

// ---- 費用入力キャッシュ -------------------------------------------------

function readExpenseCache(): ExpenseCache | null {
  try {
    const cache = JSON.parse(
      localStorage.getItem(CONFIG.expenseCache.storageKey) || "{}",
    ) as ExpenseCache;
    return cache && Array.isArray(cache.participants) && cache.participants.length ? cache : null;
  } catch (_) {
    return null;
  }
}

function saveExpenseCache(data: ExpenseSourceData): void {
  const participants = expenseParticipants(data);
  if (!participants.length) return;
  const meta = root.querySelector<HTMLElement>("[data-meta]");
  const tripTitle =
    (data && data.trip && data.trip.title) ||
    (meta && meta.textContent) ||
    CONFIG.tripTitle ||
    "旅行";
  localStorage.setItem(
    CONFIG.expenseCache.storageKey,
    JSON.stringify({
      participants,
      tripTitle,
      savedAt: new Date().toISOString(),
    }),
  );
}

// ---- パスワードゲート ---------------------------------------------------

function requestPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!CONFIG.auth.enabled || hasAuthSession()) {
      resolve(true);
      return;
    }

    const gate = document.createElement("div");
    gate.className = "auth";
    gate.innerHTML = `
          <form class="auth-box">
            <h2>費用入力を開く</h2>
            <div class="auth-body">
              <p>共有されたパスワードを入力してください。</p>
              <label>
                パスワード
                <input type="password" autocomplete="current-password" autofocus aria-label="パスワード" placeholder="パスワードを入力">
              </label>
              <button type="submit">開く</button>
              <div class="auth-error" aria-live="polite"></div>
            </div>
          </form>`;
    document.body.appendChild(gate);

    const form = gate.querySelector("form");
    const input = gate.querySelector("input");
    const error = gate.querySelector<HTMLElement>(".auth-error");
    if (!form || !input || !error) {
      gate.remove();
      resolve(true);
      return;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const passwordHash = await sha256Hex(input.value || "");
        const response = await callAppsScript({ action: "auth", passwordHash });
        saveAuthSession(response.token, response.expiresAt);
        gate.remove();
        resolve(true);
      } catch (apiError) {
        input.value = "";
        input.focus();
        error.textContent = errorMessage(apiError) || "認証に失敗しました。";
      }
    });
  });
}

// ---- 値ユーティリティ ---------------------------------------------------

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

function todayISO(): string {
  if (CONFIG.todayOverride) return CONFIG.todayOverride;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatYen(value: number): string {
  const n = Number(value || 0);
  return "¥" + Math.round(n).toLocaleString("ja-JP");
}

function numberValue(value: unknown): number {
  const n = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function expenseParticipants(data: ExpenseSourceData): string[] {
  const rawParticipants = Array.isArray(data && data.participants)
    ? (data.participants as unknown[])
    : [];
  const fromData = rawParticipants
    .map((member): string => {
      if (typeof member === "string") return member;
      if (member && typeof member === "object") {
        const record = member as Record<string, unknown>;
        const candidate = record.name || record.displayName || record["表示名"];
        return candidate ? String(candidate) : "";
      }
      return "";
    })
    .filter(Boolean);
  if (fromData.length) return fromData;
  const fromMembers = String((data && data.trip && data.trip.members) || "")
    .split(/\s*\/\s*|、|,|\n/)
    .map((name) => name.trim())
    .filter((name) => name && !/\d+人|共有メンバー/.test(name));
  return fromMembers.length ? fromMembers : FALLBACK_PARTICIPANTS;
}

function expenseCurrencies(data: ExpenseSourceData): string[] {
  const localInfo: unknown[] = Array.isArray(data && data.localInfo)
    ? (data.localInfo as unknown[])
    : [];
  const fromLocalInfo = localInfo
    .map((row) => {
      if (!row || typeof row !== "object") return "";
      const record = row as Record<string, unknown>;
      const candidate = record.currencyCode || record.currency || record["通貨コード"];
      return candidate ? String(candidate) : "";
    })
    .filter(Boolean);
  return Array.from(new Set(["JPY"].concat(CONFIG.currencies || [], fromLocalInfo)))
    .map((code) => String(code || "").trim().toUpperCase())
    .filter(Boolean);
}

function setStatus(message: string, type: "error" | "ok" | ""): void {
  const status = root.querySelector<HTMLElement>("[data-expense-status]");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", type === "error");
  status.classList.toggle("is-ok", type === "ok");
}

function isAuthError(error: unknown): boolean {
  const message = errorMessage(error);
  return /auth|token|password|Authentication|Invalid token|Token expired|認証|権限|Password/i.test(
    message,
  );
}

// ---- フォーム要素アクセス ----------------------------------------------

function selectControl(form: HTMLFormElement, name: string): HTMLSelectElement {
  return form.elements.namedItem(name) as HTMLSelectElement;
}

function inputControl(form: HTMLFormElement, name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

function textAreaControl(form: HTMLFormElement, name: string): HTMLTextAreaElement {
  return form.elements.namedItem(name) as HTMLTextAreaElement;
}

/** ラジオグループ splitMode の選択値を返す */
function radioValue(form: HTMLFormElement, name: string): string {
  const checked = form.querySelector<HTMLInputElement>(`input[name='${name}']:checked`);
  return checked ? checked.value : "";
}

// ---- 描画 ---------------------------------------------------------------

function renderExpenseEntry(data: ExpenseSourceData): void {
  const participants = expenseParticipants(data);
  state.participants = participants;
  const meta = root.querySelector<HTMLElement>("[data-meta]");
  if (meta && data && data.trip && data.trip.title) meta.textContent = data.trip.title;
  const profileName = currentProfileName(participants);
  const currencyOptions = expenseCurrencies(data)
    .map((code) => `<option>${escapeHtml(code)}</option>`)
    .join("");
  const payerOptions = participants
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}" ${name === profileName ? "selected" : ""}>${escapeHtml(name)}</option>`,
    )
    .join("");
  const targetPicks = participants
    .map(
      (name) => `
        <label class="pick">
          <input type="checkbox" name="targets" value="${escapeHtml(name)}" checked>
          <span>${escapeHtml(name)}</span>
        </label>`,
    )
    .join("");
  const shareInputs = participants
    .map(
      (name) => `
        <label class="expense-field">
          <span>${escapeHtml(name)}</span>
          <input type="number" name="share-${escapeHtml(name)}" data-share-name="${escapeHtml(name)}" min="0" step="1" inputmode="numeric" placeholder="0">
        </label>`,
    )
    .join("");

  qs("[data-expense-entry]").innerHTML = `
        <form class="expense-form" data-expense-form-native>
          <div class="expense-grid">
            <label class="expense-field wide">
              <span>内容 <b class="required-mark" aria-label="必須">*</b></span>
              <input type="text" name="title" required placeholder="例: タクシー">
            </label>
            <label class="expense-field">
              <span>支払金額 <b class="required-mark" aria-label="必須">*</b></span>
              <input type="number" name="amount" required min="1" step="1" inputmode="decimal" placeholder="12000">
            </label>
            <label class="expense-field">
              <span>通貨 <b class="required-mark" aria-label="必須">*</b></span>
              <select name="currency" required>${currencyOptions}</select>
            </label>
            <label class="expense-field">
              <span>支払者 <b class="required-mark" aria-label="必須">*</b></span>
              <select name="payer" required>${payerOptions}</select>
            </label>
            <label class="expense-field">
              <span>支払日 <b class="required-mark" aria-label="必須">*</b></span>
              <input type="date" name="paidDate" required>
            </label>
            <label class="expense-field">
              <span>カテゴリ <b class="required-mark" aria-label="必須">*</b></span>
              <select name="category" required>
                <option>食費</option>
                <option>交通</option>
                <option>宿泊</option>
                <option>観光</option>
                <option>通信</option>
                <option>その他</option>
              </select>
            </label>
            <label class="expense-field">
              <span>支払方法</span>
              <select name="paymentMethod">
                <option>カード</option>
                <option>現金</option>
                <option>送金</option>
                <option>その他</option>
              </select>
            </label>
          </div>

          <div class="split">
            <span class="split-label">精算方法 <b class="required-mark" aria-label="必須">*</b></span>
            <div class="segments">
              <label class="segment"><input type="radio" name="splitMode" value="全員で等分" required checked><span>全員で等分</span></label>
              <label class="segment"><input type="radio" name="splitMode" value="選んだ人だけで等分" required><span>選んだ人だけ</span></label>
              <label class="segment"><input type="radio" name="splitMode" value="個別金額を入力" required><span>個別金額</span></label>
              <label class="segment"><input type="radio" name="splitMode" value="精算不要" required><span>精算不要</span></label>
            </div>
          </div>

          <div class="split-detail" data-selected-detail>
            <span class="split-label">割り勘する人</span>
            <div class="participant-picks">${targetPicks}</div>
          </div>

          <div class="split-detail" data-individual-detail>
            <span class="split-label">各自の負担額</span>
            <div class="individual-grid">${shareInputs}</div>
            <div class="share-total" data-share-total>合計 ¥0</div>
          </div>

          <div class="expense-grid">
            <label class="expense-field wide photo-field">
              <span>レシート写真</span>
              <input type="file" name="receiptPhoto" accept="image/*" capture="environment">
            </label>
            <label class="expense-field wide">
              <span>メモ</span>
              <textarea name="note" placeholder="任意。為替メモや補足があれば入力"></textarea>
            </label>
          </div>

          <div class="expense-submit">
            <div class="expense-status" data-expense-status aria-live="polite"></div>
            <button type="submit">保存</button>
          </div>
        </form>`;

  const form = qs<HTMLFormElement>("[data-expense-form-native]");
  inputControl(form, "paidDate").value = todayISO();
  applyProfileDefaults(form, participants);
  setupExpenseEntryHandlers(form, participants);
  if (profileName) requestAnimationFrame(() => inputControl(form, "title").focus());
}

function setupExpenseEntryHandlers(form: HTMLFormElement, participants: string[]): void {
  const selectedDetail = form.querySelector<HTMLElement>("[data-selected-detail]");
  const individualDetail = form.querySelector<HTMLElement>("[data-individual-detail]");
  const totalNode = form.querySelector<HTMLElement>("[data-share-total]");
  const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
  if (!selectedDetail || !individualDetail || !totalNode || !button) return;
  const amountInput = inputControl(form, "amount");

  const activeMode = (): string => radioValue(form, "splitMode");
  const formatInputAmount = (value: number): string => {
    const currency = selectControl(form, "currency").value || "JPY";
    if (currency === "JPY") return formatYen(value);
    return `${currency} ${Math.round(value * 100) / 100}`;
  };
  const shareInputFor = (name: string): HTMLInputElement | undefined =>
    Array.from(form.querySelectorAll<HTMLInputElement>("[data-share-name]")).find(
      (input) => input.dataset.shareName === name,
    );
  const individualTotal = (): number =>
    participants.reduce((sum, name) => {
      const input = shareInputFor(name);
      return sum + numberValue(input && input.value);
    }, 0);
  const updateShareTotal = (): void => {
    const total = individualTotal();
    const amount = numberValue(amountInput.value);
    const message = amount
      ? `合計 ${formatInputAmount(total)} / 支払額 ${formatInputAmount(amount)}`
      : `合計 ${formatInputAmount(total)}`;
    totalNode.textContent = message;
    totalNode.style.color =
      /個別金額/.test(activeMode()) && amount && Math.abs(total - amount) > 1
        ? "var(--red)"
        : "var(--muted)";
  };
  const updateMode = (): void => {
    const mode = activeMode();
    selectedDetail.classList.toggle("is-visible", /選んだ人だけ/.test(mode));
    individualDetail.classList.toggle("is-visible", /個別金額/.test(mode));
    updateShareTotal();
  };

  form.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (target && target.name === "payer") saveProfile(target.value);
    if (target && target.name === "splitMode") updateMode();
    updateShareTotal();
  });
  form.addEventListener("input", updateShareTotal);
  updateMode();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = activeMode();
    const targets = Array.from(
      form.querySelectorAll<HTMLInputElement>("input[name='targets']:checked"),
    ).map((input) => input.value);
    const individual: Record<string, number> = {};
    participants.forEach((name) => {
      const input = shareInputFor(name);
      const amount = numberValue(input && input.value);
      if (amount) individual[name] = amount;
    });
    const amount = numberValue(inputControl(form, "amount").value);

    if (/選んだ人だけ/.test(mode) && !targets.length) {
      setStatus("割り勘する人を1人以上選んでください。", "error");
      return;
    }
    if (/個別金額/.test(mode)) {
      const total = individualTotal();
      if (!total) {
        setStatus("個別金額を入力してください。", "error");
        return;
      }
      if (Math.abs(total - amount) > 1) {
        setStatus("個別金額の合計が支払額と一致していません。", "error");
        return;
      }
    }

    button.disabled = true;
    setStatus("保存中...", "");
    try {
      saveProfile(selectControl(form, "payer").value);
      const receiptInput = form.elements.namedItem("receiptPhoto") as HTMLInputElement | null;
      const photo =
        receiptInput && receiptInput.files && receiptInput.files.length
          ? receiptInput.files[0]
          : null;
      let receiptUrl = "";
      if (photo) {
        setStatus("写真アップロード中...", "");
        const upload = await uploadReceiptPhoto(photo);
        receiptUrl = upload.url || "";
        setStatus("保存中...", "");
      }
      const response = await callAppsScript({
        action: "expense",
        token: getAuthToken(),
        paidDate: inputControl(form, "paidDate").value,
        payer: selectControl(form, "payer").value,
        category: selectControl(form, "category").value,
        title: inputControl(form, "title").value,
        amount: inputControl(form, "amount").value,
        currency: selectControl(form, "currency").value,
        splitMode: mode,
        targets: JSON.stringify(targets),
        individual: JSON.stringify(individual),
        paymentMethod: selectControl(form, "paymentMethod").value,
        receiptUrl,
        note: textAreaControl(form, "note").value,
      });
      if (response.data) {
        state.data = response.data;
        saveExpenseCache(response.data);
      }
      const payer = selectControl(form, "payer").value;
      const paidDate = inputControl(form, "paidDate").value;
      const category = selectControl(form, "category").value;
      const currency = selectControl(form, "currency").value;
      const paymentMethod = selectControl(form, "paymentMethod").value;
      form.reset();
      selectControl(form, "payer").value = payer;
      inputControl(form, "paidDate").value = paidDate || todayISO();
      selectControl(form, "category").value = category || "食費";
      selectControl(form, "currency").value = currency || "JPY";
      selectControl(form, "paymentMethod").value = paymentMethod || "カード";
      form
        .querySelectorAll<HTMLInputElement>("input[name='targets']")
        .forEach((input) => {
          input.checked = true;
        });
      updateMode();
      setStatus("保存しました。続けて入力できます。", "ok");
      inputControl(form, "title").focus();
    } catch (error) {
      if (isAuthError(error)) clearAuthSession();
      setStatus(errorMessage(error) || "保存に失敗しました。", "error");
    } finally {
      button.disabled = false;
    }
  });
}

// ---- 初期化 -------------------------------------------------------------

async function init(): Promise<void> {
  await requestPassword();
  const cache = readExpenseCache();
  const meta = qs<HTMLElement>("[data-meta]");
  meta.textContent = cache && cache.tripTitle ? cache.tripTitle : CONFIG.tripTitle || "旅行";
  updateProfileButton();
  qs<HTMLButtonElement>("[data-profile-button]").addEventListener("click", () => {
    showIdentityModal(false);
  });
  renderExpenseEntry(
    cache ? { participants: cache.participants, trip: { title: cache.tripTitle } as TripData["trip"] } : {},
  );
  await requestIdentityIfNeeded();
}

void init();
