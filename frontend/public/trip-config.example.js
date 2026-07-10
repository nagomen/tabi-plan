window.TRIP_CONFIG = {
  tripSlug: "2703-sample-trip",
  tripTitle: "2027年3月サンプル旅行",
  mode: "appsScript",
  spreadsheetId: "YOUR_SPREADSHEET_ID",
  schema: "trip",
  appsScriptUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "USD", "EUR", "KRW", "TWD", "CNY", "THB", "SGD", "AUD", "GBP"],
  mapDefaults: {
    center: [35.6812, 139.7671],
    zoom: 5,
    activeRadiusKm: 300,
    overviewRadiusKm: 800
  },
  geocoding: {
    // Mapbox 公開トークン（pk.…）。設定すると計画エディタの場所検索が
    // Mapbox（多言語POI）になる。空なら OpenStreetMap(Nominatim) を使う。
    mapboxToken: ""
  },
  sharedBackend: {
    // true にするとローカル計画・候補・投票・費用などを Apps Script の
    // 共有ストアへ同期する。静的サイトでも別端末/別ブラウザで同じ計画を扱える。
    enabled: true,
    mode: "appsScript"
  }
};
