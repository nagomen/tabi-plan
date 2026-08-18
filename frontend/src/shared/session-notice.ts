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

const NOTICE_ID = "trip-session-notice";

function loginHref(): string {
  const back = location.pathname.split("/").pop() + location.search;
  return "login.html?returnTo=" + encodeURIComponent(back);
}

function build(): HTMLElement {
  const el = document.createElement("div");
  el.id = NOTICE_ID;
  el.className = "trip-session-notice";
  el.setAttribute("role", "alert");
  el.innerHTML =
    '<p class="trip-session-notice-text">ログインの期限が切れました。' +
    "続きを保存するには、もう一度ログインしてください。</p>" +
    '<a class="trip-session-notice-go" href="' + loginHref() + '">ログインし直す</a>' +
    '<button class="trip-session-notice-close" type="button" aria-label="閉じる">×</button>';
  el.querySelector(".trip-session-notice-close")?.addEventListener("click", () => el.remove());
  return el;
}

/** 期限切れの通知を受け取れるようにする。何度呼んでも帯は1つだけ。 */
export function mountSessionNotice(): void {
  if (typeof window === "undefined") return;
  const show = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    // 自分でログアウトしたときは出さない（期限切れのときだけ）
    if (detail && detail.reason !== "expired") return;
    if (document.getElementById(NOTICE_ID)) return;
    document.body.appendChild(build());
  };
  window.addEventListener("trip-account-logout", show);
  // account-store を読み込んでいない画面でも拾えるようにしておく
  window.addEventListener("trip-session-expired", show);
}
