const TRANSITION_KEY = "trip:page-transition";
const LEAVE_MS = 220;
const ENTER_MS = 320;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function sameDocumentHash(url: URL): boolean {
  return (
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search &&
    !!url.hash
  );
}

function isInternalPage(url: URL): boolean {
  return url.origin === location.origin && /\.(html)?$/.test(url.pathname) || url.origin === location.origin;
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

  document.body.classList.remove("ui-page-leave");
  window.addEventListener("pageshow", () => {
    document.body.classList.remove("ui-page-leave");
  });

  try {
    if (sessionStorage.getItem(TRANSITION_KEY) === "1") {
      sessionStorage.removeItem(TRANSITION_KEY);
      if (!reducedMotion()) {
        document.body.classList.add("ui-page-enter");
        window.setTimeout(() => document.body.classList.remove("ui-page-enter"), ENTER_MS);
      }
    }
  } catch {
    // sessionStorage が使えない環境では通常遷移に戻す。
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const url = new URL(link.href, location.href);
      if (shouldSkip(event, link, url)) return;

      try { sessionStorage.setItem(TRANSITION_KEY, "1"); } catch { /* ignore */ }
      if (reducedMotion()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      document.body.classList.add("ui-page-leave");
      window.setTimeout(() => {
        location.href = url.href;
      }, LEAVE_MS);
    },
    true,
  );
}
