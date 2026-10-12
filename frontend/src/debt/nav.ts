// ヘッダー右上のページ内メニュー。表示中のセクション（data-nav）だけを拾って目次にし、
// タップでそのセクションへスクロールする。返済計画の描画後に1回だけ呼ぶ。

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 非表示の親（hidden）の中にあるセクションは目次に出さない。 */
function visibleSections(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-content] [data-nav]"))
    .filter((section) => section.id && !section.closest("[hidden]"));
}

export function initDebtNav(): void {
  const toggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
  const menu = document.querySelector<HTMLElement>("[data-menu]");
  const list = menu?.querySelector<HTMLOListElement>("[data-menu-list]");
  if (!toggle || !menu || !list) return;
  const sections = visibleSections();
  if (!sections.length) return;

  const links = new Map<string, HTMLAnchorElement>();
  list.replaceChildren();
  for (const section of sections) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `#${section.id}`;
    // 番号の無い項目も空の番号欄を置き、見出しの頭をそろえる。
    const no = document.createElement("span");
    no.className = "dn-menu-no";
    no.textContent = section.dataset.navNo || "";
    link.append(no, section.dataset.nav || "");
    link.addEventListener("click", (event) => {
      // ハッシュを書き換えると共有トークン（#token=…）が消え、hashchange で再読み込みになる。
      event.preventDefault();
      close(false);
      section.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      section.setAttribute("tabindex", "-1");
      section.focus({ preventScroll: true });
    });
    item.append(link);
    list.append(item);
    links.set(section.id, link);
  }

  const open = (): void => {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "メニューを閉じる");
    links.values().next().value?.focus();
  };
  function close(restoreFocus = true): void {
    if (menu!.hidden) return;
    menu!.hidden = true;
    toggle!.setAttribute("aria-expanded", "false");
    toggle!.setAttribute("aria-label", "メニューを開く");
    if (restoreFocus) toggle!.focus();
  }

  toggle.hidden = false;
  toggle.setAttribute("aria-label", "メニューを開く");
  toggle.onclick = () => (menu.hidden ? open() : close());
  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (!menu.hidden && target && !menu.contains(target) && !toggle.contains(target)) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  // いま読んでいるセクションを目次で強調する。
  if (typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver((entries) => {
    const current = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!current) return;
    for (const [id, link] of links) {
      if (id === current.target.id) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }, { rootMargin: "-20% 0px -60% 0px" });
  for (const section of sections) observer.observe(section);
}
