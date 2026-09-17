// 公開旅行を未ログインで取得した場合に返してよいリンクだけを列挙する。
// 決済・管理・個人用リンクを誤って公開しないため、ページ一覧とは意図的に分離する。
export const PUBLIC_PLAN_LINK_KEYS = ["itinerary", "maps", "photos", "casinoGuide"] as const;
