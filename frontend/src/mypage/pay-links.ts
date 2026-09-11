import * as db from "../shared/db";
import { icon } from "../shared/icons";
import { escapeHtml } from "../shared/dom";
import { currentUserId } from "../shared/identity";
import { getPayLink, setPayLink } from "../shared/payment-links";

export interface PayLinkEls {
  payMount: HTMLElement;
  payCount: HTMLElement;
}

// ---- 送金リンク登録（PayPay 受取リンク/ID） ----------------------------

export function mountPayLinks(els: PayLinkEls): { renderPayLinks: () => void } {
  const { payMount, payCount } = els;

  /** 自分＋表示可能な計画のメンバーをuser_id単位で集める。 */
  function payPeople(): { id: string; name: string }[] {
    const ids = new Set(db.members().filter((member) => member.status === "active").map((member) => member.user_id));
    const me = currentUserId();
    if (me) ids.add(me);
    return [...ids].map((id) => ({ id, name: db.nameOf(id) })).filter((person) => person.name);
  }

  function renderPayLinks(): void {
    const meId = currentUserId();
    const people = payPeople();
    payCount.textContent = people.length ? `${people.length}人` : "";
    if (!people.length) {
      payMount.innerHTML = `<div class="mp-empty"><b>メンバーがいません</b><span>計画にメンバーを追加すると、ここで送金リンクを登録できます</span></div>`;
      return;
    }
    payMount.innerHTML = people
      .map(({ id, name }) => {
        const link = getPayLink(id);
        const self = Boolean(meId) && id === meId;
        return (
          `<div class="mp-pay-row">` +
          `<span class="mp-pay-name">${self ? icon("user") : ""}${escapeHtml(name)}${self ? `<span class="mp-badge">自分</span>` : ""}</span>` +
          `<input type="text" inputmode="url" data-pay-user="${escapeHtml(id)}" value="${escapeHtml(link?.paypay || "")}" placeholder="${self ? "https://qr.paypay.ne.jp/… または ID" : "本人が登録すると表示されます"}" aria-label="${escapeHtml(name)}の送金リンク"${self ? "" : " disabled"}>` +
          `</div>`
        );
      })
      .join("");
  }

  let payTimer = 0;
  payMount.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const userId = input.dataset.payUser || "";
    if (!userId || userId !== currentUserId()) return;
    window.clearTimeout(payTimer);
    const value = input.value;
    payTimer = window.setTimeout(() => setPayLink(userId, value), 400);
  });

  return { renderPayLinks };
}
