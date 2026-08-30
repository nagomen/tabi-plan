// Google マップのリンク生成（認証不要のテンプレートURL）。

/** 地名・住所を Google マップ検索で開くURL。 */
export function mapsSearchUrl(query: string | undefined): string {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query || "");
}
