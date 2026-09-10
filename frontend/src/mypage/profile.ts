import * as db from "../shared/db";
import { navigateWithPageTransition } from "../shared/page-transition";
import { icon } from "../shared/icons";
import { escapeHtml } from "../shared/dom";
import { getUser, setUserName } from "../shared/user-store";
import { currentUserId } from "../shared/identity";
import { currentAccount, logOut, updateName, isLoggedIn } from "../shared/account-store";
import { isHistoryPublic, setHistoryPublic } from "../shared/history-privacy";

export interface ProfileEls {
  nameInput: HTMLInputElement;
  avatarEl: HTMLElement;
  noteEl: HTMLElement;
  accountEl: HTMLElement;
  historyToggle: HTMLInputElement;
  historyNote: HTMLElement;
}

export interface ProfileDeps {
  isEmbedded: boolean;
  renderPlans: () => void;
}

// ---- プロフィール -------------------------------------------------------

export function mountProfile(els: ProfileEls, deps: ProfileDeps): { renderProfile: () => void } {
  const { nameInput, avatarEl, noteEl, accountEl, historyToggle, historyNote } = els;
  const { isEmbedded, renderPlans } = deps;

  function avatarText(name: string): string {
    return (name.trim().slice(0, 1) || "?").toUpperCase();
  }

  function renderProfile(): void {
    const user = getUser();
    // LINE で登録した場合、この端末には名前が無い。サーバー側の表示名を引き継ぐ
    // （以降はここで変えた名前が正。LINE 名で上書きはしない）。
    if (!user.name.trim()) {
      const serverName = db.nameOf(currentUserId());
      if (serverName) {
        setUserName(serverName);
        user.name = serverName;
      }
    }
    nameInput.value = user.name;
    avatarEl.textContent = avatarText(user.name);
    renderAccount();
    renderHistorySetting();
  }

  // 旅行履歴の公開設定（名前キーで保存）。名前未設定なら無効化。
  function renderHistorySetting(): void {
    const name = getUser().name.trim();
    const userId = currentUserId();
    historyToggle.disabled = !name;
    historyToggle.checked = name && userId ? isHistoryPublic(userId) : false;
    historyNote.textContent = name
      ? "あなたのアイコンから開くプロフィールに、行った場所やカレンダーを掲載します（共有計画内の参加者表示は変わりません）"
      : "名前を設定すると、旅行履歴プロフィールへの掲載を選べます";
  }
  historyToggle.addEventListener("change", () => {
    const name = getUser().name.trim();
    const userId = currentUserId();
    if (!name || !userId) return;
    setHistoryPublic(userId, historyToggle.checked);
  });

  function renderAccount(): void {
    const account = currentAccount();
    if (account) {
      // LINE で登録した場合はメールを持たない。その場合は表示名で伝える。
      const who = account.email || account.name || "この端末";
      accountEl.innerHTML =
        `${icon("user")}<span>${escapeHtml(who)} でログイン中</span>` +
        `<a href="plans.html" class="danger" data-logout data-no-transition="true">ログアウト</a>`;
      const logout = accountEl.querySelector<HTMLAnchorElement>("[data-logout]");
      logout?.addEventListener("click", (e) => {
        e.preventDefault();
        if (isEmbedded) {
          try {
            window.parent?.postMessage({ type: "trip-account-logout" }, location.origin);
          } catch {
            /* ignore */
          }
          return;
        }
        logOut();
        navigateWithPageTransition("plans.html", { replace: true });
      });
    } else {
      accountEl.innerHTML = `<a href="login.html">ログイン / 新規登録</a><span>すると別端末でも同じ旅行計画を使えます</span>`;
    }
  }

  // 名前は自動保存（入力中はデバウンス、確定時は即時）。
  // 表示名は users テーブルの1列なので、変更はそこを更新するだけで済む。
  // 以前は名前が実質的な主キーだったため、計画のメンバー欄・費用の支払者・
  // 候補の票・送金リンクへ配り直す必要があった（shared/rename.ts）。
  let nameTimer = 0;
  let noteTimer = 0;

  function commitName(): void {
    const user = setUserName(nameInput.value);
    if (isLoggedIn()) updateName(user.name); // ログイン中はアカウントの表示名も更新
    avatarEl.textContent = avatarText(user.name);
    renderPlans();
    renderHistorySetting();
    noteEl.textContent = user.name ? "保存しました" : "入力すると自動で保存されます";
    window.clearTimeout(noteTimer);
    if (user.name) noteTimer = window.setTimeout(() => { noteEl.textContent = ""; }, 2000);
  }
  nameInput.addEventListener("input", () => {
    window.clearTimeout(nameTimer);
    nameTimer = window.setTimeout(commitName, 500);
  });
  nameInput.addEventListener("blur", () => { window.clearTimeout(nameTimer); commitName(); });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { window.clearTimeout(nameTimer); commitName(); nameInput.blur(); }
  });

  return { renderProfile };
}
