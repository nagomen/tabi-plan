const TRANSITION_KEY = "trip:page-transition";
const LEAVE_MS = 180;
const ENTER_MS = 240;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// クロスドキュメント View Transitions に対応しているか。
// 対応時は CSS の @view-transition がネイティブに遷移を処理するため、
// JS による退場アニメ・ブートクロークは一切不要（そちらの方がなめらか）。
function supportsCrossDocViewTransitions(): boolean {
  // view-transition-name への対応は「同一ドキュメントの」対応判定にすぎない。
  // クロスドキュメント遷移が動くかは pagereveal イベントの有無で見る
  // （このイベントはクロスドキュメント対応と一緒に入った）。
  // ここを CSS.supports で見ていたため、Safari のように前者だけ対応する
  // ブラウザではネイティブ遷移もフォールバックも効かず、組み立て途中の
  // 画面がそのまま見えていた。
  try {
    return typeof window !== "undefined" && "onpagereveal" in window;
  } catch {
    return false;
  }
}

function sameDocumentHash(url: URL): boolean {
  return (
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search &&
    (url.hash !== "" || url.href.endsWith("#"))
  );
}

function isInternalPage(url: URL): boolean {
  if (url.origin !== location.origin) return false;
  return url.pathname.endsWith("/") || /\.html$/.test(url.pathname);
}

function shouldSkip(event: MouseEvent, link: HTMLAnchorElement, url: URL): boolean {
  if (event.defaultPrevented || event.button !== 0) return true;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
  if (link.target && link.target !== "_self") return true;
  if (link.hasAttribute("download") || link.dataset.noTransition === "true") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (url.origin !== location.origin) return true;
  if (sameDocumentHash(url)) return true;
  return !isInternalPage(url);
}

export function initPageTransitions(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const native = supportsCrossDocViewTransitions();

  // ブートクロークはどのブラウザでも使う。組み立て前の素の HTML
  // （原寸のアイコンや素の見出し）が一瞬見えるのを防ぐため。
  // ネイティブ遷移がある場合は pagereveal で先に表示へ戻す。
  // ここで戻しておかないと、遷移が「空のページ」を写してしまう。
  if (native) {
    const revealForNative = (): void => document.documentElement.classList.add("ui-ready");
    window.addEventListener("pagereveal", revealForNative, { once: true });
    window.requestAnimationFrame(revealForNative);
    window.setTimeout(revealForNative, 800);
    window.addEventListener("pageshow", revealForNative);
    return;
  }

  // 以下は View Transitions 非対応ブラウザ向けフォールバック（退場フェード＋ブートクローク）。
  document.body.classList.remove("ui-page-leave");

  // 遷移フラグを読み、入場アニメの要否だけ先に決める（表示は reveal まで保留）。
  let enterAnimation = false;
  try {
    if (sessionStorage.getItem(TRANSITION_KEY) === "1") {
      sessionStorage.removeItem(TRANSITION_KEY);
      enterAnimation = !reducedMotion();
    }
  } catch {
    // sessionStorage が使えない環境では通常遷移に戻す。
  }

  // ページの同期構築（共通ヘッダーの挿入など）が終わった直後・描画前に表示する。
  // これでヘッダー未挿入の骨組みが一瞬見える現象とレイアウトジャンプを防ぐ（ブートクローク）。
  const reveal = (): void => {
    if (document.documentElement.classList.contains("ui-ready")) return;
    document.documentElement.classList.add("ui-ready");
    if (enterAnimation) {
      document.body.classList.add("ui-page-enter");
      window.setTimeout(() => document.body.classList.remove("ui-page-enter"), ENTER_MS);
    }
  };
  window.requestAnimationFrame(reveal);
  // 保険: rAF が来ない環境でも必ず表示する（CSS 側 uiBootFailsafe と二重の保険）。
  window.setTimeout(reveal, 800);

  window.addEventListener("pageshow", () => {
    document.body.classList.remove("ui-page-leave");
    // bfcache 復帰時など、確実に表示状態へ戻す。
    document.documentElement.classList.add("ui-ready");
  });

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const url = new URL(link.href, location.href);
      if (shouldSkip(event, link, url)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      navigateWithPageTransition(url.href);
    },
    true,
  );
}

export function navigateWithPageTransition(href: string, options: { replace?: boolean } = {}): void {
  const url = new URL(href, location.href);
  try { sessionStorage.setItem(TRANSITION_KEY, "1"); } catch { /* ignore */ }

  const go = (): void => {
    if (options.replace) location.replace(url.href);
    else location.href = url.href;
  };

  if (reducedMotion() || supportsCrossDocViewTransitions()) {
    go();
    return;
  }

  document.body.classList.add("ui-page-leave");
  window.setTimeout(go, LEAVE_MS);
}
