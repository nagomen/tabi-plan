import { icon } from "../shared/icons";
import { escapeHtml, errorMessage } from "../shared/dom";
import { isLoggedIn, searchAccounts, searchAccountsRemote, type Account } from "../shared/account-store";
import * as Friendships from "../shared/friendship-store";

export interface FriendEls {
  friendNoteEl: HTMLElement;
  friendSearchForm: HTMLFormElement;
  friendSearchInput: HTMLInputElement;
  friendSearchResults: HTMLElement;
  friendIncomingMount: HTMLElement;
  friendIncomingCount: HTMLElement;
  friendListMount: HTMLElement;
  friendCount: HTMLElement;
  friendOutgoingMount: HTMLElement;
  friendOutgoingCount: HTMLElement;
  friendTabBadge: HTMLElement;
}

// ---- 友達（アカウント単位） ----------------------------------------------

export function mountFriends(els: FriendEls): { renderFriends: () => void } {
  const {
    friendNoteEl,
    friendSearchForm,
    friendSearchInput,
    friendSearchResults,
    friendIncomingMount,
    friendIncomingCount,
    friendListMount,
    friendCount,
    friendOutgoingMount,
    friendOutgoingCount,
    friendTabBadge,
  } = els;

  function friendNote(message: string): void {
    friendNoteEl.textContent = message;
  }

  function accountRow(account: Account, action: string): string {
    return (
      `<div class="mp-row mp-row-static">` +
      `<span class="mp-dot" style="background:#68746e"></span>` +
      `<span class="mp-row-body">` +
      `<span class="mp-row-name">${icon("user")}<span>${escapeHtml(account.name || account.email)}</span></span>` +
      `<span class="mp-row-meta">${escapeHtml(account.email)}</span>` +
      `</span>` +
      action +
      `</div>`
    );
  }

  function requestRow(name: string, email: string, action: string): string {
    return (
      `<div class="mp-row mp-row-static">` +
      `<span class="mp-dot" style="background:#68746e"></span>` +
      `<span class="mp-row-body">` +
      `<span class="mp-row-name">${icon("user")}<span>${escapeHtml(name)}</span></span>` +
      `<span class="mp-row-meta">${escapeHtml(email)}</span>` +
      `</span>` +
      action +
      `</div>`
    );
  }

  function renderFriendSearchResults(results: Account[]): void {
    if (!results.length) {
      friendSearchResults.innerHTML = "";
      return;
    }
    friendSearchResults.innerHTML = results
      .map((account) => {
        const status = Friendships.statusWith(account.id);
        const action =
          status === "friends"
            ? `<span class="mp-badge">友達</span>`
            : status === "outgoing_pending"
              ? `<span class="mp-badge">申請中</span>`
              : status === "incoming_pending"
                ? `<span class="mp-badge">申請が届いています</span>`
                : `<button type="button" class="mp-friend-btn" data-friend-request="${escapeHtml(account.id)}">${icon("plus")}申請を送る</button>`;
        return accountRow(account, action);
      })
      .join("");
  }

  function renderFriends(): void {
    if (!isLoggedIn()) {
      friendTabBadge.hidden = true;
      friendTabBadge.textContent = "";
      friendSearchResults.innerHTML = "";
      friendIncomingMount.innerHTML = `<div class="mp-empty"><b>ログインすると友達を追加できます</b><span>マイページ上部からログイン / 新規登録してください</span></div>`;
      friendIncomingCount.textContent = "";
      friendListMount.innerHTML = "";
      friendCount.textContent = "";
      friendOutgoingMount.innerHTML = "";
      friendOutgoingCount.textContent = "";
      friendNote("");
      return;
    }

    const incoming = Friendships.incomingRequests();
    friendTabBadge.hidden = incoming.length === 0;
    friendTabBadge.textContent = incoming.length ? String(incoming.length) : "";
    friendIncomingCount.textContent = incoming.length ? `${incoming.length}件` : "";
    friendIncomingMount.innerHTML = incoming.length
      ? incoming
          .map((row) =>
            requestRow(
              row.fromName,
              row.fromEmail,
              `<span class="mp-row-actions">` +
                `<button type="button" class="mp-friend-btn" data-friend-accept="${escapeHtml(row.id)}">${icon("check")}承諾</button>` +
                `<button type="button" class="mp-friend-btn danger" data-friend-decline="${escapeHtml(row.id)}">${icon("xMark")}拒否</button>` +
                `</span>`,
            ),
          )
          .join("")
      : `<div class="mp-empty"><b>届いている申請はありません</b></div>`;

    const friends = Friendships.listFriends();
    friendCount.textContent = friends.length ? `${friends.length}人` : "";
    friendListMount.innerHTML = friends.length
      ? friends
          .map((account) =>
            accountRow(
              account,
              `<button type="button" class="mp-friend-btn danger" data-friend-remove="${escapeHtml(account.id)}">${icon("trash")}削除</button>`,
            ),
          )
          .join("")
      : `<div class="mp-empty"><b>友達はまだいません</b><span>上の検索から友達を探して申請を送りましょう</span></div>`;

    const outgoing = Friendships.outgoingRequests();
    friendOutgoingCount.textContent = outgoing.length ? `${outgoing.length}件` : "";
    friendOutgoingMount.innerHTML = outgoing.length
      ? outgoing
          .map((row) =>
            requestRow(
              row.toName,
              row.toEmail,
              `<button type="button" class="mp-friend-btn" data-friend-cancel="${escapeHtml(row.id)}">${icon("xMark")}取り消す</button>`,
            ),
          )
          .join("")
      : "";
  }

  friendSearchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = friendSearchInput.value.trim();
    if (!query) {
      friendSearchResults.innerHTML = "";
      friendNote("");
      return;
    }
    if (!isLoggedIn()) {
      friendNote("検索するにはログインが必要です");
      return;
    }
    const results = await searchAccountsRemote(query, { excludeSelf: true });
    friendNote(results.length ? "" : "見つかりませんでした");
    renderFriendSearchResults(results);
  });

  async function handleFriendAction(run: () => Promise<unknown>): Promise<void> {
    const controls = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view="friends"] button'));
    controls.forEach((button) => { button.disabled = true; });
    try {
      await run();
      friendNote("");
    } catch (err) {
      friendNote(errorMessage(err) || "操作に失敗しました");
    }
    renderFriends();
    const query = friendSearchInput.value.trim();
    if (query) renderFriendSearchResults(searchAccounts(query, { excludeSelf: true }));
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const requestBtn = target.closest<HTMLButtonElement>("[data-friend-request]");
    if (requestBtn) {
      const accountId = requestBtn.dataset.friendRequest || "";
      void handleFriendAction(() => Friendships.sendFriendRequest({ accountId }));
      return;
    }
    const acceptBtn = target.closest<HTMLButtonElement>("[data-friend-accept]");
    if (acceptBtn) {
      const requestId = acceptBtn.dataset.friendAccept || "";
      void handleFriendAction(() => Friendships.acceptFriendRequest(requestId));
      return;
    }
    const declineBtn = target.closest<HTMLButtonElement>("[data-friend-decline]");
    if (declineBtn) {
      const requestId = declineBtn.dataset.friendDecline || "";
      void handleFriendAction(() => Friendships.declineFriendRequest(requestId));
      return;
    }
    const cancelBtn = target.closest<HTMLButtonElement>("[data-friend-cancel]");
    if (cancelBtn) {
      const requestId = cancelBtn.dataset.friendCancel || "";
      void handleFriendAction(() => Friendships.cancelFriendRequest(requestId));
      return;
    }
    const removeBtn = target.closest<HTMLButtonElement>("[data-friend-remove]");
    if (removeBtn) {
      const accountId = removeBtn.dataset.friendRemove || "";
      void handleFriendAction(() => Friendships.removeFriend(accountId));
    }
  });

  return { renderFriends };
}
