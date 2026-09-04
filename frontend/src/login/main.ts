// ログイン / 新規登録ページ。メール+パスワードで account-store を呼ぶ。
// データは backend 経由（dev: data/store/trip-dashboard-accounts.json、本番: localStorage）。

import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import { icon } from "../shared/icons";
import { makeScopedQuery, errorMessage, escapeHtml } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import * as db from "../shared/db";
import {
  signUp,
  logIn,
  logOut,
  currentAccount,
  isValidEmail,
  isWeakPassword,
} from "../shared/account-store";
import { readInviteReturn } from "../shared/invite-resume";

initPageTransitions();

const { qs } = makeScopedQuery(document);

qs<HTMLElement>("[data-ic-brand]").insertAdjacentHTML("afterbegin", icon("mapPin") + " ");

const form = qs<HTMLFormElement>("[data-form]");
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".lg-tab"));
const nameField = qs<HTMLElement>("[data-field-name]");
const titleEl = qs<HTMLElement>("[data-title]");
const subEl = qs<HTMLElement>("[data-sub]");
const errorEl = qs<HTMLElement>("[data-error]");
const submitLabel = qs<HTMLElement>("[data-submit-label]");
const submitBtn = qs<HTMLButtonElement>("[data-submit]");
const recoveryOpen = qs<HTMLButtonElement>("[data-recover-open]");
const recoveryForm = qs<HTMLFormElement>("[data-recover-form]");
const recoveryError = qs<HTMLElement>("[data-recover-error]");
const loggedBox = qs<HTMLElement>("[data-logged]");
const loggedText = qs<HTMLElement>("[data-logged-text]");
function safeReturnTo(value: string | null): string {
  const raw = String(value || "");
  return raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("//") ? raw : "";
}

const returnTo = safeReturnTo(new URLSearchParams(location.search).get("returnTo"));
const resumeInvite = new URLSearchParams(location.search).get("resumeInvite") === "1";
const destination = (consume = false): string =>
  (resumeInvite ? readInviteReturn(consume) : "") || returnTo || "plans.html";

const emailInput = form.elements.namedItem("email") as HTMLInputElement;
const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
const nameInput = form.elements.namedItem("name") as HTMLInputElement;

let mode: "login" | "signup" = "login";
submitBtn.disabled = true;

function showError(message: string): void {
  errorEl.textContent = message;
  errorEl.classList.add("is-shown");
}
function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.remove("is-shown");
}

function showRecoveryCode(code: string): void {
  if (!code) return;
  window.prompt(
    "この復旧コードは再表示できません。パスワード管理アプリなど安全な場所へコピーしてください。",
    code,
  );
}

function applyMode(next: "login" | "signup"): void {
  mode = next;
  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.mode === mode));
  nameField.hidden = mode !== "signup";
  const isSignup = mode === "signup";
  titleEl.textContent = isSignup ? "新規登録" : "ログイン";
  subEl.textContent = isSignup
    ? "メールアドレスとパスワード（8文字以上）で登録します。"
    : "メールアドレスとパスワードでログインします。";
  submitLabel.textContent = isSignup ? "登録する" : "ログイン";
  passwordInput.autocomplete = isSignup ? "new-password" : "current-password";
  clearError();
}

tabs.forEach((t) => t.addEventListener("click", () => applyMode(t.dataset.mode === "signup" ? "signup" : "login")));

