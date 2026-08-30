window.TRIP_CONFIG = {
  tripSlug: "2608-tohoku",
  tripTitle: "2026年8月 東北旅行",
  tripDates: "2026年8月",
  tripRoute: "仙台、松島、蔵王、青森",
  tripCover: "./images/cover_tohoku.webp",
  mode: "local",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY"],
  auth: {
    enabled: false
  },
  // 公開ページは閲覧のみ。編集は plan_members で許可された参加者に限定する。
  openEditing: false,
  mapDefaults: {
    center: [39.6, 140.6],
    zoom: 6,
    activeRadiusKm: 180,
    overviewRadiusKm: 620
  },
  // 共有ストア（MySQL）。これを有効にすると計画・費用・アカウント・権限などが
  // 端末をまたいで共有される。apiToken は静的サイトに埋まる＝公開値なので、
  // 権限管理ではなく無差別アクセス避けとして扱うこと。
  sharedBackend: {
    enabled: true,
    mode: "api",
    apiBaseUrl: "https://travel-api.vote-jt.com",
    apiToken: "8BVHM317b2euKzNhl6YKAQlFtie9RtNx6JsrDhtP"
  },
  geocoding: {
    // 計画エディタの場所検索。Mapbox 公開トークン（pk.…）を入れると
    // 多言語POI検索になり「プラザホテル ニューヨーク」等も引ける。
    // AI生成行程の施設住所と地図座標は設定なしでも登録し、設定時はMapboxで照合する。
    // 空なら明示的に検索ボタンを押した時だけ OpenStreetMap(Nominatim) を使う。
    // 公開Nominatimの規約に従い、入力中の自動候補には利用しない。
    // 取得: https://account.mapbox.com/ → Access tokens（無料枠あり）
    mapboxToken: ""
  }
};
