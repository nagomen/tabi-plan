// ログインの期限切れと、裏で走る保存の失敗を画面上部の帯で知らせる。
//
// これまでは、期限切れのトークンでも画面は普通に開き（bootstrap は
// セッション無しでも公開ぶんを返すので通ってしまう）、保存しようとした
// ときに初めて「保存できませんでした」と出るだけだった。
// ログインし直す導線が無く、編集内容も保存されないまま気づけない。
//
// db.ts が 401 session_required を受けると trip-session-expired を投げ、
// account-store がセッションを消して trip-account-logout（reason: expired）
// を投げる。また、投げっぱなしの書き込み（チェックリスト・費用の削除・
// 参加期間など）が失敗すると trip-sync-error を投げる。ここでは
// その通知を受けて、上部に帯を出す。

import { adoptSessionFromUrl } from "./db";

const NOTICE_ID = "trip-session-notice";

function loginHref(): string {
  const back = location.pathname.split("/").pop() + location.search;
  return "login.html?returnTo=" + encodeURIComponent(back);
}

const EXPIRED_TEXT = "ログインの期限が切れました。続きを保存するには、もう一度ログインしてください。";

function build(text: string, link: { href: string; label: string } | null): HTMLElement {
  const el = document.createElement("div");
  el.id = NOTICE_ID;
  el.className = "trip-session-notice";
  el.setAttribute("role", "alert");
  el.innerHTML =
    '<p class="trip-session-notice-text"></p>' +
    (link ? '<a class="trip-session-notice-go"></a>' : "") +
    '<button class="trip-session-notice-close" type="button" aria-label="閉じる">×</button>';
  const textEl = el.querySelector(".trip-session-notice-text");
  if (textEl) textEl.textContent = text;
  const linkEl = el.querySelector<HTMLAnchorElement>(".trip-session-notice-go");
  if (linkEl && link) {
    linkEl.href = link.href;
    linkEl.textContent = link.label;
  }
  el.querySelector(".trip-session-notice-close")?.addEventListener("click", () => el.remove());
  return el;
}

function showNotice(
  text: string,
  link: { href: string; label: string } | null = null,
  priority: "sync" | "session" = "sync",
): void {
  const current = document.getElementById(NOTICE_ID);
  if (current) {
    if (priority !== "session") return;
    current.replaceWith(build(text, link));
    return;
  }
  document.body.appendChild(build(text, link));
}

// 自動保存の失敗は短い間隔で繰り返し届くため、閉じた直後の再表示を抑える。
const SYNC_NOTICE_COOLDOWN_MS = 30_000;
let lastSyncNoticeAt = 0;

function showSyncNotice(event: Event): void {
  const detail = (event as CustomEvent<{ message?: string; action?: string }>).detail;
  const now = Date.now();
  if (now - lastSyncNoticeAt < SYNC_NOTICE_COOLDOWN_MS) return;
  lastSyncNoticeAt = now;
  const message = detail?.message || "変更を保存できませんでした。通信状態を確認してください。";
  showNotice(
    message,
    detail?.action === "reload"
      ? { href: location.href, label: "読み込み直す" }
      : null,
  );
}

/** 期限切れ・保存失敗の通知を受け取れるようにする。何度呼んでも帯は1つだけ。 */
export function mountSessionNotice(): void {
  if (typeof window === "undefined") return;
  const show = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    // 自分でログアウトしたときは出さない（期限切れのときだけ）
    if (detail && detail.reason !== "expired") return;
    showNotice(EXPIRED_TEXT, { href: loginHref(), label: "ログインし直す" }, "session");
  };
  window.addEventListener("trip-account-logout", show);
  // account-store を読み込んでいない画面でも拾えるようにしておく
  window.addEventListener("trip-session-expired", show);
  // 裏で走る保存（チェックリスト・費用の削除・参加期間など）の失敗を知らせる
  window.addEventListener("trip-sync-error", showSyncNotice);
  // 予期しない例外も、白画面や「押しても何も起きない」ではなく帯で知らせる
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[trip] unhandled rejection", (event as PromiseRejectionEvent).reason);
    showSyncNotice(new CustomEvent("trip-sync-error", {
      detail: { message: "処理を完了できませんでした。画面を読み込み直してください。", action: "reload" },
    }));
  });
  // LINE から戻ったのに受け取れなかった場合も、ここで知らせて導線を出す
  // （ログイン画面以外に戻ってくると、黙って未ログインのままになるため）。
  const adopted = adoptSessionFromUrl();
  if (adopted.error) showNotice(adopted.error, { href: loginHref(), label: "ログインし直す" });
}