function renderLoggedIn(): void {
  const account = currentAccount();
  if (!account) {
    loggedBox.classList.remove("is-shown");
    return;
  }
  loggedBox.classList.add("is-shown");
  loggedText.innerHTML =
    `${icon("user")} <span>${escapeHtml(account.name)}（${escapeHtml(account.email)}）でログイン中</span>` +
    `<a href="#" data-logout>ログアウト</a>`;
  const logout = loggedBox.querySelector<HTMLAnchorElement>("[data-logout]");
  if (logout) {
    logout.addEventListener("click", (e) => {
      e.preventDefault();
      logOut();
      navigateWithPageTransition("plans.html", { replace: true });
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  if (!isValidEmail(email)) {
    showError("メールアドレスの形式が正しくありません");
    emailInput.focus();
    return;
  }
  if (mode === "signup" && isWeakPassword(password)) {
    showError("パスワードは8文字以上にしてください");
    passwordInput.focus();
    return;
  }
  if (!password) {
    showError("パスワードを入力してください");
    passwordInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitLabel.textContent = mode === "signup" ? "登録中…" : "ログイン中…";
  try {
    if (mode === "signup") {
      const account = await signUp(email, password, name);
      showRecoveryCode(account.recoveryCode || "");
    } else await logIn(email, password);
    // 成功 → 招待経由なら元の招待URLへ戻る。通常は計画一覧へ。
    navigateWithPageTransition(destination(true));
  } catch (err) {
    showError(errorMessage(err) || "失敗しました");
    submitBtn.disabled = false;
    submitLabel.textContent = mode === "signup" ? "登録する" : "ログイン";
  }
});

recoveryOpen.addEventListener("click", () => {
  recoveryForm.hidden = !recoveryForm.hidden;
  recoveryOpen.textContent = recoveryForm.hidden ? "パスワードを忘れた方" : "再設定を閉じる";
  recoveryError.textContent = "";
  recoveryError.classList.remove("is-shown");
  if (!recoveryForm.hidden) recoveryForm.querySelector<HTMLInputElement>("input")?.focus();
});

recoveryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = (recoveryForm.elements.namedItem("recover-email") as HTMLInputElement).value.trim();
  const code = (recoveryForm.elements.namedItem("recovery-code") as HTMLInputElement).value.trim();
  const next = (recoveryForm.elements.namedItem("new-password") as HTMLInputElement).value;
  const button = recoveryForm.querySelector<HTMLButtonElement>("[data-recover-submit]");
  recoveryError.textContent = "";
  recoveryError.classList.remove("is-shown");
  if (!isValidEmail(email) || !code || isWeakPassword(next)) {
    recoveryError.textContent = "メールアドレス・復旧コード・8文字以上の新しいパスワードを確認してください。";
    recoveryError.classList.add("is-shown");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await db.recoverPassword({ email, recovery_code: code, new_password: next });
    showRecoveryCode(result.recovery_code);
    recoveryForm.reset();
    recoveryForm.hidden = true;
    recoveryOpen.textContent = "パスワードを忘れた方";
    applyMode("login");
    emailInput.value = email;
    window.alert("パスワードを再設定し、すべての端末からログアウトしました。新しいパスワードでログインしてください。");
  } catch (error) {
    recoveryError.textContent = errorMessage(error) || "再設定できませんでした";
    recoveryError.classList.add("is-shown");
  } finally {
    if (button) button.disabled = false;
  }
});

// ---- LINE ログイン -------------------------------------------------------

const lineBtn = document.querySelector<HTMLButtonElement>("[data-line]");
const lineBlocks = Array.from(document.querySelectorAll<HTMLElement>("[data-line-block]"));

function setupLineLogin(): void {
  const base = db.apiBaseUrl();
  // API を使わない構成では LINE ログインもできないので、導線を出さない。
  if (!base || !lineBtn) return;
  for (const el of lineBlocks) el.hidden = false;
  lineBtn.hidden = false;
  lineBtn.addEventListener("click", () => {
    // 戻り先は「ログイン後に行きたい画面」。許可オリジンの外はサーバーが弾く。
    // LINEからはいったんこのログイン画面へ戻り、sessionStorageの招待情報を復元する。
    const back = new URL(resumeInvite ? location.pathname + location.search : destination(), location.href).toString();
    lineBtn.disabled = true;
    // URL はサーバーに作らせる（この端末の印を state に入れてもらうため）。
    void db.lineAuthorizeUrl(back)
      .then((url) => {
        if (url) location.href = url;
        else throw new Error("LINEログインを開始できませんでした");
      })
      .catch((error) => {
        lineBtn.disabled = false;
        showError(errorMessage(error) || "LINEログインを開始できませんでした");
      });
  });
}

async function init(): Promise<void> {
  await Backend.preload();
  // LINE から戻ってきた場合は、まずセッションを取り込む。
  const adopted = db.adoptSessionFromUrl();
  if (adopted.error) showError(adopted.error);
  if (adopted.ok) {
    navigateWithPageTransition(destination(true), { replace: true });
    return;
  }
  setupLineLogin();
  // 期限切れのトークンが手元に残っていると「ログイン中」と表示してしまう。
  // サーバーに一度確かめさせ、無効なら db 側がセッションを片付ける。
  if (db.isEnabled()) await db.load({ fresh: true }).catch(() => undefined);
  registerServiceWorker();
  applyMode("login");
  submitBtn.disabled = false;
  renderLoggedIn();
}

void init();
