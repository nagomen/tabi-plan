window.TRIP_CONFIG = {
  tripSlug: "tabi-plan",
  tripTitle: "Tabi Plan",
  mode: "local",
  defaultParticipants: [],
  currencies: ["JPY", "USD", "EUR", "KRW", "TWD", "CNY", "THB", "SGD", "AUD", "GBP"],
  // true にすると、この計画だけログイン・新規登録なしで誰でも参加者として扱う。
  // 名前を入れるだけで費用の追加・精算が使える（?view=1 で開いても編集できる）。
  // 誰でも書ける前提なので、公開してよい計画にだけ使うこと。
  openEditing: false,
  mapDefaults: {
    center: [35.6812, 139.7671],
    zoom: 5,
    overviewRadiusKm: 800
  },
  geocoding: {
    // Mapbox 公開トークン（pk.…）。設定すると計画エディタの場所検索が
    // Mapbox（多言語POI）になり、AI生成行程の住所と座標も検索結果で照合する。
    // 空なら検索ボタン操作時だけ
    // OpenStreetMap(Nominatim) を使い、入力中の自動候補には利用しない。
    mapboxToken: ""
  },
  sharedBackend: {
    // true にすると計画・費用・アカウント・権限などを共有ストア API（MySQL）へ
    // 同期する。非公開データと書き込みはログインセッションで認可する。
    enabled: false,
    mode: "api",
    // 空なら同一オリジンの /api を使う。別ドメイン API の場合だけ URL を入れる。
    apiBaseUrl: ""
  }
};
