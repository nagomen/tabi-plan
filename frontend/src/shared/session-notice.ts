// ログインの期限が切れたことを画面で知らせ、そのままログインへ戻す。
//
// これまでは、期限切れのトークンでも画面は普通に開き（bootstrap は
// セッション無しでも公開ぶんを返すので通ってしまう）、保存しようとした
// ときに初めて「保存できませんでした」と出るだけだった。
// ログインし直す導線が無く、編集内容も保存されないまま気づけない。
//
// db.ts が 401 session_required を受けると trip-session-expired を投げ、
// account-store がセッションを消して trip-account-logout（reason: expired）
// を投げる。ここではその通知を受けて、上部に帯を出す。

import { adoptSessionFromUrl } from "./db";

const NOTICE_ID = "trip-session-notice";

function loginHref(): string {
  const back = location.pathname.split("/").pop() + location.search;
  return "login.html?returnTo=" + encodeURIComponent(back);
}

const EXPIRED_TEXT = "ログインの期限が切れました。続きを保存するには、もう一度ログインしてください。";

function build(text: string): HTMLElement {
  const el = document.createElement("div");
  el.id = NOTICE_ID;
  el.className = "trip-session-notice";
  el.setAttribute("role", "alert");
  el.innerHTML =
    '<p class="trip-session-notice-text"></p>' +
    '<a class="trip-session-notice-go" href="' + loginHref() + '">ログインし直す</a>' +
    '<button class="trip-session-notice-close" type="button" aria-label="閉じる">×</button>';
  const textEl = el.querySelector(".trip-session-notice-text");
  if (textEl) textEl.textContent = text;
  el.querySelector(".trip-session-notice-close")?.addEventListener("click", () => el.remove());
  return el;
}

function showNotice(text: string): void {
  if (document.getElementById(NOTICE_ID)) return;
  document.body.appendChild(build(text));
}

/** 期限切れの通知を受け取れるようにする。何度呼んでも帯は1つだけ。 */
export function mountSessionNotice(): void {
  if (typeof window === "undefined") return;
  const show = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    // 自分でログアウトしたときは出さない（期限切れのときだけ）
    if (detail && detail.reason !== "expired") return;
    showNotice(EXPIRED_TEXT);
  };
  window.addEventListener("trip-account-logout", show);
  // account-store を読み込んでいない画面でも拾えるようにしておく
  window.addEventListener("trip-session-expired", show);
  // LINE から戻ったのに受け取れなかった場合も、ここで知らせて導線を出す
  // （ログイン画面以外に戻ってくると、黙って未ログインのままになるため）。
  const adopted = adoptSessionFromUrl();
  if (adopted.error) showNotice(adopted.error);
}
