import { mountAppHeader } from "../shared/app-header";
import { icon, type IconName } from "../shared/icons";
import type { CasinoGuideContext } from "./context";

export interface CasinoGuideShellOptions {
  kicker: string;
  title: string;
  backLabel: string;
  meta: string;
}

const DEFAULT_SHELL: CasinoGuideShellOptions = {
  kicker: "Seoul Casino Guide",
  title: "韓国カジノ完全ガイド",
  backLabel: "韓国旅行へ戻る",
  meta: "韓国旅行・1日目のための特設ページ",
};

/** 共通ヘッダー、旅行への戻り先、静的アイコンを初期化する。 */
export function initializePageShell(
  context: CasinoGuideContext,
  shell: CasinoGuideShellOptions = DEFAULT_SHELL,
): void {
  mountAppHeader({
    kicker: shell.kicker,
    title: shell.title,
    back: { href: context.tripHref, label: shell.backLabel },
    meta: [{ text: shell.meta }],
    actions: [
      { kind: "link", display: "text", icon: "calendarDays", label: "旅行計画", text: "旅行計画", href: context.tripHref },
    ],
  });

  document.querySelectorAll<HTMLAnchorElement>("[data-trip-link]").forEach((link) => {
    link.href = context.tripHref;
  });

  document.querySelectorAll<HTMLElement>("[data-ic]").forEach((element) => {
    const name = element.dataset.ic as IconName | undefined;
    if (name) element.innerHTML = icon(name);
  });
}
