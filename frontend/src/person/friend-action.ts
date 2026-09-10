import { escapeHtml } from "../shared/dom";
import { icon } from "../shared/icons";
import { currentAccount, searchAccountsRemote, type Account } from "../shared/account-store";
import * as Friendships from "../shared/friendship-store";
import { personName } from "./context";

async function exactPersonAccounts(): Promise<Account[]> {
  const key = personName.trim().toLowerCase();
  if (!key) return [];
  const accounts = await searchAccountsRemote(personName, { excludeSelf: true });
  return accounts.filter((account) =>
    account.name.trim().toLowerCase() === key || account.email.trim().toLowerCase() === key,
  );
}

export async function renderFriendAction(friendActionEl: HTMLElement | null, message = ""): Promise<void> {
  if (!friendActionEl) return;
  if (!personName) {
    friendActionEl.innerHTML = "";
    return;
  }
  const account = currentAccount();
  if (!account) {
    friendActionEl.innerHTML =
      '<a class="pv-friend-btn" href="login.html">' + icon("user") + '<span>ログインして友達申請</span></a>';
    return;
  }
  if (account.name.trim() === personName || account.email.trim().toLowerCase() === personName.toLowerCase()) {
    friendActionEl.innerHTML = '<span class="pv-friend-badge">' + icon("checkCircle") + '<span>あなたのページ</span></span>';
    return;
  }
  const matches = await exactPersonAccounts();
  if (matches.length !== 1) {
    const text = matches.length > 1 ? "同じ名前のアカウントが複数あります" : "この名前のアカウントが見つかりません";
    friendActionEl.innerHTML = '<span class="pv-friend-note">' + icon("informationCircle") + '<span>' + escapeHtml(text) + '</span></span>';
    return;
  }
  const target = matches[0];
  const status = Friendships.statusWith(target.id);
  if (status === "friends") {
    friendActionEl.innerHTML = '<span class="pv-friend-badge">' + icon("checkCircle") + '<span>友達</span></span>';
    return;
  }
  if (status === "outgoing_pending") {
    friendActionEl.innerHTML = '<span class="pv-friend-badge is-pending">' + icon("paperAirplane") + '<span>申請中</span></span>';
    return;
  }
  if (status === "incoming_pending") {
    friendActionEl.innerHTML =
      '<a class="pv-friend-btn" href="mypage.html?tab=friends">' + icon("users") + '<span>届いた申請を見る</span></a>';
    return;
  }
  friendActionEl.innerHTML =
    '<button class="pv-friend-btn" type="button" data-send-friend-request="' + escapeHtml(target.id) + '">' +
    icon("plus") + '<span>友達申請を送る</span></button>' +
    (message ? '<span class="pv-friend-message">' + escapeHtml(message) + '</span>' : "");
}

export async function handleFriendActionClick(friendActionEl: HTMLElement, event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("[data-send-friend-request]");
  if (!button) return;
  const accountId = button.dataset.sendFriendRequest || "";
  try {
    button.disabled = true;
    await Friendships.sendFriendRequest({ accountId });
    await renderFriendAction(friendActionEl, "申請を送信しました");
  } catch (err) {
    button.disabled = false;
    friendActionEl.innerHTML += '<span class="pv-friend-message is-error">' +
      escapeHtml(err instanceof Error ? err.message : "送信できませんでした") + '</span>';
  }
}
