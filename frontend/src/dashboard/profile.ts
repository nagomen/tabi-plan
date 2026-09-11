import { navigateWithPageTransition } from "../shared/page-transition";
import { getUser } from "../shared/user-store";
import { currentAccount } from "../shared/account-store";
import { currentUserId, identifyByName } from "../shared/identity";
import * as db from "../shared/db";
import { escapeHtml } from "../shared/dom";
import { requestPasswordGate } from "../shared/auth";
import { expenseCurrencyCodes, expenseParticipantNames } from "../shared/expense-form";
import type { TripData } from "../shared/types";
import { CONFIG, hooks, isReadOnly, SAMPLE, state } from "./state";
import { qs, root } from "./dom";
import { isOpenEditingVisitor } from "./plan-access";

/** ローカルストレージに保存する本人プロフィール */
interface ProfileRecord {
  name?: string;
  savedAt?: string;
}

// ---- 認証 / プロフィール ------------------------------------------------

export function readProfile(): ProfileRecord | null {
  try {
    const profile = JSON.parse(localStorage.getItem(CONFIG.profile.storageKey) || "{}") as ProfileRecord;
    return profile && profile.name ? profile : null;
  } catch {
    return null;
  }
}

function saveProfile(name: string): void {
  try {
    localStorage.setItem(CONFIG.profile.storageKey, JSON.stringify({
      name,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // プライベートモード等。名前はこのセッション内でだけ有効になる。
  }
}

export function saveExpenseEntryCache(data: TripData): void {
  const participants = expenseParticipants(data || SAMPLE);
  if (!participants.length) return;
  try {
    localStorage.setItem(CONFIG.expenseCache.storageKey, JSON.stringify({
      participants,
      tripTitle: (data && data.trip && data.trip.title) || CONFIG.tripTitle || "旅行",
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // 保存できなくても入力補助が効かなくなるだけなので続行する。
  }
}

export function currentProfileName(participants: string[]): string {
  const profile = readProfile();
  if (!profile || !profile.name) return "";
  if (!participants || !participants.length) return profile.name;
  return participants.includes(profile.name) ? profile.name : "";
}

function profileInitial(name: string | undefined): string {
  return String(name || "?").trim().slice(0, 1) || "?";
}

export function applyProfileDefaults(form: HTMLFormElement | null, participants: string[]): void {
  const name = currentProfileName(participants);
  const payer = form?.elements.namedItem("payer") as HTMLSelectElement | null;
  if (!name || !payer) return;
  payer.value = name;
}

function showIdentityModal(required: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(".tl-identity-modal");
    if (existing) existing.remove();

    const participants = expenseParticipants(state.data || SAMPLE);
    const savedName = currentProfileName(participants) || (readProfile()?.name || "");
    // 公開共同編集者は正式メンバー表に載っていない。
    // 選択肢から選ばせると誰も自分を選べないので、自由入力（既存メンバーは候補表示）にする。
    const freeText = isOpenEditingVisitor();
    const control = freeText
      ? `<input type="text" name="profileName" list="tlIdentityNames" required maxlength="24"
               autocomplete="name" placeholder="例: たろう" value="${escapeHtml(savedName)}">
         <datalist id="tlIdentityNames">
           ${participants.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}
         </datalist>`
      : `<select name="profileName" required>
           <option value="">選択してください</option>
           ${participants.map((name) =>
             `<option value="${escapeHtml(name)}" ${name === savedName ? "selected" : ""}>${escapeHtml(name)}</option>`,
           ).join("")}
         </select>`;
    const modal = document.createElement("div");
    modal.className = "tl-identity-modal";
    modal.innerHTML = `
      <form class="tl-identity-card" role="dialog" aria-modal="true" aria-labelledby="identityTitle">
        <header>
          <div>
            <h2 id="identityTitle">あなたは誰ですか</h2>
            <p>${freeText
              ? "名前を入れるだけでこの旅行に参加できます。ログインは不要です。"
              : "この端末に保存して、支払者などの初期値に使います。"}</p>
          </div>
          <div class="tl-identity-mark" data-identity-mark>${escapeHtml(profileInitial(savedName))}</div>
        </header>
        <div class="tl-identity-body">
          <label class="tl-identity-field">
            <span>本人として使う名前</span>
            ${control}
          </label>
          <div class="tl-identity-actions">
            <span class="tl-identity-note">ブラウザのローカルストレージにだけ保存されます。</span>
            <button type="submit">登録する</button>
            ${required ? "" : `<button class="secondary" type="button" data-identity-close>閉じる</button>`}
          </div>
        </div>
      </form>`;
    document.body.appendChild(modal);

    const form = qs<HTMLFormElement>("form", modal);
    const field = qs<HTMLSelectElement | HTMLInputElement>(freeText ? "input[name='profileName']" : "select", modal);
    const mark = qs<HTMLElement>("[data-identity-mark]", modal);
    const close = modal.querySelector<HTMLButtonElement>("[data-identity-close]");
    field.focus();
    const syncMark = (): void => {
      mark.textContent = profileInitial(field.value);
    };
    field.addEventListener("change", syncMark);
    field.addEventListener("input", syncMark);
    if (close) {
      close.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = field.value.trim();
      if (!name) {
        field.focus();
        return;
      }
      saveProfile(name);
      // API利用時は既存の旅行メンバーだけを確定する。未登録者は招待で紐付ける。
      void identifyByName(name).then(() => {
        hooks.renderBase();
        hooks.renderActive();
      });
      modal.remove();
      const expenseForm = root.querySelector<HTMLFormElement>("[data-expense-form-native]");
      applyProfileDefaults(expenseForm, participants);
      hooks.renderBase();
      hooks.renderActive();
      resolve(true);
    });
  });
}

export async function requestIdentityIfNeeded(): Promise<void> {
  // 読み取り専用（他人の公開計画の閲覧）では費用に関わらないので本人設定は求めない。
  if (isReadOnly()) return;
  // 利用者は identity（user_id）が正。確定済みなら訊かない。
  if (currentUserId()) {
    // 旧プロフィール（計画ごとの表示名）が空なら表示名で埋めておく（明細の見た目用）。
    if (!readProfile()) {
      const name = db.nameOf(currentUserId());
      if (name) saveProfile(name);
    }
    return;
  }
  // MySQL/API 版の本人確認はアカウントのセッションが正であり、端末ごとの
  // 表示名選択を使わない。招待された人の「誰として参加するか」は、署名付き
  // 招待リンクを開いた plans 画面で選択・承諾する。
  if (db.isEnabled()) {
    const back = "index.html?plan=" + encodeURIComponent(CONFIG.tripSlug);
    navigateWithPageTransition(
      "login.html?returnTo=" + encodeURIComponent(back),
      { replace: true },
    );
    return;
  }
  await showIdentityModal(true);
}

export function requestPassword(): Promise<boolean> {
  return requestPasswordGate({
    auth: CONFIG.auth,
    classPrefix: "tl-auth",
    title: "旅行ページを開く",
    submitLabel: "送信",
  });
}

/** 本人の名前（ログイン中のアカウント名 → 端末のユーザー名 → 保存済みプロフィール）。 */
function selfName(): string {
  const account = currentAccount();
  if (account && account.name.trim()) return account.name.trim();
  const user = getUser().name.trim();
  if (user) return user;
  const profile = readProfile();
  return (profile && profile.name ? profile.name : "").trim();
}

/**
 * 参加者一覧に本人を必ず含める。
 * メンバー未設定の計画（1人で作った計画・招待前の計画）では支払者の候補に自分が出ず、
 * 本人設定も参加者一覧に一致しないため費用を自分名義で追加できなくなる。
 * 閲覧のみの計画では他人の割り勘に自分を混ぜないので、追加しない。
 */
function withSelf(names: string[]): string[] {
  if (isReadOnly()) return names;
  // 保存済みの本人設定も必ず含める。端末のユーザー名と本人設定が食い違っていると
  // currentProfileName() が空を返し、本人設定モーダルが毎回出てしまうため。
  const mine = [selfName(), (readProfile()?.name || "").trim()].filter(Boolean);
  const out = [...names];
  mine.forEach((name) => {
    if (!out.includes(name)) out.unshift(name);
  });
  return out;
}

export function expenseParticipants(data: TripData): string[] {
  const discovered = expenseParticipantNames(data);
  if (discovered.length) return withSelf(discovered);
  // メンバーも本人も分からないときだけダミー名にフォールバックする。
  const onlySelf = withSelf([]);
  return onlySelf.length ? onlySelf : CONFIG.defaultParticipants || ["参加者A", "参加者B"];
}

export function expenseCurrencies(data: TripData): string[] {
  return expenseCurrencyCodes(data, CONFIG.currencies);
}
