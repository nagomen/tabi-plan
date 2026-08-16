window.TRIP_CONFIG = {
  tripSlug: "2703-sample-trip",
  tripTitle: "2027年3月サンプル旅行",
  mode: "appsScript",
  spreadsheetId: "YOUR_SPREADSHEET_ID",
  schema: "trip",
  appsScriptUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "USD", "EUR", "KRW", "TWD", "CNY", "THB", "SGD", "AUD", "GBP"],
  // true にすると、この計画だけログイン・新規登録なしで誰でも参加者として扱う。
  // 名前を入れるだけで費用の追加・精算が使える（?view=1 で開いても編集できる）。
  // 誰でも書ける前提なので、公開してよい計画にだけ使うこと。
  openEditing: false,
  mapDefaults: {
    center: [35.6812, 139.7671],
    zoom: 5,
    activeRadiusKm: 300,
    overviewRadiusKm: 800
  },
  geocoding: {
    // Mapbox 公開トークン（pk.…）。設定すると計画エディタの場所検索が
    // Mapbox（多言語POI）になる。空なら検索ボタン操作時だけ
    // OpenStreetMap(Nominatim) を使い、入力中の自動候補には利用しない。
    mapboxToken: ""
  },
  sharedBackend: {
    // true にすると計画・費用・アカウント・権限などを共有ストア API（MySQL）へ
    // 同期する。静的サイトのままで、別端末/別ブラウザから同じデータを扱える。
    // apiToken は静的サイトに埋まる＝公開値。無差別アクセス避け程度の意味しかない。
    enabled: false,
    mode: "api",
    // 空なら同一オリジンの /api を使う。別ドメイン API の場合だけ URL を入れる。
    apiBaseUrl: "",
    apiToken: ""
  }
};
