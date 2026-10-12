import { icon, type IconName } from "../shared/icons";

/** HTML 側は data-ic="名前" だけを持ち、ここで heroicon の SVG を流し込む。 */
export function fillIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-ic]").forEach((node) => {
    const name = node.dataset.ic as IconName | undefined;
    if (!name) return;
    node.classList.add("dn-ic");
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = icon(name);
  });
}
