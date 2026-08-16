/* ホームは計画一覧。?plan= 指定が無ければ一覧へ。CSPのため外部スクリプトにする。 */
try {
  if (!new URLSearchParams(location.search).has("plan")) location.replace("plans.html");
} catch {
  // URL API が使えない古い環境では通常表示へフォールバックする。
}
