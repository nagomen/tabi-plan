// ログイン / 新規登録ページ。メール+パスワードで account-store を呼ぶ。
// データは backend 経由（dev: data/store/trip-dashboard-accounts.json、本番: localStorage）。

import "../shared/ui.css";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import { icon } from "../shared/icons";
import { makeScopedQuery, errorMessage, escapeHtml } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import {
  signUp,
  logIn,
  logOut,
  currentAccount,
  isValidEmail,
  isWeakPassword,
} from "../shared/account-store";

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
const loggedBox = qs<HTMLElement>("[data-logged]");
const loggedText = qs<HTMLElement>("[data-logged-text]");

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
      location.replace(new URL("plans.html", location.href).href);
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
    if (mode === "signup") await signUp(email, password, name);
    else await logIn(email, password);
    // 成功 → ホーム（計画一覧）へ。マイページはヘッダーのユーザーアイコンから開ける。
    location.href = "plans.html";
  } catch (err) {
    showError(errorMessage(err) || "失敗しました");
    submitBtn.disabled = false;
    submitLabel.textContent = mode === "signup" ? "登録する" : "ログイン";
  }
});

async function init(): Promise<void> {
  await Backend.preload();
  registerServiceWorker();
  applyMode("login");
  submitBtn.disabled = false;
  renderLoggedIn();
}

void init();
