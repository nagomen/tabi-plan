interface SectionNavigationOptions {
  onSectionVisible?: (sectionId: string) => void;
}

/** PCの目次追従と、スマホの1画面1タブ表示を同じセクション一覧で管理する。 */
export function initializeSectionNavigation(options: SectionNavigationOptions = {}): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".cg-toc a"));
  const sections = links
    .map((link) => document.querySelector<HTMLElement>(link.hash))
    .filter((section): section is HTMLElement => Boolean(section));
  const toc = document.querySelector<HTMLElement>(".cg-toc");
  if (!links.length || !sections.length || !toc) return;

  const mobile = window.matchMedia("(max-width: 600px)");
  const selectedSectionId = (): string => {
    const hashId = window.location.hash.slice(1);
    return sections.some((section) => section.id === hashId) ? hashId : sections[0]?.id || "route";
  };

  const showMobileSection = (sectionId: string, moveToTop: boolean): void => {
    sections.forEach((section) => {
      const selected = section.id === sectionId;
      section.classList.toggle("is-mobile-active", selected);
      section.setAttribute("aria-hidden", String(!selected));
    });
    links.forEach((link) => {
      const selected = link.hash === `#${sectionId}`;
      link.classList.toggle("is-active", selected);
      link.setAttribute("aria-selected", String(selected));
      link.tabIndex = selected ? 0 : -1;
    });
    links.find((link) => link.hash === `#${sectionId}`)
      ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    if (moveToTop) window.scrollTo({ top: toc.offsetTop, behavior: "auto" });
    options.onSectionVisible?.(sectionId);
  };

  const syncLayout = (): void => {
    if (mobile.matches) {
      toc.setAttribute("role", "tablist");
      links.forEach((link) => {
        link.setAttribute("role", "tab");
        link.setAttribute("aria-controls", link.hash.slice(1));
      });
      if (!window.location.hash) {
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}#route`);
      }
      showMobileSection(selectedSectionId(), false);
      return;
    }

    toc.removeAttribute("role");
    links.forEach((link) => {
      link.removeAttribute("role");
      link.removeAttribute("aria-controls");
      link.removeAttribute("aria-selected");
      link.removeAttribute("tabindex");
    });
    sections.forEach((section) => {
      section.classList.remove("is-mobile-active");
      section.removeAttribute("aria-hidden");
    });
    options.onSectionVisible?.("compare");
  };

  links.forEach((link, index) => {
    link.addEventListener("click", (event) => {
      if (!mobile.matches) return;
      event.preventDefault();
      if (window.location.hash !== link.hash) {
        history.pushState(null, "", `${window.location.pathname}${window.location.search}${link.hash}`);
      }
      showMobileSection(link.hash.slice(1), true);
    });
    link.addEventListener("keydown", (event) => {
      if (!mobile.matches || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = links[(index + direction + links.length) % links.length];
      next?.click();
      next?.focus();
    });
  });

  window.addEventListener("popstate", () => {
    if (mobile.matches) showMobileSection(selectedSectionId(), true);
  });
  mobile.addEventListener("change", syncLayout);
  syncLayout();

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (mobile.matches) return;
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((link) => link.classList.toggle("is-active", link.hash === `#${visible.target.id}`));
    }, { rootMargin: "-25% 0px -65% 0px", threshold: [0, 0.2, 0.6] });
    sections.forEach((section) => observer.observe(section));
  }
}

export function initializeBackToTop(): void {
  const button = document.querySelector<HTMLElement>(".cg-to-top");
  if (!button) return;
  const update = (): void => {
    button.classList.toggle("is-visible", window.scrollY > 700);
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
}
