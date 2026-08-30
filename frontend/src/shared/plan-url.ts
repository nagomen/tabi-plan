// 計画ダッシュボードへのURL。全ページで同じ組み立てを使う。

/** `index.html?plan=<slug>`（view=1 で閲覧専用リンク）。 */
export function planDashboardHref(slug: string, opts: { view?: boolean } = {}): string {
  return "index.html?plan=" + encodeURIComponent(slug) + (opts.view ? "&view=1" : "");
}
