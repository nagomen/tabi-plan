window.TRIP_CONFIG = {
  tripSlug: "2608-tohoku",
  tripTitle: "2026年8月 東北旅行",
  tripDates: "2026年8月",
  tripRoute: "仙台、松島、蔵王、青森",
  tripCover: "./images/cover_tohoku.webp",
  mode: "googleSheets",
  spreadsheetId: "1Vsed92F7ao0rW0y5WWao_6VOasuqwATVH1GwE7MvsXw",
  schema: "trip",
  appsScriptUrl: "",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY"],
  auth: {
    enabled: false
  },
  mapDefaults: {
    center: [39.6, 140.6],
    zoom: 6,
    activeRadiusKm: 180,
    overviewRadiusKm: 620
  },
  geocoding: {
    // 計画エディタの場所検索。Mapbox 公開トークン（pk.…）を入れると
    // 多言語POI検索になり「プラザホテル ニューヨーク」等も引ける。
    // 空なら無料の OpenStreetMap(Nominatim) に自動フォールバック。
    // 取得: https://account.mapbox.com/ → Access tokens（無料枠あり）
    mapboxToken: ""
  }
};
